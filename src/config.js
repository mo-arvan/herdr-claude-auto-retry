import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_CONFIG = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  handleTransient: true,
  transientWaitSeconds: 60,
  transientMaxWaitSeconds: 300,
  handleStuckWorking: true,
  stuckWorkingMinutes: 5,
  retryMessage: 'Continue where you left off.',
  customPatterns: [],
  customTransientPatterns: [],
  readSource: 'detection',
  readLines: 40,
  detectionTailLines: 15,
  dismissMenu: true,
  menuDismissDelayMs: 300,
  submitDelayMs: 400,
  eligibleStates: ['idle', 'blocked', 'done'],
  engagedLabel: 'retry engaged',
};

const SELECTABLE_STATES = ['idle', 'blocked', 'done', 'unknown'];

function configPath() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR || join(homedir(), '.config', 'herdr');
  return join(dir, 'claude-auto-retry.json');
}

function validNumber(val, min, fallback) {
  return typeof val === 'number' && Number.isFinite(val) && val >= min ? val : fallback;
}

function validPatternArray(arr, fallback) {
  if (!Array.isArray(arr)) return fallback;
  return arr.filter((p) => {
    if (typeof p !== 'string') return false;
    try { new RegExp(p); return true; } catch { return false; }
  });
}

function validate(cfg) {
  cfg.maxRetries = validNumber(cfg.maxRetries, 1, DEFAULT_CONFIG.maxRetries);
  cfg.pollIntervalSeconds = validNumber(cfg.pollIntervalSeconds, 1, DEFAULT_CONFIG.pollIntervalSeconds);
  cfg.marginSeconds = validNumber(cfg.marginSeconds, 0, DEFAULT_CONFIG.marginSeconds);
  cfg.fallbackWaitHours = validNumber(cfg.fallbackWaitHours, 0.1, DEFAULT_CONFIG.fallbackWaitHours);
  cfg.transientWaitSeconds = validNumber(cfg.transientWaitSeconds, 1, DEFAULT_CONFIG.transientWaitSeconds);
  cfg.transientMaxWaitSeconds = Math.max(
    cfg.transientWaitSeconds,
    validNumber(cfg.transientMaxWaitSeconds, 1, DEFAULT_CONFIG.transientMaxWaitSeconds),
  );
  if (typeof cfg.handleTransient !== 'boolean') cfg.handleTransient = DEFAULT_CONFIG.handleTransient;
  if (typeof cfg.handleStuckWorking !== 'boolean') cfg.handleStuckWorking = DEFAULT_CONFIG.handleStuckWorking;
  cfg.stuckWorkingMinutes = validNumber(cfg.stuckWorkingMinutes, 1, DEFAULT_CONFIG.stuckWorkingMinutes);
  cfg.readLines = validNumber(cfg.readLines, 5, DEFAULT_CONFIG.readLines);
  cfg.detectionTailLines = validNumber(cfg.detectionTailLines, 1, DEFAULT_CONFIG.detectionTailLines);
  cfg.menuDismissDelayMs = validNumber(cfg.menuDismissDelayMs, 0, DEFAULT_CONFIG.menuDismissDelayMs);
  cfg.submitDelayMs = validNumber(cfg.submitDelayMs, 0, DEFAULT_CONFIG.submitDelayMs);

  if (typeof cfg.retryMessage !== 'string' || !cfg.retryMessage) {
    cfg.retryMessage = DEFAULT_CONFIG.retryMessage;
  }
  if (typeof cfg.engagedLabel !== 'string' || !cfg.engagedLabel.trim()) {
    cfg.engagedLabel = DEFAULT_CONFIG.engagedLabel;
  }
  if (cfg.readSource !== 'recent' && cfg.readSource !== 'recent-unwrapped' && cfg.readSource !== 'visible' && cfg.readSource !== 'detection') {
    cfg.readSource = DEFAULT_CONFIG.readSource;
  }
  if (typeof cfg.dismissMenu !== 'boolean') cfg.dismissMenu = DEFAULT_CONFIG.dismissMenu;

  if (!Array.isArray(cfg.eligibleStates)) {
    cfg.eligibleStates = [...DEFAULT_CONFIG.eligibleStates];
  } else {
    cfg.eligibleStates = cfg.eligibleStates.filter((s) => SELECTABLE_STATES.includes(s));
    if (cfg.eligibleStates.length === 0) cfg.eligibleStates = [...DEFAULT_CONFIG.eligibleStates];
  }

  cfg.customPatterns = validPatternArray(cfg.customPatterns, DEFAULT_CONFIG.customPatterns);
  cfg.customTransientPatterns = validPatternArray(cfg.customTransientPatterns, DEFAULT_CONFIG.customTransientPatterns);
  return cfg;
}

export function loadConfig(path = configPath()) {
  try {
    const raw = readFileSync(path, 'utf-8');
    return validate({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
