
import {
  stripAnsi, classifyLimit, findRateLimitMessage, limitInLatestBlock, outputFingerprint,
} from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';

export function createMonitorState() {
  return {
    status: 'monitoring',
    waitUntil: 0,
    attempts: 0,
    lastRateLimitMessage: null,
    lastKind: null,
    limitFingerprint: null,
    standDownReason: null,
  };
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
  const kindRaw = stripped != null ? classifyLimit(stripped, tail, config.customPatterns, config.customTransientPatterns) : null;
  // A rate limit is real news even while herdr still reports the pane as
  // working. After the limit error Claude Code keeps a spinner up as it drains queued
  // teammate messages, which used to hide the limit for minutes (observed: 6.5). An
  // ineligible pane only counts when the limit is the latest thing printed, and only
  // for reset-style limits — a transient error on a busy pane is Claude's own retry to
  // make, not ours.
  const kind = eligible || (kindRaw === 'reset' && limitInLatestBlock(stripped, tail, config.customPatterns))
    ? kindRaw
    : null;
  const limited = kind === 'reset' || (kind === 'transient' && config.handleTransient !== false);

  if (state.status === 'waiting') {
    if (stripped == null || stripped.trim() === '') return 'waiting';

    // The banner going away is NOT evidence that the session resumed. It
    // scrolls out of the detection tail on its own, and treating that as "the user
    // continued" silently skipped the one send this plugin exists for — with a log line
    // identical to a genuine manual resume. Stand down only on positive evidence: the
    // pane is busy again, or its latest output block changed since the limit was seen.
    // Otherwise resume, banner or no banner.
    const resumed = !eligible
      || (state.limitFingerprint != null && outputFingerprint(stripped, tail) !== state.limitFingerprint);
    if (!limited && resumed) {
      state.status = 'monitoring';
      state.attempts = 0;
      state.limitFingerprint = null;
      state.standDownReason = eligible ? 'new output' : 'pane busy';
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
    // Baseline for the stand-down check above.
    state.limitFingerprint = outputFingerprint(stripped, tail);
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
