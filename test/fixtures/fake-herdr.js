#!/usr/bin/env node
// A stand-in for the herdr CLI used by integration tests. It serves canned
// responses from a JSON scenario file (FAKE_HERDR_STATE) and appends every
// send-text / send-keys invocation to a log file (FAKE_HERDR_SENDS), so a test
// can assert the exact argv the adapter produced.
//
// Supported: `pane list`, `pane get <id>`, `pane read <id> ...`,
// `pane send-text <id> <text>`, `pane send-keys <id> <key...>`.

import { readFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const statePath = process.env.FAKE_HERDR_STATE;
const sendsPath = process.env.FAKE_HERDR_SENDS;

function state() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { panes: [], read: '' };
  }
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

const [group, cmd, ...rest] = argv;
const s = state();

if (group === 'pane' && cmd === 'list') ok({ panes: s.panes });
if (group === 'pane' && cmd === 'get') {
  const pane = (s.panes || []).find((p) => p.pane_id === rest[0]);
  if (!pane) err('pane_not_found', 'pane not found');
  ok({ pane });
}
if (group === 'pane' && cmd === 'read') {
  process.stdout.write(s.read || '');
  process.exit(0);
}
if (group === 'pane' && cmd === 'send-text') {
  recordSend('send-text', rest);
  process.exit(0);
}
if (group === 'pane' && cmd === 'send-keys') {
  recordSend('send-keys', rest);
  process.exit(0);
}
if (group === 'pane' && cmd === 'report-metadata') {
  recordSend('report-metadata', rest);
  process.exit(0);
}

err('unknown', `unhandled: ${argv.join(' ')}`);
