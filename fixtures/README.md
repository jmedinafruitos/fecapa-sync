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
