import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';

function withConfig(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'car-cfg-'));
  const path = join(dir, 'claude-auto-retry.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

test('missing config file returns defaults', () => {
  const cfg = loadConfig(join(tmpdir(), 'definitely-missing-car.json'));
  assert.deepEqual(cfg, { ...DEFAULT_CONFIG });
});

test('valid overrides are applied', () => {
  const cfg = loadConfig(withConfig({ maxRetries: 9, retryMessage: 'resume please', dismissMenu: false }));
  assert.equal(cfg.maxRetries, 9);
  assert.equal(cfg.retryMessage, 'resume please');
  assert.equal(cfg.dismissMenu, false);
});

test('invalid values fall back to safe defaults', () => {
  const cfg = loadConfig(withConfig({ maxRetries: -3, pollIntervalSeconds: 0, retryMessage: '', readSource: 'bogus' }));
  assert.equal(cfg.maxRetries, DEFAULT_CONFIG.maxRetries);
  assert.equal(cfg.pollIntervalSeconds, DEFAULT_CONFIG.pollIntervalSeconds);
  assert.equal(cfg.retryMessage, DEFAULT_CONFIG.retryMessage);
  assert.equal(cfg.readSource, DEFAULT_CONFIG.readSource);
});

test('non-string / invalid-regex custom patterns are dropped', () => {
  const cfg = loadConfig(withConfig({ customPatterns: ['ok pattern', 42, '(unclosed'], customTransientPatterns: ['ok too', '(bad'] }));
  assert.deepEqual(cfg.customPatterns, ['ok pattern']);
  assert.deepEqual(cfg.customTransientPatterns, ['ok too']);
});

test('eligibleStates defaults to the stopped states', () => {
  const cfg = loadConfig(join(tmpdir(), 'missing-car.json'));
  assert.deepEqual(cfg.eligibleStates, ['idle', 'blocked', 'done']);
});

test('eligibleStates can be narrowed but never includes working', () => {
  const cfg = loadConfig(withConfig({ eligibleStates: ['idle', 'working', 'bogus'] }));
  assert.deepEqual(cfg.eligibleStates, ['idle']); // working + junk stripped
});

test('an all-invalid eligibleStates falls back to the default', () => {
  const cfg = loadConfig(withConfig({ eligibleStates: ['working', 'nope'] }));
  assert.deepEqual(cfg.eligibleStates, ['idle', 'blocked', 'done']);
});

test('transient handling config validates', () => {
  const def = loadConfig(join(tmpdir(), 'missing-tr.json'));
  assert.equal(def.transientWaitSeconds, 60);
  assert.equal(def.handleTransient, true);
  assert.equal(loadConfig(withConfig({ transientWaitSeconds: 0 })).transientWaitSeconds, 60); // min 1
  assert.equal(loadConfig(withConfig({ handleTransient: false })).handleTransient, false);
  assert.equal(loadConfig(withConfig({ handleTransient: 'nope' })).handleTransient, true);
  assert.equal(def.transientMaxWaitSeconds, 300);
  assert.equal(loadConfig(withConfig({ transientMaxWaitSeconds: 600 })).transientMaxWaitSeconds, 600);
  // The backoff cap can never be below the base wait.
  assert.equal(loadConfig(withConfig({ transientWaitSeconds: 90, transientMaxWaitSeconds: 30 })).transientMaxWaitSeconds, 90);
  assert.equal(def.handleStuckWorking, true);
  assert.equal(def.stuckWorkingMinutes, 5);
  assert.equal(loadConfig(withConfig({ handleStuckWorking: false })).handleStuckWorking, false);
  assert.equal(loadConfig(withConfig({ stuckWorkingMinutes: 10 })).stuckWorkingMinutes, 10);
  assert.equal(loadConfig(withConfig({ stuckWorkingMinutes: 0 })).stuckWorkingMinutes, 5); // min 1
});

test('engagedLabel defaults, overrides, and falls back when blank', () => {
  assert.equal(loadConfig(join(tmpdir(), 'missing-label.json')).engagedLabel, 'retry engaged');
  assert.equal(loadConfig(withConfig({ engagedLabel: 'auto-retry' })).engagedLabel, 'auto-retry');
  assert.equal(loadConfig(withConfig({ engagedLabel: '   ' })).engagedLabel, 'retry engaged');
});
