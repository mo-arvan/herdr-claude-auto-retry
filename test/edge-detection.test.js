import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRateLimited,
  classifyLimit,
  findRateLimitMessage,
  limitInLatestBlock,
  latestOutputBlock,
  agentErrorBlock,
  stripAnsi,
} from '../src/patterns.js';
import { limitScreen } from './fixtures/screens.js';

// Fixtures below are reconstructions of the message templates carried in the
// Claude Code 2.1.258 binary, rendered with the interpolation gaps filled in.
// Limit-name table from the binary: five_hour="session limit",
// seven_day="weekly limit", seven_day_opus="Opus limit",
// seven_day_sonnet="Sonnet limit", overage="usage credit limit".
// The banner template is `You've hit your ${name}${" · resets " + time}${" · progress saved"}`.

const pane = (...lines) => lines.join('\n');

// ---------------------------------------------------------------------------
// Real session-stopping limit banners. Every one of these leaves Claude idle.
// ---------------------------------------------------------------------------

test('five_hour banner: session limit with a bare clock reset', () => {
  const text = "⏺ You've hit your session limit · resets 3pm (America/Chicago)";
  assert.equal(classifyLimit(text), 'reset');
  assert.equal(findRateLimitMessage(text), text);
});

test('seven_day banner: weekly limit', () => {
  const text = "⏺ You've hit your weekly limit · resets 9am (Europe/London)";
  assert.equal(classifyLimit(text), 'reset');
});

test('seven_day_opus banner: "Opus limit" (a per-model window name)', () => {
  assert.equal(classifyLimit("⏺ You've hit your Opus limit · resets Wed 9am"), 'reset');
});

test('seven_day_sonnet banner: "Sonnet limit"', () => {
  assert.equal(classifyLimit("⏺ You've hit your Sonnet limit · resets 11:30am (UTC)"), 'reset');
});

test('overage banner: "usage credit limit"', () => {
  assert.equal(classifyLimit("⏺ You've hit your usage credit limit · resets 1am"), 'reset');
});

test('banner with the " · progress saved" suffix the binary appends', () => {
  const text = "⏺ You've hit your session limit · resets 6pm · progress saved";
  assert.equal(classifyLimit(text), 'reset');
  assert.equal(findRateLimitMessage(text), text);
});

test('banner with the "/upgrade to keep using Claude Code" call to action', () => {
  assert.equal(classifyLimit("⏺ You've hit your session limit · resets 6pm · /upgrade to keep using Claude Code"), 'reset');
});

test('banner with the enterprise "ask your admin for a higher limit" tail', () => {
  assert.equal(classifyLimit("⏺ You've hit your weekly limit · resets 9am · ask your admin for a higher limit"), 'reset');
});

test('the org variant: "hit your org\'s monthly usage limit"', () => {
  assert.equal(classifyLimit("⏺ You've hit your org's monthly usage limit · resets 12am (UTC)"), 'reset');
});

test('"You\'ve reached your ..." is the same banner with the other verb', () => {
  assert.equal(classifyLimit("⏺ You've reached your weekly limit · resets 9am"), 'reset');
});

test('the banner rendered as a ⎿ tool-result line', () => {
  const text = pane('⏺ Bash(npm test)', "  ⎿  You've hit your session limit · resets 4:50pm (Asia/Shanghai)");
  assert.equal(classifyLimit(text), 'reset');
  assert.ok(limitInLatestBlock(text));
});

test('the banner rendered as a bare status line with no output markers on screen', () => {
  const text = pane(
    '──────────',
    '❯',
    '──────────',
    "  You've hit your session limit · resets 3pm (America/Chicago)",
  );
  assert.equal(latestOutputBlock(text), null);
  assert.equal(classifyLimit(text), 'reset');
});

test('the shipped limitScreen fixture still classifies as reset', () => {
  assert.equal(classifyLimit(limitScreen(3)), 'reset');
});

// ---------------------------------------------------------------------------
// Fast-mode notices. Fast mode is a separate high-speed pool; when it is
// exhausted the session keeps running on the normal model, so nothing here
// should engage the plugin.
// ---------------------------------------------------------------------------

test('fast-mode rate_limit notice must not arm a wait', () => {
  assert.equal(classifyLimit('⏺ Fast limit reached and temporarily disabled · resets in 8m'), null);
});

test('"You\'ve hit your fast limit" must not arm a wait', () => {
  assert.equal(classifyLimit("⏺ You've hit your fast limit · resets in 8m"), null);
});

test('fast-mode overloaded notice must not be treated as an API transient', () => {
  assert.equal(classifyLimit('⏺ Fast mode overloaded and is temporarily unavailable · resets in 8m'), null);
});

// ---------------------------------------------------------------------------
// Usage-percentage warnings (D16) and spend/credit notices where waiting is
// pointless because no reset will unblock the pane.
// ---------------------------------------------------------------------------

test('usage-percentage warnings stay inert across every window name', () => {
  assert.equal(classifyLimit("You've used 90% of your session limit · resets 3pm"), null);
  assert.equal(classifyLimit("You've used 75% of your Opus limit · resets Wed 9am"), null);
  assert.equal(classifyLimit("You've used 97% of your session limit · resets 6pm · /upgrade to keep using Claude Code"), null);
});

test('spend-limit notices with no reset are inert', () => {
  assert.equal(classifyLimit("⏺ You've hit your monthly spend limit. Run /usage-credits to manage your limit and keep using Opus or switch models to continue this chat."), null);
  assert.equal(classifyLimit("⏺ You've hit your monthly spend limit. /model to switch models."), null);
});

test('out-of-credits notices with no reset are inert', () => {
  assert.equal(classifyLimit("⏺ You're out of usage credits. Switch to another model to continue."), null);
  assert.equal(classifyLimit('⏺ Your org is out of usage · add funds to continue'), null);
  assert.equal(classifyLimit("⏺ Your group's usage limit is set to $0 · ask your admin"), null);
});

test('a monthly spend cap that quotes a different window\'s reset must not arm that wait', () => {
  assert.equal(classifyLimit("⏺ You've hit your monthly spend limit · your session limit resets 3pm"), null);
});

test("Claude Code's own auto-continue banner must not double-arm", () => {
  // Claude Code is already holding the turn and will resume itself; a second
  // waiter would fire Escape into its countdown.
  assert.equal(classifyLimit('Usage limit reached · continuing automatically at 3pm · esc to cancel'), null);
  assert.equal(classifyLimit('Usage limit reached · continuing automatically when it resets · esc to cancel'), null);
  assert.equal(classifyLimit('Usage limit reached · continuing shortly · esc to cancel'), null);
  assert.equal(classifyLimit('Your usage limit has reset · press enter to continue'), null);
});

// ---------------------------------------------------------------------------
// Text that merely talks about limits.
// ---------------------------------------------------------------------------

test('a limit banner in scrollback above a newer block is ignored', () => {
  const text = pane(
    "⏺ You've hit your session limit · resets 3pm (America/Chicago)",
    '',
    '⏺ Retried and the suite is green now.',
    '',
    '❯',
  );
  assert.equal(classifyLimit(text), null);
  assert.equal(limitInLatestBlock(text), false);
});

test("a user's draft mentioning a limit is filtered with the prompt line", () => {
  const text = pane(
    '⏺ Ready.',
    '',
    "❯ why did we hit the session limit yesterday, does it reset at 3pm?",
  );
  assert.equal(classifyLimit(text), null);
});

test("a wrapped draft whose continuation line escapes the ❯ filter stays inert", () => {
  const text = pane(
    '⏺ Ready.',
    '',
    '❯ Please document that when we hit the session',
    '  limit it resets at 3pm and the plugin waits.',
  );
  assert.equal(classifyLimit(text), null);
});

test('prose about rate limits in the newest block must not arm a wait', { todo: 'classifyLimit returns "reset"; a sentence describing the feature is indistinguishable from the banner once both keywords land on one line' }, () => {
  const text = '⏺ Documented it: when you hit your session limit, the plugin sleeps until it resets at 3pm and then nudges the pane.';
  assert.equal(classifyLimit(text), null);
});

test('a README quoting "rate limit" and "try again in" must not arm a wait', { todo: 'a limit name and a retry time on one line is indistinguishable from a banner by text; the stopped-pane gate and the two-poll confirm are the mitigation' }, () => {
  const text = pane(
    '⏺ Read(README.md)',
    '  ⎿  ## Rate limits',
    '     If Claude reports a rate limit, try again in 5 minutes.',
  );
  assert.equal(classifyLimit(text), null);
});

test('a lone "try again in <n> minutes" sentence must not arm a wait', () => {
  assert.equal(classifyLimit('⏺ Done. If the push flakes, try again in 5 minutes.'), null);
});

// ---------------------------------------------------------------------------
// Tables (D29) versus boxes and pipe-heavy status lines (D25).
// ---------------------------------------------------------------------------

test('a rendered markdown table describing limits is never a candidate', () => {
  const text = pane(
    '⏺ Here is the incident table:',
    '  ⎿  | Window | Symptom                | Recovery       |',
    '     | 5h     | hit your session limit | resets at 3pm  |',
    '     | 7d     | weekly limit reached   | resets 9am     |',
  );
  assert.equal(classifyLimit(text), null);
});

test('a box-drawn table with │ separators is never a candidate', () => {
  const text = pane(
    '⏺ Usage report:',
    '  │ Window │ State                  │ Resets │',
    '  │ 5h     │ hit your session limit │ 3pm    │',
  );
  assert.equal(classifyLimit(text), null);
});

test('a wide table wrapped across rows is still never a candidate', () => {
  const text = pane(
    '⏺ Plan:',
    '  | Cause                  | Action        |',
    '  | hit your session limit | wait until it |',
    '  | resets at 3pm          | then resume   |',
  );
  assert.equal(classifyLimit(text), null);
});

test('the boxed /rate-limit-options menu (2 borders per line) still fires', () => {
  const text = pane(
    '╭──────────────────────╮',
    "│ You've hit your session limit           │",
    '│ · resets 6:50pm (Europe/London)         │',
    '│ What do you want to do?                 │',
    '│ ❯ 1. Wait for the reset                 │',
    '╰──────────────────────╯',
  );
  assert.equal(classifyLimit(text), 'reset');
});

test('a pipe-heavy status line (no leading pipe) still yields the reset time', () => {
  const text = pane(
    "⏺ You've hit your session limit",
    '  5h: 100% | 7d: 41% | ctx: 12% | resets at 3:05pm (America/Chicago)',
  );
  assert.equal(classifyLimit(text), 'reset');
  assert.equal(findRateLimitMessage(text), '5h: 100% | 7d: 41% | ctx: 12% | resets at 3:05pm (America/Chicago)');
});

// ---------------------------------------------------------------------------
// TUI shapes.
// ---------------------------------------------------------------------------

test('a narrow terminal wrapping the banner before the "· resets" clause', () => {
  const text = pane(
    "⏺ You've hit your session limit",
    '  · resets 3:00pm (America/Chicago)',
  );
  assert.equal(classifyLimit(text), 'reset');
});

test('a narrow terminal wrapping the banner between "resets" and the time', { todo: 'isRateLimited returns false; RESET_PATTERNS require the digits on the same line as "resets", so a 40-column wrap hides a real limit' }, () => {
  const text = pane(
    "⏺ You've hit your session limit · resets",
    '  3:00pm (America/Chicago) · /upgrade to',
    '  keep using Claude Code',
  );
  assert.equal(classifyLimit(text), 'reset');
});

test('a task list between the block and the input box does not hide the limit (D18)', () => {
  const text = pane(
    "⏺ You've hit your weekly limit · resets 9am (UTC)",
    '',
    '  ☐ wire the adapter',
    '  ☐ backfill the fixtures',
    '  ☐ land the release notes',
    '  ☐ update the changelog',
    '  ☐ re-run the suite',
    '',
    '──────────',
    '❯',
    '──────────',
  );
  assert.equal(classifyLimit(text), 'reset');
});

test('notification and tip lines under the status line stay inert', () => {
  const text = pane(
    '⏺ All tests pass.',
    '',
    '❯',
    '  Tip: run /rate-limit-options to choose what happens when you hit your session limit',
  );
  assert.equal(classifyLimit(text), null);
});

test('an ANSI-coloured banner is detected once stripped', () => {
  const raw = "⏺ \x1b[1;31mYou've hit your session limit\x1b[0m · \x1b[2mresets 3pm (UTC)\x1b[0m";
  assert.equal(stripAnsi(raw), "⏺ You've hit your session limit · resets 3pm (UTC)");
  assert.equal(classifyLimit(raw), 'reset');
  assert.equal(findRateLimitMessage(raw), "⏺ You've hit your session limit · resets 3pm (UTC)");
});

test('an OSC title sequence carrying limit text does not leak into detection', () => {
  const raw = pane('\x1b]0;claude - session limit resets 3pm\x07⏺ Build finished.', '', '❯');
  assert.equal(classifyLimit(raw), null);
});

// ---------------------------------------------------------------------------
// Transient API failures.
// ---------------------------------------------------------------------------

test('529 overloaded_error envelope', () => {
  const text = '⏺ API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  assert.equal(classifyLimit(text), 'transient');
  assert.ok(agentErrorBlock(text));
});

test('the "Repeated 529 Overloaded errors" summary', () => {
  assert.equal(classifyLimit('⏺ Repeated 529 Overloaded errors · https://status.claude.com'), 'transient');
});

test('a 500 internal server error', () => {
  assert.equal(classifyLimit('⏺ API Error: 500 Internal server error'), 'transient');
});

test('a 503 from an upstream gateway', () => {
  assert.equal(classifyLimit('⏺ API Error: 503 upstream overloaded'), 'transient');
});

test('a 429 rate_limit_error from the API (not a subscription window)', () => {
  assert.equal(classifyLimit('⏺ API Error: 429 {"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}'), 'transient');
});

test('the "Server is temporarily limiting requests (not your usage limit)" notice', () => {
  // Carries the words "usage limit" but no reset time; it must land as transient, never as a reset wait.
  assert.equal(classifyLimit('⏺ Server is temporarily limiting requests (not your usage limit)'), 'transient');
});

test('an API connection error', () => {
  assert.equal(classifyLimit('⏺ API Error: Connection error.'), 'transient');
});

test('a dropped connection mid-stream', () => {
  assert.equal(classifyLimit('⏺ API Error: Unable to connect to API. Check your internet connection'), 'transient');
});

test('the high-load model-switch advisory shown after repeated 529s', () => {
  assert.equal(classifyLimit('⏺ Opus is experiencing high load, please use /model to switch to Sonnet'), 'transient');
});

test('a 4xx client error is not transient', () => {
  assert.equal(classifyLimit('⏺ API Error: 400 duplicate tool_use ID in conversation history.'), null);
  assert.equal(classifyLimit('⏺ API Error: 401 Invalid API key · Please run /login'), null);
  assert.equal(classifyLimit('⏺ API Error: 403 blocked by your organization\'s policy'), null);
});

test('a tool result that merely quotes an API error is not an agent error', () => {
  const text = pane(
    '⏺ Bash(curl -s https://api.example.com/v1/messages)',
    '  ⎿  {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  );
  // agentErrorBlock is the gate the monitor uses; it requires the ⏺ line itself to
  // carry the failure, so a curl output quoting one cannot take the pane over.
  assert.equal(agentErrorBlock(text), null);
});

test('"temporarily unavailable" from a subsystem is not an API transient', () => {
  assert.equal(classifyLimit('⏺ The memory store is temporarily unavailable. Try again later.'), null);
  assert.equal(classifyLimit('⏺ Publish service temporarily unavailable'), null);
});

// ---------------------------------------------------------------------------
// Message extraction.
// ---------------------------------------------------------------------------

test('the nearest reset line wins when several are on screen', () => {
  const text = pane(
    '⏺ Quota check:',
    '  resets in 12m',
    '  (stale reading)',
    "  You've hit your weekly limit",
    '  resets at 9am (America/Chicago)',
  );
  assert.equal(findRateLimitMessage(text), 'resets at 9am (America/Chicago)');
});

test('a reset line 8 rows from the limit line falls back to the last reset line', () => {
  const text = pane(
    "⏺ You've hit your weekly limit",
    '  building the plan',
    '  reading src/patterns.js',
    '  reading src/monitor-core.js',
    '  reading src/registry.js',
    '  reading src/herdr.js',
    '  reading bin/main.js',
    '  writing the summary',
    '  resets at 9am (UTC)',
  );
  // Outside WINDOW, so nothing arms, but the reported line is still the reset.
  assert.equal(classifyLimit(text), null);
  assert.equal(findRateLimitMessage(text), 'resets at 9am (UTC)');
});

test('with no reset line at all the limit line itself is reported', () => {
  assert.equal(findRateLimitMessage("⏺ You've hit your session limit."), "⏺ You've hit your session limit.");
});

test('with neither a limit nor a reset the transient line is reported', () => {
  assert.equal(findRateLimitMessage('⏺ API Error: 529 Overloaded'), '⏺ API Error: 529 Overloaded');
});

test('table rows are never picked as the reported message', () => {
  const text = pane(
    "⏺ You've hit your session limit · resets 3pm (UTC)",
    '  | Window | Resets |',
    '  | 5h     | resets at 9am |',
  );
  assert.equal(findRateLimitMessage(text), "⏺ You've hit your session limit · resets 3pm (UTC)");
});

test('an empty or marker-free screen reports nothing', () => {
  assert.equal(findRateLimitMessage(''), null);
  assert.equal(classifyLimit(''), null);
  assert.equal(latestOutputBlock(''), null);
  assert.equal(classifyLimit('❯\n─────\n  proj git:(main) | Opus 5 | ctx: 4%'), null);
});
