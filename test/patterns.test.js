import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitInLatestBlock, stripAnsi, isRateLimited, findRateLimitMessage, classifyLimit, latestOutputBlock } from '../src/patterns.js';
import { DEFAULT_CONFIG } from '../src/config.js';

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

// Issue #15 / #13 / #18: "session limit" / "weekly limit" wording.
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

// Claude shows a proactive usage banner in its persistent status line ("You've
// used 75% of your weekly limit · resets 10pm"). That is a warning, not a limit
// that stopped the session, and it sits in the footer of a healthy idle pane. A
// real blocked state says "hit" / "reached" instead. These strings are taken
// verbatim from live logs, where every rate-limit activation was one of these.
test('a "used N% of your ... limit" usage warning is NOT a rate limit', () => {
  assert.equal(classifyLimit("⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents        You've used 75% of your weekly limit · resets 10pm (America/Chicago)"), null);
  assert.equal(classifyLimit("You've used 97% of your session limit · resets 6pm (America/Chicago) · /upgrade to keep using Claude Code"), null);
  assert.equal(classifyLimit("You've used 80% of your weekly limit · resets 9am"), null);
});

test('a real blocked limit still fires (hit / reached wording)', () => {
  assert.equal(classifyLimit("You've hit your session limit · resets 1am (America/Chicago)"), 'reset');
  assert.equal(classifyLimit('Weekly limit reached · resets 9am'), 'reset');
  assert.equal(classifyLimit("You've hit your limit · resets 3pm (UTC)"), 'reset');
  // Claude also renders a real limit as a tool-result line; the leading glyph
  // must not change the verdict.
  assert.equal(classifyLimit("⎿ You've hit your session limit · resets 9am"), 'reset');
});

// The escape hatch: customPatterns short-circuit ahead of the built-ins, so if
// Claude ever blocks with a percentage form, config can still force-detect it.
test('customPatterns can force-detect a percentage form without a code change', () => {
  assert.equal(classifyLimit("You've used 100% of your session limit · resets 1am", 0, ['used 100% of your']), 'reset');
});

// Issue #19: the interactive /rate-limit-options menu still reads as a limit
// (recovery dismisses any menu unconditionally with Escape, so no menu-specific
// detection is needed).
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

// Issue #6: a stale earlier limit higher in the scrollback must not mis-time the
// wait; extract the reset line nearest the most recent limit line.
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

// Anticipating that Claude's wording changes: users add new limit or server-error
// phrasings via config, no code edit needed.
test('customPatterns catch new limit wording; customTransientPatterns catch new server-error wording', () => {
  assert.equal(classifyLimit('New usage cap hit for this account', 0, ['usage cap hit']), 'reset');
  assert.equal(classifyLimit('⏺ API Error: Service is busy, try later', 0, [], ['service is busy']), 'transient');
});

// The retry message is echoed into the pane's input line, so if it contained a
// detector keyword the monitor would match its own nudge and loop forever. The
// default must trip nothing - guard against re-introducing a trigger word.
test('the default retry message never matches a detector (no self-trigger loop)', () => {
  const m = DEFAULT_CONFIG.retryMessage;
  assert.equal(isRateLimited(m), false, 'retryMessage must not look like a rate limit');
  assert.equal(classifyLimit(m), null, 'retryMessage must not classify as any limit');
  assert.equal(classifyLimit(`> ${m}`), null, 'nor when echoed in the input line');
  assert.equal(classifyLimit(`❯ ${m}`), null, 'nor with the real input glyph Claude renders');
});

// Bottom-anchoring (the fix for the idle false-engage): rate-limit text scrolled
// up in the transcript must not match; only the live footer counts.
test('tailLines ignores rate-limit text scrolled up in the transcript', () => {
  const buffer = [
    "You've hit your session limit · resets 3pm (UTC)", // line 0, high in the buffer
    ...Array(20).fill('normal conversation line'),
    '> ', // live prompt at the bottom, no limit text
  ].join('\n');
  assert.ok(isRateLimited(buffer), 'matches without a tail window'); // whole-buffer scan
  assert.ok(!isRateLimited(buffer, [], 6), 'does NOT match within the last 6 lines');
});

test('tailLines still matches a real limit sitting at the footer', () => {
  const buffer = [
    ...Array(20).fill('earlier conversation'),
    "You've hit your session limit · resets 3pm (UTC)", // just above the prompt
    '> ',
  ].join('\n');
  assert.ok(isRateLimited(buffer, [], 6), 'matches when the limit is in the footer');
});

// classifyLimit distinguishes a subscription limit (has a reset) from a
// transient server throttle (no reset) - the latter is the API-error case that
// slipped past detection entirely.
test('classifyLimit: subscription limit with reset -> reset', () => {
  assert.equal(classifyLimit("You've hit your session limit · resets 3pm (UTC)"), 'reset');
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
  // ...but a bare mention of a closed connection (no "API Error:" prefix) is just
  // normal output, not a live error.
  assert.equal(classifyLimit('⏺ The connection was closed by the remote host in your test.'), null);
});

test('classifyLimit: permanent 4xx API errors are NOT retried', () => {
  assert.equal(classifyLimit('⏺ API Error: 400 Bad Request'), null);
  assert.equal(classifyLimit('⏺ API Error: 401 invalid x-api-key'), null);
  assert.equal(classifyLimit('⏺ API Error: 404 model not found'), null);
});

test('classifyLimit: normal output -> null', () => {
  assert.equal(classifyLimit('Reference set: 76 items'), null);
  // The thinking-time spinner shows for any turn, success or failure, so it must
  // never read as an error on its own.
  assert.equal(classifyLimit('✻ Cogitated for 1s'), null);
});

// Found live: a 7h stall. Claude renders a task list, prompt box, model line and
// hint below the error, which pushed the "API Error" 18 lines up - outside the
// 15-line tail window - so detection silently missed a genuinely stalled pane.
// Transient detection is therefore anchored to the latest output block across the
// whole read, not to a fixed line count.
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
  assert.equal(classifyLimit(footer, 15), 'transient', 'must detect despite the 15-line tail window');
  // ...and it still stops once Claude actually responds below the error.
  assert.equal(classifyLimit(`${footer}\n\n⏺ Continuing with T-109.`, 15), null);
});

test('classifyLimit respects the tail window', () => {
  const buf = ['API Error: Server is temporarily limiting requests · Rate limited', ...Array(20).fill('x'), '> '].join('\n');
  assert.equal(classifyLimit(buf), 'transient'); // whole buffer
  assert.equal(classifyLimit(buf, 6), null); // footer only
});

// The recovery guard: a transient error is only "live" while it is the latest
// output block. A real response below it (Claude resumed) means recovered.
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

// The self-trigger guard: the monitor's own nudge echoed in the ❯ input line must
// never be read as the live error, even if a (neutral) message sat next to one.
test('classifyLimit: the echoed nudge in the input line is ignored', () => {
  const afterNudge = [
    '⏺ API Error: 529 Overloaded.', // the error we are waiting on (latest ⏺)
    '',
    '❯ Continue where you left off.', // our echoed nudge, below the error
  ].join('\n');
  // The latest OUTPUT block is the error (the ❯ line is input, not output), so it
  // is still transient - the echo neither creates nor masks a detection.
  assert.equal(classifyLimit(afterNudge), 'transient');
});

test('latestOutputBlock returns the last ⏺/⎿ block, else null', () => {
  assert.equal(latestOutputBlock('plain text, no markers'), null);
  assert.equal(latestOutputBlock('⏺ first\n\n❯ in\n\n⏺ second'), '⏺ second');
  assert.equal(latestOutputBlock('⏺ wrapped line one\n  continues here\n\n✻ Worked for 2s'), '⏺ wrapped line one\n  continues here');
});


// D18 anchored transient detection to the newest output block, which made the
// tail fallback unreachable: a real screen almost always contains some ⏺ line,
// so footer-form errors (the status-line wordings) stopped being detected at all
// - a regression against v1.0.0. Detection now reads the newest block AND the
// footer beneath it, which is where those forms render.
test('a footer-form transient is detected even under ordinary output', () => {
  const screen = [
    '⏺ Read(src/app.js)', '  ⎿ Read 120 lines', '', '✻ Cogitated for 4s', '',
    ...Array(18).fill('  transcript line'),
    'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    '❯',
  ].join('\n');
  assert.equal(classifyLimit(screen, 15), 'transient');
});

test('the footer read does not revive a stale error above a fresh response', () => {
  const recovered = [
    '⏺ API Error: Connection closed mid-response. The response above may be incomplete.', '',
    '⏺ Continuing with the refactor now.', '  ⎿ Edited 3 files', '❯',
  ].join('\n');
  assert.equal(classifyLimit(recovered, 15), null);
});

// The prompt box holds text the USER is typing. Pulling it into detection means
// a half-written question mentioning an error engages the monitor, and because
// send-text appends to the input line, Enter would submit that draft.
test('a half-written user prompt is never treated as an error', () => {
  const drafting = [
    '⏺ Read(src/app.js)', '  ⎿ Read 120 lines', '', '✻ Cogitated for 4s', '',
    '─'.repeat(50),
    '❯ the upstream api was overloaded earlier, can you add a retry?',
    '─'.repeat(50),
    'Opus 5 (1M context)  |  ctx 22%',
  ].join('\n');
  assert.equal(classifyLimit(drafting, 15), null);
  assert.equal(findRateLimitMessage(drafting, 15), null);
});

// ── PR #2 (astorozhevsky): a working pane's limit, and table rows ──────────
// A real screen from a rate-limited pane: the error is the last thing Claude
// printed, and everything below it is chrome that re-renders on its own.
function limitScreen(counter) {
  return [
    '⏺ Bash(git push origin main)',
    '  ⎿  main -> main',
    '',
    "⏺ You've hit your session limit · resets 8:50pm (Asia/Omsk)",
    '',
    `✻ Cooking… (${counter}m 14s · ↓ 8.1k tokens)`,
    '─────────────────────────────────────────',
    '❯',
    '─────────────────────────────────────────',
    `  proj git:(main) | Opus 5 (1M context) | ctx: ${counter}%`,
    `  5h: 30% (resets in ${counter}m) | 7d: 29% (resets in 5d8h)`,
    '  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
}

test('limitInLatestBlock: true when the limit is the newest output', () => {
  assert.equal(limitInLatestBlock(limitScreen(2), 30), true);
});

test('limitInLatestBlock: false when the limit only sits in the scrollback', () => {
  const resumed = [
    "⏺ You've hit your session limit · resets 8:50pm (Asia/Omsk)",
    '',
    '⏺ Done - pushed the fix.',
  ].join('\n');
  // The whole-tail check still matches (the old line is there), which is exactly
  // why the narrower block check is the one that gates an ineligible pane.
  assert.equal(classifyLimit(resumed), 'reset');
  assert.equal(limitInLatestBlock(resumed, 30), false);
});

test('limitInLatestBlock: false when nothing was printed as output at all', () => {
  assert.equal(limitInLatestBlock('❯ please try again in 1 hour', 30), false);
});

// Observed live 2026-08-13 14:15:46: a pane where an incident involving this
// plugin was being written up rendered a markdown table, and the row below armed
// a 7h wait. Text ABOUT a limit is not a limit; Claude Code never renders its
// banner as a table row.
test('a rendered table row about a limit is not a rate limit', () => {
  const row = '│             │ session limit · resets 8:50pm)                                    │            │';
  assert.equal(isRateLimited(row), false);
  assert.equal(classifyLimit(row), null);
  assert.equal(limitInLatestBlock(`⏺ Итог разбора:\n${row}`, 30), false);
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

// The boxed /rate-limit-options menu (#19) has two borders per line, not three,
// so the table guard must leave a genuine boxed limit alone.
test('the table guard does not swallow a boxed limit menu (#19)', () => {
  const boxed = [
    '╭─────────────────────────────────────────────────╮',
    "│ You've hit your session limit · resets 6:50pm   │",
    '│ ❯ 1. Upgrade your plan                          │',
    '╰─────────────────────────────────────────────────╯',
  ].join('\n');
  assert.equal(isRateLimited(boxed), true);
});

// The table guard must not swallow a pipe-separated STATUS line: a real limit
// rendered in a busy status line is exactly the form D25 exists to keep
// readable. Tables start with a separator; status lines do not.
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
