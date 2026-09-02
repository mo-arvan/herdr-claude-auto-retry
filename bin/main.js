#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createLogger, tailLog } from '../src/logger.js';
import { createHerdr, isClaudeAgent } from '../src/herdr.js';
import { createMonitorState, carriedState, processOneTick } from '../src/monitor-core.js';
import { recover } from '../src/recovery.js';
import { stateDir } from '../src/paths.js';
import {
  claimSlot, touchRecord, removeRecord, readRecord, listRecords, isFresh, hasActiveMonitor, lockHeldByOther,
} from '../src/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, 'main.js');
const MAX_CONSECUTIVE_ERRORS = 10;
const ENGAGED_TTL_MS = 300_000;
const SWEEP_INTERVAL_MS = 60_000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function sweepDue() {
  const f = join(stateDir(), 'last-sweep');
  try {
    if (Date.now() - Number(readFileSync(f, 'utf8')) < SWEEP_INTERVAL_MS) return false;
  } catch {}
  try { writeFileSync(f, String(Date.now())); } catch {}
  return true;
}

function spawnMonitor(pane) {
  const root = process.env.HERDR_PLUGIN_ROOT;
  if (root && pane.cwd && (pane.cwd === root || pane.cwd.startsWith(`${root}/`))) return 'ignored-self';
  if (hasActiveMonitor(pane.terminal_id)) return 'already-running';
  const child = spawn(process.execPath, [MAIN, 'monitor', pane.terminal_id, pane.pane_id], {
    detached: true,
    stdio: 'ignore',
    cwd: process.env.HERDR_PLUGIN_ROOT || dirname(HERE),
    env: process.env,
  });
  child.unref();
  return 'spawned';
}

const age = (ms) => humanDur(Date.now() - ms);

function paneHandle(pane) {
  const suffix = String(pane.pane_id).split(':').pop() || pane.pane_id;
  const base = pane.cwd ? pane.cwd.replace(/\/+$/, '').split('/').pop() : '';
  return base ? `${base}/${suffix}` : suffix;
}

function humanDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function paneIdFromEnv() {
  if (process.env.HERDR_PANE_ID) return process.env.HERDR_PANE_ID;
  try {
    const ev = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || '{}');
    const scan = (o) => {
      if (!o || typeof o !== 'object') return null;
      if (typeof o.pane_id === 'string') return o.pane_id;
      for (const v of Object.values(o)) {
        const found = scan(v);
        if (found) return found;
      }
      return null;
    };
    return scan(ev);
  } catch {
    return null;
  }
}

async function hookAgentDetected() {
  const paneId = paneIdFromEnv();
  if (!paneId) return;
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
    const agent = ctx.focused_pane_agent ?? ctx.agent;
    if (typeof agent === 'string' && agent && !/claude/i.test(agent)) return;
  } catch {}
  const herdr = createHerdr();
  const pane = await herdr.paneGet(paneId);
  if (!pane || !isClaudeAgent(pane)) return;
  if (spawnMonitor(pane) === 'spawned') {
    createLogger().info(`${paneHandle(pane)}  detected; starting monitor`);
  }
  if (sweepDue()) {
    for (const p of await herdr.listClaudePanes()) spawnMonitor(p);
  }
}

async function watchAll() {
  const herdr = createHerdr();
  const panes = await herdr.listClaudePanes();
  let spawned = 0;
  for (const pane of panes) {
    if (spawnMonitor(pane) === 'spawned') spawned++;
  }
  process.stdout.write(`Claude panes found: ${panes.length}. Monitors starting: ${spawned} (others already running or skipped).\n`);
}

async function arm() {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    process.stderr.write('arm: no focused pane (HERDR_PANE_ID unset).\n');
    process.exit(1);
  }
  const herdr = createHerdr();
  const pane = await herdr.paneGet(paneId);
  if (!pane) {
    process.stderr.write(`arm: pane ${paneId} not found.\n`);
    process.exit(1);
  }
  if (!isClaudeAgent(pane)) {
    process.stdout.write(`arm: pane ${paneId} is not a Claude Code agent (agent: ${pane.agent || 'none'}); not armed.\n`);
    return;
  }
  const outcome = spawnMonitor(pane);
  if (outcome === 'spawned') {
    createLogger().info(`${paneHandle(pane)}  armed; starting monitor`);
  }
  const msg = {
    spawned: `Armed auto-retry monitor on pane ${pane.pane_id}.`,
    'already-running': `Pane ${pane.pane_id} is already being monitored.`,
    'ignored-self': `Pane ${pane.pane_id} is the plugin's own pane; not monitored.`,
  };
  process.stdout.write(`${msg[outcome] || msg.spawned}\n`);
}

async function status() {
  const herdr = createHerdr();
  const panes = await herdr.paneList();
  const byTerminal = new Map(panes.map((p) => [p.terminal_id, p]));
  const records = listRecords();
  const active = records.filter(isFresh);
  if (panes.length > 0) {
    for (const r of records) {
      if (!isFresh(r) && !byTerminal.has(r.terminalId)) removeRecord(r.terminalId);
    }
  }

  if (active.length === 0) {
    process.stdout.write('No active auto-retry monitors.\n');
  } else {
    process.stdout.write(`Active auto-retry monitors (${active.length}):\n`);
    for (const r of active) {
      const pane = byTerminal.get(r.terminalId);
      const where = pane ? `pane ${pane.pane_id} [${pane.agent_status}]` : 'pane gone';
      process.stdout.write(`  - ${where}  agent=${r.agent}  pid=${r.pid}  up=${age(r.startedAtMs)}  seen=${age(r.updatedAtMs)} ago\n`);
    }
  }
  const log = tailLog(15);
  if (log.trim()) {
    process.stdout.write('\nRecent activity:\n');
    process.stdout.write(log.trimEnd() + '\n');
  }
}

function stop() {
  const records = listRecords();
  let stopped = 0;
  for (const r of records) {
    if (isFresh(r)) {
      try {
        process.kill(r.pid, 'SIGTERM');
        stopped++;
      } catch {
      }
    }
    removeRecord(r.terminalId);
  }
  if (stopped) createLogger().info(`stop: stopped ${stopped} monitor(s)`);
  process.stdout.write(`Stopped ${stopped} monitor(s).\n`);
}

function logs() {
  const out = tailLog(80);
  process.stdout.write(out.trim() ? out.trimEnd() + '\n' : 'No log entries yet today.\n');
}

async function monitor() {
  const terminalId = process.argv[3];
  const initialPaneId = process.argv[4] || '';
  if (!terminalId) {
    process.stderr.write('usage: main.js monitor <terminalId> [paneId]\n');
    process.exit(2);
  }

  let config = loadConfig();
  let handle = initialPaneId ? String(initialPaneId).split(':').pop() : terminalId.replace(/^term_/, '').slice(-6);
  const logger = createLogger(undefined, { tag: () => handle });

  const prior = readRecord(terminalId);
  const state = createMonitorState(prior && prior.state);

  const claimed = claimSlot({
    terminalId, paneId: initialPaneId, agent: 'claude',
    pid: process.pid, startedAtMs: Date.now(), updatedAtMs: Date.now(),
    state: carriedState(state),
  });
  if (!claimed) {
    logger.info('already monitored by another process; exiting');
    process.exit(0);
  }

  const herdr = createHerdr();
  let consecutiveErrors = 0;
  let stopped = false;
  let engaged = false;
  let labelWarned = false;
  let currentPaneId = initialPaneId;
  let inTick = null;
  let lastResult = null;

  const shutdown = async (reason) => {
    if (stopped) return;
    stopped = true;
    if (inTick) await Promise.race([inTick.catch(() => {}), delay(6000)]);
    const stillOurs = !lockHeldByOther(terminalId, process.pid);
    if (stillOurs) {
      if (engaged && currentPaneId) await herdr.reportMetadata(currentPaneId, { clear: true });
      removeRecord(terminalId);
    }
    logger.info(`stopped (${reason})`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info(`started (pid ${process.pid})`);
  if (state.frozenMs || state.attempts) {
    const frozen = state.frozenMs ? `, error unchanged for ${humanDur(state.frozenMs)} of watched time` : '';
    logger.info(`carried state from a prior monitor (attempt ${state.attempts}${frozen})`);
  }

  async function resolvePane() {
    if (currentPaneId) {
      const p = await herdr.paneGet(currentPaneId);
      if (p && p.terminal_id === terminalId) return p;
    }
    const p = await herdr.findByTerminalId(terminalId);
    if (p) currentPaneId = p.pane_id;
    return p;
  }

  const tick = async () => {
    if (!stopped && lockHeldByOther(terminalId, process.pid)) {
      logger.info('superseded by another monitor; exiting');
      process.exit(0);
    }
    config = loadConfig();

    let pane;
    try {
      pane = await resolvePane();
    } catch (err) {
      consecutiveErrors++;
      logger.error(`pane resolve failed: ${err.message}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) await shutdown('too many errors');
      return;
    }
    if (!pane) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) await shutdown('pane gone');
      return;
    }
    touchRecord(terminalId, { paneId: pane.pane_id, agent: pane.agent || 'claude', state: carriedState(state) });
    handle = paneHandle(pane);

    const adapter = {
      exists: () => true,
      eligible: () => config.eligibleStates.includes(pane.agent_status),
      blocked: () => pane.agent_status === 'blocked',
      isClaude: async () => isClaudeAgent(pane),
      read: async () => herdr.paneRead(pane.pane_id, { source: config.readSource, lines: config.readLines }),
      recover: async () => recover(herdr, pane.pane_id, config, { blocked: pane.agent_status === 'blocked' || state.lastKind === 'reset', log: (msg) => logger.info(msg) }),
    };

    try {
      const result = await processOneTick(state, adapter, config);
      consecutiveErrors = 0;

      if (result === 'exit') {
        await shutdown('pane gone');
        return;
      }
      const isTransient = state.lastKind === 'transient';
      if (result === 'waiting' && state.lastRateLimitMessage) {
        const label = isTransient ? 'server error' : 'rate limit';
        const verb = isTransient ? 'retry in' : 'waiting';
        const stuck = state.lastStuck ? ' [stuck; herdr reported working]' : '';
        logger.info(`${label}${stuck}: "${state.lastRateLimitMessage.slice(0, 120)}" -> ${verb} ${humanDur(state.waitUntil - Date.now())}`);
        state.lastRateLimitMessage = null;
      }
      if (result === 'retried') {
        const next = humanDur(state.waitUntil - Date.now());
        logger.info(isTransient ? `nudged (attempt ${state.nudges}); next retry in ${next}` : `resumed (attempt ${state.attempts})`);
      }
      if (result === 'user-continued') logger.info(isTransient ? 'server error cleared; monitoring' : 'limit cleared; monitoring');
      if (result === 'max-retries' && lastResult !== 'max-retries') logger.warn(`max retries (${config.maxRetries}) reached; cooling down`);
      if (result === 'skipped-not-claude') logger.warn('pane no longer a Claude agent; skipping send');
      lastResult = result;

      const nowEngaged = state.status === 'waiting' && (config.eligibleStates.includes(pane.agent_status) || state.lastStuck);
      let labelRes = null;
      if (nowEngaged) {
        labelRes = await herdr.reportMetadata(pane.pane_id, { customStatus: config.engagedLabel, agent: pane.agent, ttlMs: ENGAGED_TTL_MS });
      } else if (engaged) {
        labelRes = await herdr.reportMetadata(pane.pane_id, { clear: true });
      }
      if (labelRes && labelRes.code !== 0 && !labelWarned) {
        labelWarned = true;
        logger.warn(`label report failed (exit ${labelRes.code}); retries are unaffected`);
      }
      engaged = nowEngaged;
    } catch (err) {
      consecutiveErrors++;
      logger.error(`tick error: ${err.message}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) await shutdown('too many errors');
    }
  };

  const loop = () => {
    if (stopped) return;
    setTimeout(async () => {
      if (stopped) return;
      inTick = tick();
      await inTick;
      inTick = null;
      loop();
    }, config.pollIntervalSeconds * 1000);
  };
  inTick = tick();
  await inTick;
  inTick = null;
  loop();
}

const HANDLERS = {
  'hook-agent-detected': { fn: hookAgentDetected, neverFail: true },
  'watch-all': { fn: watchAll },
  arm: { fn: arm },
  status: { fn: status },
  stop: { fn: stop },
  logs: { fn: logs },
  monitor: { fn: monitor },
};

const sub = process.argv[2];
const handler = HANDLERS[sub];
if (!handler) {
  process.stderr.write(`claude-auto-retry: unknown subcommand "${sub || ''}"\n`);
  process.exit(2);
}
Promise.resolve()
  .then(() => handler.fn())
  .catch((err) => {
    process.stderr.write(`${sub} error: ${err && (err.stack || err.message) ? err.stack || err.message : err}\n`);
    process.exit(handler.neverFail ? 0 : 1);
  });
