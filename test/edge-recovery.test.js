import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recover, readInputLine, classifyTypedInput } from '../src/recovery.js';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';

// Helper shapes copied from test/recovery.test.js, not imported.
function mockHerdr() {
  const calls = [];
  return {
    calls,
    sendText: async (pane, text) => calls.push(['send-text', pane, text]),
    sendKeys: async (pane, ...keys) => calls.push(['send-keys', pane, ...keys]),
  };
}

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

const MSG = DEFAULT_CONFIG.retryMessage;
const VCFG = { ...DEFAULT_CONFIG, menuDismissDelayMs: 0, submitDelayMs: 0, retryMessage: MSG };
const CFG = { ...DEFAULT_CONFIG, menuDismissDelayMs: 0, submitDelayMs: 0, retryMessage: 'go on' };

// ---- readInputLine ----

test('readInputLine trims trailing spaces after the echoed text', () => {
  const screen = ['❯ hello world   ', '─────'].join('\n');
  assert.equal(readInputLine(screen), 'hello world');
});

test('readInputLine returns empty string for a bare marker with no text', () => {
  assert.equal(readInputLine('❯'), '');
  assert.equal(readInputLine('❯ '), '');
});

test('readInputLine joins a message wrapped across two lines with extra indentation', () => {
  const screen = ['❯ Continue where you', '    left off.', '─────'].join('\n');
  assert.equal(readInputLine(screen), 'Continue where you left off.');
});

test('readInputLine joins a message wrapped across three lines with varying indentation', () => {
  const screen = ['❯ Please continue', '  where you left', '      off today.', '─────'].join('\n');
  assert.equal(readInputLine(screen), 'Please continue where you left off today.');
});

test('a wrapped continuation line that itself starts with a box character still contributes its text', () => {
  const screen = ['❯ Continue where you', '│ left off.', '─────'].join('\n');
  assert.equal(readInputLine(screen), 'Continue where you left off.');
});

test('readInputLine strips combined bold and colour ANSI codes around the marker', () => {
  const screen = ['\x1b[1m\x1b[36m❯\x1b[0m hello', '─────'].join('\n');
  assert.equal(readInputLine(screen), 'hello');
});

test('only the bottom-most prompt line counts when an earlier one also has text', () => {
  const screen = ['❯ stale earlier text', 'some output', '❯', '─────'].join('\n');
  assert.equal(readInputLine(screen), '');
});

test('readInputLine handles Windows CRLF line endings', () => {
  const screen = ['❯ hello world', '─────'].join('\r\n');
  assert.equal(readInputLine(screen), 'hello world');
});

test('readInputLine returns null for a screen with only status lines', () => {
  const screen = ['  repo | Opus 5', '  -- INSERT -- bypass permissions on', '─────'].join('\n');
  assert.equal(readInputLine(screen), null);
});

// ---- classifyTypedInput ----

test('classifyTypedInput treats regex metacharacters as literal text', () => {
  const msg = 'a.b*c(d)+e?';
  const screen = ['❯ ' + msg, '─────'].join('\n');
  assert.equal(classifyTypedInput(screen, msg), 'intact');
});

test('classifyTypedInput handles unicode emoji and CJK text', () => {
  const msg = '继续 🚀 干活';
  const intact = ['❯ ' + msg, '─────'].join('\n');
  assert.equal(classifyTypedInput(intact, msg), 'intact');
  const eaten = ['❯ ' + msg.slice(1), '─────'].join('\n');
  assert.equal(classifyTypedInput(eaten, msg), 'eaten');
});

test('classifyTypedInput collapses leading and trailing whitespace inside the message', () => {
  const msg = '   hello world   ';
  const screen = ['❯ hello world', '─────'].join('\n');
  assert.equal(classifyTypedInput(screen, msg), 'intact');
});

test('classifyTypedInput never reports eaten for a 1-character message', () => {
  const msg = 'x';
  const screen = ['❯', '─────'].join('\n');
  assert.equal(classifyTypedInput(screen, msg), 'unknown');
});

test('classifyTypedInput detects eaten for a 2-character message', () => {
  const msg = 'ab';
  const screen = ['❯ b', '─────'].join('\n');
  assert.equal(classifyTypedInput(screen, msg), 'eaten');
});

test('classifyTypedInput reports intact when the message appears doubled on the line', () => {
  const msg = 'hi';
  const screen = ['❯ hihi', '─────'].join('\n');
  assert.equal(classifyTypedInput(screen, msg), 'intact');
});

test('classifyTypedInput does not call it eaten when only the last character is missing', () => {
  const msg = 'hello';
  const screen = ['❯ hell', '─────'].join('\n');
  assert.equal(classifyTypedInput(screen, msg), 'unknown');
});

test('classifyTypedInput is case-sensitive', () => {
  const msg = 'Hello';
  const screen = ['❯ hello', '─────'].join('\n');
  assert.equal(classifyTypedInput(screen, msg), 'unknown');
});

test('classifyTypedInput returns unknown for any non-string screen', () => {
  assert.equal(classifyTypedInput(undefined, 'go'), 'unknown');
  assert.equal(classifyTypedInput(42, 'go'), 'unknown');
  assert.equal(classifyTypedInput({ foo: 'bar' }, 'go'), 'unknown');
});

// ---- recover() sequencing ----

test('recover repairs and logs exactly one line when eaten is followed by intact', async () => {
  const h = mockHerdrWithReads([screenWith('ontinue where you left off.'), screenWith(MSG)]);
  const logs = [];
  await recover(h, '1-2', VCFG, { blocked: true, log: (m) => logs.push(m) });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /repaired/);
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 2);
});

test('recover submits anyway and logs not-verified when eaten persists after repair', async () => {
  const h = mockHerdrWithReads([screenWith('ontinue where you left off.')]);
  const logs = [];
  await recover(h, '1-2', VCFG, { blocked: true, log: (m) => logs.push(m) });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /still not verified/);
  assert.deepEqual(h.calls.at(-1), ['send-keys', '1-2', 'enter']);
});

test('recover logs the actual classification when eaten is followed by unknown', async () => {
  const h = mockHerdrWithReads([screenWith('ontinue where you left off.'), screenWith('totally different text')]);
  const logs = [];
  await recover(h, '1-2', VCFG, { blocked: true, log: (m) => logs.push(m) });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /still not verified \(unknown\)/);
});

test('recover never repairs when the first read is already intact', async () => {
  const h = mockHerdrWithReads([screenWith(MSG)]);
  const logs = [];
  await recover(h, '1-2', VCFG, { blocked: true, log: (m) => logs.push(m) });
  assert.equal(logs.length, 0);
  assert.equal(h.reads, 1);
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 1);
  assert.ok(!h.calls.some((c) => c.includes('ctrl+u')));
});

test(
  'paneRead throwing must not crash recovery; it should degrade to a blind send',
  async () => {
    const h = mockHerdr();
    h.paneRead = async () => {
      throw new Error('read failed');
    };
    await recover(h, '1-2', VCFG, { blocked: true });
    assert.deepEqual(h.calls.at(-1), ['send-keys', '1-2', 'enter']);
  },
);

test('recover treats a null paneRead result as unverifiable, not eaten', async () => {
  const h = mockHerdrWithReads([null]);
  await recover(h, '1-2', VCFG, { blocked: true });
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 1);
  assert.ok(!h.calls.some((c) => c.includes('ctrl+u')));
});

test('recover treats an empty-string paneRead result as unverifiable, not eaten', async () => {
  const h = mockHerdrWithReads(['']);
  await recover(h, '1-2', VCFG, { blocked: true });
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 1);
  assert.ok(!h.calls.some((c) => c.includes('ctrl+u')));
});

test('dismissMenu=false on a blocked pane skips both Escape and verification', async () => {
  const h = mockHerdrWithReads([screenWith('ontinue where you left off.')]);
  await recover(h, '1-2', { ...VCFG, dismissMenu: false }, { blocked: true });
  assert.equal(h.reads, 0);
  assert.ok(!h.calls.some((c) => c.includes('esc')));
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 1);
});

test('verifyInput=false skips verification even when Escape was sent', async () => {
  const h = mockHerdrWithReads([screenWith('ontinue where you left off.')]);
  await recover(h, '1-2', { ...VCFG, verifyInput: false }, { blocked: true });
  assert.equal(h.reads, 0);
  assert.equal(h.calls.filter((c) => c[0] === 'send-text').length, 1);
  assert.deepEqual(h.calls[0], ['send-keys', '1-2', 'esc']);
});

test('a retryMessage starting with a vim-normal-mode letter gets no special handling', async () => {
  const msg = 'delete the branch';
  const cfg = { ...VCFG, retryMessage: msg };
  const h = mockHerdrWithReads([screenWith('elete the branch'), screenWith(msg)]);
  const logs = [];
  await recover(h, '1-2', cfg, { blocked: true, log: (m) => logs.push(m) });
  assert.deepEqual(h.calls, [
    ['send-keys', '1-2', 'esc'],
    ['send-text', '1-2', msg],
    ['send-keys', '1-2', 'ctrl+u'],
    ['send-text', '1-2', msg],
    ['send-keys', '1-2', 'enter'],
  ]);
  assert.match(logs[0], /repaired/);
});

test('log callback fires exactly once per repair attempt, never zero or twice', async () => {
  const scenarios = [
    [screenWith('ontinue where you left off.'), screenWith(MSG)],
    [screenWith('ontinue where you left off.')],
  ];
  for (const screens of scenarios) {
    const h = mockHerdrWithReads(screens);
    const logs = [];
    await recover(h, '1-2', VCFG, { blocked: true, log: (m) => logs.push(m) });
    assert.equal(logs.length, 1);
  }
});

test('recover awaits the configured delays between each keystroke', async () => {
  const h = mockHerdr();
  const cfg = { ...CFG, menuDismissDelayMs: 15, submitDelayMs: 15 };
  const start = Date.now();
  await recover(h, '1-2', cfg, { blocked: true });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 25, `expected recover to await its delays, elapsed=${elapsed}ms`);
  assert.deepEqual(h.calls, [
    ['send-keys', '1-2', 'esc'],
    ['send-text', '1-2', 'go on'],
    ['send-keys', '1-2', 'enter'],
  ]);
});

// ---- loadConfig ----

function withConfigFile(obj, fn) {
  const path = join(tmpdir(), `edge-recovery-cfg-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(obj));
  try {
    return fn(path);
  } finally {
    unlinkSync(path);
  }
}

test('loadConfig falls back to the default retryMessage when it is only whitespace', () => {
  withConfigFile({ retryMessage: '   ' }, (path) => {
    const cfg = loadConfig(path);
    assert.equal(cfg.retryMessage, DEFAULT_CONFIG.retryMessage);
  });
});

test('loadConfig falls back to the default retryMessage when it is not a string', () => {
  withConfigFile({ retryMessage: 12345 }, (path) => {
    const cfg = loadConfig(path);
    assert.equal(cfg.retryMessage, DEFAULT_CONFIG.retryMessage);
  });
});

test('loadConfig preserves an extremely long retryMessage', () => {
  const long = 'x'.repeat(20000);
  withConfigFile({ retryMessage: long }, (path) => {
    const cfg = loadConfig(path);
    assert.equal(cfg.retryMessage, long);
    assert.equal(cfg.retryMessage.length, 20000);
  });
});

test('loadConfig falls back to the default verifyInput when given the string "true"', () => {
  withConfigFile({ verifyInput: 'true' }, (path) => {
    const cfg = loadConfig(path);
    assert.equal(cfg.verifyInput, DEFAULT_CONFIG.verifyInput);
    assert.equal(typeof cfg.verifyInput, 'boolean');
  });
});
