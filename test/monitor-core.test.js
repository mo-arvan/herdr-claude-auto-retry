import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor-core.js';

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

// A relative reset keeps waitUntil deterministic (now + waitMs), independent of
// wall-clock timezone.
const LIMIT_TEXT = 'Please try again in 1 hour';
const NORMAL_TEXT = '> ready for input';

function adapter({ text = NORMAL_TEXT, claude = true, present = true, eligible = true } = {}) {
  const a = {
    recovered: 0,
    _text: text,
    _claude: claude,
    _present: present,
    _eligible: eligible, // true = stopped (idle/blocked/done); false = working
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

// The safety gate: an actively working pane (not eligible) is never treated as
// rate-limited, even when its screen is full of rate-limit text. This is what
// stops a false resume being typed into a busy agent.
test('a working pane is never rate-limited even with limit text on screen', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: false });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'monitoring');
  assert.equal(state.status, 'monitoring');
  assert.equal(a.recovered, 0);
});

// Real rate limits show as a stopped (idle) state, so an eligible pane fires.
test('an eligible (stopped) pane with limit text enters waiting', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  assert.equal(await processOneTick(state, a, CONFIG, 0), 'waiting');
  assert.equal(state.status, 'waiting');
});

// Transient server throttle (the scholar-tracking case): no reset time, so it
// must engage with the SHORT transient wait, not the 5h fallback.
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

// A server outage can outlast any fixed count, so a transient error nudges
// indefinitely - but the interval backs off exponentially (capped), so a
// struggling server is never hammered.
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

// The recovery guard that makes unlimited nudging safe: once Claude responds, the
// OLD error lingering ABOVE the response is no longer the latest output block, so
// classifyLimit reads "not limited" and nudging stops - it never re-pokes a
// resumed session even though the error text is still on screen.
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

test('clears the wait once the pane goes back to working', async () => {
  const state = createMonitorState();
  const a = adapter({ text: LIMIT_TEXT, eligible: true });
  await processOneTick(state, a, CONFIG, 0); // -> waiting
  a._eligible = false; // Claude is working again (resumed)
  const res = await processOneTick(state, a, CONFIG, 3_600_001);
  assert.equal(res, 'user-continued');
  assert.equal(a.recovered, 0);
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

// Issue #1: never get stuck skipping forever. herdr's own agent detection
// gates the send instead of a fragile `ps`/pane_current_command check.
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

// A transient empty/failed read at the deadline must never be read as "the limit
// cleared" - that would silently abandon the resume.
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

// While merely waiting for the reset we must not read the pane at all, so a read
// failure during a long wait cannot accumulate toward shutdown.
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
