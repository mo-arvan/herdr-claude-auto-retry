# Changelog

Notable changes, newest first. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- The engaged label never appeared. `herdr pane report-metadata` dropped `--custom-status` and
  `--clear-custom-status` in herdr 0.7.4, so every label call failed with `unknown option`. Because
  `run()` resolves on any exit code and the result is not inspected, the failure was silent: retries
  worked, the label did not. The label is now reported as a `retry` pane token
  (`--token retry=…` / `--clear-token retry`), and `min_herdr_version` moves to `0.7.4` accordingly.
  Tokens render where the user places `$retry` in `[ui.sidebar.agents]`, which the docs now cover.

## [1.0.0] - 2026-07-02

Initial release.

herdr-claude-auto-retry is a herdr-native replacement for the unmaintained, tmux-based [`claude-auto-retry`](https://github.com/cheapestinference/claude-auto-retry). It waits out an Anthropic rate limit or a transient server error (a throttle, an overload, a 5xx, or a dropped connection) and resumes the Claude Code pane. Activation is a herdr event hook, so there is no tmux and no injected shell wrapper. The plugin has zero runtime dependencies and ships with 86 tests.

[1.0.0]: https://github.com/mo-arvan/herdr-claude-auto-retry/releases/tag/v1.0.0
