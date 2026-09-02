# herdr-claude-auto-retry

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node: >=18](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json) [![tests](https://github.com/mo-arvan/herdr-claude-auto-retry/actions/workflows/test.yml/badge.svg)](https://github.com/mo-arvan/herdr-claude-auto-retry/actions/workflows/test.yml) [![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

> Wait out Anthropic rate limits and auto-resume Claude Code, the herdr-native way: no tmux, no shell wrapper.

Claude Code stops when it hits an Anthropic rate limit or a transient server error (a throttle, an overload, a 5xx, a dropped connection). This [herdr](https://herdr.dev) plugin waits the limit out and resumes the session for you. You come back to find the work continued. It is a herdr-native rewrite of the unmaintained, tmux-based [`claude-auto-retry`](https://github.com/cheapestinference/claude-auto-retry).

## Install

Requires herdr `>= 0.7.5` and Node `>= 18`.

```bash
herdr plugin install mo-arvan/herdr-claude-auto-retry    # or: herdr plugin link /path/to/checkout
herdr plugin action invoke claude-auto-retry.watch-all   # attach to already-open Claude panes
```

New Claude panes are picked up automatically. Every command runs through `launch.sh`, which finds node on `PATH` or in the usual version-manager dirs (fnm/nvm/mise/asdf/volta). Set `HERDR_NODE` to node's path if it cannot.

A plain install tracks the default branch, so reinstalling picks up whatever has landed since. To stay on one version instead, pin a release tag: `herdr plugin install mo-arvan/herdr-claude-auto-retry --ref <tag>` (tags are listed on the [releases page](https://github.com/mo-arvan/herdr-claude-auto-retry/releases)).

## How it works

A herdr event hook starts a small detached monitor for each Claude pane. It separates a real rate limit or server error from ordinary output by reading the newest block of Claude's output plus the status lines below it, so an error stays "live" only until Claude says something else. For a rate limit it waits out the reset time; for a server error it retries with exponential backoff, up to five minutes. It resumes by typing the message and pressing Enter as separate keystrokes, which sidesteps Claude's paste detection, and it reads the message back off the input line before submitting, so vim editor mode cannot swallow its first character. Escape is sent only when the pane is waiting at a prompt, because on a running turn it would interrupt the work. A pane that is genuinely busy is never typed into (a reset limit that is its latest output arms the wait early, without sending anything), and a pane waiting on you for a permission decision is never answered on your behalf. It reads recovery off the screen, so it never re-pokes a session that already came back. Coverage self-heals after a herdr restart. A pane that is waiting reports a single `retry engaged` label, shown once you add `$retry` to an agent row ([Configuration](docs/configuration.md#showing-the-engaged-label)).

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
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
