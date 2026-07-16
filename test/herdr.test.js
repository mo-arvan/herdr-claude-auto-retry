import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope, isClaudeAgent } from '../src/herdr.js';

test('parseEnvelope unwraps a pane get response from stdout', () => {
  const stdout = JSON.stringify({ id: 'x', result: { pane: { pane_id: '1-1', agent: 'claude', terminal_id: 't1' } } });
  const env = parseEnvelope({ stdout, stderr: '' });
  assert.equal(env.result.pane.pane_id, '1-1');
});

test('parseEnvelope reads the last JSON line when output has noise', () => {
  const stdout = 'warning: something\n' + JSON.stringify({ result: { panes: [] } });
  const env = parseEnvelope({ stdout, stderr: '' });
  assert.deepEqual(env.result.panes, []);
});

test('parseEnvelope falls back to stderr for error envelopes', () => {
  const stderr = JSON.stringify({ id: 'x', error: { code: 'pane_not_found', message: 'pane not found' } });
  const env = parseEnvelope({ stdout: '', stderr });
  assert.equal(env.error.code, 'pane_not_found');
});

test('parseEnvelope returns null on non-JSON', () => {
  assert.equal(parseEnvelope({ stdout: 'not json', stderr: '' }), null);
});

test('isClaudeAgent matches claude / claude-code, not others', () => {
  assert.ok(isClaudeAgent({ agent: 'claude' }));
  assert.ok(isClaudeAgent({ agent: 'claude-code' }));
  assert.ok(!isClaudeAgent({ agent: 'codex' }));
  assert.ok(!isClaudeAgent({ agent: null }));
  assert.ok(!isClaudeAgent(null));
});
