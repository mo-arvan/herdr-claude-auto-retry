// End-to-end coverage for bin/main.js (the monitor loop, the recovery, the
// sidebar indicator, the lock lifecycle, and the self-exclusion) by driving the
// real entrypoint against the fake herdr binary. This is the layer the unit
// tests do not reach, and the one every past incident lived in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const FAKE = join(here, 'fixtures', 'fake-herdr.js');
const MAIN = join(repo, 'bin', 'main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(120);
  }
  return null;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'car-e2e-'));
  const stateDir = join(root, 'state');
  const cfgDir = join(root, 'config');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cfgDir, { recursive: true });
  const statePath = join(root, 'hs.json');
  const sendsPath = join(root, 'sends.log');
  writeFileSync(sendsPath, '');
  writeFileSync(
    join(cfgDir, 'claude-auto-retry.json'),
    JSON.stringify({ pollIntervalSeconds: 1, transientWaitSeconds: 1, marginSeconds: 0, menuDismissDelayMs: 0, submitDelayMs: 0 }),
  );
  const procEnv = {
    ...process.env,
    HERDR_BIN_PATH: FAKE,
    HERDR_PLUGIN_ROOT: repo,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: cfgDir,
    FAKE_HERDR_STATE: statePath,
    FAKE_HERDR_SENDS: sendsPath,
  };
  const setState = (s) => writeFileSync(statePath, JSON.stringify(s));
  const sends = () => readFileSync(sendsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const locks = () => {
    try {
      return readdirSync(join(stateDir, 'monitors'));
    } catch {
      return [];
    }
  };
  return { procEnv, setState, sends, locks };
}

test('monitor: detect -> engage label -> recover (text/enter, no esc) -> clear on resume -> lock cleaned', async () => {
  const t = setup();
  t.setState({
    panes: [{ pane_id: 'w1:p1', terminal_id: 't1', agent: 'claude', agent_status: 'idle', cwd: '/x/proj' }],
    read: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
  });
  const proc = spawn(process.execPath, [MAIN, 'monitor', 't1', 'w1:p1'], { env: t.procEnv, stdio: 'ignore' });
  try {
    const fired = await waitFor(() => {
      const s = t.sends();
      const label = s.some((c) => c[0] === 'report-metadata' && c.includes('retry engaged'));
      const enter = s.some((c) => c[0] === 'send-keys' && c.includes('enter'));
      return label && enter ? s : null;
    });
    assert.ok(fired, 'engaged label + recovery should fire within timeout');
    assert.ok(!fired.some((c) => c[0] === 'send-keys' && c.includes('esc')), 'an idle pane is never sent Escape (D22)');
    assert.ok(fired.some((c) => c[0] === 'send-text'), 'retry text sent');
    // The session resumes: footer no longer limited and the pane goes working.
    t.setState({
      panes: [{ pane_id: 'w1:p1', terminal_id: 't1', agent: 'claude', agent_status: 'working', cwd: '/x/proj' }],
      read: 'back to work',
    });
    const cleared = await waitFor(() => t.sends().some((c) => c[0] === 'report-metadata' && c.includes('--clear-custom-status')));
    assert.ok(cleared, 'engaged label cleared once the pane resumes');
  } finally {
    proc.kill('SIGTERM');
  }
  await waitFor(() => t.locks().length === 0);
  assert.equal(t.locks().length, 0, 'lock removed on shutdown');
});

test('monitor exits itself when superseded (a different live pid reclaims its lock)', async () => {
  const t = setup();
  t.setState({
    panes: [{ pane_id: 'w1:p1', terminal_id: 't1', agent: 'claude', agent_status: 'idle', cwd: '/x/proj' }],
    read: 'normal prompt',
  });
  const proc = spawn(process.execPath, [MAIN, 'monitor', 't1', 'w1:p1'], { env: t.procEnv, stdio: 'ignore' });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  try {
    const claimed = await waitFor(() => t.locks().includes('t1.json'));
    assert.ok(claimed, 'monitor claimed its lock');
    // Simulate a sleep/wake reclaim: a different LIVE pid (this test runner) now
    // owns the lock. Re-assert each poll so a tick's lock refresh cannot race it.
    const lockPath = join(t.procEnv.HERDR_PLUGIN_STATE_DIR, 'monitors', 't1.json');
    const steal = () => writeFileSync(lockPath, JSON.stringify({
      terminalId: 't1', pid: process.pid, paneId: 'w1:p1', agent: 'claude',
      startedAtMs: Date.now(), updatedAtMs: Date.now(),
    }));
    const deadline = Date.now() + 7000;
    while (!exited && Date.now() < deadline) { steal(); await sleep(150); }
    assert.ok(exited, 'a superseded monitor should exit on its own');
    assert.ok(t.locks().includes('t1.json'), "it must leave the new owner's lock intact (not removeRecord)");
  } finally {
    if (!exited) proc.kill('SIGKILL');
  }
});

test('hook does NOT monitor the plugin\'s own pane (cwd under HERDR_PLUGIN_ROOT)', async () => {
  const t = setup();
  t.setState({
    panes: [{ pane_id: 'w1:p1', terminal_id: 't-dev', agent: 'claude', agent_status: 'idle', cwd: repo }],
    read: 'normal',
  });
  await new Promise((resolve) => {
    spawn(process.execPath, [MAIN, 'hook-agent-detected'], { env: { ...t.procEnv, HERDR_PANE_ID: 'w1:p1' }, stdio: 'ignore' }).on('exit', resolve);
  });
  await sleep(400);
  assert.equal(t.locks().length, 0, 'the plugin must not monitor its own dev pane');
});

test('hook DOES start a monitor for a normal Claude pane', async () => {
  const t = setup();
  t.setState({
    panes: [{ pane_id: 'w1:p1', terminal_id: 't-real', agent: 'claude', agent_status: 'idle', cwd: '/some/project' }],
    read: 'normal prompt',
  });
  await new Promise((resolve) => {
    spawn(process.execPath, [MAIN, 'hook-agent-detected'], { env: { ...t.procEnv, HERDR_PANE_ID: 'w1:p1' }, stdio: 'ignore' }).on('exit', resolve);
  });
  const lock = await waitFor(() => (t.locks().length === 1 ? t.locks()[0] : null));
  assert.ok(lock, 'a monitor lock should be created for a normal Claude pane');
  // clean up the detached monitor it spawned
  for (const f of t.locks()) {
    try {
      const rec = JSON.parse(readFileSync(join(t.procEnv.HERDR_PLUGIN_STATE_DIR, 'monitors', f), 'utf8'));
      process.kill(rec.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
});

// The coverage-recovery sweep: one hook fire re-attaches monitors to EVERY Claude
// pane, not just the one that changed. This is what heals a herdr restart (which
// emits no event), so a monitor that died is replaced on the next pane activity.
test('one hook fire re-establishes coverage for all Claude panes (restart sweep)', async () => {
  const t = setup();
  t.setState({
    panes: [
      { pane_id: 'w1:p1', terminal_id: 't-a', agent: 'claude', agent_status: 'working', cwd: '/proj/a' },
      { pane_id: 'w1:p2', terminal_id: 't-b', agent: 'claude', agent_status: 'idle', cwd: '/proj/b' },
    ],
    read: 'normal prompt',
  });
  // A single status-change event fires for pane a; the sweep must also cover b.
  await new Promise((resolve) => {
    spawn(process.execPath, [MAIN, 'hook-agent-detected'], { env: { ...t.procEnv, HERDR_PANE_ID: 'w1:p1' }, stdio: 'ignore' }).on('exit', resolve);
  });
  const locks = await waitFor(() => (t.locks().length === 2 ? t.locks() : null));
  assert.ok(locks, 'both panes get a monitor from one hook fire (a directly, b via the sweep)');
  for (const f of t.locks()) {
    try {
      process.kill(JSON.parse(readFileSync(join(t.procEnv.HERDR_PLUGIN_STATE_DIR, 'monitors', f), 'utf8')).pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
});

// The D19 handoff, end to end. The unit tests prove the state model; these two
// prove the wiring, which is where it would silently die: the monitor has to
// WRITE the state, and nothing else may delete it before its successor reads it.
const readLock = (t, file) => JSON.parse(readFileSync(join(t.procEnv.HERDR_PLUGIN_STATE_DIR, 'monitors', file), 'utf8'));

test('a running monitor persists its episode state into the lock record', async () => {
  const t = setup();
  t.setState({
    panes: [{ pane_id: 'w1:p1', terminal_id: 't1', agent: 'claude', agent_status: 'working', cwd: '/x/proj' }],
    read: '⏺ API Error: Connection closed mid-response. The response above may be incomplete.',
  });
  const proc = spawn(process.execPath, [MAIN, 'monitor', 't1', 'w1:p1'], { env: t.procEnv, stdio: 'ignore' });
  try {
    const rec = await waitFor(() => {
      if (!t.locks().includes('t1.json')) return null;
      const r = readLock(t, 't1.json');
      return r.state && r.state.stuckSig ? r : null;
    });
    assert.ok(rec, 'the lock record must carry state, or a replacement has nothing to inherit');
    assert.match(rec.state.stuckSig, /^[0-9a-f]{40}$/, 'the signature is hashed, not the raw output block');
    assert.equal(typeof rec.state.nudges, 'number');
  } finally {
    proc.kill('SIGTERM');
  }
});

test('status prunes records for vanished panes but keeps a stale one whose pane still exists', async () => {
  const t = setup();
  t.setState({
    panes: [{ pane_id: 'w1:p1', terminal_id: 't-live', agent: 'claude', agent_status: 'idle', cwd: '/x/proj' }],
    read: 'normal prompt',
  });
  const DEAD_PID = 2 ** 30;
  const state = { nudges: 2, lastKind: 'transient', lastStuck: false, frozenMs: 1000, stuckSig: 'a'.repeat(40) };
  const dir = join(t.procEnv.HERDR_PLUGIN_STATE_DIR, 'monitors');
  mkdirSync(dir, { recursive: true });
  for (const id of ['t-live', 't-gone']) {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      terminalId: id, paneId: 'w1:p1', agent: 'claude', pid: DEAD_PID, startedAtMs: 0, updatedAtMs: 0, state,
    }));
  }
  await new Promise((resolve) => {
    spawn(process.execPath, [MAIN, 'status'], { env: t.procEnv, stdio: 'ignore' }).on('exit', resolve);
  });
  assert.ok(t.locks().includes('t-live.json'), 'a stale record whose pane is still open holds the episode state');
  assert.deepEqual(readLock(t, 't-live.json').state, state, 'and status must not touch it');
  assert.ok(!t.locks().includes('t-gone.json'), 'a record whose pane is gone is still pruned');
});

// herdr.paneList() returns [] on ANY failure (crash, restart, timeout, bad JSON),
// so a single blip used to look identical to "the pane closed" and shut the
// monitor down - deleting the lock record and the episode state it carries. That
// is worse than the stale-record prune D19 already forbids.
test('a single failed pane list does not delete the monitor or its carried state', async () => {
  const t = setup();
  const live = {
    panes: [{ pane_id: 'w1:p1', terminal_id: 't1', agent: 'claude', agent_status: 'working', cwd: '/x/proj' }],
    read: '⏺ API Error: Connection closed mid-response. The response above may be incomplete.',
  };
  t.setState(live);
  const proc = spawn(process.execPath, [MAIN, 'monitor', 't1', 'w1:p1'], { env: t.procEnv, stdio: 'ignore' });
  try {
    const before = await waitFor(() => {
      if (!t.locks().includes('t1.json')) return null;
      const r = readLock(t, 't1.json');
      return r.state && r.state.stuckSig ? r : null;
    });
    assert.ok(before, 'monitor claimed its lock and banked episode state');

    t.setState({ panes: [], read: '' }); // herdr blips: empty list, no error
    await sleep(2500);
    t.setState(live);
    await sleep(1500);

    assert.ok(t.locks().includes('t1.json'), 'the record must survive a transient empty pane list');
    assert.equal(readLock(t, 't1.json').state.stuckSig, before.state.stuckSig, 'and keep its carried state');
  } finally {
    proc.kill('SIGTERM');
  }
});
