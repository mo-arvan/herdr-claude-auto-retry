// Ship-readiness checks: pushing main IS the release (no gate after), so these duplicated facts are asserted here because they have drifted before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERIC, localPatterns, scan, trackedFiles } from '../scripts/scan-private.mjs';
import { createMonitorState } from '../src/monitor-core.js';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...p) => readFileSync(join(repo, ...p), 'utf8');
const manifest = read('herdr-plugin.toml');
const main = read('bin', 'main.js');
const changelog = read('CHANGELOG.md');
const pkg = JSON.parse(read('package.json'));

const commands = [...manifest.matchAll(/^command = \[(.+)\]$/gm)].map((m) => m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')));

test('every manifest command runs a subcommand bin/main.js actually dispatches', () => {
  const handlers = main.slice(main.indexOf('const HANDLERS = {'), main.indexOf('const sub = process.argv'));
  assert.ok(commands.length >= 7, `expected the manifest to declare commands, found ${commands.length}`);
  for (const cmd of commands) {
    assert.deepEqual(cmd.slice(0, 2), ['/bin/sh', 'launch.sh'], `manifest command must go through launch.sh (D5): ${cmd}`);
    const sub = cmd[2];
    assert.ok(
      new RegExp(`(^|\\s|')${sub}('|:)`).test(handlers),
      `manifest references "${sub}", which is not a key in HANDLERS`,
    );
  }
});

// Missing this hook left an 11-minute coverage gap after a herdr restart; it's why the floor is 0.7.5.
test('the startup hook is declared, and the version floor supports it', () => {
  assert.match(manifest, /\[\[startup\]\]\s*\ncommand = \["\/bin\/sh", "launch\.sh", "watch-all"\]/);
  const floor = manifest.match(/^min_herdr_version = "(.+)"$/m)[1].split('.').map(Number);
  assert.ok(floor[0] > 0 || floor[1] > 7 || floor[2] >= 5, `[[startup]] needs herdr >= 0.7.5, floor is ${floor.join('.')}`);
});

test('the version is the same in package.json and the manifest', () => {
  const manifestVersion = manifest.match(/^version = "(.+)"$/m)[1];
  assert.equal(pkg.version, manifestVersion, 'package.json and herdr-plugin.toml disagree on the version');
});

test('the current version has a CHANGELOG section, and every released one has a link', () => {
  assert.ok(
    changelog.includes(`## [${pkg.version}]`),
    `CHANGELOG has no section for ${pkg.version}; write it before bumping the version`,
  );
  for (const [, version] of changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)) {
    assert.ok(changelog.includes(`[${version}]: https://`), `CHANGELOG section ${version} has no link reference`);
  }
});

// Same scan the pre-push hook runs; see scripts/scan-private.mjs for why.
test('no private content in tracked files', () => {
  const local = localPatterns(join(repo, '.private-markers'));
  const hits = scan(trackedFiles(repo), read, [...GENERIC, ...(local || [])]);
  assert.deepEqual(hits, [], hits.map((h) => `${h.file}: ${h.what}: ${h.sample}`).join('\n'));
});

// A silently-weakened scan is worse than none: assert each pattern class still bites.
test('the leak scan catches each class it claims to', () => {
  const probes = {
    'src/x.js': 'see CP-D94 for the rationale',
    'src/y.js': 'tracked in references/decisions/LOG.md',
    'src/z.js': 'Status: blocked on the rerun',
    'src/w.js': 'ping someone@somewhere.org',
    'src/v.js': 'cd /Users/someone/Workspace/x',
  };
  const hits = scan(Object.keys(probes), (f) => probes[f], GENERIC);
  assert.equal(hits.length, Object.keys(probes).length, `every probe should be caught, got ${JSON.stringify(hits)}`);
  // ...without flagging this repo's own bare decision tags.
  assert.deepEqual(scan(['a.md'], () => 'D19 supersedes D8, see docs/configuration.md', GENERIC), []);
});

// CONTRIBUTING: rationale lives in AGENTS.md, not code comments; v1.0.0 shipped src/ and bin/ at zero.
test('src/ and bin/ carry no code comments', () => {
  const offenders = trackedFiles(repo)
    .filter((f) => /^(src|bin)\/.+\.js$/.test(f))
    .map((f) => [f, read(f).split('\n').filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).length])
    .filter(([, n]) => n > 0);
  assert.deepEqual(offenders, [], `move the rationale to AGENTS.md: ${JSON.stringify(offenders)}`);
});

// A renamed state field silently logs undefined with no failing test (happened: stuckSince -> frozenMs).
test('bin/main.js only reads monitor-state fields that exist', () => {
  const known = new Set(Object.keys(createMonitorState()));
  const used = [...read('bin', 'main.js').matchAll(/\bstate\.([A-Za-z_]\w*)/g)].map((m) => m[1]);
  const unknown = [...new Set(used)].filter((f) => !known.has(f));
  assert.deepEqual(unknown, [], `bin/main.js reads state fields that createMonitorState never sets: ${unknown}`);
});

test('the documented herdr floor matches the manifest', () => {
  const floor = manifest.match(/^min_herdr_version = "(.+)"$/m)[1];
  for (const file of ['README.md', 'CONTRIBUTING.md']) {
    assert.ok(read(file).includes(`>= ${floor}`), `${file} does not state the herdr floor as >= ${floor}`);
  }
});

// nudges (transient) and attempts (reset) are different counters (D26); logging the wrong one printed "attempt 0" forever.
test('each retry path logs its own counter', () => {
  const main = read('bin', 'main.js');
  const line = main.split('\n').find((l) => l.includes('nudged (attempt'));
  assert.ok(line, 'the nudge log line still exists');
  assert.match(line, /nudged \(attempt \$\{state\.nudges\}\)/, 'the transient path must log nudges, not attempts');
});
