
import { stripAnsi, classifyLimit, findRateLimitMessage } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';

export function createMonitorState() {
  return { status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null, lastKind: null };
}

function transientBackoffMs(attempts, config) {
  const base = (config.transientWaitSeconds || 60) * 1000;
  const cap = (config.transientMaxWaitSeconds || 300) * 1000;
  return Math.min(base * 2 ** attempts, cap);
}

export async function processOneTick(state, adapter, config, now = Date.now()) {
  if (!adapter.exists()) return 'exit';

  if (state.status === 'waiting' && now < state.waitUntil) return 'waiting';

  const eligible = adapter.eligible();
  const text = await adapter.read();
  const stripped = text == null ? null : stripAnsi(text);
  const tail = config.detectionTailLines || 0;
  const kind = eligible && stripped != null ? classifyLimit(stripped, tail, config.customPatterns, config.customTransientPatterns) : null;
  const limited = kind === 'reset' || (kind === 'transient' && config.handleTransient !== false);

  if (state.status === 'waiting') {
    if (stripped == null || stripped.trim() === '') return 'waiting';

    if (!limited) {
      state.status = 'monitoring';
      state.attempts = 0;
      return 'user-continued';
    }

    if (!(await adapter.isClaude())) {
      state.waitUntil = now + config.pollIntervalSeconds * 1000 * 6;
      return 'skipped-not-claude';
    }

    if (kind === 'transient') {
      state.attempts++;
      state.waitUntil = now + transientBackoffMs(state.attempts, config);
      await adapter.recover();
      return 'retried';
    }

    if (state.attempts >= config.maxRetries) {
      state.waitUntil = now + config.pollIntervalSeconds * 1000 * 12;
      return 'max-retries';
    }
    state.attempts++;
    state.waitUntil = now + 30_000;
    await adapter.recover();
    return 'retried';
  }

  if (limited) {
    const message = findRateLimitMessage(stripped, tail);
    state.lastRateLimitMessage = message;
    state.lastKind = kind;
    if (kind === 'transient') {
      state.waitUntil = now + (config.transientWaitSeconds || 60) * 1000;
    } else {
      const parsed = message ? parseResetTime(message) : null;
      state.waitUntil = now + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours, new Date(now));
    }
    state.status = 'waiting';
    return 'waiting';
  }

  return 'monitoring';
}
