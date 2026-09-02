
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { monitorsDir } from './paths.js';

const STALE_MS = 60_000;

function sanitize(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function lockPath(terminalId) {
  return join(monitorsDir(), `${sanitize(terminalId)}.json`);
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function isFresh(rec) {
  return !!rec && isAlive(rec.pid) && Date.now() - (rec.updatedAtMs || 0) < STALE_MS;
}

export function readRecord(terminalId) {
  try {
    return JSON.parse(readFileSync(lockPath(terminalId), 'utf-8'));
  } catch {
    return null;
  }
}

export function claimSlot(rec) {
  mkdirSync(monitorsDir(), { recursive: true });
  const path = lockPath(rec.terminalId);
  const body = JSON.stringify({ ...rec, updatedAtMs: rec.updatedAtMs ?? Date.now() }, null, 2);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const existing = readRecord(rec.terminalId);
      if (isFresh(existing) && existing.pid !== rec.pid) return false;
      removeRecord(rec.terminalId);
    }
  }
  return false;
}

export function touchRecord(terminalId, patch = {}, ownerPid = process.pid) {
  const rec = readRecord(terminalId);
  if (!rec || rec.pid !== ownerPid) return;
  mkdirSync(monitorsDir(), { recursive: true });
  writeFileSync(lockPath(terminalId), JSON.stringify({ ...rec, ...patch, updatedAtMs: Date.now() }, null, 2));
}

export function removeRecord(terminalId) {
  try {
    unlinkSync(lockPath(terminalId));
  } catch {
  }
}

export function listRecords() {
  let files;
  try {
    files = readdirSync(monitorsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(monitorsDir(), file), 'utf-8')));
    } catch {
    }
  }
  return out;
}

export function lockHeldByOther(terminalId, myPid) {
  const rec = readRecord(terminalId);
  return !!(rec && rec.pid !== myPid && isAlive(rec.pid));
}

export function hasActiveMonitor(terminalId) {
  return isFresh(readRecord(terminalId));
}
