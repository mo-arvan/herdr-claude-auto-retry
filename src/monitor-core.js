
import { createHash } from 'node:crypto';
import { stripAnsi, classifyLimit, findRateLimitMessage, agentErrorBlock } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';

export function createMonitorState(carried) {
  const state = {
    status: 'monitoring', waitUntil: 0, attempts: 0,
    lastRateLimitMessage: null, lastKind: null, lastStuck: false,
    nudges: 0, frozenMs: 0, stuckSig: null, lastTickAt: 0,
  };
  if (!carried || typeof carried !== 'object') return state;
  if (Number.isFinite(carried.nudges) && carried.nudges >= 0) state.nudges = Math.floor(carried.nudges);
  if (carried.lastKind === 'reset' || carried.lastKind === 'transient') state.lastKind = carried.lastKind;
  state.lastStuck = carried.lastStuck === true;
  if (Number.isFinite(carried.frozenMs) && carried.frozenMs > 0 && typeof carried.stuckSig === 'string') {
    state.frozenMs = carried.frozenMs;
    state.stuckSig = carried.stuckSig;
  }
  return state;
}

export function carriedState(state) {
  return {
    nudges: state.nudges,
    lastKind: state.lastKind,
    lastStuck: state.lastStuck,
    frozenMs: state.frozenMs,
    stuckSig: state.stuckSig,
  };
}

function clearStuck(state) {
  state.frozenMs = 0;
  state.stuckSig = null;
}

function transientBackoffMs(attempts, config) {
  const base = (config.transientWaitSeconds || 60) * 1000;
  const cap = (config.transientMaxWaitSeconds || 300) * 1000;
  return Math.min(base * 2 ** attempts, cap);
}

function stuckWorkingEligible(state, stripped, tail, config, now, watching) {
  const step = Math.max(1, config.pollIntervalSeconds || 5) * 2000;
  const elapsed = state.lastTickAt > 0 ? Math.min(Math.max(0, now - state.lastTickAt), step) : 0;
  state.lastTickAt = now;

  if (!watching || config.handleStuckWorking === false
      || classifyLimit(stripped, tail, config.customPatterns, config.customTransientPatterns) !== 'transient') {
    clearStuck(state);
    return false;
  }
  const block = agentErrorBlock(stripped);
  if (block == null) {
    clearStuck(state);
    return false;
  }
  const sig = createHash('sha1').update(block).digest('hex');
  if (state.stuckSig !== sig) {
    state.stuckSig = sig;
    state.frozenMs = 0;
  } else {
    state.frozenMs += elapsed;
  }
  return state.frozenMs >= (config.stuckWorkingMinutes || 5) * 60_000;
}

export async function processOneTick(state, adapter, config, now = Date.now()) {
  if (!adapter.exists()) return 'exit';

  if (state.status === 'waiting' && now < state.waitUntil) return 'waiting';

  const stoppedEligible = adapter.eligible();
  const blocked = !!(adapter.blocked && adapter.blocked());
  if (stoppedEligible) state.lastStuck = false;
  const text = await adapter.read();
  const stripped = text == null ? null : stripAnsi(text);
  const readable = stripped != null && stripped.trim() !== '';
  const tail = config.detectionTailLines || 0;
  const stuck = readable && !blocked && stuckWorkingEligible(state, stripped, tail, config, now, !stoppedEligible);
  const viaStuck = !stoppedEligible && stuck;
  const inStuckEpisode = !stoppedEligible && state.status === 'waiting' && state.lastStuck;
  const screenKind = readable ? classifyLimit(stripped, tail, config.customPatterns, config.customTransientPatterns) : null;
  const actionable = screenKind === 'reset' || (screenKind === 'transient' && config.handleTransient !== false && !blocked);
  const eligible = stoppedEligible || viaStuck || (state.status === 'waiting' && state.lastKind === 'reset' && screenKind === 'reset');
  const kind = eligible || inStuckEpisode ? screenKind : null;
  const limited = eligible && actionable;

  if (state.status === 'waiting') {
    if (!readable) return 'waiting';

    if (blocked && screenKind !== null) return 'waiting';
    const resumed = !actionable || (!stoppedEligible && !inStuckEpisode && screenKind !== 'reset');
    if (resumed) {
      state.status = 'monitoring';
      state.attempts = 0;
      state.nudges = 0;
      state.lastStuck = false;
      clearStuck(state);
      return 'user-continued';
    }

    if (!(await adapter.isClaude())) {
      state.waitUntil = now + config.pollIntervalSeconds * 1000 * 6;
      return 'skipped-not-claude';
    }

    if (!limited) return 'waiting';

    if (viaStuck) state.lastStuck = true;
    if (screenKind === 'transient') {
      state.nudges++;
      state.waitUntil = now + transientBackoffMs(state.nudges, config);
      clearStuck(state);
      await adapter.recover();
      return 'retried';
    }

    if (state.attempts >= config.maxRetries) {
      state.waitUntil = now + config.pollIntervalSeconds * 1000 * 12;
      return 'max-retries';
    }
    state.attempts++;
    state.waitUntil = now + 30_000;
    clearStuck(state);
    await adapter.recover();
    return 'retried';
  }

  if (limited) {
    const message = findRateLimitMessage(stripped, tail);
    state.lastRateLimitMessage = message;
    state.lastKind = kind;
    state.lastStuck = viaStuck;
    if (kind === 'transient') {
      state.waitUntil = now + (config.transientWaitSeconds || 60) * 1000;
    } else {
      const parsed = message ? parseResetTime(message) : null;
      state.waitUntil = now + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours, new Date(now));
    }
    state.status = 'waiting';
    return 'waiting';
  }

  if (readable) { state.attempts = 0; state.nudges = 0; }
  return 'monitoring';
}
