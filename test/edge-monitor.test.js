import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, carriedState, processOneTick } from '../src/monitor-core.js';
import { limitScreen } from './fixtures/screens.js';

const CONFIG = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 0,
  fallbackWaitHours: 5,
  customPatterns: [],
  handleTransient: true,
  transientWaitSeconds: 60,
};

const TRANSIENT_TEXT = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';
const STUCK_ERR = '⏺ API Error: Connection closed mid-response. The response above may be incomplete.';
const LIMIT_TEXT = "You've hit your session limit · resets in 1 hour";
const NORMAL_TEXT = '> ready for input';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

function adapter({ text = NORMAL_TEXT, claude = true, present = true, eligible = true, blocked = false } = {}) {
  const a = {
    recovered: 0,
    _text: text,
    _claude: claude,
    _present: present,
    _eligible: eligible, // true = stopped (idle/blocked/done); false = working
    _blocked: blocked,
    blocked: () => a._blocked,
    exists: () => a._present,
    eligible: () => a._eligible,
    isClaude: async () => a._claude,
    read: async () => a._text,
    recover: async () => {
      a.recovered++;
    },
  };
  return a;
}

async function poll(state, a, cfg, from, to) {
  const step = (cfg.pollIntervalSeconds || 5) * 1000;
  let result = 'monitoring';
  for (let t = from; t <= to; t += step) result = await processOneTick(state, a, cfg, t);
  return result;
}

// A limit line only a customPattern can match: no stock reset phrasing anywhere.
function customLimitScreen(counter) {
  return [
    '⏺ Bash(npm run build)',
    '  ⎿  built in 4s',
    '',
    '⏺ Quota exhausted for this workspace',
    '',
    `✻ Cooking… (${counter}m 02s · ↓ 3.2k tokens)`,
    '─────────────────────────────────────────',
    '❯',
    '─────────────────────────────────────────',
    `  proj | Opus 5 | ctx: ${counter}%`,
  ].join('\n');
}

// ---------------------------------------------------------------- sleep / wake

test('a 10h sleep gap that swallows the deadline resumes on the first tick back', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, CONFIG, T0), 'waiting');
  assert.equal(state.waitUntil, T0 + HOUR);

  const wake = T0 + 10 * HOUR; // machine slept through the whole wait
  assert.equal(await processOneTick(state, a, CONFIG, wake), 'retried');
  assert.equal(state.attempts, 1);
  assert.equal(state.waitUntil, wake + 30_000);
  assert.equal(a.recovered, 1);
});

test('a 10h sleep gap inside a stuck episode banks no frozen time', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false });
  await poll(state, a, cfg, T0, T0 + 6 * MIN);
  assert.equal(a.recovered, 1, 'the first takeover fired');
  assert.equal(state.lastStuck, true);

  const wake = T0 + 10 * HOUR;
  assert.equal(await processOneTick(state, a, cfg, wake), 'waiting', 'the gap alone never nudges');
  assert.ok(state.frozenMs <= 2 * cfg.pollIntervalSeconds * 1000, `gap capped, got ${state.frozenMs}`);
  assert.equal(a.recovered, 1);

  await poll(state, a, cfg, wake, wake + 3 * MIN);
  assert.equal(a.recovered, 1, 'three observed minutes are not a window');
  await poll(state, a, cfg, wake + 3 * MIN, wake + 7 * MIN);
  assert.equal(a.recovered, 2, 'a full freshly observed window is');
});

test('a 10h sleep gap straight out of monitoring dates the wait from the wake tick', async () => {
  const state = createMonitorState();
  const a = adapter({ text: NORMAL_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, CONFIG, T0), 'monitoring');

  const wake = T0 + 10 * HOUR;
  a._text = LIMIT_TEXT;
  assert.equal(await processOneTick(state, a, CONFIG, wake), 'waiting');
  assert.equal(state.waitUntil, wake + HOUR, 'the deadline is relative to now, not to the last tick');
  assert.equal(state.attempts, 0);
});

// -------------------------------------------------------- monitor replacement

test('a successor mid reset wait re-derives the deadline from the screen', async () => {
  const gen1 = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(gen1, a, CONFIG, T0);
  assert.equal(gen1.status, 'waiting');

  const carried = carriedState(gen1);
  assert.deepEqual(Object.keys(carried).sort(), ['frozenMs', 'lastKind', 'lastStuck', 'nudges', 'stuckSig']);
  const gen2 = createMonitorState(carried);
  assert.equal(gen2.status, 'monitoring', 'a successor never boots already waiting');
  assert.equal(gen2.waitUntil, 0);
  assert.equal(gen2.lastKind, 'reset');

  const t = T0 + 10 * MIN;
  assert.equal(await processOneTick(gen2, a, CONFIG, t), 'waiting');
  assert.equal(gen2.waitUntil, t + HOUR, 'a fresh full wait read off the banner');
  assert.equal(a.recovered, 0);
  assert.equal(gen2.attempts, 0);
});

test('a successor mid stuck episode must observe its own frozen window', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const gen1 = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false });
  await poll(gen1, a, cfg, T0, T0 + 6 * MIN);
  assert.equal(a.recovered, 1);
  assert.equal(gen1.lastStuck, true);

  const gen2 = createMonitorState(carriedState(gen1));
  assert.equal(gen2.lastStuck, true, 'the episode label carries');
  assert.equal(gen2.status, 'monitoring');
  assert.equal(gen2.frozenMs, 0, 'the takeover cleared the clock, so nothing to inherit');
  assert.equal(gen2.nudges, 1);

  assert.equal(await processOneTick(gen2, a, cfg, T0 + 7 * MIN), 'monitoring');
  assert.equal(a.recovered, 1, 'tick one never fires');
  await poll(gen2, a, cfg, T0 + 7 * MIN, T0 + 13 * MIN);
  assert.equal(a.recovered, 2, 'a full observed window does');
});

test('a successor after max-retries starts with a fresh reset budget', async () => {
  const cfg = { ...CONFIG, maxRetries: 1 };
  const gen1 = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(gen1, a, cfg, T0);
  assert.equal(await processOneTick(gen1, a, cfg, T0 + HOUR + 1), 'retried');
  assert.equal(await processOneTick(gen1, a, cfg, gen1.waitUntil + 1), 'max-retries');
  assert.equal(gen1.attempts, 1);

  const carried = carriedState(gen1);
  assert.equal(carried.attempts, undefined, 'the exhausted cap is never written to the lock record');
  const gen2 = createMonitorState(carried);
  assert.equal(gen2.attempts, 0);

  const t = T0 + 2 * HOUR;
  assert.equal(await processOneTick(gen2, a, cfg, t), 'waiting');
  assert.equal(await processOneTick(gen2, a, cfg, t + HOUR + 1), 'retried', 'the successor can still resume the pane');
  assert.equal(a.recovered, 2);
});

test('a successor booting on an already cleared screen ends the episode', async () => {
  const gen1 = createMonitorState();
  const a = adapter({ text: TRANSIENT_TEXT, eligible: true });
  await processOneTick(gen1, a, CONFIG, T0);
  assert.equal(await processOneTick(gen1, a, CONFIG, T0 + 2 * MIN), 'retried');
  assert.equal(gen1.nudges, 1);

  const gen2 = createMonitorState(carriedState(gen1));
  a._text = NORMAL_TEXT; // the outage ended while the monitor was being replaced
  assert.equal(await processOneTick(gen2, a, CONFIG, T0 + 5 * MIN), 'monitoring');
  assert.equal(gen2.status, 'monitoring');
  assert.equal(gen2.nudges, 0, 'a clean readable screen ends the episode');
  assert.equal(gen2.attempts, 0);
  assert.equal(a.recovered, 1, 'the successor sent nothing');
});

test('a corrupted carried record degrades to a clean monitoring state', async () => {
  const junk = {
    nudges: -3, lastKind: 42, lastStuck: 'yes', frozenMs: Number.NaN, stuckSig: 12,
    status: 'waiting', waitUntil: T0 + 1e9, attempts: 99, armSig: 'stale', extra: { deep: true },
  };
  const state = createMonitorState(junk);
  assert.equal(state.nudges, 0);
  assert.equal(state.lastKind, null);
  assert.equal(state.lastStuck, false);
  assert.equal(state.frozenMs, 0);
  assert.equal(state.stuckSig, null);
  assert.equal(state.status, 'monitoring');
  assert.equal(state.waitUntil, 0);
  assert.equal(state.attempts, 0);
  assert.equal(state.armSig, null);
  assert.equal(state.extra, undefined, 'unknown keys are never copied through');

  // Partial shapes: a fractional count floors, a clock without a string signature is dropped.
  assert.equal(createMonitorState({ nudges: 3.7 }).nudges, 3);
  assert.equal(createMonitorState({ nudges: Number.POSITIVE_INFINITY }).nudges, 0);
  assert.equal(createMonitorState({ frozenMs: -5, stuckSig: 'abc' }).frozenMs, 0);
  assert.equal(createMonitorState({ frozenMs: 90_000, stuckSig: 12 }).stuckSig, null);
  assert.equal(createMonitorState('not an object').nudges, 0);

  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, CONFIG, T0), 'waiting', 'and it still ticks normally');
  assert.equal(state.waitUntil, T0 + HOUR);
});

// ------------------------------------------------------ deadline-time surprises

test('unreadable screens at the deadline hold the wait open without moving it', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(state, a, CONFIG, T0);
  const deadline = state.waitUntil;

  a._text = null; // failed read
  assert.equal(await processOneTick(state, a, CONFIG, deadline + 1), 'waiting');
  assert.equal(state.waitUntil, deadline, 'a failed read never postpones the check');
  a._text = '   \n  '; // blank read
  assert.equal(await processOneTick(state, a, CONFIG, deadline + 2), 'waiting');
  assert.equal(state.attempts, 0);
  assert.equal(a.recovered, 0);

  a._text = LIMIT_TEXT;
  assert.equal(await processOneTick(state, a, CONFIG, deadline + 3), 'retried');
  assert.equal(state.attempts, 1);
  assert.equal(a.recovered, 1);
});

test('a Claude agent that vanishes at the deadline is retried after a short requeue', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true, claude: false });
  await processOneTick(state, a, CONFIG, T0);
  const deadline = state.waitUntil;

  assert.equal(await processOneTick(state, a, CONFIG, deadline + 1), 'skipped-not-claude');
  assert.equal(state.waitUntil, deadline + 1 + CONFIG.pollIntervalSeconds * 1000 * 6);
  assert.equal(state.attempts, 0);
  assert.equal(a.recovered, 0);

  a._claude = true; // herdr sees the agent again
  assert.equal(await processOneTick(state, a, CONFIG, state.waitUntil + 1), 'retried');
  assert.equal(state.attempts, 1);
  assert.equal(a.recovered, 1);
});

test('a pane that disappears mid wait exits without touching the episode', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(state, a, CONFIG, T0);
  const deadline = state.waitUntil;

  a._present = false;
  assert.equal(await processOneTick(state, a, CONFIG, T0 + MIN), 'exit', 'before the deadline');
  assert.equal(await processOneTick(state, a, CONFIG, deadline + 1), 'exit', 'and at it');
  assert.equal(state.status, 'waiting');
  assert.equal(state.waitUntil, deadline);
  assert.equal(a.recovered, 0);
});

test('blocked flipping on exactly at the deadline suppresses the send until it clears', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(state, a, CONFIG, T0);
  const deadline = state.waitUntil;

  a._blocked = true; // a permission prompt landed on the same tick
  assert.equal(await processOneTick(state, a, CONFIG, deadline), 'waiting');
  assert.equal(a.recovered, 0, 'never types over a prompt');
  assert.equal(state.status, 'waiting', 'the episode is paused, not ended');
  assert.equal(state.attempts, 0);
  assert.equal(state.waitUntil, deadline);

  a._blocked = false;
  assert.equal(await processOneTick(state, a, CONFIG, deadline + 1), 'retried');
  assert.equal(state.attempts, 1);
  assert.equal(a.recovered, 1);
});

// ------------------------------------------------------------ working-pane arm

test('a blank read between the two confirm polls restarts the arm', async () => {
  const state = createMonitorState();
  const a = adapter({ text: limitScreen(2), eligible: false });
  assert.equal(await processOneTick(state, a, CONFIG, T0), 'monitoring');

  a._text = ''; // the read hiccuped between sightings
  assert.equal(await processOneTick(state, a, CONFIG, T0 + 5000), 'monitoring');
  assert.equal(state.armSig, null, 'confirmation restarts rather than counting an unseen poll');

  a._text = limitScreen(3);
  assert.equal(await processOneTick(state, a, CONFIG, T0 + 10_000), 'monitoring', 'this is sighting one again');
  a._text = limitScreen(4);
  assert.equal(await processOneTick(state, a, CONFIG, T0 + 15_000), 'waiting');
  assert.equal(state.status, 'waiting');
  assert.equal(a.recovered, 0);
});

test('a customPatterns-only arm falls back to the fallback wait and never types while working', async () => {
  const cfg = { ...CONFIG, customPatterns: ['Quota exhausted for this workspace'] };
  const state = createMonitorState();
  const a = adapter({ text: customLimitScreen(2), eligible: false });
  assert.equal(await processOneTick(state, a, cfg, T0), 'monitoring');
  a._text = customLimitScreen(3);
  assert.equal(await processOneTick(state, a, cfg, T0 + 5000), 'waiting');
  assert.equal(state.lastKind, 'reset');
  assert.equal(state.lastRateLimitMessage, null, 'no stock phrasing to parse');
  assert.equal(state.waitUntil, T0 + 5000 + cfg.fallbackWaitHours * HOUR);
  assert.equal(a.recovered, 0);

  a._text = customLimitScreen(9);
  const deadline = state.waitUntil;
  assert.equal(await processOneTick(state, a, cfg, deadline + 1), 'waiting', 'still working: requeued');
  assert.equal(a.recovered, 0);
  assert.ok(state.waitUntil > deadline + 1);
});

test('a pane that goes idle between the confirm polls arms through the ordinary path', async () => {
  const state = createMonitorState();
  const a = adapter({ text: limitScreen(2), eligible: false });
  assert.equal(await processOneTick(state, a, CONFIG, T0), 'monitoring');

  a._eligible = true; // the spinner stopped before the second sighting
  a._text = limitScreen(3);
  const t = T0 + 5000;
  assert.equal(await processOneTick(state, a, CONFIG, t), 'waiting');
  assert.equal(state.lastKind, 'reset');
  assert.ok(state.waitUntil > t, 'a real reset deadline, not a zero-length wait');
  assert.equal(state.armSig, null, 'a stopped pane needs no arming evidence');
  assert.equal(a.recovered, 0);

  a._eligible = false; // and a send still waits for the pane to stop again
  const deadline = state.waitUntil;
  assert.equal(await processOneTick(state, a, CONFIG, deadline + 1), 'waiting');
  assert.equal(a.recovered, 0);
});

// ------------------------------------------------------- transient/reset mix

test('a reset banner replacing a transient mid wait re-derives the reset deadline', async () => {
  const state = createMonitorState();
  const a = adapter({ text: TRANSIENT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, CONFIG, T0), 'waiting');
  assert.equal(await processOneTick(state, a, CONFIG, state.waitUntil), 'retried');
  assert.equal(state.nudges, 1);
  const nudged = a.recovered;

  a._text = LIMIT_TEXT; // the throttle was the front edge of a session limit
  const t = state.waitUntil;
  assert.equal(await processOneTick(state, a, CONFIG, t), 'waiting', 'a session limit is waited out, not nudged');
  assert.equal(state.lastKind, 'reset');
  assert.equal(state.waitUntil, t + HOUR);
  assert.equal(a.recovered, nudged, 'no send into a pane that is limited for the next hour');
});

test('a working pane showing a transient at the reset deadline stands down, then the stuck path re-engages', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, cfg, T0), 'waiting');
  const deadline = state.waitUntil;

  a._eligible = false; // herdr says working
  a._text = STUCK_ERR; // and the banner is gone, replaced by a transient
  assert.equal(await processOneTick(state, a, cfg, deadline + 1), 'user-continued', 'a working transition plus no banner is resumption');
  assert.equal(state.status, 'monitoring');
  assert.equal(state.attempts, 0);
  assert.equal(state.nudges, 0);
  assert.equal(a.recovered, 0);

  await poll(state, a, cfg, deadline + 1, deadline + 7 * MIN);
  assert.equal(a.recovered, 1, 'the freeze is then handled as a stuck takeover');
  assert.equal(state.lastStuck, true);
});

test('handleTransient=false ends a reset wait when a transient replaces the banner', async () => {
  const cfg = { ...CONFIG, handleTransient: false };
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, cfg, T0), 'waiting', 'reset handling is unaffected by the flag');
  const deadline = state.waitUntil;

  a._text = TRANSIENT_TEXT;
  assert.equal(await processOneTick(state, a, cfg, deadline + 1), 'user-continued');
  assert.equal(state.status, 'monitoring');
  assert.equal(state.attempts, 0);
  assert.equal(a.recovered, 0, 'the ignored kind is never nudged');
  assert.equal(await processOneTick(state, a, cfg, deadline + 2 * MIN), 'monitoring');
  assert.equal(a.recovered, 0);
});

// ----------------------------------------------------------------- budgets

test('the reset cap ends in a cool-down requeue that keeps watching', async () => {
  const cfg = { ...CONFIG, maxRetries: 2 };
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(state, a, cfg, T0);
  assert.equal(await processOneTick(state, a, cfg, state.waitUntil + 1), 'retried');
  assert.equal(await processOneTick(state, a, cfg, state.waitUntil + 1), 'retried');
  assert.equal(state.attempts, 2);
  assert.equal(a.recovered, 2);

  let t = state.waitUntil + 1;
  assert.equal(await processOneTick(state, a, cfg, t), 'max-retries');
  assert.equal(state.waitUntil, t + cfg.pollIntervalSeconds * 1000 * 12, 'a longer cool-down, not a send');
  assert.equal(a.recovered, 2);

  t = state.waitUntil + 1;
  assert.equal(await processOneTick(state, a, cfg, t), 'max-retries', 'and it stays capped');
  assert.equal(a.recovered, 2);

  a._text = NORMAL_TEXT;
  assert.equal(await processOneTick(state, a, cfg, state.waitUntil + 1), 'user-continued');
  assert.equal(state.attempts, 0, 'clearance re-opens the budget');
});

test('the nudge backoff doubles to the cap and stays there', async () => {
  const cfg = { ...CONFIG, transientWaitSeconds: 60, transientMaxWaitSeconds: 300 };
  const state = createMonitorState();
  const a = adapter({ text: TRANSIENT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, cfg, T0), 'waiting');
  assert.equal(state.waitUntil, T0 + 60_000);

  const deltas = [];
  for (let i = 0; i < 4; i++) {
    const t = state.waitUntil;
    assert.equal(await processOneTick(state, a, cfg, t), 'retried');
    deltas.push(state.waitUntil - t);
  }
  assert.deepEqual(deltas, [120_000, 240_000, 300_000, 300_000]);
  assert.equal(state.nudges, 4, 'nudges are uncapped: only the wait is');
  assert.equal(state.attempts, 0, 'a transient never spends the reset budget');
  assert.equal(a.recovered, 4);
});

test('a resumption clears both budgets while a replacement keeps the backoff', async () => {
  const cfg = { ...CONFIG, transientWaitSeconds: 60, transientMaxWaitSeconds: 300 };
  const gen1 = createMonitorState();
  const a = adapter({ text: TRANSIENT_TEXT, eligible: true });
  await processOneTick(gen1, a, cfg, T0);
  await processOneTick(gen1, a, cfg, gen1.waitUntil);
  await processOneTick(gen1, a, cfg, gen1.waitUntil);
  assert.equal(gen1.nudges, 2);

  const gen2 = createMonitorState(carriedState(gen1));
  assert.equal(gen2.nudges, 2, 'a replacement continues the backoff');
  assert.equal(gen2.attempts, 0, 'but never the reset cap');

  a._text = NORMAL_TEXT; // the outage ended for real
  assert.equal(await processOneTick(gen2, a, cfg, T0 + 30 * MIN), 'monitoring');
  assert.equal(gen2.nudges, 0, 'a genuine resumption is a new episode, so the backoff restarts');
  assert.equal(gen2.attempts, 0);
});

// ------------------------------------------------------------- config oddities

test('a missing pollIntervalSeconds never yields a NaN deadline', async () => {
  const cfg = { ...CONFIG, pollIntervalSeconds: undefined, maxRetries: 1 };

  const s1 = createMonitorState();
  const a1 = adapter({ text: LIMIT_TEXT, eligible: true, claude: false });
  await processOneTick(s1, a1, cfg, T0);
  assert.equal(await processOneTick(s1, a1, cfg, T0 + HOUR + 1), 'skipped-not-claude');
  assert.ok(Number.isFinite(s1.waitUntil) && s1.waitUntil > T0 + HOUR, `skip requeue: got ${s1.waitUntil}`);

  const s2 = createMonitorState();
  const a2 = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(s2, a2, cfg, T0);
  await processOneTick(s2, a2, cfg, T0 + HOUR + 1);
  const t2 = s2.waitUntil + 1;
  assert.equal(await processOneTick(s2, a2, cfg, t2), 'max-retries');
  assert.ok(Number.isFinite(s2.waitUntil) && s2.waitUntil > t2, `cool-down: got ${s2.waitUntil}`);

  const s3 = createMonitorState();
  const a3 = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(s3, a3, cfg, T0);
  a3._eligible = false; // working at the deadline: D31 requeue
  const t3 = s3.waitUntil + 1;
  assert.equal(await processOneTick(s3, a3, cfg, t3), 'waiting');
  assert.ok(Number.isFinite(s3.waitUntil) && s3.waitUntil > t3, `working requeue: got ${s3.waitUntil}`);
  assert.equal(a3.recovered, 0);
});

test('maxRetries=1 sends exactly once per episode', async () => {
  const cfg = { ...CONFIG, maxRetries: 1 };
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(state, a, cfg, T0);
  assert.equal(await processOneTick(state, a, cfg, state.waitUntil + 1), 'retried');
  assert.equal(state.attempts, 1);

  const t = state.waitUntil + 1;
  assert.equal(await processOneTick(state, a, cfg, t), 'max-retries');
  assert.equal(state.waitUntil, t + cfg.pollIntervalSeconds * 1000 * 12);
  assert.equal(a.recovered, 1);
  assert.equal(await processOneTick(state, a, cfg, state.waitUntil + 1), 'max-retries');
  assert.equal(a.recovered, 1);
});

// eligibleStates without 'blocked': herdr reports the pane not stopped while blocked() is true.
test('a blocked pane outside eligibleStates arms on evidence but is never typed into', async () => {
  const state = createMonitorState();
  const a = adapter({ text: limitScreen(2), eligible: false, blocked: true });
  assert.equal(await processOneTick(state, a, CONFIG, T0), 'monitoring');
  a._text = limitScreen(3);
  assert.equal(await processOneTick(state, a, CONFIG, T0 + 5000), 'waiting', 'the two-poll arm still works');
  assert.equal(state.lastKind, 'reset');
  assert.equal(a.recovered, 0);

  const deadline = state.waitUntil;
  a._text = limitScreen(9);
  assert.equal(await processOneTick(state, a, CONFIG, deadline + 1), 'waiting', 'blocked pauses the episode');
  assert.equal(state.status, 'waiting');
  assert.equal(state.attempts, 0);
  assert.equal(a.recovered, 0);

  a._blocked = false;
  a._eligible = true;
  assert.equal(await processOneTick(state, a, CONFIG, state.waitUntil + 1), 'retried');
  assert.equal(state.attempts, 1);
  assert.equal(a.recovered, 1);
});
