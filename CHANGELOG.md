# Changelog

Notable changes, newest first. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-02

Initial release.

herdr-claude-auto-retry is a herdr-native replacement for the unmaintained, tmux-based [`claude-auto-retry`](https://github.com/cheapestinference/claude-auto-retry). It waits out an Anthropic rate limit or a transient server error (a throttle, an overload, a 5xx, or a dropped connection) and resumes the Claude Code pane. Activation is a herdr event hook, so there is no tmux and no injected shell wrapper. The plugin has zero runtime dependencies and ships with 86 tests.

[1.0.0]: https://github.com/mo-arvan/herdr-claude-auto-retry/releases/tag/v1.0.0
