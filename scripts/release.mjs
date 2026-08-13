// Local half of the release: every mechanical step, then STOP. Pushing is a
// human action because the push is the release. See CONTRIBUTING.md.
//
//   node scripts/release.mjs --check     readiness report
//   node scripts/release.mjs 1.1.0       bump, promote, sync, commit, tag

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promote } from './changelog.mjs';

const DOC_FILES = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md'];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const read = (f) => readFileSync(f, 'utf8');
const ok = (m) => process.stdout.write(`  ok    ${m}\n`);
const fail = (m) => {
  process.stdout.write(`  FAIL  ${m}\n`);
  failures.push(m);
};
const failures = [];

// Returns the passing count, or null after printing the failing test names.
function testCount() {
  let out;
  try {
    out = execFileSync('npm', ['test'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout || ''}`;
    for (const [, name] of out.matchAll(/^not ok \d+ - (.+)$/gm)) process.stdout.write(`        ${name}\n`);
    const failed = out.match(/^# fail (\d+)$/m);
    fail(failed ? `${failed[1]} test(s) failing` : 'npm test did not complete');
    return null;
  }
  const tests = out.match(/^# tests (\d+)$/m);
  if (!tests) {
    fail('could not parse the test summary');
    return null;
  }
  return Number(tests[1]);
}

function currentVersions() {
  return {
    pkg: JSON.parse(read('package.json')).version,
    manifest: read('herdr-plugin.toml').match(/^version = "(.+)"$/m)[1],
  };
}

// Quoted in three docs and has drifted before, so derive it.
function syncDocs(count, { write }) {
  const stale = [];
  const unmatched = [];
  for (const file of DOC_FILES) {
    const before = read(file);
    if (!new RegExp(`\\b${count}\\b`).test(before) && !/tests-\d+%20passing|- `npm test` - \d+ tests|npm test\s+# \d+ tests/.test(before)) {
      unmatched.push(file);
    }
    const after = before
      .replace(/(\[!\[tests: )\d+( passing\]\(https:\/\/img\.shields\.io\/badge\/tests-)\d+(%20passing)/, `$1${count}$2${count}$3`)
      .replace(/^(- `npm test` - )\d+( tests)/m, `$1${count}$2`)
      .replace(/^(npm test\s+# )\d+( tests)/m, `$1${count}$2`);
    if (after === before) continue;
    if (write) writeFileSync(file, after);
    stale.push(file);
  }
  for (const f of unmatched) fail(`${f}: the test-count pattern matched nothing, so the count cannot be kept honest`);
  return stale;
}

function checkGit(releasing) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'main') ok('on main');
  else fail(`on branch "${branch}", releases are cut from main`);

  // The release commit carries the version bump and nothing else.
  const dirty = git('status', '--porcelain');
  const changed = dirty ? dirty.split('\n').length : 0;
  if (!dirty) ok('working tree is clean');
  else if (releasing) fail(`${changed} uncommitted file(s); commit the work first, then release`);
  else process.stdout.write(`  note  working tree has ${changed} changed file(s)\n`);

  try {
    const [behind, ahead] = git('rev-list', '--left-right', '--count', 'origin/main...HEAD').split(/\s+/);
    if (Number(behind) > 0) fail(`${behind} commit(s) behind origin/main; pull first`);
    else ok(`in sync with origin/main (${ahead} ahead)`);
  } catch {
    process.stdout.write('  note  no origin/main ref to compare against\n');
  }
}

function preflight(target) {
  process.stdout.write('Release preflight\n');
  checkGit(target !== null);

  const { pkg, manifest } = currentVersions();
  if (pkg === manifest) ok(`version ${pkg} consistent across package.json and the manifest`);
  else fail(`package.json says ${pkg}, herdr-plugin.toml says ${manifest}`);

  if (target) {
    if (/^\d+\.\d+\.\d+$/.test(target)) ok(`target version ${target} is well formed`);
    else fail(`target version "${target}" is not X.Y.Z`);
    const tags = git('tag', '-l').split('\n');
    if (tags.includes(`v${target}`)) fail(`tag v${target} already exists`);
    else ok(`tag v${target} is free`);
  }

  const changelog = read('CHANGELOG.md');
  if (/^## \[Unreleased\]/m.test(changelog)) ok('CHANGELOG has an [Unreleased] section');
  else fail('CHANGELOG has no [Unreleased] section; nothing to release');

  const count = testCount();
  if (count === null) return { count: null };
  ok(`${count} tests passing`);
  const stale = syncDocs(count, { write: false });
  if (stale.length === 0) ok('documented test count matches the suite');
  else process.stdout.write(`  note  test count stale in ${stale.join(', ')} (the release will fix it)\n`);

  reviewGate();
  return { count };
}

// The suite covers the mechanical half. This is the half that needs eyes, so it
// prints the diff it is asking about rather than a bare checklist.
function reviewGate() {
  let range = '';
  try {
    range = `${git('describe', '--tags', '--abbrev=0')}..HEAD`;
  } catch {
    range = 'HEAD';
  }
  const stat = git('diff', '--shortstat', range) || 'no file changes';
  process.stdout.write(`\nUnreleased since ${range.split('..')[0]}: ${stat}\n`);
  const files = git('diff', '--name-only', range).split('\n').filter(Boolean);
  if (files.length) process.stdout.write(`  ${files.join('\n  ')}\n`);
  process.stdout.write([
    '\nNot checkable by the suite - review before releasing:',
    '  1. Read the diff. Correctness, and whether a simpler version exists.',
    '  2. Comments: src/ and bin/ stay at zero (enforced); tests explain WHY, not what.',
    '  3. Verboseness: did a doc grow more than the change deserves? Cut it back.',
    '  4. CHANGELOG: written for users, in their terms, no internals.',
    '  5. Fixtures: real pane captures scrubbed of anything private.',
    '',
  ].join('\n'));
}

const arg = process.argv[2];
if (!arg || arg === '--check') {
  preflight(null);
  process.stdout.write(failures.length ? `\nNot ready: ${failures.length} problem(s).\n` : '\nReady to release.\n');
  process.exit(failures.length ? 1 : 0);
}

const version = arg;
const { count } = preflight(version);
if (failures.length) {
  process.stdout.write(`\nAborted: ${failures.length} problem(s).\n`);
  process.exit(1);
}

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
writeFileSync('package.json', read('package.json').replace(/^(  "version": ").+(",)$/m, `$1${version}$2`));
writeFileSync('herdr-plugin.toml', read('herdr-plugin.toml').replace(/^version = ".+"$/m, `version = "${version}"`));
writeFileSync('CHANGELOG.md', promote(read('CHANGELOG.md'), version, today));
syncDocs(count, { write: true });
process.stdout.write(`\nWrote version ${version} and promoted the CHANGELOG to ${today}.\n`);

// test/release.test.js is what proves the promotion left a consistent tree.
const after = testCount();
if (after === null) {
  process.stdout.write('\nThe edited tree does not pass. Files are written but nothing was committed.\n');
  process.exit(1);
}
process.stdout.write(`Re-checked: ${after} tests passing.\n`);

git('add', 'package.json', 'herdr-plugin.toml', 'CHANGELOG.md', ...DOC_FILES);
execFileSync('git', ['commit', '-m', `Release v${version}\n\nSee CHANGELOG.md for the full notes.`], { stdio: 'inherit' });
git('tag', '-a', `v${version}`, '-m', `v${version}`);

process.stdout.write(`\nCommitted and tagged v${version}. Nothing has been pushed.\n`);
process.stdout.write('Review, then release with:\n\n');
process.stdout.write('  git show --stat HEAD\n');
process.stdout.write('  git push origin main --follow-tags\n\n');
process.stdout.write('The tag push triggers .github/workflows/release.yml, which runs the\n');
process.stdout.write('suite and opens the GitHub release with the CHANGELOG section as notes.\n');
