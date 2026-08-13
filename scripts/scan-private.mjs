// Leak scan over tracked files. Callers: `npm test`, `.githooks/pre-push`,
// `npm run scan`. Exits 1 and prints every hit. See CONTRIBUTING.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const GENERIC = [
  [/\/(?:Users|home)\/[a-z][\w.-]+/i, 'an absolute home directory path'],
  [/[\w.+-]+@(?!example\.)[\w-]+\.[a-z]{2,}/i, 'an email address'],
  [/\b(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_]{16,}/, 'something shaped like an API token'],
  // Cross-project decision and defect tags (<PROJECT>-D<n> / <PROJECT>-X<n>).
  // This repo's own decisions are bare D1..D19, which deliberately do not match.
  [/\b[A-Z]{2,}-[DX]\d+\b/, 'a cross-project decision or defect tag'],
  // Paths that only exist in the private workspace.
  [/\b(?:references\/(?:decisions|critique)|professional-life|agentic-workspace)\b/, 'a private workspace path'],
  [/^\s*(?:Status|Next|Blockers):/m, 'a PROGRESS-style handoff entry'],
];

// Gitignored: a denylist of private names, published, leaks what it protects.
// Returns null only when the file is absent. One bad line is reported and
// skipped, never allowed to discard the rest of the list.
export function localPatterns(file = '.private-markers', onBadLine = () => {}) {
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out = [];
  body.split('\n').forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith('#')) return;
    try {
      out.push([new RegExp(l, 'im'), `a private marker (${l})`]);
    } catch (err) {
      onBadLine(`${file}:${i + 1}: ignoring unparseable pattern ${JSON.stringify(l)} (${err.message})`);
    }
  });
  return out;
}

export function scan(files, readFile, patterns) {
  const hits = [];
  for (const file of files) {
    if (file.startsWith('scripts/scan-private.mjs') || file.startsWith('test/release.test.js')) continue;
    let body;
    try {
      body = readFile(file);
    } catch {
      continue;
    }
    for (const [pattern, what] of patterns) {
      const m = body.match(pattern);
      if (m) hits.push({ file, what, sample: m[0].slice(0, 60) });
    }
  }
  return hits;
}

export function trackedFiles(cwd = '.') {
  return execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

// A push ships commits, not the worktree: content committed and later scrubbed
// still leaves the machine, and an endpoint diff cannot see it. Walk every blob
// each commit in the range introduces.
export function rangeBlobs(range) {
  const commits = execFileSync('git', ['rev-list', ...range.trim().split(/\s+/)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const out = new Map();
  for (const sha of commits) {
    const files = execFileSync('git', ['show', '--name-only', '--pretty=format:', '--diff-filter=d', sha], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    for (const f of files) {
      const key = `${f} (${sha.slice(0, 8)})`;
      if (out.has(key)) continue;
      try {
        out.set(key, execFileSync('git', ['show', `${sha}:${f}`, '--'], { encoding: 'utf8' }));
      } catch {
        /* not present at that commit */
      }
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const local = localPatterns('.private-markers', (m) => process.stderr.write(`${m}\n`));
  if (local === null) {
    process.stderr.write('warning: no .private-markers, scanning with the generic patterns only\n');
  }
  const rangeIdx = process.argv.indexOf('--range');
  const range = rangeIdx > 0 ? process.argv[rangeIdx + 1] : null;
  let files;
  let readOne;
  if (range) {
    const blobs = rangeBlobs(range);
    files = [...blobs.keys()];
    readOne = (f) => blobs.get(f);
  } else {
    files = trackedFiles();
    readOne = (f) => readFileSync(f, 'utf8');
  }
  const hits = scan(files, readOne, [...GENERIC, ...(local || [])]);
  for (const h of hits) process.stderr.write(`${h.file}: ${h.what}: ${h.sample}\n`);
  if (hits.length) {
    process.stderr.write(`\n${hits.length} possible leak(s). Fix, or add a narrower pattern if this is a false positive.\n`);
    process.exit(1);
  }
  process.stdout.write(`scan clean (${files.length} ${range ? `file(s) in ${range}` : 'tracked files'})\n`);
}
