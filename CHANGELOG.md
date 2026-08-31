# Changelog

Notable changes, newest first. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-08-31

- The engaged label never appeared. `herdr pane report-metadata` dropped `--custom-status` and
  `--clear-custom-status` in herdr 0.7.4, so every label call failed with `unknown option`. Because
  `run()` resolves on any exit code and the result is not inspected, the failure was silent: retries
  worked, the label did not. The label is now reported as a `retry` pane token
  (`--token retry=...` / `--clear-token retry`). Tokens render where the user places `$retry` in
  `[ui.sidebar.agents]`, which the docs now cover.
- A rate limit that lands while the pane is still busy is no longer missed. Claude Code keeps its
  spinner up after a limit error while it drains queued work, and detection used to wait for the pane
  to go idle - observed hiding a session limit for 6.5 minutes. A `reset` limit that stays the latest
  thing Claude printed across two consecutive checks now arms the wait early; the resume itself
  still waits for the pane to actually stop.
- A rendered table row about rate limits is no longer mistaken for one. A pane writing an incident
  report armed a 7-hour wait on its own markdown table; a line with three or more column separators
  is now never a limit candidate, while the boxed `/rate-limit-options` menu (two borders per line)
  still detects.
- Recovery no longer loses the first character of `retryMessage` when Claude Code runs in vim editor
  mode. The Escape that dismisses the `/rate-limit-options` menu also switches the input line to
  NORMAL, where the first character is executed as a vim command rather than typed, so Claude
  received `ontinue where you left off.`. The message is now read back off the `❯` input line and
  retyped once when its first character is missing (`verifyInput`, default `true`).

## [1.1.0] - 2026-08-31

Reliability fixes from live use. All came from real stalls that the shipped release missed.

**Now requires herdr `>= 0.7.5`** (was `0.7.0`), for the `[[startup]]` hook below.

- Re-attach monitors as soon as herdr finishes restoring a session, using the `[[startup]]` hook added in herdr 0.7.5. herdr emits no event for restored panes, so coverage used to wait on the first pane activity: after one observed restart that left every pane unmonitored for 11 minutes.
- Log files are now named by local date instead of UTC, so an evening entry no longer lands in the next day's file.
- Detect a transient server error even when a long task list pushes it out of the footer window. Detection now anchors to the latest on-screen output block rather than a fixed line count, and reads more lines. A stalled session with ten tracked tasks put the error 18 lines up, outside the 15-line window, and went unrecovered.
- Keep the retry backoff and the stalled-session timer across a monitor restart. A monitor is replaced whenever the machine sleeps long enough for its lock to expire, and its progress used to reset each time, so the exponential backoff never escalated past its first step and the stalled-session takeover could never reach its threshold overnight. That state now lives in the monitor's lock file and is handed to its replacement.
- Measure a stalled session by how long it was actually watched, not by elapsed wall-clock. Sleeping the machine no longer counts toward the stall timer, so waking it cannot make the plugin treat a session that is merely mid-turn as stuck. A session it has just resumed is also given a fresh window before it can be nudged again.
- Wait out a rate limit for its real duration. A limit shown in the status line could be detected but not read, so the plugin fell back to a fixed five-hour wait and logged nothing about it.
- Keep resuming a session after the plugin restarts. Two different retry budgets shared one counter, so a monitor that took over from another could believe it had already used up its attempts and never resume the pane at all.
- Leave a session alone while it is running a long command, even if that command's output mentions a server error.
- Never read what you are typing. A half-written prompt that happens to mention an error no longer looks like an error, so the plugin cannot engage on your draft or submit it for you.
- Survive a herdr restart without losing a session's retry progress. A momentary failure to list panes used to look identical to the pane closing, which shut the monitor down and discarded what it knew about the outage.
- Never resume a session that is waiting on you. A pane sitting at a permission prompt is left alone even if an older error is still on screen; only a real rate-limit menu is acted on.
- Stop sending Escape to sessions that are not waiting at a prompt. Escape interrupts a running turn, and it was previously sent on every resume; it is now sent only when the pane is blocked, which is the only case it was ever needed for. Resuming a session that turns out to be busy now just queues a message instead of cancelling its work.
- Detect server errors that appear in the status line again. Anchoring detection to the newest block of output stopped the plugin seeing errors rendered below it, which meant several common server-error wordings went unnoticed in 1.0.0-era sessions. It now reads both.
- Take over a pane herdr reports as `working` when it is actually stalled. herdr infers `working` from a spinner glyph in the terminal title, which Claude Code leaves stale after a connection drops, so a dead turn looked busy. Such a pane is resumed only after its latest output has been the same transient error, with no new output, for `stuckWorkingMinutes` (default 5); a genuinely working pane keeps producing output and never qualifies. Set `handleStuckWorking` false to opt out.

## [1.0.0] - 2026-07-02

Initial release.

herdr-claude-auto-retry is a herdr-native replacement for the unmaintained, tmux-based [`claude-auto-retry`](https://github.com/cheapestinference/claude-auto-retry). It waits out an Anthropic rate limit or a transient server error (a throttle, an overload, a 5xx, or a dropped connection) and resumes the Claude Code pane. Activation is a herdr event hook, so there is no tmux and no injected shell wrapper. The plugin has zero runtime dependencies and ships with 86 tests.

[1.0.0]: https://github.com/mo-arvan/herdr-claude-auto-retry/releases/tag/v1.0.0
[1.1.0]: https://github.com/mo-arvan/herdr-claude-auto-retry/releases/tag/v1.1.0
[1.2.0]: https://github.com/mo-arvan/herdr-claude-auto-retry/releases/tag/v1.2.0
