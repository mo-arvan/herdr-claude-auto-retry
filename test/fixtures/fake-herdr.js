#!/usr/bin/env node
// Stand-in for the herdr CLI. Serves the JSON scenario file (FAKE_HERDR_STATE) and logs
// every send-* / report-metadata argv to FAKE_HERDR_SENDS. With `read` a string it is a
// canned screen. With `screen` it is a small Claude Code TUI model that reacts to sends:
// text lands on the input line (vim NORMAL mode eats the first character and enters
// INSERT, as the real editor does), Escape enters NORMAL in vim mode and dismisses a
// menu, ctrl+u clears the line in INSERT, Enter submits into `screen.submitted`.

import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const statePath = process.env.FAKE_HERDR_STATE;
const sendsPath = process.env.FAKE_HERDR_SENDS;

function load() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { panes: [], read: '' };
  }
}

function save(s) {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(s));
  renameSync(`${statePath}.tmp`, statePath);
}

function ok(result) {
  process.stdout.write(JSON.stringify({ id: 'fake', result }) + '\n');
  process.exit(0);
}

function err(code, message) {
  process.stderr.write(JSON.stringify({ id: 'fake', error: { code, message } }) + '\n');
  process.exit(1);
}

function recordSend(kind, rest) {
  if (sendsPath) appendFileSync(sendsPath, JSON.stringify([kind, ...rest]) + '\n');
}

function render(sc) {
  const lines = [...sc.transcript, ''];
  if (sc.status === 'working') lines.push('✻ Cooking… (3s · ↓ 1.2k tokens)', '');
  lines.push('─'.repeat(40), `❯ ${sc.input || ''}`.trimEnd(), '─'.repeat(40), '  Opus 5 (1M context)  |  ctx 12%');
  if (sc.vim && sc.mode === 'insert') lines.push('  -- INSERT --');
  return lines.join('\n');
}

const [group, cmd, ...rest] = argv;
const s = load();
const sc = s.screen;
const panes = (s.panes || []).map((p) => (sc ? { ...p, agent_status: sc.status } : p));

if (group === 'pane' && cmd === 'list') ok({ panes });
if (group === 'pane' && cmd === 'get') {
  const pane = panes.find((p) => p.pane_id === rest[0]);
  if (!pane) err('pane_not_found', 'pane not found');
  ok({ pane });
}
if (group === 'pane' && cmd === 'read') {
  if (!sc) {
    process.stdout.write(s.read || '');
    process.exit(0);
  }
  const n = Number(rest[rest.indexOf('--lines') + 1]) || 40;
  process.stdout.write(render(sc).split('\n').slice(-n).join('\n'));
  process.exit(0);
}
if (group === 'pane' && cmd === 'send-text') {
  recordSend('send-text', rest);
  if (sc) {
    let text = rest[1] || '';
    if (sc.vim && sc.mode === 'normal') {
      text = text.slice(1);
      sc.mode = 'insert';
    }
    sc.input = (sc.input || '') + text;
    save(s);
  }
  process.exit(0);
}
if (group === 'pane' && cmd === 'send-keys') {
  recordSend('send-keys', rest);
  if (sc) {
    for (const key of rest.slice(1)) {
      if (key === 'esc') {
        if (sc.vim) sc.mode = 'normal';
        if (sc.status === 'blocked') sc.status = 'idle';
      } else if (key === 'ctrl+u') {
        if (!sc.vim || sc.mode === 'insert') sc.input = '';
      } else if (key === 'enter' && sc.input) {
        sc.submitted = [...(sc.submitted || []), sc.input];
        sc.input = '';
        sc.status = 'working';
      }
    }
    save(s);
  }
  process.exit(0);
}
if (group === 'pane' && cmd === 'report-metadata') {
  recordSend('report-metadata', rest);
  process.exit(0);
}

err('unknown', `unhandled: ${argv.join(' ')}`);
