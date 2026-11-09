---
"fecapa-sync": major
---

1.0: first stable release, ready for contributions and npm.

**1.0**

- `fecapa-sync capture <calendar|report|leagues|clubs|rosters> [<id>]` saves one live SIDGAD answer as a test fixture, anonymised deterministically: player, staff and referee names become invented names and their ids become ids ≥ 900000; team, club and venue names and ids are replaced too unless `--keep-teams` (local debugging only). One API request through the polite client (plus the portal page without a token). It writes only inside `fixtures/` unless `--force`, and writes nothing if any input name or id survives. Also `anonymise()`, `findLeaks()` and `capture()` in the API.
- Every stored fixture, old and new, runs through the parser for its kind (`test/all-fixtures.test.mjs`); a new fixture only needs the naming convention.
- A weekly `live-canary` workflow checks leagues, clubs, a calendar and a report on live public data (at most 5 requests, 2 s apart, nothing personal logged) and keeps one `source-drift` issue open while it fails.
- ICS: `SEQUENCE` is now a per-game revision that never decreases. A removed game that reappears used to get a lower `SEQUENCE`, so calendar apps ignored the update. Stores written before 1.0 load unchanged and continue from the old value. Games gain an optional `revision` field (`gameRevision()`).
- CONTRIBUTING (with a "FECAPA changed" playbook), issue and PR templates, SECURITY, CODEOWNERS, and releases with changesets and npm provenance.

**Earlier releases (0.x, from GitHub only)**

- 0.4: `players` level from the stored actes (plus opt-in per-league rosters), the `players.names` privacy option (`full`, `initials`, `none`), `export` to JSON, CSV and ICS from the local store, quieter cron output.
- 0.3: `leagues`, `categories`, `teams` and `clubs` from the SIDGAD lists; scope by club or category name; discovery API and CLI (`find`, `--live`).
- 0.2: the sync engine: config file, local JSON store, `state.json`, minimum refresh intervals, request budget, backoff, lock and changesets of created/updated/removed records; `games` and `actas` levels; CLI `init`, `sync`, `status`.
- 0.1: the client: calendar and match report from three sources tried in order (`sidgad-api`, `portal-config`, `legacy-html`), zod validation, typed errors with stable codes, a polite HTTP client.
