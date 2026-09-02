# Troubleshooting

Start with what a working run looks like, so you know whether anything is actually wrong. If it is, gather state, then match a symptom.

## What a healthy run looks like

When the plugin is working, one monitor runs per Claude pane, and the log records the lifecycle of each recovery. A monitor starting:

```
[09:00:00] proj/p1  started (pid 12345)
```

A subscription rate limit, waited out and resumed:

```
[09:00:05] proj/p1  rate limit: "resets 3pm (UTC)" -> waiting 6h
[15:00:35] proj/p1  resumed (attempt 1)
[15:01:05] proj/p1  limit cleared; monitoring
```

A transient server error, retried with backoff until it clears:

```
[10:00:00] proj/p1  server error: "API Error: 500 Internal server error" -> retry in 60s
[10:01:00] proj/p1  nudged (attempt 1); next retry in 2m
[10:01:30] proj/p1  server error cleared; monitoring
```

While a monitor waits, its pane carries a `retry engaged` label, and the label clears the moment the session resumes. The label is a pane token, so it is only drawn if you added `$retry` to an agent row ([Configuration](configuration.md#showing-the-engaged-label)); `herdr pane get <pane_id>` shows it either way under `tokens`. If you see these log lines and the label, it is working. If not, continue below.

## Gather state

```bash
# Is the plugin linked, and are both event hooks registered?
herdr plugin list

# How many monitors are running, and how many locks exist? These should match
# (one per Claude pane, minus the plugin's own pane).
pgrep -fl 'main.js monitor' | wc -l
ls ~/.local/state/herdr/plugins/claude-auto-retry/monitors/

# What has the plugin been doing? This is the plain-text monitor log.
tail -50 ~/.local/state/herdr/plugins/claude-auto-retry/logs/*.log

# Did a hook or action fail? herdr captures each command's exit code and stderr.
herdr plugin log list --plugin claude-auto-retry --limit 20
```

## It is not triggering

Work through these in order; each has the command to check it.

- Is a monitor running for that pane? The log shows a `started` line for each. If none is running, run `herdr plugin action invoke claude-auto-retry.watch-all`.
- Is the pane stopped? The plugin sends only to `idle`, `blocked`, or `done` panes, never `working`. Read the state with `herdr pane get <pane-id>`. A `working` pane can still arm a wait, but only when the limit is the newest thing Claude printed; a limit sitting higher in a working pane's transcript will not fire.
- Is the limit text still live? Detection reads Claude's newest output block plus the footer below it (status lines included); a limit higher in the transcript is scrollback and is ignored. Inspect what the plugin sees with `herdr pane read <pane-id> --source detection --lines 40`.
- Does the wording still match? If the footer clearly shows a limit but nothing fires, Claude's phrasing may have changed. Add the new phrasing via config; see "The wording changed" below.
- Is it the plugin's own pane? A pane whose working directory is the plugin's own directory is never monitored, because it inherently shows limit-like text.

## The wording changed and detection stopped

Claude Code's on-screen text is not a stable API, so a phrasing the plugin looks for can stop matching after an update. Fix it from your config, without editing code: add the new wording to `customPatterns` (a usage limit) or `customTransientPatterns` (a server error). Running monitors re-read the config each poll, so the change takes effect within a few seconds, and the config file survives plugin upgrades. Full recipe, with a snippet to test a pattern against a live pane, is in [configuration.md](configuration.md#adjusting-detection-when-claudes-wording-changes).

## Monitors disappeared or coverage dropped

- A herdr restart gives panes new terminal ids and retires the old monitors. Coverage self-heals on the next pane activity (the hook re-sweeps every pane, rate-limited), and `watch-all` re-attaches everything immediately.
- Compare the monitor count to the number of Claude panes (`herdr pane list`). A large gap means several monitors are missing; run `watch-all`.

## "node not found" or a plugin command failed

- herdr runs plugin commands with the server's own PATH, which often lacks version-manager node directories. Look in `herdr plugin log list` for a command with a non-zero exit code and a "could not find a node binary" message.
- Find node's absolute path in your normal shell with `which node`. Set `HERDR_NODE` to that path in herdr's environment, then re-link the plugin or restart herdr.

## It resumed a pane that was not actually limited

- This requires the pane to be stopped and limit-like text to be in the footer at the same time. The usual cause is limit-like text (a log, a doc, or a conversation about rate limits) sitting in the footer of an idle pane. A rendered table row is ignored structurally, but bare prose quoting a limit banner with a reset time nearby still matches; a pane whose job is writing about rate limits is best kept under `HERDR_PLUGIN_ROOT`, which is never monitored.
- Never add `working` to `eligibleStates`. It is rejected in config validation for exactly this reason.
- If a custom pattern is too broad, tighten `customPatterns` or `customTransientPatterns`.

## It kept nudging the same pane

- For a server error, repeated nudging is expected. The plugin retries with exponential backoff up to five minutes, and stops once Claude's latest output is a real response rather than an error.
- Two monitors acting on one pane is not expected. It can happen after the machine sleeps and wakes. Compare `pgrep -fl 'main.js monitor'` to the lock files: a monitor process whose terminal has no matching lock is stale. Run `stop` then `watch-all` to clear it.

## Claude received the message with its first character missing

- Symptom: the log says `resumed`, but Claude got `ontinue where you left off.` instead of `Continue where you left off.`
- Cause: Claude Code's vim editor mode (`"editorMode": "vim"`). The Escape that dismisses a menu (sent when the pane is blocked or the limit is a reset) also leaves the input line in NORMAL mode, where the first character of the message runs as a vim command rather than being typed - `C` is change-to-end-of-line, which enters INSERT and lets the rest through as text.
- The plugin detects this on the echoed input line and retypes the message before submitting; the log records `input repaired (vim normal mode ate the first character)`. If you see the symptom anyway, check that `verifyInput` is not turned off, and that pane reads work (`herdr pane read <pane> --source visible`).
- A `retryMessage` whose first character is a vim command that does not enter INSERT (`P`, `d`, `y`, ...) mangles differently and is not repairable; start the message with an ordinary word.

## The message was typed but Claude did not continue

- Recovery sends Escape (blocked/reset only), then the message, then Enter as separate keystrokes, with one retype in between if `verifyInput` detects the first character was eaten (see the section above). If Claude is in some other interactive state (a different menu, a permission prompt), the message may not be read as a continuation.
- Adjust `retryMessage`, or turn `dismissMenu` off if the Escape is interfering.

## `logs` or `status` print JSON

- Every herdr CLI call wraps its output in a JSON envelope, so these actions read cleanest from herdr's UI. From a shell, read the plain-text log file directly with the `tail` command under "Gather state".

## Reset the plugin

```bash
herdr plugin action invoke claude-auto-retry.stop
herdr plugin action invoke claude-auto-retry.watch-all
```

This stops every monitor and re-attaches one to each open Claude pane. Use it after upgrading the plugin or restarting herdr (config edits are picked up automatically). It also clears a stale monitor, because the fresh monitor takes the lock and the stale one exits on its next tick.
