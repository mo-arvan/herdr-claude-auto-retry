import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitInLatestBlock, stripAnsi, isRateLimited, findRateLimitMessage, classifyLimit, latestOutputBlock } from '../src/patterns.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { limitScreen } from './fixtures/screens.js';

test('stripAnsi removes CSI, OSC, and hyperlink sequences', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(stripAnsi('\x1b]0;title\x07hi'), 'hi');
  assert.equal(stripAnsi('\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\'), 'link');
});

test('detects classic single-line limit messages', () => {
  assert.ok(isRateLimited('5-hour limit reached - resets 3pm (UTC)'));
  assert.ok(isRateLimited("You've hit your limit · resets 3pm (Europe/Dublin)"));
  assert.ok(isRateLimited('Claude usage limit reached. Resets at 2pm'));
});

test('detects multi-line TUI render (limit and resets on separate lines)', () => {
  const text = ["⚠ You've hit your limit", '· resets 3pm (UTC)'].join('\n');
  assert.ok(isRateLimited(text));
});

test('detects current "session limit" wording (#15)', () => {
  assert.ok(isRateLimited("You've hit your session limit · resets 4:50pm (Asia/Shanghai)"));
});

test('detects "weekly limit" wording (#13)', () => {
  assert.ok(isRateLimited('Weekly limit reached · resets 9am'));
});

test('does not false-positive on benign text mentioning limit without a reset', () => {
  assert.ok(!isRateLimited('We hit the rate limit ceiling in the design doc yesterday.'));
  assert.ok(!isRateLimited('Set your session limit in settings.'));
});

// Strings verbatim from live logs; distinguishes a usage warning (footer, healthy pane) from a real blocked limit ('hit'/'reached').
test('a "used N% of your ... limit" usage warning is NOT a rate limit', () => {
  assert.equal(classifyLimit("⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents        You've used 75% of your weekly limit · resets 10pm (America/Chicago)"), null);
  assert.equal(classifyLimit("You've used 97% of your session limit · resets 6pm (America/Chicago) · /upgrade to keep using Claude Code"), null);
  assert.equal(classifyLimit("You've used 80% of your weekly limit · resets 9am"), null);
});

test('a real blocked limit still fires (hit / reached wording)', () => {
  assert.equal(classifyLimit("You've hit your session limit · resets 1am (America/Chicago)"), 'reset');
  assert.equal(classifyLimit('Weekly limit reached · resets 9am'), 'reset');
  assert.equal(classifyLimit("You've hit your limit · resets 3pm (UTC)"), 'reset');
  // A ⎿ tool-result line is still a real limit; the leading glyph must not change the verdict.
  assert.equal(classifyLimit("⎿ You've hit your session limit · resets 9am"), 'reset');
});

test('customPatterns can force-detect a percentage form without a code change', () => {
  assert.equal(classifyLimit("You've used 100% of your session limit · resets 1am", ['used 100% of your']), 'reset');
});

// Recovery dismisses any menu unconditionally with Escape, so no menu-specific detection is needed here.
test('detects a rate limit inside the /rate-limit-options menu (#19)', () => {
  const menu = [
    "You've hit your session limit · resets 6:50pm (Europe/London)",
    'What do you want to do?',
    '❯ 1. Upgrade your plan',
    '  2. Stop and wait for limit to reset',
  ].join('\n');
  assert.ok(isRateLimited(menu));
});

test('findRateLimitMessage returns the resets line for parsing', () => {
  const text = ["You've hit your session limit", '· resets 6:50pm (Europe/London)'].join('\n');
  assert.match(findRateLimitMessage(text), /resets 6:50pm/);
});

test('findRateLimitMessage prefers the reset near the most recent limit line', () => {
  const text = [
    'You hit your limit · resets 9am (UTC)', // stale, earlier in the buffer
    'work', 'work', 'work', 'work', 'work', 'work', 'work',
    "You've hit your session limit", // current event
    '· resets 3pm (UTC)',
  ].join('\n');
  assert.match(findRateLimitMessage(text), /resets 3pm/);
});

test('custom patterns are honored', () => {
  assert.ok(isRateLimited('SOME WEIRD COOLDOWN BANNER', ['weird cooldown']));
});

test('customPatterns catch new limit wording; customTransientPatterns catch new server-error wording', () => {
  assert.equal(classifyLimit('New usage cap hit for this account', ['usage cap hit']), 'reset');
  assert.equal(classifyLimit('⏺ API Error: Service is busy, try later', [], ['service is busy']), 'transient');
});

test('the default retry message never matches a detector (no self-trigger loop)', () => {
  const m = DEFAULT_CONFIG.retryMessage;
  assert.equal(isRateLimited(m), false, 'retryMessage must not look like a rate limit');
  assert.equal(classifyLimit(m), null, 'retryMessage must not classify as any limit');
  assert.equal(classifyLimit(`> ${m}`), null, 'nor when echoed in the input line');
  assert.equal(classifyLimit(`❯ ${m}`), null, 'nor with the real input glyph Claude renders');
});

test('a limit above the newest output block is scrollback and does not match', () => {
  const buffer = [
    "You've hit your session limit · resets 3pm (UTC)",
    '',
    '⏺ Continuing with the refactor.',
    '❯',
  ].join('\n');
  assert.ok(!isRateLimited(buffer));
  assert.equal(findRateLimitMessage(buffer), null);
});

test('a limit in the footer below the newest block still matches', () => {
  const buffer = ['⏺ Ran the tests', '', "You've hit your session limit · resets 3pm (UTC)", '❯'].join('\n');
  assert.ok(isRateLimited(buffer));
});


test('classifyLimit: transient server throttle (no reset time) -> transient', () => {
  assert.equal(
    classifyLimit('⏺ API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'),
    'transient',
  );
  assert.equal(classifyLimit('⏺ API Error: Overloaded'), 'transient');
});

test('classifyLimit: 5xx / retryable API errors -> transient', () => {
  assert.equal(
    classifyLimit('⏺ API Error: 500 Internal server error. This is a server-side issue, usually temporary - try again in a moment.'),
    'transient',
  );
  assert.equal(classifyLimit('⏺ API Error: 503 Service Unavailable'), 'transient');
  assert.equal(classifyLimit('⏺ API Error: 529 Overloaded'), 'transient');
});

test('classifyLimit: a connection drop mid-response -> transient', () => {
  assert.equal(
    classifyLimit('⏺ API Error: Connection closed mid-response. The response above may be incomplete.'),
    'transient',
  );
  assert.equal(classifyLimit('⏺ API Error: Connection error.'), 'transient');
  // A bare mention of a closed connection (no 'API Error:' prefix) is normal output, not a live error.
  assert.equal(classifyLimit('⏺ The connection was closed by the remote host in your test.'), null);
});

test('classifyLimit: permanent 4xx API errors are NOT retried', () => {
  assert.equal(classifyLimit('⏺ API Error: 400 Bad Request'), null);
  assert.equal(classifyLimit('⏺ API Error: 401 invalid x-api-key'), null);
  assert.equal(classifyLimit('⏺ API Error: 404 model not found'), null);
});

test('classifyLimit: normal output -> null', () => {
  assert.equal(classifyLimit('Reference set: 76 items'), null);
  // The thinking-time spinner shows for any turn (success or failure); it must never read as an error alone.
  assert.equal(classifyLimit('✻ Cogitated for 1s'), null);
});

// Live 7h stall (D18): a task list pushed the error 18 lines up, past the tail window.
test('a transient error still detects when a task list pushes it out of the tail window', () => {
  const footer = [
    '⏺ Ran 1 shell command',
    '',
    '⏺ API Error: Connection closed mid-response. The response above may be incomplete.',
    '',
    '✻ Cooked for 1h 22m 18s',
    '',
    '  10 tasks (2 done, 1 in progress, 7 open)',
    '  ◼ T-109: rewrite the parser behind a flag, with unit tests',
    '  ◻ T-83: wire the retry budget into the client',
    '  ◻ T-85: three fixes to the report exporter',
    '  ◻ T-95: coverage gate plus an integration smoke test',
    '  ◻ T-106: config validation pass',
    '  … +3 pending, 2 completed',
    '  new task? /clear to save 290.4k tokens',
    '─'.repeat(60),
    '❯',
    '─'.repeat(60),
    'Opus 5 (1M context)  |  ctx 29%',
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  ].join('\n');
  assert.equal(classifyLimit(footer), 'transient', 'the newest block is always read, however far up it sits');
  // ...and it still stops once Claude actually responds below the error.
  assert.equal(classifyLimit(`${footer}\n\n⏺ Continuing with T-109.`), null);
});

test('marker-less transient text is read in full (no tail window)', () => {
  const buf = ['API Error: Server is temporarily limiting requests · Rate limited', ...Array(20).fill('x'), '> '].join('\n');
  assert.equal(classifyLimit(buf), 'transient');
});

test('classifyLimit: a transient error with a real response below it -> null (recovered)', () => {
  const recovered = [
    '⏺ API Error: 500 Internal server error.', // old error, scrolled up
    '',
    '✻ Cogitated for 1s',
    '',
    '❯ Continue where you left off.',
    '',
    '⏺ All set - the file is written.', // latest output: a real response
  ].join('\n');
  assert.equal(classifyLimit(recovered), null);
  // ...but while the error IS the latest output block, it still classifies.
  assert.equal(classifyLimit('⏺ API Error: 500 Internal server error.'), 'transient');
});

test('classifyLimit: the echoed nudge in the input line is ignored', () => {
  const afterNudge = [
    '⏺ API Error: 529 Overloaded.', // the error we are waiting on (latest ⏺)
    '',
    '❯ Continue where you left off.', // our echoed nudge, below the error
  ].join('\n');
  // The ❯ line is input, not output, so the error is still the latest output block and stays transient.
  assert.equal(classifyLimit(afterNudge), 'transient');
});

test('latestOutputBlock returns the last ⏺/⎿ block, else null', () => {
  assert.equal(latestOutputBlock('plain text, no markers'), null);
  assert.equal(latestOutputBlock('⏺ first\n\n❯ in\n\n⏺ second'), '⏺ second');
  assert.equal(latestOutputBlock('⏺ wrapped line one\n  continues here\n\n✻ Worked for 2s'), '⏺ wrapped line one\n  continues here');
});


// D18's block anchor alone made the tail fallback unreachable (real screens almost always have a block); detection now checks both.
test('a footer-form transient is detected even under ordinary output', () => {
  const screen = [
    '⏺ Read(src/app.js)', '  ⎿ Read 120 lines', '', '✻ Cogitated for 4s', '',
    ...Array(18).fill('  transcript line'),
    'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    '❯',
  ].join('\n');
  assert.equal(classifyLimit(screen), 'transient');
});

test('the footer read does not revive a stale error above a fresh response', () => {
  const recovered = [
    '⏺ API Error: Connection closed mid-response. The response above may be incomplete.', '',
    '⏺ Continuing with the refactor now.', '  ⎿ Edited 3 files', '❯',
  ].join('\n');
  assert.equal(classifyLimit(recovered), null);
});

// The prompt box is user-typed text; pulling it into detection risks Enter submitting a half-written draft (D23).
test('a half-written user prompt is never treated as an error', () => {
  const drafting = [
    '⏺ Read(src/app.js)', '  ⎿ Read 120 lines', '', '✻ Cogitated for 4s', '',
    '─'.repeat(50),
    '❯ the upstream api was overloaded earlier, can you add a retry?',
    '─'.repeat(50),
    'Opus 5 (1M context)  |  ctx 22%',
  ].join('\n');
  assert.equal(classifyLimit(drafting), null);
  assert.equal(findRateLimitMessage(drafting), null);
});

// PR #2: on a working pane, the limit is the last thing Claude printed; everything below is chrome.

test('limitInLatestBlock: true when the limit is the newest output', () => {
  assert.equal(limitInLatestBlock(limitScreen(2)), true);
});

test('limitInLatestBlock: false when the limit only sits in the scrollback', () => {
  const resumed = [
    "⏺ You've hit your session limit · resets 8:50pm (Asia/Omsk)",
    '',
    '⏺ Done - pushed the fix.',
  ].join('\n');
  assert.equal(classifyLimit(resumed), null);
  assert.equal(limitInLatestBlock(resumed), false);
});

test('limitInLatestBlock: false when nothing was printed as output at all', () => {
  assert.equal(limitInLatestBlock('❯ please try again in 1 hour'), false);
});

// Live incident 2026-08-13: a markdown table row armed a 7h wait; text ABOUT a limit is not a limit.
test('a rendered table row about a limit is not a rate limit', () => {
  const row = '│             │ session limit · resets 8:50pm)                                    │            │';
  assert.equal(isRateLimited(row), false);
  assert.equal(classifyLimit(row), null);
  assert.equal(limitInLatestBlock(`⏺ Итог разбора:\n${row}`), false);
});

test('an ASCII markdown table about limits and server errors is inert', () => {
  const doc = [
    '⏺ Разбор инцидента:',
    '| время    | событие                                             |',
    '|----------|-----------------------------------------------------|',
    "| 20:37:41 | You've hit your session limit · resets 8:50pm (Omsk) |",
    '| 20:44:19 | ⏺ API Error: 529 Overloaded, try again in 2 minutes  |',
  ].join('\n');
  assert.equal(isRateLimited(doc), false);
  assert.equal(classifyLimit(doc), null);
});

// Boxed menus have two borders per line, not three, so the pipe-table guard must not swallow them.
test('the table guard does not swallow a boxed limit menu (#19)', () => {
  const boxed = [
    '╭─────────────────────────────────────────────────╮',
    "│ You've hit your session limit · resets 6:50pm   │",
    '│ ❯ 1. Upgrade your plan                          │',
    '╰─────────────────────────────────────────────────╯',
  ].join('\n');
  assert.equal(isRateLimited(boxed), true);
});

// Tables start with a leading separator row; status lines don't, so the pipe-table guard leaves them alone (D25).
test('a pipe-heavy status line still detects and extracts a real limit', () => {
  const screen = [
    '❯',
    "  proj | main | Opus 5 | 5h: 100% — you've hit your session limit, resets 8:50pm",
  ].join('\n');
  assert.equal(isRateLimited(screen), true);
  assert.match(findRateLimitMessage(screen), /resets 8:50pm/);
});

test('the table guard needs a leading separator, not just three pipes', () => {
  assert.equal(isRateLimited('a | b | c | session limit resets 8:50pm'), true);
  assert.equal(isRateLimited('| a | session limit resets 8:50pm | c |'), false);
});
