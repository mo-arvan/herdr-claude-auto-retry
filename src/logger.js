import { appendFileSync, mkdirSync, readdirSync, unlinkSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from './paths.js';

const MAX_AGE_DAYS = 7;
const CLEANUP_INTERVAL_MS = 3_600_000;
let lastCleanup = 0;

function timeOnly() {
  return new Date().toTimeString().slice(0, 8);
}

export function logFileName(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}.log`;
}

function todayFile(dir) {
  return join(dir, logFileName());
}

function cleanup(dir) {
  if (Date.now() - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = Date.now();
  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.log')) continue;
      const s = statSync(join(dir, file));
      if (s.mtimeMs < cutoff) unlinkSync(join(dir, file));
    }
  } catch {
  }
}

export function createLogger(dir = logsDir(), { tag = '' } = {}) {
  let dirCreated = false;
  function log(level, message) {
    try {
      if (!dirCreated) {
        mkdirSync(dir, { recursive: true });
        dirCreated = true;
      }
      const handle = typeof tag === 'function' ? tag() : tag;
      const lvl = level === 'INFO' ? '' : `${level} `;
      const tagged = handle ? `${handle}  ` : '';
      appendFileSync(todayFile(dir), `[${timeOnly()}] ${lvl}${tagged}${message}\n`);
      cleanup(dir);
    } catch {
    }
  }
  return {
    info: (msg) => log('INFO', msg),
    warn: (msg) => log('WARN', msg),
    error: (msg) => log('ERROR', msg),
  };
}

export function tailLog(maxLines = 50, dir = logsDir()) {
  try {
    return readFileSync(todayFile(dir), 'utf-8').split('\n').slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}
