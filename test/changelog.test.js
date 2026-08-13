// The CHANGELOG surgery behind `npm run release`. Pure string work, so it is
// tested against fixtures rather than the real file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { section, promote } from '../scripts/changelog.mjs';

const SAMPLE = `# Changelog

Notable changes, newest first.

## [Unreleased]

Reliability fixes.

- Fixed a thing.
- Fixed another thing.

## [1.0.0] - 2026-07-02

Initial release.

[1.0.0]: https://github.com/mo-arvan/herdr-claude-auto-retry/releases/tag/v1.0.0
`;

test('section returns one release body, without the heading or link refs', () => {
  assert.equal(section(SAMPLE, '1.0.0'), 'Initial release.');
  assert.match(section(SAMPLE, 'Unreleased'), /^Reliability fixes\./);
  assert.match(section(SAMPLE, 'Unreleased'), /- Fixed another thing\.$/);
  assert.equal(section(SAMPLE, '9.9.9'), null);
});

test('promote dates the section and appends its link reference', () => {
  const out = promote(SAMPLE, '1.1.0', '2026-08-04');
  assert.match(out, /^## \[1\.1\.0\] - 2026-08-04$/m);
  assert.ok(!out.includes('## [Unreleased]'), 'the Unreleased heading is consumed');
  assert.match(out, /^\[1\.1\.0\]: https:\/\/github\.com\/.+\/releases\/tag\/v1\.1\.0$/m);
  assert.match(out, /^\[1\.0\.0\]: https:/m, 'older link references survive');
  // The promoted body is untouched, so notes extraction still works afterwards.
  assert.equal(section(out, '1.1.0'), section(SAMPLE, 'Unreleased'));
});

test('promote refuses to run twice or on an empty Unreleased section', () => {
  assert.throws(() => promote(promote(SAMPLE, '1.1.0', '2026-08-04'), '1.1.0', '2026-08-05'), /no \[Unreleased\]/);
  const empty = SAMPLE.replace(/## \[Unreleased\][\s\S]*?(?=## \[1\.0\.0\])/, '## [Unreleased]\n\n');
  assert.equal(section(empty, 'Unreleased'), '', 'fixture really is an empty section');
  assert.throws(() => promote(empty, '1.1.0', '2026-08-04'), /no \[Unreleased\] section, or it is empty/);
  assert.throws(() => promote(SAMPLE, '1.0.0', '2026-08-04'), /already has a section/);
});
