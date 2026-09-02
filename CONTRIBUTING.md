# Contributing

Thanks for helping. This is a small, zero-dependency herdr plugin. The priority is keeping it that way: less code, no new runtime deps, no behavior change without a test that pins it.

## Dev setup

Requires Node `>= 18` (built-in test runner, no `npm install` needed) and, for live testing, herdr `>= 0.7.5`.

```bash
git clone <your-fork>
cd herdr-claude-auto-retry

npm test                          # Node's built-in runner, zero deps
```

Try it against a running herdr:

```bash
herdr plugin link .               # load the working tree
herdr plugin action invoke claude-auto-retry.status
herdr plugin unlink claude-auto-retry
```

With herdr on PATH, `npm test` also checks the adapter's exact CLI flags against the real binary (`test/herdr-contract.test.js`, skipped otherwise). No-herdr loop for the I/O path: point `HERDR_BIN_PATH` at `test/fixtures/fake-herdr.js`, which serves canned `pane list/get/read` JSON and records `send-*` calls, or, given a `screen`, models a small reactive Claude TUI (vim mode, menu, input line, submit) so a whole recovery can run end to end. `test/integration-herdr.test.js` uses it to exercise the real adapter, and you can drive the monitor end to end with `node bin/main.js monitor <terminalId> <paneId>` against it.

Enable the pre-push leak scan once per clone:

```bash
git config core.hooksPath .githooks
```

## Keeping private material out

The test fixtures here are screenshots of real Claude sessions, so a careless paste publishes whatever was on that screen. One fixture once carried verbatim content from an unrelated session, caught before it was pushed.

`npm run scan` (also `npm test`, also every `git push` once the hook is enabled) checks every tracked file for absolute home paths, email addresses, token-shaped strings, prefixed cross-project decision and defect tags (a project abbreviation, a hyphen, `D` or `X`, a number), private workspace paths, and `Status:` / `Next:` / `Blockers:` handoff lines. This repo's own decision tags are bare (`D19`), and deliberately do not match.

Maintainer-specific names (private project names, research topics) go in `.private-markers`, one regex per line, gitignored. That file is not committed for the obvious reason: a denylist of private names, published in a public repo, leaks exactly what it protects. Absent, the scan silently falls back to the generic patterns, so if you rely on it, keep it durable: symlink it (and `PROGRESS.md`) at a file in a private repo rather than leaving it as the only copy on one disk.

When scrubbing a fixture, keep its shape and drop its content. The stalled-screen fixture (docs/decisions.md, D18) needs a task list long enough to push the error out of a 15-line window; what the individual task lines actually say is irrelevant to what it tests, so make them generic.

## Layout: where logic lives

- `src/` - all behavioral logic. `src/monitor-core.js` is the transport-agnostic state machine and the unit-tested core; `src/patterns.js` is rate-limit detection; `src/time-parser.js` is the reset-time math; `src/herdr.js` is the herdr CLI adapter (the only place that shells out to `herdr`); `src/registry.js` is the atomic per-terminal monitor lock.
- `bin/main.js` - the single entrypoint. It dispatches on the first argument to one of seven subcommands: the agent-detection hook (wired to both `pane.agent_detected` and `pane.agent_status_changed`), the actions (`watch-all`, `arm`, `status`, `stop`, `logs`), and the long-lived `monitor`. Keep handlers thin: parse input, call into `src/`, return. No behavioral logic here.
- `launch.sh` - POSIX node resolver that herdr's manifest invokes via `/bin/sh`, because herdr spawns plugin commands with the server's PATH (often no nvm/fnm/mise node). It resolves node, then runs `bin/main.js <subcommand>`. Touch only when node resolution changes.

Put new behavior in `src/` (testable with a fake adapter), not in `bin/main.js` or the shell.

## Adding a rate-limit pattern

New limit wording, a new reset format, or a new transient server error goes in `src/patterns.js`:

- A new "limit" line goes in `LIMIT_PATTERNS`, a new "resets" line in `RESET_PATTERNS`. Detection requires a limit line and a resets line within the same window, so a limit-only string must not match (guards against false positives on prose that merely mentions a limit).
- A new retryable server error goes in `TRANSIENT_PATTERNS`. Keep it specific (anchor to the `API Error:` prefix where the phrase is common in prose), and never add a 4xx: those are permanent and a retry is pointless.

Add a case to `test/patterns.test.js` in the same change: one assertion that the new wording is detected, and where relevant one negative assertion that benign text is not.

End users can extend detection without code via the `customPatterns` (limits) and `customTransientPatterns` (server errors) config options; reserve `patterns.js` edits for wording that should ship by default.

## Test-first

Write the test first. Every behavior change lands with a test that fails before the change and passes after. `npm test` must stay green. If a change removes code, it should remove or fold tests only when the behavior they pinned is genuinely gone, never to make a failing suite pass.

Core logic must be reachable through `processOneTick` (state machine) or the pure functions in `patterns.js` / `time-parser.js` so it can be tested with the fake adapter rather than a live herdr.

## Pull requests

- One focused change per PR. Say what it does and why.
- Run `npm test` and keep it green and zero-dependency. Do not add a runtime dependency.
- Match the existing style: ESM, Node built-ins only, no code comments (the code and tests are the documentation; design rationale goes in `docs/decisions.md`).
- Prefer less code. A diff that deletes lines while keeping coverage is the ideal contribution here.
- If behavior changes, update `README.md` (user-facing), `AGENTS.md` (the operating manual), and `docs/decisions.md` (one dated line for a non-obvious choice).

## Releasing

**A plain `herdr plugin install` takes the default branch**, so pushing `main` publishes to everyone who installs or reinstalls from then on. There is no `herdr plugin update` (refreshing means reinstalling) and no rollback other than reverting `main`.

`plugin install --ref <branch-or-tag>` fetches a specific ref instead. That gives three channels out of this one repo, with no second repository:

| Channel | How it is installed | What it is for |
| --- | --- | --- |
| working tree | `herdr plugin link .` | Local development. Edits are live in the next poll; monitors pick up config every tick. |
| `next` branch | `herdr plugin install mo-arvan/herdr-claude-auto-retry --ref next` | Soaking a candidate, including on a second machine, without touching what users get. |
| `main` | `herdr plugin install mo-arvan/herdr-claude-auto-retry` | The release. |

A real rate limit cannot be scheduled, so waiting for one is not a release gate. The gates below stand in for it: the CLI contract test proves the herdr surface, the wording test proves Claude's strings, and the reactive fake runs whole recoveries. `next` stays available for an optional soak, and a tag installs the same way, which is how a user pins instead of tracking `main`.

```bash
npm run preflight              # every automatic gate, then the review checklist
# write the [Unreleased] entries, commit the work
npm run release -- X.Y.Z       # bump, promote, commit, tag. Never pushes.
git show --stat HEAD
git push origin main --follow-tags
```

Automatic, enforced by `npm run preflight` and again by `npm run release`: on `main`, clean tree, in sync with origin, tag free, `[Unreleased]` non-empty, the suite under `npm run coverage` floors, the leak scan (part of the suite), and nothing skipped - the herdr CLI contract and Claude wording tests skip when those binaries are absent, so a release needs both on PATH. `release` re-runs all of it against the edited tree before committing. CI runs the same coverage command on Node 22 and the plain suite on 18 and 20, whose `node --test` predates the threshold flags. On push, the pre-push hook re-runs the suite and the leak scan; the tag push triggers `.github/workflows/release.yml`, which re-runs the suite, checks the tag against `package.json`, and opens the GitHub release from that CHANGELOG section.

Judgment, printed by preflight as a checklist because the suite cannot decide it: read the diff for correctness and a simpler version, hold `src/` and `bin/` at zero comments, cut any doc that grew past its change, write the CHANGELOG in users' terms, scrub fixtures, and run an adversarial review of the unreleased diff (correctness, least privilege, minimal code) with its findings fixed or recorded in `docs/decisions.md`.

## License

By contributing you agree your contributions are licensed under the MIT License (see `LICENSE`).
