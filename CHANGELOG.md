# Changelog

Notable changes, newest first. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Three detection fixes, each from a live miss on a Claude Code pane.

- A `reset` limit that is the latest output block now arms the wait even while herdr reports the pane as `working` (D17). Claude Code holds a spinner up after the limit error while it drains queued work, which hid a session limit for 6.5 minutes. The send is still gated on the pane being stopped.
- Standing down from a wait now requires positive evidence that the session moved on - the pane is busy, or its latest output block changed - instead of the banner simply no longer being visible (D18). The banner leaves a 15-line detection window on its own, and that silently skipped the resume. `user-continued` logs which reason fired, so the two cases are no longer indistinguishable in the log.
- A rendered table row (three or more column separators) is no longer a limit candidate (D19). A pane writing an incident report about rate limits armed a 7h wait on its own markdown table. A boxed `/rate-limit-options` menu has two borders per line and still detects.

## [1.0.0] - 2026-07-02

Initial release.

herdr-claude-auto-retry is a herdr-native replacement for the unmaintained, tmux-based [`claude-auto-retry`](https://github.com/cheapestinference/claude-auto-retry). It waits out an Anthropic rate limit or a transient server error (a throttle, an overload, a 5xx, or a dropped connection) and resumes the Claude Code pane. Activation is a herdr event hook, so there is no tmux and no injected shell wrapper. The plugin has zero runtime dependencies and ships with 86 tests.

[1.0.0]: https://github.com/mo-arvan/herdr-claude-auto-retry/releases/tag/v1.0.0
