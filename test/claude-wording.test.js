import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';

// Claude Code ships its UI strings inside its binary, so the wording the detectors
// anchor on can be checked against the installed build without waiting for a real
// limit. Each anchor below is a fragment src/patterns.js relies on; one vanishing
// means Claude changed its wording and the fixtures are stale. Skipped when the
// `claude` binary is not on PATH.

const ANCHORS = [
  'hit your', 'session limit', 'weekly limit', 'usage limit', 'limit reached',
  'resets ', 'try again in', 'rate-limit-options', 'Upgrade your plan',
  'temporarily limiting requests', 'Overloaded',
];

let binary = null;
try {
  const which = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
  const real = which && realpathSync(which);
  if (real && statSync(real).isFile() && statSync(real).size > 1_000_000) binary = real;
} catch {}
const skip = binary ? false : 'claude binary not on PATH';

test('every wording anchor the detectors rely on is still in the installed Claude Code', { skip }, () => {
  const found = spawnSync('grep', ['-a', '-o', '-F', '-f', '/dev/stdin', binary], { input: ANCHORS.join('\n'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const present = new Set(found.stdout.split('\n'));
  const missing = ANCHORS.filter((a) => !present.has(a));
  assert.deepEqual(missing, [], `wording no longer found in ${binary}`);
});
