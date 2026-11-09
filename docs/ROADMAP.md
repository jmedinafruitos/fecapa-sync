# Roadmap

`fecapa-sync` keeps a **local JSON copy** of FECAPA (Federació Catalana de
Patinatge) roller hockey data: clubs, categories, leagues, teams, players,
games and match reports ("actes"). It works for any club and any team.

You run it where your application lives. The first run does a **one-time full
sync** of the data you asked for. After that, **scheduled syncs** only fetch
what can still change and merge it into the same JSON files. Your application
reads those files and never talks to FECAPA directly.

## ⚠️ Sync rarely, not often

FECAPA's public portal and the SIDGAD API behind it are shared by every club,
federation official and family in Catalonia. They are not built for bulk
downloads. **Syncing all data often will get your IP blocked, or worse,
overload the origin for everyone.**

The library is designed around that:

- **One full sync, then incremental updates.** Data that cannot change again
  is never fetched again. A finished acta, for example, is final.
- **Minimum refresh intervals per level, enforced by the library.** If your
  cron runs every 5 minutes, the library still won't refetch games more often
  than their minimum interval. It answers from the local copy and reports that
  nothing was due.
- **A request budget per run** (`maxRequestsPerRun`). When the budget is spent,
  the run stops cleanly and continues next time.
- **One request at a time,** with a delay between requests (default 1 s), an
  honest User-Agent and no browser spoofing.
- **Back off on refusals.** HTTP 429/5xx or a SIDGAD refusal (`INVALID DOMAIN`,
  …) stops the run and pushes the next attempt back. It never retries in a
  tight loop.
- **A lock file,** so two runs never overlap.

Recommended schedule: **once or twice a week** for most clubs (for example
Monday 03:00 to pick up the weekend's actes, and Thursday 03:00 for fixture
changes). More often than daily is almost never useful.

## Data levels

Each level can be switched on or off. Turning a level on also turns on the
levels it depends on.

| Level | What it holds | Depends on | Source | Changes how often |
|---|---|---|---|---|
| `leagues` | Competitions for a season (id `idc`, name, category, zone, teams) and their groups | — | SIDGAD `leagues` endpoint ✅ (all seasons in one request); groups from the calendars the `games` level fetches | Start of season, phase changes |
| `categories` | Normalised categories (Prebenjamí … Sènior, Veterans, Minifem, FEM11 … FEM19, `unknown`), their raw names and leagues | `leagues` | Derived from league names, SIDGAD's `nombre_categoria` and group names ✅ | Once a season |
| `teams` | Teams (id, name, short name, club id, leagues, categories, gender) | `leagues` | SIDGAD `leagues` endpoint (`teams[]` per league) ✅ | Rarely within a season |
| `clubs` | Clubs (federation id, name) and the teams they field | `teams` | Grouped by the teams' `clubId`; official names from the SIDGAD `clubs` endpoint ✅, else derived from team names | Rarely |
| `games` | Fixtures: date, time, venue, home/away, match id, group/round, schedule history | `leagues` (only for a scope by name or `"all"`) | SIDGAD `calendar` endpoint ✅ | Dates and times shift during the season |
| `actas` | Final score, both lineups (goalkeepers marked), goals and cards per game | `games` | SIDGAD `report` endpoint ✅ | Fetched once per game after it ends, then final |
| `players` | Players (federation id, name, aliases, teams and leagues, season stats, goalkeeper, gender) | `actas` | Collected from the stored actes at no request cost ✅; optionally the per-league roster from the SIDGAD `stats` endpoint (`players.rosters`) ✅ | As actes arrive; rosters every `refresh.players` |

`calendar` and `report` work since 0.1 (`getCalendar`, `getReport`); `games`
and `actas` sync since 0.2; `leagues` and `clubs` (`getLeagues`, `getClubs`)
and the four discovery levels since 0.3; `players` and rosters (`getRosters`)
since 0.4.

Leagues, categories and teams come from **one** `leagues` request, made when
any of those enabled levels is due; club names come from one `clubs` request.
No calendar is fetched for discovery. Request cost of `init`:

- **One club** (`scope.clubs` + `scope.categories`): 2 + one calendar per
  league of that club in those categories (+1 for the portal page without a
  token), plus its due actas. Later runs: one calendar per league when games
  are due; the two list requests only every 7 and 30 days.
- **Federation-wide** (`scope.leagues: "all"`): 2 + one calendar per league
  (58 in 2026/2027), plus every due acta (budget-limited, continues next run).
- **Players:** the `players` level itself costs **0 requests**; it is rebuilt
  from the stored actes on every run. With `players.rosters: true`, add **one
  `stats` request per league in scope** on `init` and then every
  `refresh.players` (7d default, 24h floor). One club in one category is
  typically 1–2 extra requests a week; federation-wide, 58. Without a token the
  public config read for the calendars is reused, so rosters add no page
  request. A large youth league answers about 1 MB.

## Configuration

A config file (`fecapa-sync.config.json`, plain JSON) or the same object passed
in code. This is the 0.4 shape:

```json
{
  "season": "2026/2027",
  "dataDir": "./fecapa-data",
  "scope": { "clubs": ["<club name>"], "categories": ["Benjamí"] },
  "levels": { "games": true, "actas": true, "players": true },
  "players": { "names": "full", "rosters": false },
  "refresh": { "games": "24h", "actas": "12h", "players": "7d" },
  "limits": { "maxRequestsPerRun": 200, "delayMs": 1000 },
  "token": null
}
```

- `season` defaults to the current one (it changes on 1 July).
- `dataDir` is relative to the config file (or to the working directory for an
  in-code config).
- `scope.clubs`: club names or federation club ids. `scope.categories`:
  category names or keys (any accent or case, Catalan or Spanish). Names are
  resolved against the stored discovery levels; one that matches several
  things or nothing fails the run (`INVALID_CONFIG`, exit 2) with the closest
  candidates, keeps what was discovered and records no backoff. A template
  placeholder such as `"<club name>"` fails before any request.
- `scope.leagues`: competition ids (`liga` in the portal URL), or `"all"`.
  `scope.teams`: team ids; only games involving one of them are kept.
- Filters intersect: clubs + categories = that club's leagues in those
  categories, and only its teams' games. With only explicit league ids no
  discovery level is needed (0.2 configs keep working).
- `levels`: a level turns on the levels it depends on (`players` → `actas` →
  `games`, `clubs` → `teams` → `leagues`, `categories` → `leagues`); a scope by
  name turns on what it is resolved against.
- `players.names`: `"full"` (default), `"initials"` (`"J. P. T."`) or `"none"`
  (ids and stats only). Applies to `players.json`, the lineups of stored actes
  and stored rosters; a stricter value rewrites what is stored on the next run
  (no request). `players.rosters`: also fetch per-league rosters (default
  false).
- `token`: prefer the `FECAPA_SIDGAD_TOKEN` environment variable. Without a
  token the public portal config is used.

### Floors and retry policy

These are global library defaults, the same for every user.

| Setting | Default | Minimum (lower values are raised) |
|---|---|---|
| `refresh.games` (per league) | 24h | 12h |
| `refresh.actas` (first retry of an acta that wasn't available) | 12h | 6h |
| `limits.delayMs` (pause between requests) | 1000 ms | 1000 ms |
| `limits.maxRequestsPerRun` | 200 | 5 (lower is an error) |
| `refresh.leagues` / `refresh.teams` | 7d | 24h |
| `refresh.categories` / `refresh.clubs` | 30d | 7d |
| `refresh.players` (rosters, per league; only with `players.rosters`) | 7d | 24h |

- **Actas:** requested 3 h after kickoff (or the end of the day + 3 h when the
  time isn't published). If the acta isn't there yet (`not-finished` or
  SIDGAD `NO FILE`), the next attempt waits `refresh.actas`, then doubles
  (12h, 24h, 48h, 96h, then 7 days at most). After 6 attempts (about two weeks)
  the sync gives up on that acta, until the game's kickoff changes. A stored
  final acta is never requested again.
- **Budget:** one calendar or acta can need up to 3 requests when sources fall
  back, so an operation only starts if 3 requests are left. When the budget is
  spent the run ends with status `partial` and the next run continues.
- **Backoff:** any failed run (HTTP 429/5xx, network error, a SIDGAD refusal
  such as `INVALID DOMAIN`, a format change) stops at once, writes no data file,
  and records a backoff in `state.json`: 1 h, then 2 h, 4 h… up to 7 days. Runs
  during the backoff make no request. A successful run with requests clears it.
- **Lock:** `sync.lock` is created exclusively. A lock whose process is gone
  (same host) or older than 6 h is stale and is taken over; otherwise the run
  is skipped.

Examples:

- **A club calendar app:** `games` for its own teams only. A few requests per run.
- **A club stats app:** `games` + `actas` (+ `players` from 0.4) for its own teams.
- **A federation-wide viewer:** all levels (from 0.3). Only with the default
  minimums and a weekly schedule.

## Local store

```
fecapa-data/
  2026-2027/
    games/<idc>.json      # 0.2
    actas/<matchId>.json  # 0.2
    leagues.json  categories.json  teams.json  clubs.json   # 0.3, keyed by federation id
    players.json                                            # 0.4, keyed by federation player id
    rosters/<idc>.json                                      # 0.4, only with players.rosters
  state.json        # last sync per league and roster, next due time, pending actas, backoff, last run and its notes
  sync.lock
```

- Records keep the federation's ids as keys, so updates merge in place.
- Each record has `firstSeenAt`/`updatedAt`. A fixture FECAPA republishes with
  a shifted date or swapped sides (even under a new match id) is updated in
  place, not duplicated (`sameFixture`).
- A game stores its current `date`/`time`/`startsAt`/`venue`, `phaseId`/
  `phaseName`/`round`, a `history` of previous schedule values (each with
  `observedAt`, when the change was seen), `rescheduleCount`/`rescheduled`
  (changes of an already published date, time or venue; a first publication
  doesn't count) and `removedAt` when it leaves the calendar. Games are never
  deleted.
- An acta stores both lineups (`home`, `away`) with `isGoalkeeper`, the score,
  venue and group name, and the source that answered.
- Leagues, categories, teams and clubs have `firstSeenAt`/`updatedAt` and get
  `removedAt` when they disappear; they are never deleted.
- A player has `name` (latest seen) and `aliases` (earlier spellings), `teams`
  (id, name, leagues, games, `inRoster`, gender), `teamIds`, `leagueIds`,
  `season`, `stats` (`games`, `goals`, `yellowCards`, `blueCards`, `redCards`,
  `gamesAsGoalkeeper`), `isGoalkeeper`, `gender`/`genderSource` and `sources`
  (`actas`, `rosters`). Stats are recomputed from the stored actes on every
  run, so an acta is never counted twice. A player who is no longer in any
  stored acta or roster of the scope gets `removedAt`. With a club or team
  scope only those teams' players are kept.
- Every sync returns a **changeset** (created / updated / removed per level).
  Your application can apply it instead of re-reading everything.
- Writes are atomic (write to a temp file, then rename), so a crash never
  leaves a half-written file. A failed run writes no data file at all.
- **Personal data stays local.** Actes and players include minors. The store
  is meant for your own application. Don't republish it.

## API and CLI

```ts
import { createSync } from "fecapa-sync";

const sync = createSync({ configPath: "./fecapa-sync.config.json" }); // or createSync({ scope: …, … })
await sync.init();                  // one-time full sync of the configured scope
const result = await sync.run();    // scheduled incremental sync; skips what isn't due
result.status;                      // "ok" | "partial" | "skipped" | "failed"
result.changes.games.updated;       // the changeset
const status = await sync.status(); // last/next sync per level, pending actas, backoff (no network)
await sync.listClubs();             // also listLeagues, listCategories, listTeams({ league, club, category }),
await sync.findClub("exemple");     // findTeam: read the local store; STORE_EMPTY before init
await sync.export({ level: "games", format: "ics", club: "CP Exemple" }); // local store only; { content, records, skipped, notes }
const live = await discover();      // live lists for choosing a scope before init (2–3 requests)
```

```
npx fecapa-sync init   [--config fecapa-sync.config.json]   # writes a template if the file is missing
npx fecapa-sync sync   [--config …] [--json]                # call this from cron
npx fecapa-sync status [--config …] [--json]
npx fecapa-sync leagues|categories|clubs [--json] [--live]
npx fecapa-sync teams [--club …] [--category …] [--league …] [--json] [--live]
npx fecapa-sync find <query> [--json] [--live]          # local store; --live asks SIDGAD
npx fecapa-sync export --level games|actas|players|teams|clubs|leagues \
  --format json|csv|ics [--team …] [--club …] [--category …] [--league …] [--out file]   # 0.4, local store only
```

`sync` exits 1 when the run failed, 2 on usage or config errors, and 0
otherwise (including nothing due, a spent budget, an active backoff or another
run holding the lock). It prints the setup notes only on `init`, when they
changed since the last run, or with `--verbose` (`--json` always has them).

ICS export (games only): `UID` from the league and the game's store key (match
id, or the fixture key), `DTSTART` in UTC or an all-day event when the time
isn't published, `SUMMARY` "Home - Away", `LOCATION` from the calendar or else
the acta, `SEQUENCE` = schedule history length (+1 once removed), removed games
as `STATUS:CANCELLED`, games without a date skipped and counted. CRLF, folding
at 75 octets, TEXT escaping. CSV: RFC 4180, header row, fixed column order
(listed in the README).

The low-level client stays available: `createClient().getCalendar()`,
`getReport()` (one side) and, since 0.2, `getFullReport()` (both lineups in
one request). Report results carry a `status`: `final`, `not-finished` or
`no-file`.

## Milestones

| Version | Scope | Done when |
|---|---|---|
| **0.1** ✅ | Client: calendar + acta, three sources tried in order, zod validation, typed errors, polite client | Fixture tests and CI green (PR #1) |
| **0.2** ✅ | Sync engine: config file, local JSON store, `state.json`, minimum intervals, request budget, backoff, lock, changesets. Levels `games` and `actas`. CLI `init`/`sync`/`status` | A cron job keeps a team's games and actes up to date; a second run with nothing due makes 0 requests (PR #3) |
| **0.3** ✅ | `leagues`, `categories`, `teams`, `clubs` from the SIDGAD `leagues`/`clubs` lists; scope by club or category name; discovery API and CLI | A new user can go from a club or category name to synced games without knowing any id |
| **0.4** ✅ | `players` from actes (+ opt-in per-league rosters), `players.names` privacy option, `export` to JSON/CSV/ICS, quieter cron output | A team's ICS calendar from the README alone |
| **1.0** | Contributions and release: `capture` (anonymised fixtures), weekly `live-canary` that opens a `source-drift` issue, CONTRIBUTING with a "FECAPA changed" playbook, issue templates, changesets, npm publish | Published on npm; a simulated format change opens an issue |

## Principles

- **Library + CLI only.** No hosted service.
- **Club-agnostic.** No club, team or competition ids in code or docs, except
  as public examples.
- **Respect the origin.** See the warning above. Any feature that adds
  requests needs a reason and a budget.
- **No real personal data in the repo.** Fixtures and tests use invented names
  and player ids ≥ 900000.
- **Fail loudly.** A change on FECAPA's side shows up as
  `SOURCE_FORMAT_CHANGED` with the source name, never as an empty result.
  A failed run leaves the previous local data untouched.
- **MIT licensed.**

## Data notes

Facts about FECAPA's data from people who work with it, checked where
possible against the live portal and SIDGAD API (November 2026, public
competitions only).

- **Postponed or cancelled games.** FECAPA never marks a game as postponed or
  cancelled. The only signal is that its date, time or venue changes, or that
  it disappears from the calendar. The store keeps both: a `history` of
  previous schedule values with a derived `rescheduled`/`rescheduleCount`, and
  `removedAt` for games that are no longer listed.
- **Groups and rounds.** One competition id (`idc`) is published as several
  groups. The calendar list contains separator rows with `idp` "0":
  `dia_partido` "FASE" opens a group (`hora_partido` holds the group id,
  `home_name` its name, e.g. "BENJAMÍ PLATA 1") and "JORNADA" opens a round
  (`home_name` "JORNADA n"). Games store them as `phaseId`, `phaseName` and
  `round`. The report's `tournament_name` is the same group name. Group names
  carry the category (e.g. a "FEM …" prefix), which 0.3 will use.
- **Venue.** The calendar's `pista` field is the venue. It was empty (`null`)
  in every competition checked, where the portal has `has_pistas: false`; the
  report's `venue_info` was filled. Games store `venue` from the calendar and
  actas store `venue` from the report.
- **Games without a date.** No game with teams but no date was seen. One
  competition had a placeholder row with a real `idp` and empty date, time,
  teams and ids; it's skipped. A game with both teams and an empty or
  `00/00/0000` date is kept with `date`, `time` and `startsAt` set to `null`;
  any other unparseable date is `SOURCE_FORMAT_CHANGED`. No acta is requested
  for a game without a date.
- **`NO FILE`.** The report endpoint answers HTTP 200 `{"status":"NO FILE"}` for
  future matches, for matches whose acta isn't uploaded yet and for unknown ids
  alike. The client returns it as `status: "no-file"` (no error, no fallback to
  the next source) and the sync retries it later with the policy above.
  Finished matches answer the full report with `game_completed: "true"`.
- **Goalkeepers.** The acta is the only place a goalkeeper is recorded. The
  portal's roller hockey acta renders its lineup table client-side from the
  report JSON; its "P" column shows `player_role`, and the printable acta
  prints "P" only when `player_role === "P"`. In live actas, goalkeepers have
  `player_role: "P"` and everyone else `null`. `home_goalies`/`away_goalies`
  were empty in every roller hockey acta checked; the portal only reads them in
  another sport's acta. A player listed there is still treated as a goalkeeper
  and added if missing from the roster. The old server-rendered acta has the
  same "P" in the second cell of a player row. Both parsers set
  `Participant.isGoalkeeper`.
- **League list.** The portal's competitions page renders from
  `GET {api}/leagues/?jwt=…` (no id): `{"idcs": [...]}` with every competition
  of **every season** (574 rows, about 2.5 MB in November 2026; 58 for
  2026/2027). Each row has `idc`, `nombre_idc`, `id_temp`/`nombre_temp`
  (`"2026/2027"`), `id_zone`/`zone_name`, `id_categoria`/`nombre_categoria`,
  `id_sexo`/`nombre_sexo`, `agrupada`, `ids_teams` and `teams[]` with
  `teamId`, `name`, `clubId`, `name_short`, `team_logo`. Team ids in a
  calendar matched the league's `teams` exactly, and so did the calendar's
  `home_club_id`/`away_club_id`, so no calendar is needed for teams or clubs.
  A `GET {api}/seasons/` (`{"temps": [{id_temp, nombre_temp}]}`) also exists;
  not used. `ids_teams` sometimes disagrees with `teams`; `teams` is used.
- **Club list.** `GET {api}/clubs/` (not used by the portal) returns
  `{"clubes": [{id_club, nameclub, modals, logoclub}]}` for the whole
  federation (428 rows). `modals` is a list such as `hp`, `3p`, `hl`,
  `hp,hl`. **It also holds individual athletes' names** (other modalities), so
  the client keeps only entries of its modality (`hp`) and the store keeps only
  clubs that field a team. Official names look like `"<TOWN>, C.P."`. 11 of the
  129 clubs with a team in 2026/2027 aren't listed (guest clubs from outside
  Catalonia, national teams); their names come from their teams' names with
  one-letter suffixes removed (`"X B"`, `"X 'A'"`, `"X A A"`), the most used
  spelling winning. Club names also vary between a club's teams (sponsors,
  accents), so every derived name is kept as an alias for matching.
- **No club or team endpoints.** The team page is built from `standing`,
  `calendar` and `stats`. There is no endpoint per club or team.
- **Rosters.** The portal's roster view ("Plantilles") and team page read
  `GET {api}/stats/?id=<idc>&jwt=…` (one request per league, cached by the
  page): `{"stats": {goals, asist, blue_cards, direct, penals, rosters, staff}}`.
  The first five are per-stat rankings with the same row shape as `rosters`.
  A `rosters` row has `team_id` (the league's team ids, as in `leagues` and
  `calendar`), `team_name`, `team_logo`, `player_id` (the acta's player id),
  `player_name` (`"SURNAME(S),GIVEN"`), `player_flag`, `played`, `goals`,
  `asist`, `penals`, `direct`, `blue_cards`, `red_cards` and percentages; no
  yellow cards and no goalkeeper flag. Players registered but not yet played
  have `played: null` and empty stats: in a large youth league (66 teams) 383
  of 990 rows, 833 distinct players, 130 of them in more than one team; in a
  senior league 220 of 465. So rosters **do** list players who haven't played,
  which the actes can't. The portal also reads an optional `stats.goalies`
  list (absent in both leagues checked) and treats a player in both lists as a
  goalkeeper; the library takes goalkeepers from the actes only. `staff` lists
  coaches and delegates (adults' personal data, with a `role` that was always
  null); it is never read. An unknown id answers `{"status":"NO FILE"}`, read
  as an empty roster. The answer is about 1 MB for a large youth league, so
  rosters are opt-in and refreshed weekly by default.
- **Categories.** SIDGAD's `nombre_categoria` was seen as PREBENJAMI,
  PREBENJAMÍ INICIACIÓ, BENJAMI, ALEVÍ, INFANTIL, JUVENIL, JUNIOR, VETERANS,
  NACIONAL/PRIMERA/SEGONA/TERCERA CATALANA (and … FEMENÍ), OK LIGA PLATA and
  OK LIGA FEMENÍ, and is empty (`id_categoria` "0") for cups, final phases and
  tournaments (239 of 574 rows). Women's age leagues are named FEM 11 … FEM19
  and MINIFEM but carry the mixed category (FEM 13 → ALEVÍ). So the league
  name is read first, then SIDGAD's category: youth age groups, `senior`
  (Nacional/Primera/Segona/Tercera Catalana, OK Lliga, Lliga Catalana,
  Supercopa, Copa Generalitat), `veterans` (also MÀSTER), `minifem`,
  `fem11`…`fem19` (with `ageGroup` pointing at the mixed one), and `unknown`
  with the raw name for the rest (3 open tournaments in 2026/2027). Group
  names ("BCN BENJAMÍ PLATA 1") carry the category too.
- **Gender.** There is no gender field for teams or players. The rule: a
  `FEM…` category, or a league or group whose name contains "Femenina", is
  female; everything else is unknown, because youth leagues can be mixed, and
  nothing is ever "male". The leagues list has a sex label (`MIXTA`,
  `MASCULINA`, `FEMENINA`, or null for most cups). It is stored raw as
  `sidgadSex`; "FEMENINA" is read like a name containing "Femenina", and
  "MASCULINA" is ignored. "Femení" and "Femenino" (other forms of the same
  word) count too. In 2026/2027 every female-labelled league also had a FEM
  category or "Femenina"/"Femení" in its name, except MINIFEM (a FEM category).
  Leagues, groups, categories and teams carry `gender` with
  `genderSource: "inferred"`; clubs are not gendered.
- **Results in the calendar.** Calendar games carry `result` ("3:2", empty
  until played). Not used yet; it could tell the sync when an acta is likely
  available and save `NO FILE` retries.

## Open questions

- **Player page.** The portal has a player card script
  (`player/sidgad-player-ficha.js`); its endpoint and whether it adds anything
  beyond actes and rosters (e.g. earlier seasons) wasn't checked. Not used.
- **Other modalities:** the SIDGAD path includes a client and a modality
  (`fecapa`/`hp`). Making them options may support other sports. Not verified.
