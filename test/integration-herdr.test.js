// Integration test for the herdr.js adapter + recovery against a fake herdr
// binary. Validates the actual argv the plugin sends and the JSON envelope
// parsing, end to end, without a running herdr server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fixtures', 'fake-herdr.js');

function setup(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'car-int-'));
  const statePath = join(dir, 'state.json');
  const sendsPath = join(dir, 'sends.log');
  writeFileSync(statePath, JSON.stringify(scenario));
  writeFileSync(sendsPath, '');
  // The adapter resolves HERDR_BIN_PATH per call, so set it before invoking.
  // fake-herdr.js is executable with a node shebang.
  process.env.HERDR_BIN_PATH = FAKE;
  process.env.FAKE_HERDR_STATE = statePath;
  process.env.FAKE_HERDR_SENDS = sendsPath;
  return { sendsPath };
}

function reads(sendsPath) {
  return readFileSync(sendsPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const CLAUDE_PANE = { pane_id: '1-1', terminal_id: 't-abc', agent: 'claude', agent_status: 'blocked' };

test('adapter lists, gets, and reads panes through the real CLI argv path', async () => {
  setup({ panes: [CLAUDE_PANE], read: "You've hit your session limit · resets 3pm (UTC)" });
  const { createHerdr, isClaudeAgent } = await import(`../src/herdr.js?lst=${Date.now()}`);
  const h = createHerdr();

  const claudePanes = await h.listClaudePanes();
  assert.equal(claudePanes.length, 1);
  assert.ok(isClaudeAgent(claudePanes[0]));

  const pane = await h.paneGet('1-1');
  assert.equal(pane.terminal_id, 't-abc');

  const byTerm = await h.findByTerminalId('t-abc');
  assert.equal(byTerm.pane_id, '1-1');

  const text = await h.paneRead('1-1', { source: 'recent', lines: 25 });
  assert.match(text, /session limit/);

  const missing = await h.paneGet('9-9');
  assert.equal(missing, null);
});

test('recovery emits esc, send-text, enter as separate CLI calls (#7/#19)', async () => {
  const { sendsPath } = setup({ panes: [CLAUDE_PANE], read: '' });
  const { createHerdr } = await import(`../src/herdr.js?rec=${Date.now()}`);
  const { recover } = await import(`../src/recovery.js?rec=${Date.now()}`);
  const h = createHerdr();
  await recover(h, '1-1', { dismissMenu: true, menuDismissDelayMs: 0, submitDelayMs: 0, retryMessage: 'continue please' });

  assert.deepEqual(reads(sendsPath), [
    ['send-keys', '1-1', 'esc'],
    ['send-text', '1-1', 'continue please'],
    ['send-keys', '1-1', 'enter'],
  ]);
});
