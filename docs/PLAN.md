# fecapa-sync — pla

Self-contained brief: everything a planner/task-builder/implementer needs is here.

## Goal

Extract the FECAPA (Federació Catalana de Patinatge) data sync from AssistentEsportiu
(`github.com/jmedinafruitos/AssistentEsportiu`) into a public, club-agnostic
open-source library + CLI, so any club can read hoquei patins fixtures and match
reports (actas), and anyone can contribute a fix when FECAPA/SIDGAD changes its
data source.

## Decisions (fixed — don't re-litigate)

| Topic | Decision |
|---|---|
| Name | `fecapa-sync` (npm + GitHub repo `jmedinafruitos/fecapa-sync`) |
| Scope | Library + CLI only. **No hosted service** (no hosted ICS feed, no server). The CLI can write ICS/JSON/CSV files locally. |
| License | MIT |
| FECAPA contact | None. Behave as a polite public client: honest User-Agent, rate limiting, caching. No browser spoofing. |
| Language | Code/identifiers/error codes in English; README in Catalan with an English summary. |

## Source code to port

Latest code lives on AssistentEsportiu branch `jordi/fecapa-new-source`
(worktree `/private/tmp/assistent-fecapa-source`), not yet merged:

- `apps/api/src/fecapa.ts` — calendar fetch (3 fallbacks), parsers, `toStartsAt`, `nextFecapaSyncAt`, DB sync
- `apps/api/src/fecapa-reports.ts` — acta fetch (same fallbacks), DB apply
- `apps/api/src/fecapa-reports-parser.ts` — acta parsers (HTML + SIDGAD JSON), `matchReportPlayer`, `normalizePlayerName`, `currentFecapaSeason`
- Tests: `apps/api/tests/fecapa-schedule.mjs`, `fecapa-reports.mjs`, `fecapa-reports-db.mjs`, `helpers/acta-fixture.mjs`

Data sources, in fallback order:
1. `sidgad-api`: `https://api.sidgad.com/fecapa/v1/hp/{calendar|report}/?id=…&jwt=TOKEN` (token from env)
2. `portal-config`: fetch portal page `https://www.hoqueipatins.fecapa.cat/?liga={idc}&vista=calendar[&partido={id}]`,
   extract `const SIDGAD_API_CONFIG = {url, cliente, version, idm, token}`, build `{url}/{cliente}/{version}/{idm}/{calendar|report}/?id=…&jwt=…`
3. `legacy-html`: parse `tr.team_class` rows / labelled tables (calendar) and `#div_ficha_resumen` (acta)

### Library vs app split

| Goes into `fecapa-sync` | Stays in AssistentEsportiu |
|---|---|
| Fetching, the three sources, parsers | Postgres upserts, advisory lock |
| `toStartsAt` (Europe/Madrid), `currentSeason` (1 July) | Mon/Thu 03:00 scheduler |
| `sameFixture(a, b)` — pure version of the JME-48 rule: same competition, same unordered team pair, date within ±3 days | SQL that applies that rule |
| `matchPlayer(participant, roster)`, `normalizePlayerName` | roster reconciliation, `match_player_stats` |
| Typed errors with stable codes | Catalan UI messages mapped from codes |

## Must-fix before going public

1. **No real personal data.** Fixtures must use invented names (current AssistentEsportiu test has a real-looking player name `GUTIERREZ ARMENGOL` — also scrub it there; actas involve minors).
2. **No tokens committed.** Token comes from env (`FECAPA_SIDGAD_TOKEN`) or is read from the public page at runtime.
3. **Honest client.** User-Agent `fecapa-sync/<version> (+https://github.com/jmedinafruitos/fecapa-sync)`; drop fake Safari UA. Keep `origin`/`referer` only if the API strictly requires them and document why. Default concurrency 1, configurable delay between requests, optional on-disk cache.
4. **Error codes, not prose**: `HTTP_ERROR`, `SOURCE_FORMAT_CHANGED` (with `source` field), `TEAMS_MISMATCH`, `INCOMPLETE_PLAYER`, `DUPLICATE_LINEUP`, `EMPTY_RESPONSE`.

## Library design

- TypeScript, ESM, Node ≥ 20, deps: `cheerio`, `zod`. Native `fetch` injectable (`{ fetch }` option) for tests.
- Every JSON response validated with a zod schema → schema failure = `SOURCE_FORMAT_CHANGED`.
- Source modules implement one interface each (`CalendarSource`, `ReportSource`); client tries them in configured order and reports which one succeeded.
- SIDGAD `cliente`/`idm` (`fecapa`/`hp`) configurable defaults — may enable other modalities; unverified, not promised in docs.

Public API (sketch):

```ts
createClient(opts?: { baseUrl?, apiUrl?, token?, userAgent?, fetch?, sources?, delayMs?, cache? })
client.getCalendar(idc): Promise<Match[]>              // {matchId?, competitionId, homeId, awayId, homeName, awayName, date:'YYYY-MM-DD', time:'HH:MM'|null, startsAt: ISO}
client.getReport(matchId, { idc, side: 'home'|'away', expectTeams? }): Promise<Report|null>   // null = not finished
client.listCompetitions(season?)      // discovery — investigate the portal/API for an index endpoint
client.listTeams(idc)                 // derived from calendar if no endpoint exists
client.findTeam(query, { season? })
// pure utils
toStartsAt, currentSeason, sameFixture, matchPlayer, normalizePlayerName
```

CLI (`npx fecapa-sync …`):

```
calendar  --league <idc> [--team <id>] --format json|csv|ics [--out file]
report    --match <id> --league <idc> [--side home|away] --format json
teams     --league <idc>
competitions [--season 2026/2027]
find-team <query>
capture   <calendar|report> <id> --out fixtures/…   # saves raw response, anonymised
```

## Contribution / drift workflow

- `fixtures/<source>/<yyyy-mm>-<name>.{json,html}` — every parser tested against all stored fixtures, old and new.
- `capture` anonymises player names/ids deterministically before writing.
- GitHub Action `live-canary` (daily cron + manual): runs against 2–3 public competitions; on failure opens/updates an issue labelled `source-drift` with error code + source name. Not a required check on PRs.
- `CONTRIBUTING.md` with a "FECAPA changed" playbook: capture → failing test → fix/add source → PR → changeset (patch).
- Issue templates (`source-drift`, `feature`), CODEOWNERS, branch protection on `main`, changesets + npm publish workflow (npm token as repo secret).

## Phases

| # | Tickets | Done when |
|---|---|---|
| 0 | Merge `jordi/fecapa-new-source` in AssistentEsportiu; scrub real names from its fixtures | Prod on new source |
| 1 | Repo skeleton (MIT, TS, CI lint/test/build); port sources + parsers + tests; zod schemas; typed errors; honest client | `npm test` green on fixtures only |
| 2 | Discovery (`listCompetitions`/`listTeams`/`findTeam`); CLI incl. ICS/CSV; rate limit + cache; `sameFixture`/`matchPlayer` | Non-club user can export an ICS from README alone |
| 3 | `capture`; live canary → issue; CONTRIBUTING, templates, changesets; publish 1.0.0 to npm | 1.0.0 on npm; simulated drift opens issue |
| 4 | AssistentEsportiu depends on `fecapa-sync`; `fecapa*.ts` reduced to DB orchestration; existing tests pass | Preprod → prod, sync summaries unchanged |

Phases 1–3 don't touch AssistentEsportiu. Phase 4 follows that repo's flow (branch `jordi/jme-N-slug`, PR into preprod branch, Jordi merges, deploy jmfsrv, then Render).
