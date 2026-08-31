# Configuration

Configuration is optional. Create `claude-auto-retry.json` in herdr's config directory (find it with `herdr plugin config-dir claude-auto-retry`). Every key has a default, and an invalid value falls back to it. This file is yours and survives plugin upgrades, so it is the right place to adjust behavior.

Running monitors re-read this file every poll, so edits take effect on their own within a few seconds. No restart is needed.

## Options

| Key | Default | Meaning |
|---|---|---|
| `maxRetries` | `5` | Recovery nudges for a subscription/usage limit before a long cooldown. |
| `pollIntervalSeconds` | `5` | How often a monitor checks its pane. |
| `marginSeconds` | `60` | Extra wait added after a parsed reset time. |
| `fallbackWaitHours` | `5` | Wait used when a reset time cannot be parsed. |
| `handleTransient` | `true` | Also recover sessions left idle by a transient server error. |
| `transientWaitSeconds` | `60` | First wait before the first transient nudge (the backoff base). |
| `transientMaxWaitSeconds` | `300` | Cap on the transient exponential backoff (nudges continue until the error clears). |
| `handleStuckWorking` | `true` | Take over a pane herdr reports as `working` but that is actually stalled. herdr's `working` is a title-spinner heuristic that can be stale after a connection drop; set this `false` to trust herdr's state absolutely. |
| `stuckWorkingMinutes` | `5` | How long a `working` pane must show the same transient error as its latest output, with no new output, before it is treated as stalled. A genuinely working pane produces new output well within this window, so it never qualifies. |
| `retryMessage` | `"Continue where you left off."` | Text typed to resume Claude. Keep it free of detector words (`limit`, `rate`, `overloaded`, ...); it is echoed into the input line, so a trigger word makes the monitor match its own nudge. |
| `customPatterns` | `[]` | Extra regexes treated as a usage/subscription limit (waited out). See below. |
| `customTransientPatterns` | `[]` | Extra regexes treated as a transient server error (short backoff). See below. |
| `readSource` | `"detection"` | herdr read source: `recent`, `recent-unwrapped`, `visible`, or `detection`. |
| `readLines` | `40` | Lines read per check. |
| `detectionTailLines` | `15` | Tail window for rate-limit detection. Transient server errors are not bound by it: they anchor to the latest on-screen output block, so a long task list cannot push the error out of view. |
| `dismissMenu` | `true` | Send Escape before resuming, but only when the pane is blocked at a prompt (dismisses the `/rate-limit-options` menu). Never sent to an idle or working pane, where it would interrupt the turn. |
| `menuDismissDelayMs` | `300` | Pause after Escape. |
| `submitDelayMs` | `400` | Pause between typing the message and pressing Enter. |
| `eligibleStates` | `["idle","blocked","done"]` | Pane states the plugin may act on. `working` is never allowed (it is stripped in validation). |
| `engagedLabel` | `"retry engaged"` | Label reported on a pane while it waits out a limit. See below for showing it. |

## Showing the engaged label

The label is reported to herdr as a pane token named `retry` (herdr >= 0.7.4). Tokens are only
drawn where you ask for them, so add `$retry` to an agent row in your `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab"], ["agent", "$retry"]]
```

The token carries a TTL, so it disappears on its own if a monitor dies.

## Adjusting detection when Claude's wording changes

Claude Code's on-screen wording is not a stable API. It will change, and a phrasing the plugin looks for can stop matching, so detection quietly stops firing. You do not need to edit code or wait for a release to fix that. Add the new phrasing to one of two config lists, each an array of case-insensitive regular-expression strings:

- `customPatterns` - matched as a usage/subscription limit, which the plugin waits out.
- `customTransientPatterns` - matched as a transient server error, which the plugin retries with short backoff.

```json
{
  "customPatterns": ["you.?ve used up your", "monthly cap reached"],
  "customTransientPatterns": ["service is busy", "temporarily unavailable"]
}
```

To check whether a candidate pattern classifies a pane's current footer, pipe the footer through the detector from the plugin directory. It prints `reset`, `transient`, or `null`:

```bash
herdr pane read <pane-id> --source detection --lines 25 \
  | node --input-type=module -e '
      import { classifyLimit } from "./src/patterns.js";
      let t = ""; process.stdin.on("data", (d) => (t += d)).on("end", () =>
        console.log(classifyLimit(t, 15, ["your limit regex"], ["your transient regex"])));'
```

The running monitors load the new patterns on their own within a few seconds.
