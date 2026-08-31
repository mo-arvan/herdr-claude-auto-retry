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
  assert.equal(claimSlot({ terminalId: t, pid: DEAD_PID, startedAtMs: Date.now(), updatedAtMs: Date.now() }), false);
  assert.equal(readRecord(t).pid, process.pid);
  removeRecord(t);
});

test('claimSlot reclaims a stale lock left by a dead monitor', () => {
  const t = 'term_stale';
  assert.equal(claimSlot({ terminalId: t, pid: DEAD_PID, startedAtMs: Date.now(), updatedAtMs: Date.now() }), true);
  assert.equal(hasActiveMonitor(t), false); // dead pid -> not active
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

// If the spawn pre-check pruned a stale record instead of just reading it, a replacement monitor would find nothing to carry (D19).
test('a stale record survives the spawn pre-check so its state can be carried', () => {
  const t = 'term_carry';
  const state = { attempts: 2, frozenMs: 123_000, stuckSig: 'deadbeef', lastKind: 'transient', lastStuck: true };
  // A LIVE owner past STALE_MS: staleness makes it reclaimable, not deadness.
  const stale = Date.now() - 600_000;
  claimSlot({ terminalId: t, pid: process.pid, startedAtMs: stale, updatedAtMs: stale, state });
  assert.equal(readRecord(t).updatedAtMs, stale, 'the seeded record really is stale');
  assert.equal(hasActiveMonitor(t), false);
  assert.deepEqual(readRecord(t).state, state, 'pre-check must not prune the record');
  claimSlot({ terminalId: t, pid: process.pid, startedAtMs: Date.now(), updatedAtMs: Date.now(), state });
  assert.deepEqual(readRecord(t).state, state);
  removeRecord(t);
});

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

test('touchRecord refuses to write when this process no longer owns the lock', () => {
  const t = 'term_owner';
  claimSlot({ terminalId: t, pid: process.pid, startedAtMs: Date.now(), updatedAtMs: Date.now(), state: { attempts: 7 } });
  touchRecord(t, { state: { attempts: 1 } }, DEAD_PID);
  assert.equal(readRecord(t).state.attempts, 7, "a non-owner must not roll back the owner's state");
  touchRecord(t, { state: { attempts: 9 } });
  assert.equal(readRecord(t).state.attempts, 9, 'the owner still writes');
  removeRecord(t);
});
