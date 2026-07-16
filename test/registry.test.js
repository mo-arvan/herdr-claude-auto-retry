// Atomic lock claim (the fix for the TOCTOU double-monitor race) and staleness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// registry resolves the state dir from this env per call.
process.env.HERDR_PLUGIN_STATE_DIR = mkdtempSync(join(tmpdir(), 'car-reg-'));
const { claimSlot, readRecord, removeRecord, hasActiveMonitor, lockHeldByOther } = await import('../src/registry.js');

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
  assert.equal(hasActiveMonitor(t), false); // dead pid -> not active (and pruned)
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
