# Fixtures

Raw responses, one directory per source (`sidgad-api`, `portal-config`,
`legacy-html`). Their structure mirrors what FECAPA/SIDGAD serves, but every
identity is invented: player, staff and team names are fictitious, and player
ids are ≥ 900000. Never add real names (match reports involve minors) and never
add a real SIDGAD token; use `public-token`.

`sidgad-api/2026-11-leagues.json` and `2026-11-clubs.json` follow the shapes of
the `leagues/` and `clubs/` list endpoints. Club and team ids are arbitrary and
every club, team and person name is invented. The real `clubs/` list also holds
individual athletes of other modalities; the fixture stands in for them with
one invented `3p` entry.

`sidgad-api/2026-11-stats.json` follows the shape of the per-league `stats/`
endpoint the portal's roster view ("Plantilles") reads: `stats.rosters` lists
every player registered with a team of the league, with `played: null` for
those who haven't played yet. The real answer also carries per-stat rankings
and `staff`; the fixture keeps one invented row of each. Player ids are
≥ 900000 and every name is invented.

## Adding a fixture

Name it `<source>/<yyyy>[-<mm>]-<kind>[-<label>].json` (or `.html` for
`portal-config` pages and `legacy-html`), e.g.
`sidgad-api/2027-02-report-shootout.json`. The kind picks the parser:
`calendar`, `report`, `leagues`, `clubs`, `stats` or `rosters` for
`sidgad-api`; `calendar` or `page` for `portal-config`; `calendar` for
`legacy-html`. `test/all-fixtures.test.mjs` runs every file through its
parser, so a fix for a new format can't break an old one. A file whose kind
isn't in its name, or one that must fail with a given error code, goes in
`manifest.json`.

Capture new ones with `npx fecapa-sync capture <kind> <id> --out fixtures/sidgad-api/<yyyy-mm>-<kind>-<label>.json`:
one live request, saved anonymised (people always; teams, clubs and venues
unless `--keep-teams`, which is for local debugging only and must never be
committed). The test also checks that every person id in a JSON fixture is
≥ 900000 and that nothing looks like a JWT. See `CONTRIBUTING.md`.

`sidgad-api/2026-11-calendar-grouped.json` (a full public youth league
calendar with five groups and about 400 rows) and
`sidgad-api/2026-11-report-officials.json` (a finished report that also lists
match officials, team short names and penalty counts) were made with
`capture` from live answers: every person, team, club and venue is invented.
