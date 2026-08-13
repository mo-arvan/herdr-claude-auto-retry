// Log file naming. Run in a fixed zone in a child process, because TZ is read
// once at startup and the bug only shows up west of UTC after ~18:00 local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function nameAt(iso, tz) {
  const src = join(repo, 'src', 'logger.js');
  return execFileSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(src)}).then((m) => process.stdout.write(m.logFileName(new Date(${JSON.stringify(iso)}))))`],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
  );
}

test('log files are named by local date, so an evening entry stays in that day', () => {
  // 21:30 on the 4th in Chicago is already the 5th in UTC. The entry is stamped
  // 21:30, so it belongs in the 4th's file.
  assert.equal(nameAt('2026-08-05T02:30:00Z', 'America/Chicago'), '2026-08-04.log');
  assert.equal(nameAt('2026-08-04T12:00:00Z', 'America/Chicago'), '2026-08-04.log');
  // East of UTC the same argument runs the other way, early morning.
  assert.equal(nameAt('2026-08-04T22:30:00Z', 'Asia/Tokyo'), '2026-08-05.log');
});
