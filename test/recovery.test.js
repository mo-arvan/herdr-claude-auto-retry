import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recover, readInputLine, classifyTypedInput } from '../src/recovery.js';
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

// Escape is the one keystroke that can destroy work (interrupts a turn, cancels a prompt); it exists only for the /rate-limit-options menu, so it's gated on blocked (D22).
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

test('recovery defaults to no Escape when the caller says nothing', async () => {
  const h = mockHerdr();
  await recover(h, '1-2', CFG);
  assert.equal(h.calls[0][0], 'send-text');
});

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

// D30: Escape is also a vim-mode switch, so on a blocked recovery it can eat the message's first character ('C' -> change-to-eol; 17 of 20 resumes in one live week).
// The typed message is echoed into the â¯ line before Enter, so recovery reads it back and retypes once if the first character is missing.

function mockHerdrWithReads(screens) {
  const h = mockHerdr();
  const queue = [...screens];
  h.reads = 0;
  h.paneRead = async () => {
    h.reads++;
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return h;
}

const MSG = 'Continue where you left off.';
const VCFG = { ...DEFAULT_CONFIG, menuDismissDelayMs: 0, submitDelayMs: 0, retryMessage: MSG };

function screenWith(inputText) {
  return [
    '⏺ Working on it.',
    '─────────────────────────────',
    `❯ ${inputText}`,
    '─────────────────────────────',
    '  repo | Opus 5',
    '  -- INSERT -- ⏵⏵ bypass permissions on',
  ].join('\n');
}

test('readInputLine reads the echoed message out of the prompt line', () => {
  assert.equal(readInputLine(screenWith(MSG)), MSG);
  assert.equal(readInputLine(screenWith('ontinue where you left off.')), 'ontinue where you left off.');
  assert.equal(readInputLine(screenWith('')), '');
});

test('readInputLine strips ANSI and joins a wrapped message, stopping at the box border', () => {
  const screen = ['\x1b[2m─────\x1b[0m', '\x1b[1m❯\x1b[0m Continue where you', '  left off.', '─────', '  repo | Opus 5'].join('\n');
  assert.equal(readInputLine(screen), MSG);
});

test('readInputLine returns null when the screen has no prompt line', () => {
  assert.equal(readInputLine('⏺ no input box here\n─────'), null);
  assert.equal(readInputLine(''), null);
  assert.equal(readInputLine(null), null);
});

test('classifyTypedInput separates an intact echo from a first-character-eaten one', () => {
  assert.equal(classifyTypedInput(screenWith(MSG), MSG), 'intact');
  assert.equal(classifyTypedInput(screenWith('ontinue where you left off.'), MSG), 'eaten');
  assert.equal(classifyTypedInput(screenWith('some other text'), MSG), 'unknown');
  assert.equal(classifyTypedInput(null, MSG), 'unknown');
});

test('classifyTypedInput ignores an intact copy of the message above the prompt line', () => {
  const screen = ['⏺ Continue where you left off.', '─────', '❯ ontinue where you left off.', '─────'].join('\n');
  assert.equal(classifyTypedInput(screen, MSG), 'eaten');
});

test('recovery clears and retypes when the prompt line lost the first character', async () => {
  const h = mockHerdrWithReads([screenWith('ontinue where you left off.'), screenWith(MSG)]);
  const logs = [];
  await recover(h, '1-2', VCFG, { blocked: true, log: (m) => logs.push(m) });
  assert.deepEqual(h.calls, [
    ['send-keys', '1-2', 'esc'],
    ['send-text', '1-2', MSG],
    ['send-keys', '1-2', 'ctrl+u'],
    ['send-text', '1-2', MSG],
    ['send-keys', '1-2', 'enter'],
  ]);
  assert.match(logs[0], /repaired/);
});

test('recovery types once when the prompt line already holds the whole message', async () => {
  const h = mockHerdrWithReads([screenWith(MSG)]);
  await recover(h, '1-2', VCFG, { blocked: true });
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 1);
  assert.ok(!h.calls.some((c) => c.includes('ctrl+u')));
  assert.equal(h.reads, 1);
});

test('recovery does not retype when the screen cannot be read', async () => {
  for (const screen of [null, '', 'no prompt line at all']) {
    const h = mockHerdrWithReads([screen]);
    await recover(h, '1-2', VCFG, { blocked: true });
    assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 1);
    assert.ok(!h.calls.some((c) => c.includes('ctrl+u')));
  }
});

test('recovery still submits when the repair did not take', async () => {
  const h = mockHerdrWithReads([screenWith('ontinue where you left off.')]);
  const logs = [];
  await recover(h, '1-2', VCFG, { blocked: true, log: (m) => logs.push(m) });
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 2);
  assert.deepEqual(h.calls.at(-1), ['send-keys', '1-2', 'enter']);
  assert.match(logs[0], /still not verified/);
});

test('verifyInput=false never reads the pane', async () => {
  const h = mockHerdrWithReads([screenWith('ontinue where you left off.')]);
  await recover(h, '1-2', { ...VCFG, verifyInput: false }, { blocked: true });
  assert.equal(h.reads, 0);
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 1);
});

test('an adapter without paneRead falls back to typing once', async () => {
  const h = mockHerdr();
  await recover(h, '1-2', VCFG, { blocked: true });
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 1);
});

// PR review hardening: 'eaten' is exact-match on the live â¯ line only (a draft ending in the tail is 'unknown'), verify only runs after an Escape, and a transcript '> text' echo is not an input line.
test('a draft that happens to end with the message tail is unknown, never eaten', () => {
  assert.equal(classifyTypedInput(screenWith('please investigate the 529 ontinue where you left off.'), MSG), 'unknown');
});

test('a transcript "> text" echo is not an input line', () => {
  assert.equal(readInputLine('⏺ hi\n> ontinue where you left off.'), null);
  assert.equal(classifyTypedInput('⏺ hi\n> ontinue where you left off.', MSG), 'unknown');
});

test('the non-Escape path never reads the pane and never repairs', async () => {
  const h = mockHerdrWithReads([screenWith('ontinue where you left off.')]);
  await recover(h, '1-2', VCFG, { blocked: false });
  assert.equal(h.reads, 0);
  assert.ok(!h.calls.some((c) => c.includes('esc')));
  assert.ok(!h.calls.some((c) => c.includes('ctrl+u')));
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 1);
});
