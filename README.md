# herdr-claude-auto-retry

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node: >=18](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json) [![tests: 86 passing](https://img.shields.io/badge/tests-86%20passing-brightgreen.svg)](test/) [![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

> Wait out Anthropic rate limits and auto-resume Claude Code, the herdr-native way: no tmux, no shell wrapper.

Claude Code stops when it hits an Anthropic rate limit or a transient server error (a throttle, an overload, a 5xx, a dropped connection). This [herdr](https://herdr.dev) plugin waits the limit out and resumes the session for you. You come back to find the work continued. It is a herdr-native rewrite of the unmaintained, tmux-based [`claude-auto-retry`](https://github.com/cheapestinference/claude-auto-retry).

## Install

Requires herdr `>= 0.7.0` and Node `>= 18`.

```bash
herdr plugin install mo-arvan/herdr-claude-auto-retry    # or: herdr plugin link /path/to/checkout
herdr plugin action invoke claude-auto-retry.watch-all   # attach to already-open Claude panes
```

New Claude panes are picked up automatically. Every command runs through `launch.sh`, which finds node on `PATH` or in the usual version-manager dirs (fnm/nvm/mise/asdf/volta). Set `HERDR_NODE` to node's path if it cannot.

## How it works

A herdr event hook starts a small detached monitor for each Claude pane. The monitor acts only when herdr reports the pane stopped, never while it is working, so it cannot fire on a pane that merely displays rate-limit-like text. It reads the live footer to separate a real rate limit or server error from ordinary output. For a rate limit, it waits out the reset time. For a server error, it retries with exponential backoff, up to five minutes. It resumes by sending Escape, the message, and Enter as separate keystrokes, which sidesteps Claude's paste detection and the `/rate-limit-options` menu. It reads recovery off the screen, so it never re-pokes a session that already came back. Coverage self-heals after a herdr restart. A pane that is waiting shows a single `retry engaged` label.

## Commands

```bash
herdr plugin action invoke claude-auto-retry.watch-all   # watch all Claude panes
herdr plugin action invoke claude-auto-retry.arm         # watch the focused pane
herdr plugin action invoke claude-auto-retry.status      # active monitors + recent activity
herdr plugin action invoke claude-auto-retry.stop        # stop all monitors
herdr plugin action invoke claude-auto-retry.logs        # recent log lines
```

Every herdr CLI call wraps its output in a JSON envelope, so `status` and `logs` read cleanest from herdr's UI (menu or keybinding). To read monitor activity as plain text from a shell, tail the log file directly (under herdr's plugin state directory):

```bash
tail -f ~/.local/state/herdr/plugins/claude-auto-retry/logs/*.log
```

## Configuration

Configuration is optional; every key has a sensible default. See [docs/configuration.md](docs/configuration.md) for all options. If a Claude Code wording change ever stops detection, add the new phrasing to `customPatterns` (usage limits) or `customTransientPatterns` (server errors) in the config file - no code change, and it survives upgrades.

## Notes

- Recovery types the configured message at the prompt. If Claude is in some other interactive state when the limit clears, the message may not resume it. Tune `retryMessage` and `eligibleStates` for your setup.
- Supported on Linux and macOS. herdr's Windows support is beta.
- Something not working? See [docs/troubleshooting.md](docs/troubleshooting.md).
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). License: [MIT](LICENSE).
