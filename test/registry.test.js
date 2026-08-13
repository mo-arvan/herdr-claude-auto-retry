// Atomic lock claim (the fix for the TOCTOU double-monitor race) and staleness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// registry resolves the state dir from this env per call.
process.env.HERDR_PLUGIN_STATE_DIR = mkdtempSync(join(tmpdir(), 'car-reg-'));
const { claimSlot, readRecord, removeRecord, touchRecord, hasActiveMonitor, lockHeldByOther } = await import('../src/registry.js');

const DEAD_PID = 2 ** 30; // far above any real pid; process.kill -> ESRCH

test('claimSlot is exclusive while a live owner holds the lock', () => {
  const t = 'term_excl';
  assert.equal(claimSlot({ terminalId: t, pid: process.pid, startedAtMs: Date.now(), updatedAtMs: Date.now() }), true);
  // a competing claim loses because the existing owner (this process) is alive + fresh
  assert.equal(claimSlot({ terminalId: t, pid: DEAD_PID, startedAtMs: Date.now(), updatedAtMs: Date.now() }), false);
  assert.equal(readRecord(t).pid, process.pid);
  removeRecord(t);
});

test('claimSlot reclaims a stale lock left by a dead monitor', () => {
  const t = 'term_stale';
  // seed a lock owned by a dead pid
  assert.equal(claimSlot({ terminalId: t, pid: DEAD_PID, startedAtMs: Date.now(), updatedAtMs: Date.now() }), true);
  assert.equal(hasActiveMonitor(t), false); // dead pid -> not active
  // a real monitor can now take over
  assert.equal(claimSlot({ terminalId: t, pid: process.pid, startedAtMs: Date.now(), updatedAtMs: Date.now() }), true);
  assert.equal(readRecord(t).pid, process.pid);
  removeRecord(t);
});

test('hasActiveMonitor treats a lock not refreshed within the window as stale', () => {
  const t = 'term_old';
  claimSlot({ terminalId: t, pid: process.pid, startedAtMs: Date.now() - 600_000, updatedAtMs: Date.now() - 600_000 });
  assert.equal(hasActiveMonitor(t), false); // alive pid but updatedAt is 10 min old
  removeRecord(t);
});

// The sweep asks hasActiveMonitor before spawning. If that check pruned the stale
// record, the replacement monitor would find nothing to carry, and the whole
// state handoff would be dead on the exact path it exists for (D19).
test('a stale record survives the spawn pre-check so its state can be carried', () => {
  const t = 'term_carry';
  const state = { attempts: 2, frozenMs: 123_000, stuckSig: 'deadbeef', lastKind: 'transient', lastStuck: true };
  // A LIVE owner whose record is past STALE_MS, so staleness is what makes this
  // reclaimable - not a dead pid, which would pass even if the prune came back.
  const stale = Date.now() - 600_000;
  claimSlot({ terminalId: t, pid: process.pid, startedAtMs: stale, updatedAtMs: stale, state });
  assert.equal(readRecord(t).updatedAtMs, stale, 'the seeded record really is stale');
  assert.equal(hasActiveMonitor(t), false);
  assert.deepEqual(readRecord(t).state, state, 'pre-check must not prune the record');
  // ...and the successor's claim writes its own state over it.
  claimSlot({ terminalId: t, pid: process.pid, startedAtMs: Date.now(), updatedAtMs: Date.now(), state });
  assert.deepEqual(readRecord(t).state, state);
  removeRecord(t);
});

// The superseded-monitor guard: after a sleep/wake reclaim, a monitor must see
// that a different live process now owns its lock, so it can exit instead of
// lingering as a lockless zombie that double-sends.
test('lockHeldByOther detects a different live owner, ignores self and dead owners', () => {
  const t = 'term_super';
  // owned by us: not "held by other"
  claimSlot({ terminalId: t, pid: process.pid, startedAtMs: Date.now(), updatedAtMs: Date.now() });
  assert.equal(lockHeldByOther(t, process.pid), false);
  // a hypothetical other monitor on this box would see our live pid as the owner
  assert.equal(lockHeldByOther(t, DEAD_PID), true);
  // a dead owner is not a live competitor (the reclaim path handles it)
  removeRecord(t);
  claimSlot({ terminalId: t, pid: DEAD_PID, startedAtMs: Date.now(), updatedAtMs: Date.now() });
  assert.equal(lockHeldByOther(t, process.pid), false);
  removeRecord(t);
  // no lock at all: nobody else holds it
  assert.equal(lockHeldByOther('term_absent', process.pid), false);
});

// D19: a monitor that lost its lock mid-tick must not write its stale episode
// state over the winner's record.
test('touchRecord refuses to write when this process no longer owns the lock', () => {
  const t = 'term_owner';
  claimSlot({ terminalId: t, pid: process.pid, startedAtMs: Date.now(), updatedAtMs: Date.now(), state: { attempts: 7 } });
  touchRecord(t, { state: { attempts: 1 } }, DEAD_PID);
  assert.equal(readRecord(t).state.attempts, 7, "a non-owner must not roll back the owner's state");
  touchRecord(t, { state: { attempts: 9 } });
  assert.equal(readRecord(t).state.attempts, 9, 'the owner still writes');
  removeRecord(t);
});
