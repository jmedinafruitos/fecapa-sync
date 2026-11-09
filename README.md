# fecapa-sync

Llibreria de codi obert per mantenir una còpia local en JSON dels calendaris i
les actes d'hoquei patins de la FECAPA (Federació Catalana de Patinatge),
independent de qualsevol club.

> **Estat:** pre-1.0. L'API pot canviar entre versions 0.x. Encara no està
> publicada a npm. Vegeu [`docs/ROADMAP.md`](docs/ROADMAP.md).

> **Sincronitza poc, no sovint.** L'objectiu és una còpia local en JSON: una
> sincronització completa inicial i després sincronitzacions programades
> (una o dues per setmana) que només baixen el que encara pot canviar.
> Sincronitzar-ho tot sovint pot bloquejar la teva IP o saturar el servidor de
> la FECAPA per a tothom. Vegeu [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Instal·lació

Requereix Node.js 20.19 o superior. Mentre no estigui a npm, es pot instal·lar
des de GitHub:

```bash
npm install github:jmedinafruitos/fecapa-sync
```

## Del nom d'un club als seus partits (0.3)

No cal saber cap número. Executa `npx fecapa-sync init`: si no hi ha
configuració, en crea una plantilla:

```json
{
  "season": "2026/2027",
  "dataDir": "./fecapa-data",
  "scope": { "clubs": ["<club name>"], "categories": ["Benjamí"] },
  "levels": { "games": true, "actas": false },
  "refresh": { "games": "24h" },
  "limits": { "maxRequestsPerRun": 200, "delayMs": 1000 },
  "token": null
}
```

1. Busca el nom del teu club (2 o 3 peticions, no escriu res):

   ```bash
   npx fecapa-sync find "exemple" --live
   # Clubs:
   #   9001  EXEMPLE, C.P.  (teams: CP EXEMPLE)  5 teams: Benjamí, Sènior, FEM11
   ```

2. Posa'l a `scope.clubs` (nom o id), per exemple `"clubs": ["CP Exemple"]`.
   `scope.categories` és opcional: sense, tens totes les categories del club.
3. Executa `npx fecapa-sync init`. La llibreria descarrega la llista de lligues
   (amb els equips i els clubs) i la de clubs, resol els noms i només baixa els
   calendaris de les lligues del club en aquestes categories, i només en desa
   els partits dels seus equips.
4. Programa `npx fecapa-sync sync` al cron (vegeu més avall).

Si un nom coincideix amb més d'un club o amb cap, la sincronització s'atura
amb codi 2 i et mostra els candidats més semblants, sense fer cap més petició.
Les dades descobertes es guarden igualment: `npx fecapa-sync clubs` les llista.

Comandes de consulta (llegeixen la còpia local; `--live` pregunta a SIDGAD;
totes accepten `--json`):

```bash
npx fecapa-sync leagues    [--category Benjamí]
npx fecapa-sync categories
npx fecapa-sync clubs
npx fecapa-sync teams      [--club "CP Exemple"] [--category Aleví] [--league 4811]
npx fecapa-sync find "<text>"
```

Les categories es normalitzen sense tenir en compte accents, majúscules ni
català/castellà (Aleví/Alevín, Benjamí/Benjamín…): Prebenjamí, Benjamí, Aleví,
Infantil, Juvenil, Júnior, Sènior, Veterans i les femenines Minifem, FEM11,
FEM13, FEM15, FEM17 i FEM19. Les que no es reconeixen queden com a `unknown`
amb el nom original. La FECAPA no té camp de gènere: un equip d'una categoria
FEM o d'una lliga o grup que diu «Femenina» és `female`; la resta, `unknown`
(mai «masculí», perquè hi ha lligues mixtes).

## Sincronització

Altres àmbits possibles a `scope`:

- `clubs`: noms o ids de club. `categories`: noms o claus de categoria.
- `leagues`: números de competició (el paràmetre `liga` de l'URL del portal),
  o `"all"` per a tota la federació (només amb el calendari setmanal i els
  mínims per defecte).
- `teams`: ids d'equip per quedar-te només amb els partits d'aquests equips.

Els filtres es combinen: club + categoria són les lligues d'aquest club en
aquesta categoria. Amb `leagues` numèriques i sense noms, no cal cap nivell
de descoberta (com a la 0.2).

- `levels`: `leagues`, `categories`, `teams`, `clubs`, `games` i `actas`
  (`actas` activa `games`; un àmbit per club o categoria activa els nivells
  que necessita). `players` arriba a la 0.4.
- `token`: millor a la variable d'entorn `FECAPA_SIDGAD_TOKEN`. Sense token es
  fa servir la configuració pública del portal. No publiquis mai un token.

```bash
npx fecapa-sync init     # primera sincronització completa
npx fecapa-sync sync     # incremental: només el que toca; per al cron
npx fecapa-sync status   # estat local, sense xarxa
```

Cron recomanat, una o dues vegades per setmana (dilluns per recollir les actes
del cap de setmana, dijous pels canvis de calendari):

```cron
0 3 * * 1,4  cd /srv/app && npx fecapa-sync sync >> fecapa-sync.log 2>&1
```

`sync` surt amb codi 1 si la sincronització falla, 2 si la configuració és
incorrecta (també un nom de club o categoria ambigu), i 0 en els altres casos
(també si no hi havia res pendent, si s'ha acabat el pressupost de peticions o
si està en pausa per errors).

Des del codi:

```ts
import { createSync, discover } from "fecapa-sync";

// Abans del primer init, per triar l'àmbit (2-3 peticions, no escriu res):
const live = await discover();
console.log(live.findClub("exemple").map((club) => `${club.id} ${club.name}`));

const sync = createSync({ configPath: "./fecapa-sync.config.json" });
const result = await sync.run();
console.log(result.status, result.requests, result.changes.games.updated, result.changes.teams.created);
console.log(await sync.listTeams({ club: "CP Exemple", category: "Benjamí" }));
```

Les dades queden a `fecapa-data/2026-2027/`: `leagues.json`,
`categories.json`, `teams.json` i `clubs.json` (pels ids de la federació, amb
`firstSeenAt`/`updatedAt`, i `removedAt` si desapareixen),
`games/<liga>.json` i `actas/<partit>.json`. La FECAPA no marca mai un partit
com a ajornat o suspès: cada partit guarda la data, hora i pista actuals, un
historial (`history`) dels valors anteriors i `rescheduled`. Un partit que
desapareix del calendari es conserva amb `removedAt`. Cada acta té les dues
alineacions, amb `isGoalkeeper` per als porters. Les actes contenen dades de
menors: no les republiquis.

### Límits que imposa la llibreria

| | Per defecte | Mínim |
|---|---|---|
| `refresh.games` (per competició) | 24h | 12h |
| `refresh.actas` (primer reintent d'una acta no disponible) | 12h | 6h |
| `refresh.leagues` / `refresh.teams` | 7d | 24h |
| `refresh.categories` / `refresh.clubs` | 30d | 7d |
| `limits.delayMs` | 1000 ms | 1000 ms |
| `limits.maxRequestsPerRun` | 200 | 5 |

Els valors per sota del mínim s'apugen al mínim. Lligues, categories i equips
surten d'una sola petició (la llista de lligues) i els noms de club d'una
altra: un `init` per a un club costa 2 peticions més una per calendari de les
seves lligues; per a tota la federació, 2 més una per lliga (58 la temporada
2026/2027), sense comptar les actes. Una acta es demana 3 hores
després de l'inici del partit; si encara no hi és, es torna a provar al cap de
12h, 24h, 48h, 96h i 7 dies, i després de 6 intents es deixa fins que el
partit canviï de data o d'hora. Una acta final no es torna a demanar mai. Un error
(HTTP 429/5xx, rebuig de SIDGAD, canvi de format) atura la sincronització
sense tocar les dades i posa una pausa d'1 h, 2 h, 4 h… fins a 7 dies. Vegeu
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## Client de baix nivell

```ts
import { createClient, isFecapaError } from "fecapa-sync";

const fecapa = createClient({
  // Opcional. Sense token, la llibreria llegeix la configuració pública del portal.
  token: process.env.FECAPA_SIDGAD_TOKEN,
});

// Calendari d'una competició (el número `liga` de l'URL del portal)
const { source, matches } = await fecapa.getCalendar(4811);
console.log(source); // "sidgad-api" | "portal-config" | "legacy-html"
for (const m of matches) console.log(m.date, m.time, m.homeName, "-", m.awayName, m.venue, m.phaseName);

// Acta d'un partit amb les dues alineacions. `report` és null si no és final:
// `status` és "not-finished" o "no-file" (SIDGAD encara no té l'acta).
try {
  const { status, report } = await fecapa.getFullReport(matches[0].matchId!, { idc: 4811 });
  if (status === "final") console.log(report.homeScore, report.awayScore, report.home.filter((p) => p.isGoalkeeper));
} catch (error) {
  if (isFecapaError(error)) console.error(error.code, error.source); // p. ex. SOURCE_FORMAT_CHANGED
  else throw error;
}
```

`getReport(matchId, { idc, side })` retorna només un dels dos equips.
`getLeagues()` retorna totes les competicions de totes les temporades amb els
equips i els ids de club (una petició), i `getClubs()` els noms oficials dels
clubs. Utilitats pures: `toStartsAt`, `currentSeason`, `sameFixture`,
`matchPlayer`, `normalizePlayerName`, `categoryOf`, `normalizeCategory`,
`inferGender`.

### Bon veí

La llibreria es comporta com un client públic educat: s'identifica amb
`User-Agent: fecapa-sync/<versió> (+https://github.com/jmedinafruitos/fecapa-sync)`,
fa les peticions d'una en una i espera `delayMs` (per defecte 1000 ms) entre
peticions. No falseja cap navegador. Mai no publiquis un token SIDGAD al codi.

Consulteu també [`docs/HARDENING.md`](docs/HARDENING.md) per a la validació de marcadors i dates i el tractament de refusos.

## English

Open-source, club-agnostic TypeScript library that keeps a local JSON copy of
FECAPA (Catalan roller skating federation) roller hockey fixtures and match
reports ("actes").

**Status: pre-1.0.** The API may change between 0.x releases, and the package is
not on npm yet. Install it from GitHub (`npm install github:jmedinafruitos/fecapa-sync`,
Node.js ≥ 20.19).

**From a club name to its games (0.3).** No ids needed. `npx fecapa-sync init`
writes a template with `"scope": { "clubs": ["<club name>"], "categories": ["Benjamí"] }`.
Look your club up with `npx fecapa-sync find "<text>" --live` (2–3 requests,
nothing written), put its name or id in `scope.clubs`, keep or drop
`scope.categories`, and run `npx fecapa-sync init`. The library fetches the
league list (with teams and club ids) and the club list, resolves the names,
then fetches only the calendars of that club's leagues in those categories and
keeps only its teams' games. A name that matches several clubs or none stops
the run (exit 2) with the closest candidates and no further request. The
discovered data is stored anyway, so `fecapa-sync leagues|categories|clubs|teams
[--club …] [--category …]|find <query>` (all with `--json`, reading the local
store) can help you choose. Categories are matched ignoring accents and case,
in Catalan or Spanish (Aleví/Alevín…); unknown ones are kept as `unknown` with
their raw name. FECAPA has no gender field: a `FEM…` category or a league or
group named "Femenina" is `female`, everything else `unknown`, never male.

**Sync.** Other scopes: `scope.leagues` (the portal's `liga` ids, or `"all"` for
the whole federation), `scope.teams` (team ids). Filters intersect. Levels:
`leagues`, `categories`, `teams`, `clubs`, `games`, `actas` (`players` in 0.4).
Then run `npx fecapa-sync sync` from cron once or twice a week, e.g.
`0 3 * * 1,4`. In code: `createSync({ configPath })` or `createSync(configObject)`
returns `init()`, `run()`, `status()` and `listLeagues()`, `listCategories()`,
`listTeams({ league?, club?, category? })`, `listClubs()`, `findClub(query)`,
`findTeam(query)` over the local store; `discover()` lists a season live. Every
run returns a changeset covering every level. A run with nothing due makes no
request. Leagues, categories and teams share one request (refreshed every 7d by
default, floor 24h; categories 30d, floor 7d); club names one more (30d, floor
7d). `init` for one club costs 2 requests plus one per calendar of its leagues;
federation-wide, 2 plus one per league (58 in 2026/2027), actas aside. The
library enforces floors: games are refreshed at most every 12h (default 24h),
an unavailable acta is retried after 12h (minimum 6h), 24h, 48h, 96h and 7d,
then given up after 6 attempts until the game is rescheduled; a final acta is
never refetched; 1 s between requests; at most `maxRequestsPerRun` requests
(default 200). Any failure (HTTP 429/5xx, a SIDGAD refusal, a format change)
stops the run without touching the data and backs off for 1 h, doubling up to
7 days. FECAPA never marks a game as postponed or cancelled, so games keep a
`history` of previous date/time/venue values, a `rescheduled` flag and
`removedAt` when they leave the calendar; leagues, teams and clubs get
`removedAt` too. Actas hold both lineups with `isGoalkeeper`. `sync` exits 1
on failure and 2 on a config error.

**Client.** `createClient(options)` returns `getCalendar(idc)`,
`getReport(matchId, { idc, side, expectTeams? })` and
`getFullReport(matchId, { idc, expectTeams? })`, plus `getLeagues()` (every
league of every season with teams and club ids, one request) and `getClubs()`
(official club names). Report results carry a
`status` (`final`, `not-finished`, or `no-file` when SIDGAD has no acta yet).
Each call reports which data source answered: the SIDGAD JSON API with your own
token (`sidgad-api`), the public config embedded in the portal page
(`portal-config`), or the old server-rendered HTML (`legacy-html`), tried in
that order. Errors are `FecapaError`s with a stable `code` (`HTTP_ERROR`,
`SOURCE_FORMAT_CHANGED`, `TEAMS_MISMATCH`, `INVALID_CONFIG`, …). The client is
polite: honest User-Agent, one request at a time, a configurable delay between
requests.

**Sync rarely, not often.** Syncing everything often can get your IP blocked or
overload FECAPA's servers for everyone. Actes include minors' data: keep the
store for your own application. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Llicència

MIT
