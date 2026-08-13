// CHANGELOG surgery, kept pure so the release script and the release workflow
// share one implementation instead of re-deriving it in shell and YAML.
//
// CLI: `node scripts/changelog.mjs <version>` prints that release's notes, which
// is what .github/workflows/release.yml feeds to `gh release create`.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REPO = 'https://github.com/mo-arvan/herdr-claude-auto-retry';

// Body of one section, heading and trailing link refs excluded.
export function section(changelog, heading) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${heading}]`));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  const body = (end < 0 ? rest : rest.slice(0, end))
    .filter((l) => !/^\[[^\]]+\]: https:/.test(l))
    .join('\n')
    .trim();
  return body;
}

// Turn `## [Unreleased]` into a dated release and append its link reference.
export function promote(changelog, version, date) {
  if (!section(changelog, 'Unreleased')) {
    throw new Error('CHANGELOG has no [Unreleased] section, or it is empty');
  }
  if (changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG already has a section for ${version}`);
  }
  const promoted = changelog.replace(/^## \[Unreleased\][^\n]*$/m, `## [${version}] - ${date}`);
  const link = `[${version}]: ${REPO}/releases/tag/v${version}`;
  return `${promoted.trimEnd()}\n${link}\n`.replace(/\n{3,}(\[[^\]]+\]: https:)/g, '\n\n$1');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { readFileSync } = await import('node:fs');
  const version = process.argv[2];
  if (!version) {
    process.stderr.write('usage: changelog.mjs <version>\n');
    process.exit(2);
  }
  const body = section(readFileSync('CHANGELOG.md', 'utf8'), version);
  if (!body) {
    process.stderr.write(`no CHANGELOG section for ${version}\n`);
    process.exit(1);
  }
  process.stdout.write(`${body}\n`);
}
