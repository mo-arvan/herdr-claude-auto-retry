
import { stripAnsi } from './patterns.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROMPT_LINE = /^\s*❯\s?/u;
const BOX_CHARS = /[─━│┃╭╮╰╯┌┐└┘┄┈]/gu;
const VERIFY_READ_LINES = 12;

function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

export function readInputLine(screen) {
  if (typeof screen !== 'string' || !screen.trim()) return null;
  const lines = stripAnsi(screen).split('\n');
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_LINE.test(lines[i])) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return null;
  const parts = [lines[idx].replace(PROMPT_LINE, '')];
  for (let i = idx + 1; i < lines.length; i++) {
    if (PROMPT_LINE.test(lines[i])) break;
    const rest = lines[i].replace(BOX_CHARS, '').trim();
    if (!rest) break;
    parts.push(rest);
  }
  return collapse(parts.join(' '));
}

export function classifyTypedInput(screen, message) {
  const line = readInputLine(screen);
  if (line === null) return 'unknown';
  const typed = collapse(message);
  if (typed && line.includes(typed)) return 'intact';
  const withoutFirst = collapse(String(message).slice(1));
  if (withoutFirst && line === withoutFirst) return 'eaten';
  return 'unknown';
}

async function inspectInput(herdr, paneId, config) {
  if (typeof herdr.paneRead !== 'function') return 'unknown';
  const screen = await herdr.paneRead(paneId, { source: 'visible', lines: VERIFY_READ_LINES, timeoutMs: 1500 });
  return classifyTypedInput(screen, config.retryMessage);
}

export async function recover(herdr, paneId, config, { blocked = false, log = null } = {}) {
  const escaped = !!(config.dismissMenu && blocked);
  if (escaped) {
    await herdr.sendKeys(paneId, 'esc');
    await delay(config.menuDismissDelayMs);
  }
  await herdr.sendText(paneId, config.retryMessage);
  await delay(config.submitDelayMs);

  if (escaped && config.verifyInput) {
    if ((await inspectInput(herdr, paneId, config)) === 'eaten') {
      await herdr.sendKeys(paneId, 'ctrl+u');
      await delay(config.menuDismissDelayMs);
      await herdr.sendText(paneId, config.retryMessage);
      await delay(config.submitDelayMs);
      const after = await inspectInput(herdr, paneId, config);
      log?.(after === 'intact' ? 'input repaired (vim normal mode ate the first character)' : `input still not verified (${after}); submitting as typed`);
    }
  }

  await herdr.sendKeys(paneId, 'enter');
}
