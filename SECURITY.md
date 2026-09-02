# Security

Report a vulnerability privately through the "Report a vulnerability" button on this repository's Security tab (GitHub private vulnerability reporting), not in a public issue. Expect an acknowledgement within a few days.

Supported: the latest release on `main`. Fixes ship as a new release; there are no backports.

What this plugin does that matters for a report: it reads the text of every Claude Code pane herdr shows it, types one fixed message into a pane it believes is rate-limited, and writes one truncated line per event to a local log. It makes no network requests. `docs/configuration.md` describes what it reads and keeps.
