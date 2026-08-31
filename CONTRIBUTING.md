# Contributing

Thanks for helping. This is a small, zero-dependency herdr plugin. The priority is keeping it that way: less code, no new runtime deps, no behavior change without a test that pins it.

## Dev setup

Requires Node `>= 18` (built-in test runner, no `npm install` needed) and, for live testing, herdr `>= 0.7.5`.

```bash
git clone <your-fork>
cd herdr-claude-auto-retry

npm test                          # 146 tests, Node's built-in runner, zero deps
```

Try it against a running herdr:

```bash
herdr plugin link .               # load the working tree
herdr plugin action invoke claude-auto-retry.status
herdr plugin unlink claude-auto-retry
```

No-herdr loop for the I/O path: point `HERDR_BIN_PATH` at `test/fixtures/fake-herdr.js`, which serves canned `pane list/get/read` JSON and records `send-*` calls. `test/integration-herdr.test.js` uses it to exercise the real adapter, and you can drive the monitor end to end with `node bin/main.js monitor <terminalId> <paneId>` against it.

Enable the pre-push leak scan once per clone:

```bash
git config core.hooksPath .githooks
```

## Keeping private material out

The test fixtures here are screenshots of real Claude sessions, so a careless paste publishes whatever was on that screen. One fixture did carry verbatim task descriptions from an unpublished research project, caught before it was pushed.

`npm run scan` (also `npm test`, also every `git push` once the hook is enabled) checks every tracked file for absolute home paths, email addresses, token-shaped strings, prefixed cross-project decision and defect tags (a project abbreviation, a hyphen, `D` or `X`, a number), private workspace paths, and `Status:` / `Next:` / `Blockers:` handoff lines. This repo's own decision tags are bare (`D19`), and deliberately do not match.

Maintainer-specific names (private project names, research topics) go in `.private-markers`, one regex per line, gitignored. That file is not committed for the obvious reason: a denylist of private names, published in a public repo, leaks exactly what it protects. Absent, the scan silently falls back to the generic patterns, so if you rely on it, keep it durable: symlink it (and `PROGRESS.md`) at a file in a private repo rather than leaving it as the only copy on one disk.

When scrubbing a fixture, keep its shape and drop its content. The D18 fixture needs a task list long enough to push the error out of a 15-line window; what the individual task lines actually say is irrelevant to what it tests, so make them generic.

## Layout: where logic lives

- `src/` - all behavioral logic. `src/monitor-core.js` is the transport-agnostic state machine and the unit-tested core; `src/patterns.js` is rate-limit detection; `src/time-parser.js` is the reset-time math; `src/herdr.js` is the herdr CLI adapter (the only place that shells out to `herdr`); `src/registry.js` is the atomic per-terminal monitor lock.
- `bin/main.js` - the single entrypoint. It dispatches on the first argument to one of seven subcommands: the `pane.agent_detected` hook, the actions (`watch-all`, `arm`, `status`, `stop`, `logs`), and the long-lived `monitor`. Keep handlers thin: parse input, call into `src/`, return. No behavioral logic here.
- `launch.sh` - POSIX node resolver that herdr's manifest invokes via `/bin/sh`, because herdr spawns plugin commands with the server's PATH (often no nvm/fnm/mise node). It resolves node, then runs `bin/main.js <subcommand>`. Touch only when node resolution changes.

Put new behavior in `src/` (testable with a fake adapter), not in `bin/main.js` or the shell.

## Adding a rate-limit pattern

New limit wording, a new reset format, or a new transient server error goes in `src/patterns.js`:

- A new "limit" line goes in `LIMIT_PATTERNS`, a new "resets" line in `RESET_PATTERNS`. Detection requires a limit line and a resets line within the same window, so a limit-only string must not match (guards against false positives on prose that merely mentions a limit).
- A new retryable server error goes in `TRANSIENT_PATTERNS`. Keep it specific (anchor to the `API Error:` prefix where the phrase is common in prose), and never add a 4xx: those are permanent and a retry is pointless.

Add a case to `test/patterns.test.js` in the same change: one assertion that the new wording is detected, and where relevant one negative assertion that benign text is not.

End users can extend detection without code via the `customPatterns` (limits) and `customTransientPatterns` (server errors) config options; reserve `patterns.js` edits for wording that should ship by default.

## Test-first

Write the test first. Every behavior change lands with a test that fails before the change and passes after. `npm test` must stay green and the count must not drop. If a change removes code, it should remove or fold tests only when the behavior they pinned is genuinely gone, never to make a failing suite pass.

Core logic must be reachable through `processOneTick` (state machine) or the pure functions in `patterns.js` / `time-parser.js` so it can be tested with the fake adapter rather than a live herdr.

## Pull requests

- One focused change per PR. Say what it does and why.
- Run `npm test` and keep it green and zero-dependency. Do not add a runtime dependency.
- Match the existing style: ESM, Node built-ins only, no code comments (the code and tests are the documentation; design rationale goes in `AGENTS.md`).
- Prefer less code. A diff that deletes lines while keeping coverage is the ideal contribution here.
- If behavior changes, update `README.md` (user-facing) and `AGENTS.md` (the operating manual, including a Decisions entry for a non-obvious choice).

## Releasing

**A plain `herdr plugin install` takes the default branch**, so pushing `main` publishes to everyone who installs or reinstalls from then on. There is no `herdr plugin update` (refreshing means reinstalling) and no rollback other than reverting `main`.

`plugin install --ref <branch-or-tag>` fetches a specific ref instead. That gives three channels out of this one repo, with no second repository:

| Channel | How it is installed | What it is for |
| --- | --- | --- |
| working tree | `herdr plugin link .` | Local development. Edits are live in the next poll; monitors pick up config every tick. |
| `next` branch | `herdr plugin install mo-arvan/herdr-claude-auto-retry --ref next` | Soaking a candidate, including on a second machine, without touching what users get. |
| `main` | `herdr plugin install mo-arvan/herdr-claude-auto-retry` | The release. |

Anything that needs real sessions before it ships lands on `next` first. A tag installs the same way, which is how a user pins instead of tracking `main`.

```bash
npm run preflight              # readiness, plus the review checklist
# write the [Unreleased] entries, commit the work
npm run release -- 1.1.0       # bump, promote, sync, commit, tag. Never pushes.
git show --stat HEAD
git push origin main --follow-tags
```

`npm run release` aborts unless the tree is clean, you are on `main` and in sync, the tag is free, `[Unreleased]` is non-empty, and the suite passes. It then re-runs the suite against the edited tree before committing. The tag push triggers `.github/workflows/release.yml`, which re-runs the suite, checks the tag against `package.json`, and opens the release from that CHANGELOG section.

`npm run preflight` prints the unreleased diff and the review gate, because the suite covers only the mechanical half: read the diff for correctness and for a simpler version, hold `src/` and `bin/` at zero comments, cut any doc that grew past its change, write the CHANGELOG in users' terms, and scrub fixtures of anything private.

Three calls stay yours. **The version number**: additive is a minor, removing or repurposing a config key is a major. **`min_herdr_version`**: raise it only for a herdr feature actually used, and say so in the CHANGELOG. herdr refuses old hosts with `plugin_requires_newer_herdr`, so the failure is at least legible. **Whether it has soaked**: behavior that types into someone's session can ship defaulted off and flip a release later.

## License

By contributing you agree your contributions are licensed under the MIT License (see `LICENSE`).
