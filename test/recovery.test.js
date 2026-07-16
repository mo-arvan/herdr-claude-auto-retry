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

// Issue #19: dismiss the menu first so Enter never confirms "Upgrade your plan".
// Issue #7: text and Enter are SEPARATE calls, so Enter is not swallowed as a newline.
test('recovery dismisses menu, types text, then submits with a separate Enter', async () => {
  const h = mockHerdr();
  const config = { ...DEFAULT_CONFIG, menuDismissDelayMs: 0, submitDelayMs: 0, retryMessage: 'go on' };
  await recover(h, '1-2', config);
  assert.deepEqual(h.calls, [
    ['send-keys', '1-2', 'esc'],
    ['send-text', '1-2', 'go on'],
    ['send-keys', '1-2', 'enter'],
  ]);
});

test('text and Enter are never combined into one request', async () => {
  const h = mockHerdr();
  const config = { ...DEFAULT_CONFIG, menuDismissDelayMs: 0, submitDelayMs: 0 };
  await recover(h, '1-2', config);
  const combined = h.calls.find((c) => c[0] === 'send-text' && c.includes('enter'));
  assert.equal(combined, undefined);
});

test('dismissMenu=false skips the Escape', async () => {
  const h = mockHerdr();
  const config = { ...DEFAULT_CONFIG, dismissMenu: false, menuDismissDelayMs: 0, submitDelayMs: 0 };
  await recover(h, '1-2', config);
  assert.equal(h.calls[0][0], 'send-text');
  assert.ok(!h.calls.some((c) => c.includes('esc')));
});
