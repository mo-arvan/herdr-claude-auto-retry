import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, carriedState, processOneTick } from '../src/monitor-core.js';

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

// Relative reset text keeps waitUntil timezone-independent.
const LIMIT_TEXT = 'Please try again in 1 hour';
const NORMAL_TEXT = '> ready for input';

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

test('stays monitoring when there is no rate limit', async () => {
  const state = createMonitorState();
  const a = adapter();
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'monitoring');
  assert.equal(state.status, 'monitoring');
});

test('enters waiting on a detected rate limit and sets the reset deadline', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'waiting');
  assert.equal(state.status, 'waiting');
  assert.equal(state.waitUntil, 3_600_000); // 1h relative, margin 0
});

test('a working pane is never rate-limited even with limit text on screen', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: false });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'monitoring');
  assert.equal(state.status, 'monitoring');
  assert.equal(a.recovered, 0);
});

test('an eligible (stopped) pane with limit text enters waiting', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'waiting');
  assert.equal(state.status, 'waiting');
});

test('a transient server throttle engages with the short transient wait', async () => {
  const cfg = { ...CONFIG, transientWaitSeconds: 30 };
  const state = createMonitorState();
  const a = adapter({ text: TRANSIENT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, cfg, 0), 'waiting');
  assert.equal(state.waitUntil, 30_000); // short wait, not 5h
});

test('transient handling can be disabled via config', async () => {
  const cfg = { ...CONFIG, handleTransient: false };
  const state = createMonitorState();
  const a = adapter({ text: TRANSIENT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, cfg, 0), 'monitoring');
  assert.equal(a.recovered, 0);
});

const STUCK_ERR = '⏺ API Error: Connection closed mid-response. The response above may be incomplete.';
const MIN = 60_000;
const T0 = 1_700_000_000_000;

// Steps in small ticks like the real monitor; a single big tick is a sleep gap and must not count.
async function poll(state, a, cfg, from, to) {
  const step = cfg.pollIntervalSeconds * 1000;
  let result = 'monitoring';
  for (let t = from; t <= to; t += step) result = await processOneTick(state, a, cfg, t);
  return result;
}

// Real 7h-stall shape (D18): status lines push the error ~18 lines up, past detectionTailLines.
const STALLED_SCREEN = [
  '⏺ Ran 1 shell command', '',
  STUCK_ERR, '',
  '✻ Cooked for 1h 22m 18s', '',
  '  10 tasks (2 done, 1 in progress, 7 open)',
  '  ◼ T-109: rewrite the parser behind a flag',
  '  ◻ T-83: wire the retry budget into the client',
  '  ◻ T-85: three fixes to the report exporter',
  '  ◻ T-95: coverage gate plus a smoke test',
  '  ◻ T-106: config validation pass',
  '  … +3 pending, 2 completed',
  '  new task? /clear to save 290.4k tokens',
  '─'.repeat(60), '❯', '─'.repeat(60),
  'Opus 5 (1M context)  |  ctx 29%',
  '⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

test('takes over a working pane frozen on a transient error past the stuck threshold', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false }); // herdr says WORKING throughout
  await poll(state, a, cfg, T0, T0 + 4 * MIN);
  assert.equal(a.recovered, 0, 'must not act under the threshold');
  await poll(state, a, cfg, T0 + 4 * MIN, T0 + 6 * MIN);
  assert.ok(a.recovered >= 1, 'takes over once the frozen window is met');
  assert.equal(state.lastStuck, true);
});

test('takes over a stall whose error sits outside the tail window', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5, detectionTailLines: 15 };
  const state = createMonitorState();
  const a = adapter({ text: STALLED_SCREEN, eligible: false });
  await poll(state, a, cfg, T0, T0 + 6 * MIN);
  assert.ok(a.recovered >= 1, 'the 7h-stall shape must fire, not sit in monitoring forever');
  assert.equal(state.lastStuck, true);
});

test('does NOT take over a working pane whose output keeps changing', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false });
  await poll(state, a, cfg, T0, T0 + 4 * MIN);
  a._text = `${STUCK_ERR}\n\n⏺ Retrying, here is more output.`; // new output = progress
  await processOneTick(state, a, cfg, T0 + 4 * MIN + 5000);
  a._text = STUCK_ERR;
  assert.equal(await poll(state, a, cfg, T0 + 4 * MIN, T0 + 6 * MIN), 'monitoring');
  assert.equal(a.recovered, 0);
});

test('never takes over a genuinely working pane (latest output is not an error)', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 1 };
  const state = createMonitorState();
  const a = adapter({ text: '⏺ Bash(npm test)\n  ⎺ running the suite...', eligible: false });
  assert.equal(await poll(state, a, cfg, T0, T0 + 10 * MIN), 'monitoring');
  assert.equal(a.recovered, 0);
});

test('handleStuckWorking=false restores absolute trust in herdr state', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: false, stuckWorkingMinutes: 1 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false });
  assert.equal(await poll(state, a, cfg, T0, T0 + 60 * MIN), 'monitoring');
  assert.equal(a.recovered, 0);
});

test('observed frozen time survives a monitor replacement', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const a = adapter({ text: STUCK_ERR, eligible: false });
  const gen1 = createMonitorState();
  assert.equal(await poll(gen1, a, cfg, T0, T0 + 3 * MIN), 'monitoring');

  const gen2 = createMonitorState(carriedState(gen1));
  await poll(gen2, a, cfg, T0 + 3 * MIN, T0 + 6 * MIN);
  assert.ok(a.recovered >= 1, 'the successor picks up where gen1 stopped');

  // Without the carry the successor restarts the clock and the stall is missed.
  const fresh = createMonitorState();
  const b = adapter({ text: STUCK_ERR, eligible: false });
  await poll(fresh, b, cfg, T0 + 3 * MIN, T0 + 6 * MIN);
  assert.equal(b.recovered, 0, 'a monitor with no carried state cannot reach the threshold in 3 min');
});

test('a sleep gap does not count as observed frozen time', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const a = adapter({ text: STUCK_ERR, eligible: false });
  const gen1 = createMonitorState();
  await processOneTick(gen1, a, cfg, T0);
  await processOneTick(gen1, a, cfg, T0 + 10 * 3600_000); // one tick, ten hours later
  assert.ok(gen1.frozenMs <= 2 * cfg.pollIntervalSeconds * 1000, `gap capped, got ${gen1.frozenMs}`);
  assert.equal(a.recovered, 0);

  const gen2 = createMonitorState(carriedState(gen1));
  assert.equal(await processOneTick(gen2, a, cfg, T0 + 10 * 3600_000 + 5000), 'monitoring', 'must not fire on tick one');
});

test('an empty or failed read does not clear the stuck clock', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false });
  await poll(state, a, cfg, T0, T0 + 4 * MIN);
  const banked = state.frozenMs;
  a._text = '   \n  ';
  await processOneTick(state, a, cfg, T0 + 4 * MIN + 5000);
  a._text = null;
  await processOneTick(state, a, cfg, T0 + 4 * MIN + 10000);
  assert.equal(state.frozenMs, banked, 'a blank or failed read must not reset progress');
  a._text = STUCK_ERR;
  await poll(state, a, cfg, T0 + 4 * MIN, T0 + 6 * MIN);
  assert.ok(a.recovered >= 1, 'progress was banked, so the threshold is still reached');
});

test('a frozen pane keeps escalating its backoff and never reports a false clear', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5, transientWaitSeconds: 60, transientMaxWaitSeconds: 300 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false });
  const results = [];
  for (let t = T0; t <= T0 + 40 * MIN; t += cfg.pollIntervalSeconds * 1000) {
    results.push(await processOneTick(state, a, cfg, t));
  }
  assert.ok(!results.includes('user-continued'), 'the pane never recovered, so it must never report cleared');
  assert.ok(state.nudges >= 4, `the backoff must escalate, got nudges=${state.nudges}`);
  assert.ok(a.recovered >= 4, 'and it must keep trying while the outage lasts');
});

test('a pane that comes back resets the episode', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false });
  await poll(state, a, cfg, T0, T0 + 8 * MIN);
  assert.ok(state.nudges >= 1);
  a._text = '⏺ Continuing with the refactor.';
  a._eligible = true;
  assert.equal(await processOneTick(state, a, cfg, T0 + 20 * MIN), 'user-continued');
  assert.equal(state.nudges, 0);
  assert.equal(state.frozenMs, 0, 'the stuck clock is cleared when the episode ends');
});

test('the transient backoff keeps escalating across a monitor replacement', async () => {
  const cfg = { ...CONFIG, transientWaitSeconds: 60, transientMaxWaitSeconds: 300 };
  const a = adapter({ text: TRANSIENT_TEXT });
  const gen1 = createMonitorState();
  await processOneTick(gen1, a, cfg, T0);
  assert.equal(await processOneTick(gen1, a, cfg, T0 + 60_000), 'retried');
  assert.equal(gen1.nudges, 1);

  const gen2 = createMonitorState(carriedState(gen1)); // replaced mid-outage
  await processOneTick(gen2, a, cfg, T0 + 10 * MIN);
  assert.equal(await processOneTick(gen2, a, cfg, T0 + 11 * MIN), 'retried');
  assert.equal(gen2.nudges, 2, 'continues the backoff instead of restarting at attempt 1');
});

test('carried state is sanitized, and a clock without its signature is dropped', () => {
  assert.equal(createMonitorState().attempts, 0);
  assert.equal(createMonitorState(null).attempts, 0);
  assert.equal(createMonitorState({ nudges: 'seven' }).nudges, 0);
  assert.equal(createMonitorState({ lastKind: 'bogus' }).lastKind, null);
  assert.equal(createMonitorState({ frozenMs: 90_000, stuckSig: null }).frozenMs, 0);
  const ok = createMonitorState({ frozenMs: 90_000, stuckSig: 'abc', nudges: 3, lastKind: 'transient' });
  assert.deepEqual(
    [ok.frozenMs, ok.stuckSig, ok.nudges, ok.lastKind],
    [90_000, 'abc', 3, 'transient'],
  );
  // A fresh monitor never starts already waiting: only episode counters carry.
  assert.equal(createMonitorState({ status: 'waiting', waitUntil: T0 + 1e9 }).status, 'monitoring');
  assert.equal(createMonitorState({ status: 'waiting', waitUntil: T0 + 1e9 }).waitUntil, 0);
});

test('a transient error nudges repeatedly with exponential backoff (capped)', async () => {
  const cfg = { ...CONFIG, transientWaitSeconds: 10, transientMaxWaitSeconds: 40 };
  const state = createMonitorState();
  const a = adapter({ text: TRANSIENT_TEXT, eligible: true });

  let t = 0;
  assert.equal(await processOneTick(state, a, cfg, t), 'waiting'); // detect
  assert.equal(state.waitUntil, 10_000); // initial wait = base

  t = state.waitUntil;
  assert.equal(await processOneTick(state, a, cfg, t), 'retried'); // nudge 1
  assert.equal(state.waitUntil - t, 20_000); // 2x base

  t = state.waitUntil;
  assert.equal(await processOneTick(state, a, cfg, t), 'retried'); // nudge 2 - NOT max-retries
  assert.equal(state.waitUntil - t, 40_000); // 4x base

  t = state.waitUntil;
  assert.equal(await processOneTick(state, a, cfg, t), 'retried'); // nudge 3
  assert.equal(state.waitUntil - t, 40_000); // capped at transientMaxWaitSeconds
  assert.equal(a.recovered, 3); // kept nudging, no spam cap
});

test('a transient error stops nudging once a real response appears below it', async () => {
  const cfg = { ...CONFIG, transientWaitSeconds: 10, transientMaxWaitSeconds: 40 };
  const state = createMonitorState();
  const erroring = '⏺ API Error: 500 Internal server error.';
  const recovered = [
    '⏺ API Error: 500 Internal server error.', // the old error, now scrolled up
    '',
    '✻ Cogitated for 1s',
    '',
    '❯ Continue where you left off.', // the monitor's own echoed nudge
    '',
    '⏺ Done - here is the result.', // the latest output: a real response
  ].join('\n');
  const a = adapter({ text: erroring, eligible: true });

  await processOneTick(state, a, cfg, 0); // detect -> waiting
  assert.equal(await processOneTick(state, a, cfg, state.waitUntil), 'retried'); // nudge once
  assert.equal(a.recovered, 1);

  a._text = recovered; // Claude responded; error lingers above
  assert.equal(await processOneTick(state, a, cfg, state.waitUntil), 'user-continued');
  assert.equal(a.recovered, 1); // did NOT nudge the recovered session
  assert.equal(state.status, 'monitoring');
});

test('detection records the kind (transient vs reset) for labelling', async () => {
  const s1 = createMonitorState();
  await processOneTick(s1, adapter({ text: TRANSIENT_TEXT, eligible: true }), CONFIG, 0);
  assert.equal(s1.lastKind, 'transient');
  const s2 = createMonitorState();
  await processOneTick(s2, adapter({ text: LIMIT_TEXT, eligible: true }), CONFIG, 0);
  assert.equal(s2.lastKind, 'reset');
});

test('a reset wait ends when the banner clears, not when herdr says working', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(state, a, CONFIG, 0); // -> waiting
  a._eligible = false;
  assert.equal(await processOneTick(state, a, CONFIG, 3_600_001), 'retried', 'it resumes rather than abandoning the pane');
  a._text = NORMAL_TEXT; // the banner is gone: that is the real signal
  assert.equal(await processOneTick(state, a, CONFIG, 3_700_000), 'user-continued');
});

test('keeps waiting until the deadline passes', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT });
  await processOneTick(state, a, CONFIG, 0);
  assert.equal(await processOneTick(state, a, CONFIG, 1_000), 'waiting');
  assert.equal(a.recovered, 0);
});

test('retries once the deadline passes and the limit persists', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT });
  await processOneTick(state, a, CONFIG, 0);
  const res = await processOneTick(state, a, CONFIG, 3_600_001);
  assert.equal(res, 'retried');
  assert.equal(a.recovered, 1);
  assert.equal(state.attempts, 1);
});

test('resets to monitoring when the limit cleared by the deadline', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT });
  await processOneTick(state, a, CONFIG, 0);
  a._text = NORMAL_TEXT; // user resumed, or the window reset
  const res = await processOneTick(state, a, CONFIG, 3_600_001);
  assert.equal(res, 'user-continued');
  assert.equal(state.status, 'monitoring');
  assert.equal(state.attempts, 0);
  assert.equal(a.recovered, 0);
});

// herdr's own agent detection gates the send, not a fragile ps/pane_current_command check.
test('skips the send when herdr no longer sees a Claude agent', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, claude: false });
  await processOneTick(state, a, CONFIG, 0);
  const res = await processOneTick(state, a, CONFIG, 3_600_001);
  assert.equal(res, 'skipped-not-claude');
  assert.equal(a.recovered, 0);
});

test('stops sending after maxRetries but still watches for clearance', async () => {
  const cfg = { ...CONFIG, maxRetries: 1 };
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT });
  await processOneTick(state, a, cfg, 0); // -> waiting
  let t = 3_600_001;
  assert.equal(await processOneTick(state, a, cfg, t), 'retried'); // attempt 1
  t = state.waitUntil + 1;
  assert.equal(await processOneTick(state, a, cfg, t), 'max-retries');
  assert.equal(a.recovered, 1); // never sent a second time
});

test('exits when the pane disappears', async () => {
  const state = createMonitorState();
  const a = adapter({ present: false });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'exit');
});

test('empty read at the deadline stays waiting, never concludes cleared', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT });
  await processOneTick(state, a, CONFIG, 0); // -> waiting
  a._text = ''; // transient hiccup right at the deadline
  const res = await processOneTick(state, a, CONFIG, 3_600_001);
  assert.equal(res, 'waiting');
  assert.equal(state.status, 'waiting');
  assert.equal(state.attempts, 0);
  assert.equal(a.recovered, 0);
});

test('failed read (null) at the deadline stays waiting', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT });
  await processOneTick(state, a, CONFIG, 0);
  a._text = null;
  assert.equal(await processOneTick(state, a, CONFIG, 3_600_001), 'waiting');
  assert.equal(a.recovered, 0);
});

test('does not read the pane while waiting before the deadline', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT });
  await processOneTick(state, a, CONFIG, 0); // detect -> waiting
  let reads = 0;
  a.read = async () => {
    reads++;
    return a._text;
  };
  assert.equal(await processOneTick(state, a, CONFIG, 1000), 'waiting');
  assert.equal(reads, 0);
});

test('a transient error never fires on a blocked pane, but a reset limit still does', async () => {
  const withPrompt = [
    '⏺ API Error: Connection closed mid-response. The response above may be incomplete.', '',
    '> please continue with the refactor', '',
    '  Do you want to allow this tool call?', '  1. Yes', '  2. No',
  ].join('\n');
  const blockedPane = (text) => adapter({ text, blocked: true });

  const s1 = createMonitorState();
  const a1 = blockedPane(withPrompt);
  assert.equal(await processOneTick(s1, a1, CONFIG, T0), 'monitoring', 'must not answer a permission prompt');
  assert.equal(a1.recovered, 0);

  const s2 = createMonitorState();
  const a2 = blockedPane(`${LIMIT_TEXT}\n  1. Upgrade your plan\n  2. Wait`);
  assert.equal(await processOneTick(s2, a2, CONFIG, T0), 'waiting', 'the rate-limit menu still engages');
});

test('a blank read never resets the carried retry budget', async () => {
  const state = createMonitorState({ nudges: 3, lastKind: 'transient', lastStuck: false, frozenMs: 0, stuckSig: null });
  const a = adapter({ text: '   \n  ' });
  assert.equal(await processOneTick(state, a, CONFIG, T0), 'monitoring');
  assert.equal(state.nudges, 3, 'a blank screen says nothing about the episode');
  a._text = null;
  await processOneTick(state, a, CONFIG, T0 + 5000);
  assert.equal(state.nudges, 3);
  a._text = NORMAL_TEXT;
  await processOneTick(state, a, CONFIG, T0 + 10_000);
  assert.equal(state.nudges, 0, 'a genuinely clean screen does end the episode');
});

// Banking time while idle would leave the clock already full the moment herdr flips to working.
test('the stuck clock only runs while herdr reports the pane working', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: true }); // idle: the normal path owns this
  for (let t = T0; t <= T0 + 3 * 3600_000; t += 60_000) await processOneTick(state, a, cfg, t);
  assert.equal(state.frozenMs, 0, 'no stuck time is banked while the pane is idle');
  const before = a.recovered; // the ordinary idle path has been nudging all along
  a._eligible = false; // now herdr says working
  await processOneTick(state, a, cfg, T0 + 3 * 3600_000 + 5000);
  assert.equal(a.recovered, before, 'the takeover must still observe a full fresh window');
});

test('the stuck clock is cleared when the pane genuinely comes back', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false });
  await poll(state, a, cfg, T0, T0 + 8 * MIN);
  assert.ok(state.frozenMs > 0 || state.nudges > 0);
  a._text = '⏺ Back with a real answer.';
  await processOneTick(state, a, cfg, T0 + 20 * MIN);
  assert.equal(state.frozenMs, 0);
  assert.equal(state.stuckSig, null);
});

test('the stuck clock does not bank time on an idle pane even when nothing recovers', async () => {
  const cfg = { ...CONFIG, handleTransient: false, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: true });
  await poll(state, a, cfg, T0, T0 + 30 * MIN);
  assert.equal(state.frozenMs, 0, 'an idle pane is the ordinary path, not a stuck takeover');
});

test('a stuck takeover re-arms, so the next one needs another full window', async () => {
  const cfg = {
    ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5,
    transientWaitSeconds: 1, transientMaxWaitSeconds: 2,
  };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false });
  await poll(state, a, cfg, T0, T0 + 6 * MIN);
  assert.equal(a.recovered, 1, 'the first takeover fires');
  await poll(state, a, cfg, T0 + 6 * MIN, T0 + 9 * MIN);
  assert.equal(a.recovered, 1, 'a 2s backoff must not buy a second one inside the window');
  await poll(state, a, cfg, T0 + 9 * MIN, T0 + 12 * MIN);
  assert.equal(a.recovered, 2, 'a second full frozen window does');
});

// Only Claude's own `⏺ API Error:` line counts (D27); a `⎿` result merely containing error text does not.
test('a long tool call whose output mentions an API error is not a stall', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({
    text: '⏺ Bash(npm run integration --verbose)\n  ⎿ case 12: retried after API Error: 500 Internal server error',
    eligible: false,
  });
  await poll(state, a, cfg, T0, T0 + 30 * MIN);
  assert.equal(a.recovered, 0, 'a busy pane running a long tool call must be left alone');
});

test('lastStuck clears as soon as herdr reports the pane stopped again', async () => {
  const cfg = { ...CONFIG, handleStuckWorking: true, stuckWorkingMinutes: 5 };
  const state = createMonitorState();
  const a = adapter({ text: STUCK_ERR, eligible: false });
  await poll(state, a, cfg, T0, T0 + 8 * MIN);
  assert.equal(state.lastStuck, true, 'the takeover is driving the episode');
  a._eligible = true; // herdr corrects itself
  await processOneTick(state, a, cfg, T0 + 9 * MIN);
  assert.equal(state.lastStuck, false, 'ordinary handling has taken back over');
});

test('a pane that becomes blocked pauses the episode instead of ending it', async () => {
  const state = createMonitorState();
  const a = adapter({ text: TRANSIENT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, CONFIG, T0), 'waiting');
  a._blocked = true;
  a._eligible = true;
  const res = await processOneTick(state, a, CONFIG, T0 + 2 * MIN);
  assert.notEqual(res, 'user-continued', 'nothing cleared: the error text is unchanged');
  assert.equal(state.status, 'waiting', 'the episode is still open');
  a._blocked = false;
  assert.equal(await processOneTick(state, a, CONFIG, T0 + 4 * MIN), 'retried', 'and resumes once unblocked');
});

test('a successor inherits the backoff exponent but not the reset retry cap', async () => {
  const cfg = { ...CONFIG, maxRetries: 3 };
  const gen1 = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  for (let i = 0; i <= 6; i++) await processOneTick(gen1, a, cfg, T0 + i * 3_700_000);
  assert.ok(gen1.attempts >= cfg.maxRetries, 'gen1 exhausted the reset budget');

  assert.equal(carriedState(gen1).attempts, undefined, 'the reset cap is never written to the lock record');
  const gen2 = createMonitorState(carriedState(gen1));
  assert.equal(gen2.attempts, 0, 'the successor starts with a fresh reset budget');
  const b = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(gen2, b, cfg, T0 + 10 * 3_700_000);
  await processOneTick(gen2, b, cfg, T0 + 11 * 3_700_000);
  assert.ok(b.recovered >= 1, 'so it can still resume the pane');
});

// PR #2 (2026-08-12 incident, D28): a spinner held up during queued-message drain must not block detection.
function limitScreen(counter) {
  return [
    '⏺ Bash(git push origin main)',
    '  ⎿  main -> main',
    '',
    "⏺ You've hit your session limit · resets 8:50pm (Asia/Omsk)",
    '',
    `✻ Cooking… (${counter}m 14s · ↓ 8.1k tokens)`,
    '─────────────────────────────────────────',
    '❯',
    '─────────────────────────────────────────',
    `  proj git:(main) | Opus 5 (1M context) | ctx: ${counter}%`,
    `  5h: 30% (resets in ${counter}m) | 7d: 29% (resets in 5d8h)`,
    '  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
}

test('a working pane arms the wait when the limit stays the newest output for two polls', async () => {
  const state = createMonitorState();
  const a = adapter({ text: limitScreen(2), eligible: false });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'monitoring', 'one sighting is a snapshot, not evidence');
  a._text = limitScreen(3); // chrome ticked on, output block unchanged
  assert.equal(await processOneTick(state, a, CONFIG, 5000), 'waiting');
  assert.equal(state.status, 'waiting');
  assert.equal(a.recovered, 0, 'arming never types into a working pane');
});

test('a streaming pane never confirms the arm', async () => {
  const state = createMonitorState();
  const a = adapter({ text: limitScreen(2), eligible: false });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'monitoring');
  a._text = `${limitScreen(3)}\n⏺ Draining the queue.`;
  assert.equal(await processOneTick(state, a, CONFIG, 5000), 'monitoring');
  assert.equal(state.status, 'monitoring');
});

test('a working pane ignores a limit that only sits in the scrollback', async () => {
  const state = createMonitorState();
  const scrollback = [
    "⏺ You've hit your session limit · resets 8:50pm (Asia/Omsk)",
    '',
    '⏺ Done - pushed the fix.',
  ].join('\n');
  const a = adapter({ text: scrollback, eligible: false });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'monitoring');
  assert.equal(state.status, 'monitoring');
});

// Working-pane arming is reset-only; a transient 5xx is Claude Code's own retry to make.
test('a working pane never arms on a transient server error in one tick', async () => {
  const state = createMonitorState();
  const a = adapter({ text: '⏺ API Error: 529 Overloaded.', eligible: false });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'monitoring');
  assert.equal(a.recovered, 0);
});

test('armed while working, resumes once the deadline passes and the pane is idle', async () => {
  const state = createMonitorState();
  const a = adapter({ text: limitScreen(2), eligible: false });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'monitoring');
  a._text = limitScreen(3);
  assert.equal(await processOneTick(state, a, CONFIG, 5000), 'waiting');

  a._eligible = true; // spinner gone, pane parked on the limit
  a._text = limitScreen(7); // only the chrome moved on
  assert.equal(await processOneTick(state, a, CONFIG, state.waitUntil + 1), 'retried');
  assert.equal(a.recovered, 1);
});

test('armed while working, the deadline send waits for the pane to stop', async () => {
  const state = createMonitorState();
  const a = adapter({ text: limitScreen(2), eligible: false });
  await processOneTick(state, a, CONFIG, 0);
  a._text = limitScreen(3);
  await processOneTick(state, a, CONFIG, 5000);
  assert.equal(state.status, 'waiting');

  a._text = limitScreen(9);
  const deadline = state.waitUntil + 1;
  assert.equal(await processOneTick(state, a, CONFIG, deadline), 'waiting', 'still working: no send');
  assert.equal(a.recovered, 0);
  assert.ok(state.waitUntil > deadline, 'requeued for a later check');

  a._eligible = true;
  assert.equal(await processOneTick(state, a, CONFIG, state.waitUntil + 1), 'retried');
  assert.equal(a.recovered, 1);
});

// D24: standing down needs visible progress; chrome churn (spinner, counters) alone is never evidence.
test('stands down when the pane is busy again with new output', async () => {
  const state = createMonitorState();
  const a = adapter({ text: limitScreen(2), eligible: true });
  await processOneTick(state, a, CONFIG, 0);
  a._eligible = false;
  a._text = '⏺ Continuing with the review.';
  assert.equal(await processOneTick(state, a, CONFIG, state.waitUntil + 1), 'user-continued');
  assert.equal(a.recovered, 0);
});

test('stands down when new output appeared on an idle pane', async () => {
  const state = createMonitorState();
  const a = adapter({ text: limitScreen(2), eligible: true });
  await processOneTick(state, a, CONFIG, 0);
  a._text = ['⏺ Continuing with the review.', '', '✻ Cooking… (3s)', '❯'].join('\n');
  assert.equal(await processOneTick(state, a, CONFIG, state.waitUntil + 1), 'user-continued');
  assert.equal(a.recovered, 0);
});

test('chrome churn alone is not evidence the session resumed', async () => {
  const state = createMonitorState();
  const a = adapter({ text: limitScreen(2), eligible: true });
  await processOneTick(state, a, CONFIG, 0);
  a._text = limitScreen(58); // spinner, ctx %, usage counters all moved
  assert.equal(await processOneTick(state, a, CONFIG, state.waitUntil + 1), 'retried');
  assert.equal(a.recovered, 1);
});
