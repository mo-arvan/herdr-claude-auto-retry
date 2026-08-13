# AGENTS.md - herdr-claude-auto-retry

## Overview

A [herdr](https://herdr.dev) plugin that auto-resumes Claude Code panes after an Anthropic rate limit or a transient server error. It is a herdr-native reimplementation of the unmaintained, tmux-based [`cheapestinference/claude-auto-retry`](https://github.com/cheapestinference/claude-auto-retry). herdr already multiplexes terminals and exposes agent detection + pane read/send over its CLI, so we talk to herdr directly instead of nesting tmux. `README.md` is the user-facing doc; this file is the agent operating manual.

## Commands

- `npm test` - 86 tests, Node's built-in runner, zero dependencies.
- `herdr plugin link .` - load the working tree into a running herdr for live testing.
- `herdr plugin action invoke claude-auto-retry.<watch-all|arm|status|stop|logs>` - drive the actions.
- Local E2E without a herdr server: point `HERDR_BIN_PATH` at `test/fixtures/fake-herdr.js` (serves canned `pane list/get/read` JSON, records `send-*`); drive the monitor with `node bin/main.js monitor <terminalId> <paneId>`.

## Layout

- `herdr-plugin.toml` - manifest: two event hooks (`pane.agent_detected` + `pane.agent_status_changed`, both -> `hook-agent-detected`; D12) + five actions, all run via `["/bin/sh", "launch.sh", "<subcommand>"]`.
- `launch.sh` - POSIX node resolver (fnm/nvm/mise/asdf/volta/`$HERDR_NODE`); see D5. Runs `bin/main.js <subcommand>`.
- `bin/main.js` - the single entrypoint: dispatches the hook, the actions, and the long-lived `monitor` subcommand (D6). Thin glue; logic lives in `src/`.
- `src/monitor-core.js` - the transport-agnostic rate-limit state machine (the unit-tested core).
- `src/herdr.js` - the herdr CLI adapter.
- `src/registry.js` - atomic per-`terminal_id` monitor lock (exactly one monitor per pane).
- `src/{patterns,time-parser}.js` - detection and reset-time math.

## Conventions

- ESM (`"type": "module"`), Node `>= 18`, no runtime dependencies (built-ins only).
- All herdr access goes through `src/herdr.js`; never shell out to `herdr` elsewhere.
- Behavioral logic goes in `src/` (pure, unit-tested with a fake adapter); `bin/main.js` only wires I/O. It is covered by `test/e2e-monitor.test.js`, which spawns the real entrypoint against `fake-herdr`.

## Gotchas

- Plugin event hooks can only subscribe to herdr's `PLUGIN_HOOK_EVENT_KINDS`; `pane.output_changed` is deliberately excluded (too high-volume). So activation is `pane.agent_detected` + `pane.agent_status_changed` (D12) + a polling monitor, not output-change events.
- Recovery vs still-stuck is read from the screen structure, not a timer: `✻ Cogitated/Worked/... for Xs` is Claude's thinking-time spinner (shown for any turn, success or failure) and is NOT a recovery line; a non-error `⏺`/`⎿` output is. `latestOutputBlock` keys on this so the monitor's own nudge (echoed in the `❯` input line) and an old error lingering above a fresh response never read as a live error (D13).
- Do **not** use `herdr pane run` for recovery: it submits text+Enter atomically, which trips Claude's paste detection. Use `send-text`, pause, then `send-keys enter`.
- **Detection is gated on the pane being STOPPED (`eligibleStates`, default idle/blocked/done) - never `working` (D8), with one narrow exception (D17): a `reset` limit that is the LATEST output block arms the wait from a `working` pane too, because Claude Code holds a spinner up after the limit error while it drains queued work. Screen text alone must never trigger a SEND.** `working` is still force-stripped from `eligibleStates`, and the send itself remains gated on the pane being stopped. Text that merely talks about limits is excluded structurally: table rows are not limits (D19). The monitor scans only the last `detectionTailLines` lines of the `detection` buffer (D10), and `spawnMonitor` skips panes whose cwd is under `HERDR_PLUGIN_ROOT` (never monitor the plugin's own pane).
- The monitor claims its lock atomically (`claimSlot`, O_EXCL) at boot and exits if another live monitor owns the terminal; this prevents the double-monitor TOCTOU (D7). `spawnMonitor`'s pre-check is only an optimization.
- `herdr.paneRead` returns `null` on a failed read; `monitor-core` must never treat null/empty as "limit cleared", and must not read the pane while merely waiting before the deadline (D7). Nor is a banner that simply went missing "limit cleared": standing down needs positive evidence (D18).
- herdr response envelopes are `{ result: { pane | panes | ... } }`; `pane read` returns raw text, not JSON.
- herdr pane ids look like `w653bef821f1951:p1` and terminal ids like `term_...`. Keep id handling format-agnostic (pass the opaque strings straight back); `registry.js` sanitizes `:` in lock filenames.
- herdr runs plugin commands with no shell and the server PATH; never assume `node` (or any tool) is on PATH. Go through `launch.sh` (D5).

## Decisions

Design decisions with non-obvious rationale, cited elsewhere as `D<n>`.

- **D1**: Event-driven plugin (`pane.agent_detected` hook -> detached per-pane monitor) instead of tmux + an injected `claude()` shell function, because herdr is the multiplexer and exposes agent detection + pane I/O; this removes the nested-tmux and injected-shell-wrapper failure modes by construction.
- **D2**: Key monitors by herdr `terminal_id`, not public pane id, because pane ids compact when panes close.
- **D3**: Recovery sends Escape, then text, then Enter as separate herdr calls, fixing the `/rate-limit-options` menu (a bare Enter would confirm "Upgrade your plan") and the paste-detection submit failure.
- **D4**: `calculateWaitMs` converts the wall-clock reset to a UTC instant via the zone's actual offset, fixing the ~24h over-wait in east-of-UTC zones.
- **D5**: Run every manifest command through `launch.sh` via absolute `/bin/sh`, because herdr spawns plugin commands with no shell and the server's PATH (often no version-manager node). Internally-spawned monitors use `process.execPath`, so only manifest commands need the launcher.
- **D6**: One `bin/main.js` dispatcher for the hook, the actions, and the long-lived `monitor` (launch.sh passes the subcommand), for less code. Correct `monitor` argv indexing and per-command exit semantics (the hook never fails).
- **D7**: Reliability hardening: atomic single-monitor claim (TOCTOU); never treat a failed/empty read as "limit cleared"; don't read the pane while waiting before the deadline; cooperative SIGTERM (finish the recovery send); stale-lock detection; extract the reset line nearest the most recent limit. The double `stripAnsi` is kept deliberately (it is not idempotent on doubled-ESC input).
- **D8**: Gate detection on the pane being STOPPED (default idle/blocked/done, never `working`) and read the `detection` buffer, not screen text. A real limit stops Claude (idle, or blocked for the menu); an actively working pane showing limit-like text must never fire. `working` is the load-bearing exclusion (force-stripped in config validation).
- **D9**: One sidebar indicator only - a single `retry engaged` custom-status set while a monitor waits and the pane is still eligible, cleared on resume/shutdown, TTL-refreshed each tick so a dead monitor's label expires.
- **D10**: Anchor detection to the live screen footer (`detectionTailLines`, default 15) and never monitor the plugin's own pane (cwd under `HERDR_PLUGIN_ROOT`) - a session editing this plugin inherently shows limit-like text. The real limit sits in the bottom lines while transcript text is higher up, so footer-only matching separates them.
- **D11**: Classify limits as `reset` (subscription/usage, has a reset time -> wait it out) vs `transient` (server throttle/overload/5xx/429/connection drop, no reset -> short wait), via `classifyLimit`. `transient` covers only RETRYABLE errors, never 4xx (a retry is pointless); connection-error patterns anchor to the `API Error:` prefix so bare prose never matches. A transient is logged/labelled a "server error", not a "rate limit". Its one-nudge cap is superseded by D13.
- **D12**: Hook both `pane.agent_detected` and `pane.agent_status_changed`, and the shared handler re-establishes coverage for ALL Claude panes on activity - a full sweep, rate-limited to once per `SWEEP_INTERVAL_MS` across hook fires via a `last-sweep` stamp - not just the pane that changed. herdr emits NO event when it restores panes after a restart (verified in its source, `persist/restore.rs`), so `agent_detected` never re-fires and a monitor that died then is otherwise never replaced; the activity-triggered sweep closes that gap (spawning one monitor for the changed pane alone would leave every idle pane uncovered). Deduped by the lock; early-exits on non-Claude panes via event context to bound volume; `watch-all` stays the instant manual sweep.
- **D13**: Transient handling reads the live screen structure: (a) the retry message is neutral ("Continue where you left off.") with NO detector keyword, because Claude echoes it into the `❯` input line and a keyword would make the monitor re-detect its own nudge; (b) transient detection anchors to the latest `⏺`/`⎿` output block (`latestOutputBlock`) - a non-error output means recovered - so an old error lingering above a fresh response no longer reads as still-erroring; (c) transient nudges are unlimited with exponential backoff (`transientWaitSeconds` doubling to a `transientMaxWaitSeconds` cap), so a long outage auto-recovers without hammering. Supersedes D11's one-nudge cap.
- **D14**: A monitor self-terminates when a different live process owns its lock (`lockHeldByOther`, checked each tick), and `shutdown` releases the lock/label only if it still owns them. Prevents a frozen-then-resumed monitor (e.g. after the machine sleeps and a fresh monitor reclaims its stale lock) from lingering as a lockless duplicate that double-sends or survives `stop`.
- **D17**: Detection is no longer gated purely on the pane being stopped. A `reset` limit that is the latest output block arms the wait even while herdr reports `working`, because Claude Code keeps a spinner up after the limit error as it drains queued teammate messages: observed live, that hid a session limit for 6.5 minutes (20:37:41 -> 20:44:19) and the plugin only saw it when a second delivery re-printed the banner. Arming from a `working` pane is safe because it only schedules - the send is still gated on the pane being stopped when the deadline passes. The exception is deliberately narrow: `latestOutputBlock` only (scrollback is not news, and D8's whole-window scan would match any conversation about limits), and `reset` only (a transient error on a busy pane is Claude Code's own retry to make, not ours).
- **D18**: Standing down from a wait requires positive evidence that the session moved on - the pane is busy again, or its latest output block changed since the limit was seen - not merely the absence of the banner. The banner leaves the detection window on its own (~10 of the last 15 lines of a Claude pane are chrome: input box, statusline, mode hints), and reading that as "the user continued" silently skipped the one send the plugin exists for, under a log line identical to a genuine manual resume. The fingerprint is the latest output block with digits normalised, so an idle pane's own redraws (spinner, usage counters, `-- INSERT --`) are not mistaken for activity, and `user-continued` now logs which of the two reasons fired.
- **D19**: A rendered table row (three or more `|`/`│` column separators in one line) is never a limit candidate. Observed live: a pane writing up an incident report about this plugin rendered a markdown timeline, and the row `│ │ session limit · resets 8:50pm) │ │` armed a 7h wait - D10's footer anchoring does not help when the text under discussion IS the footer, and D10's own mitigation (never monitor the plugin's own pane) does not cover a pane merely writing about limits. Claude Code renders its banner as a bare line; its boxed `/rate-limit-options` menu has two borders per line, so the three-separator threshold leaves a genuine boxed limit alone.
- **D16**: A "You've used N% of your ... limit" banner is a proactive usage warning, not a blocked state, so `USAGE_WARNING` excludes those lines from limit detection. Claude prints it in the persistent status line, so it sits in the footer of a perfectly healthy idle pane; a week of live logs showed every single rate-limit activation was one of these (75% / 80% / 97%), and one sat in `waiting 4h` and would have injected into a fine session had the pane not closed first (a false engage also blinds the monitor to a real limit on that pane until the deadline). A real blocked limit says "hit" / "reached" and still fires. `customPatterns` short-circuits ahead of the built-ins, so config can force-detect a percentage form if Claude ever blocks with one.
- **D15**: The monitor reloads config at the top of every tick (`loadConfig` is cheap and the monitor already polls), so config edits - especially `customPatterns` / `customTransientPatterns` for when Claude's wording changes - take effect within one poll with no restart. Deliberately no `fs.watch`: it is fragile across editors' atomic-save renames and across platforms, and the poll loop already exists.

## References

- Config reference, incl. extending detection via `customPatterns` / `customTransientPatterns` when Claude's wording changes: [`docs/configuration.md`](docs/configuration.md).
- Diagnostics and common failure modes (symptom -> check -> fix): [`docs/troubleshooting.md`](docs/troubleshooting.md).

