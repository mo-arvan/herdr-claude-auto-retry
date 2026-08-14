import { stripAnsi } from './patterns.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROMPT_LINE = /^\s*[❯>]\s?/u;
const BOX_CHARS = /[─━│┃╭╮╰╯┌┐└┘┄┈]/gu;
const VERIFY_READ_LINES = 12;

function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

// The text we type is echoed into Claude's `❯` input line before we submit it, so the
// screen tells us what actually arrived. Returns the input line's contents, or null
// when the screen has no prompt line to read (D20).
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
  // A long message wraps onto the following lines; the input box border ends it.
  for (let i = idx + 1; i < lines.length; i++) {
    if (PROMPT_LINE.test(lines[i])) break;
    const rest = lines[i].replace(BOX_CHARS, '').trim();
    if (!rest) break;
    parts.push(rest);
  }
  return collapse(parts.join(' '));
}

// `intact` / `eaten` are positive readings; everything else is `unknown` and gets no
// repair, so an unreadable screen can never turn into a second round of typing.
export function classifyTypedInput(screen, message) {
  const line = readInputLine(screen);
  if (line === null) return 'unknown';
  const typed = collapse(message);
  if (typed && line.includes(typed)) return 'intact';
  const withoutFirst = collapse(message.slice(1));
  if (withoutFirst && line.includes(withoutFirst)) return 'eaten';
  return 'unknown';
}

async function inspectInput(herdr, paneId, config) {
  if (typeof herdr.paneRead !== 'function') return 'unknown';
  const screen = await herdr.paneRead(paneId, { source: 'visible', lines: VERIFY_READ_LINES });
  return classifyTypedInput(screen, config.retryMessage);
}

export async function recover(herdr, paneId, config, log = null) {
  if (config.dismissMenu) {
    await herdr.sendKeys(paneId, 'esc');
    await delay(config.menuDismissDelayMs);
  }
  await herdr.sendText(paneId, config.retryMessage);
  await delay(config.submitDelayMs);

  if (config.verifyInput) {
    if ((await inspectInput(herdr, paneId, config)) === 'eaten') {
      // Claude Code's vim editor mode turns our menu-dismissing Escape into a mode
      // switch, and the first character of the message is then run as a vim command
      // instead of typed: the default "Continue..." arrives as "ontinue..." because
      // `C` is change-to-end-of-line. That command leaves the line in INSERT, so
      // clearing it and retyping lands the message intact (D20).
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
