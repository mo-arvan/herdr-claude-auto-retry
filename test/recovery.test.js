import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recover } from '../src/recovery.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function mockHerdr() {
  const calls = [];
  return {
    calls,
    sendText: async (pane, text) => calls.push(['send-text', pane, text]),
    sendKeys: async (pane, ...keys) => calls.push(['send-keys', pane, ...keys]),
  };
}

const CFG = { ...DEFAULT_CONFIG, menuDismissDelayMs: 0, submitDelayMs: 0, retryMessage: 'go on' };

// Escape is the only keystroke here that can destroy work: on a live turn it
// interrupts, at a permission prompt it cancels. It exists for one thing, the
// /rate-limit-options menu, and a menu means the pane is blocked (D22).
test('a blocked pane gets Escape first, so Enter cannot confirm a menu option', async () => {
  const h = mockHerdr();
  await recover(h, '1-2', CFG, { blocked: true });
  assert.deepEqual(h.calls, [
    ['send-keys', '1-2', 'esc'],
    ['send-text', '1-2', 'go on'],
    ['send-keys', '1-2', 'enter'],
  ]);
});

test('a pane that is not blocked is never sent Escape', async () => {
  const h = mockHerdr();
  await recover(h, '1-2', CFG, { blocked: false });
  assert.deepEqual(h.calls, [
    ['send-text', '1-2', 'go on'],
    ['send-keys', '1-2', 'enter'],
  ]);
});

// Every limit observed in production so far renders as an idle output line, not
// a menu, so this is the common path.
test('recovery defaults to no Escape when the caller says nothing', async () => {
  const h = mockHerdr();
  await recover(h, '1-2', CFG);
  assert.equal(h.calls[0][0], 'send-text');
});

// Issue #7: text and Enter are SEPARATE calls, so Enter is not swallowed as a newline.
test('text and Enter are never combined into one request', async () => {
  const h = mockHerdr();
  await recover(h, '1-2', CFG, { blocked: true });
  const combined = h.calls.find((c) => c[0] === 'send-text' && c.includes('enter'));
  assert.equal(combined, undefined);
});

test('dismissMenu=false skips the Escape even on a blocked pane', async () => {
  const h = mockHerdr();
  await recover(h, '1-2', { ...CFG, dismissMenu: false }, { blocked: true });
  assert.equal(h.calls[0][0], 'send-text');
  assert.ok(!h.calls.some((c) => c.includes('esc')));
});
