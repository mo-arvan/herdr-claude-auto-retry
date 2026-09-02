import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The exact CLI surface src/herdr.js relies on, run against a pane id that cannot
// exist. herdr parses arguments before resolving the pane, so an accepted command
// fails with pane_not_found and a removed flag fails with "unknown option" (how
// --custom-status shipped broken for a release: fake-herdr accepts anything).
// Skipped when herdr is not on PATH; key NAMES are not validated before lookup.

const BOGUS = 'w0000000000000:p0';
const herdr = (args) => spawnSync('herdr', args, { encoding: 'utf8', timeout: 10_000 });
let skip = 'herdr not on PATH';
try {
  if (herdr(['--version']).status === 0) skip = false;
} catch {}

function expectPaneNotFound(args) {
  const r = herdr(args);
  let code = null;
  try { code = JSON.parse(r.stderr || r.stdout).error.code; } catch {}
  assert.equal(code, 'pane_not_found', `herdr ${args.join(' ')} -> exit ${r.status}: ${(r.stderr || r.stdout).trim()}`);
}

test('pane list returns the envelope the adapter parses', { skip }, () => {
  const r = herdr(['pane', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Array.isArray(JSON.parse(r.stdout).result.panes));
});

test('the read-only commands accept the flags the adapter sends', { skip }, () => {
  expectPaneNotFound(['pane', 'get', BOGUS]);
  expectPaneNotFound(['pane', 'read', BOGUS, '--source', 'detection', '--lines', '40']);
  expectPaneNotFound(['pane', 'read', BOGUS, '--source', 'visible', '--lines', '12']);
});

test('the send and label commands accept the flags the adapter sends', { skip }, () => {
  expectPaneNotFound(['pane', 'get', BOGUS]); // guard: everything below targets BOGUS
  expectPaneNotFound(['pane', 'send-text', BOGUS, 'Continue where you left off.']);
  for (const key of ['esc', 'ctrl+u', 'enter']) expectPaneNotFound(['pane', 'send-keys', BOGUS, key]);
  expectPaneNotFound(['pane', 'report-metadata', BOGUS, '--source', 'claude-auto-retry', '--agent', 'claude', '--token', 'retry=retry engaged', '--ttl-ms', '300000']);
  expectPaneNotFound(['pane', 'report-metadata', BOGUS, '--source', 'claude-auto-retry', '--clear-token', 'retry']);
});
