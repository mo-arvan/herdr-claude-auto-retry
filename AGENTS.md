# AGENTS.md - herdr-claude-auto-retry

## Overview

A [herdr](https://herdr.dev) plugin that auto-resumes Claude Code panes after an Anthropic rate limit or a transient server error. It is a herdr-native reimplementation of the unmaintained, tmux-based [`cheapestinference/claude-auto-retry`](https://github.com/cheapestinference/claude-auto-retry). herdr already multiplexes terminals and exposes agent detection + pane read/send over its CLI, so we talk to herdr directly instead of nesting tmux. `README.md` is the user-facing doc; this file is the agent operating manual.

## Commands

- `npm test` - Node's built-in runner, zero dependencies.
- `npm run preflight` (every release gate, read-only: git state, changelog, suite under `npm run coverage` floors, nothing skipped so the herdr and Claude contract tests ran, review checklist) and `npm run release -- X.Y.Z` (bump, promote the CHANGELOG, commit, tag - never push). Process and the judgment calls it cannot make: `CONTRIBUTING.md`.
- `npm run scan` - leak scan over tracked files; also runs in `npm test` and in `.githooks/pre-push` (enable with `git config core.hooksPath .githooks`).
- `herdr plugin link .` - load the working tree into a running herdr for live testing.
- `herdr plugin action invoke claude-auto-retry.<watch-all|arm|status|stop|logs>` - drive the actions.
- Local E2E without a herdr server: point `HERDR_BIN_PATH` at `test/fixtures/fake-herdr.js` (serves canned `pane list/get/read` JSON and records `send-*`; give it a `screen` and it becomes a small reactive Claude TUI model - vim mode, menu, input line, submit - so whole recoveries run end to end); drive the monitor with `node bin/main.js monitor <terminalId> <paneId>`.

## Layout

- `herdr-plugin.toml` - manifest: one `[[startup]]` hook (-> `watch-all`, D12), two event hooks (`pane.agent_detected` + `pane.agent_status_changed`, both -> `hook-agent-detected`; D12) + five actions, all run via `["/bin/sh", "launch.sh", "<subcommand>"]`. `min_herdr_version` is 0.7.5, the release that added `[[startup]]`. `test/release.test.js` keeps the manifest, the `HANDLERS` table, the two version fields, the CHANGELOG and the documented herdr floor in step.
- `launch.sh` - POSIX node resolver (fnm/nvm/mise/asdf/volta/`$HERDR_NODE`); see D5. Runs `bin/main.js <subcommand>`.
- `bin/main.js` - the single entrypoint: dispatches the hook, the actions, and the long-lived `monitor` subcommand (D6). Thin glue; logic lives in `src/`.
- `src/monitor-core.js` - the transport-agnostic rate-limit state machine (the unit-tested core).
- `src/herdr.js` - the herdr CLI adapter.
- `src/registry.js` - atomic per-`terminal_id` monitor lock (exactly one monitor per pane).
- `src/{patterns,time-parser}.js` - detection and reset-time math.
- **This repo is public and its fixtures are screenshots of real sessions.** Never paste a live pane capture in verbatim: keep the shape, replace the content. `scripts/scan-private.mjs` is the guard (generic patterns shipped; maintainer names in a gitignored `.private-markers`). Gitignored files that matter - `PROGRESS.md`, `.private-markers` - are symlinks into a private repo, so they are backed up without ever entering this history.
- `scripts/{release,changelog}.mjs` - the local half of the release; `.github/workflows/release.yml` is the remote half, triggered by the tag push. **A plain `herdr plugin install` takes the default branch, so pushing `main` is the release** and the only rollback is a revert. `plugin install --ref <branch|tag>` fetches a specific ref instead, which is what makes `next` a staging channel and lets a user pin a tag; there is still no `plugin update`, so refreshing means reinstalling.

## Conventions

- ESM (`"type": "module"`), Node `>= 18`, no runtime dependencies (built-ins only).
- All herdr access goes through `src/herdr.js`; never shell out to `herdr` elsewhere. `test/herdr-contract.test.js` runs that exact CLI surface against the real `herdr` when it is on PATH (skipped otherwise), so a renamed flag fails locally instead of in a release.
- Behavioral logic goes in `src/` (pure, unit-tested with a fake adapter); `bin/main.js` only wires I/O. It is covered by `test/e2e-monitor.test.js`, which spawns the real entrypoint against `fake-herdr`.

## Gotchas

- Plugin event hooks can only subscribe to herdr's `PLUGIN_HOOK_EVENT_KINDS`; `pane.output_changed` is deliberately excluded (too high-volume). So activation is `pane.agent_detected` + `pane.agent_status_changed` (D12) + a polling monitor, not output-change events.
- Recovery vs still-stuck is read from the screen structure, not a timer: `✻ Cogitated/Worked/... for Xs` is Claude's thinking-time spinner (shown for any turn, success or failure) and is NOT a recovery line; a non-error `⏺`/`⎿` output is. `latestOutputBlock` keys on this so the monitor's own nudge (echoed in the `❯` input line) and an old error lingering above a fresh response never read as a live error (D13).
- Do **not** use `herdr pane run` for recovery: it submits text+Enter atomically, which trips Claude's paste detection. Use `send-text`, pause, then `send-keys enter`. On the Escape path, recovery then reads the `❯` line back and retypes once if vim NORMAL mode ate the first character (D30).
- **Detection is gated on the pane being STOPPED (`eligibleStates`, default idle/blocked/done) - never `working` (D8). Screen text alone must never trigger a resume.** A real limit stops Claude (idle, or blocked for the menu); an actively working pane showing limit-like text must not fire. Two narrow carve-outs, both arming-only or evidence-gated: a `reset` limit that is the latest output block arms the wait from a `working` pane (D28), and a frozen transient error can take a `working` pane over after `stuckWorkingMinutes` (D17). A reset send always waits for a stopped pane (D31). A rendered table row (3+ `|`/`│` separators) is never a limit candidate (D29). `working` is force-stripped from `eligibleStates` in config validation. Detection reads the newest output block plus the footer below it, never older scrollback (D32), and `spawnMonitor` skips panes whose cwd is under `HERDR_PLUGIN_ROOT` (never monitor the plugin's own pane).
- The monitor claims its lock atomically (`claimSlot`, O_EXCL) at boot and exits if another live monitor owns the terminal; this prevents the double-monitor TOCTOU (D7). `spawnMonitor`'s pre-check is only an optimization.
- **A monitor process is routinely replaced, not long-lived**: any freeze past `STALE_MS` (60s, e.g. the machine sleeping) makes its lock reclaimable and the next sweep respawns the fleet. Anything that must outlive one process goes in the lock record via `carriedState` (D19), never in a process-local variable. Never prune a stale record just for being stale - it is the handoff, and `claimSlot` removes the record it replaces, so a successor must `readRecord` before claiming.
- `logger.js` names files by local date, never `toISOString()`: entries are stamped in local time, so a UTC filename throws every evening entry west of UTC into the next day's file and the log reads as if it jumped backwards.
- `herdr.paneRead` returns `null` on a failed read; `monitor-core` must never treat null/empty as "limit cleared", and must not read the pane while merely waiting before the deadline (D7).
- herdr response envelopes are `{ result: { pane | panes | ... } }`; `pane read` returns raw text, not JSON.
- herdr pane ids look like `w653bef821f1951:p1` and terminal ids like `term_...`. Keep id handling format-agnostic (pass the opaque strings straight back); `registry.js` sanitizes `:` in lock filenames.
- herdr runs plugin commands with no shell and the server PATH; never assume `node` (or any tool) is on PATH. Go through `launch.sh` (D5).

## References

- Design decisions, cited as `D<n>` throughout: [`docs/decisions.md`](docs/decisions.md).
- Config reference, incl. extending detection via `customPatterns` / `customTransientPatterns` when Claude's wording changes: [`docs/configuration.md`](docs/configuration.md).
- Diagnostics and common failure modes (symptom -> check -> fix): [`docs/troubleshooting.md`](docs/troubleshooting.md).

