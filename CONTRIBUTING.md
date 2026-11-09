# Com contribuir

Gràcies per ajudar. `fecapa-sync` és una llibreria i una CLI, independent de
qualsevol club, que manté una còpia local de les dades d'hoquei patins de la
FECAPA. La majoria de contribucions arriben quan la FECAPA o SIDGAD canvien
alguna cosa i la llibreria deixa de llegir-la: per això hi ha un procediment
per a aquest cas ([«La FECAPA ha canviat»](#la-fecapa-ha-canviat)).

[English below](#contributing-english).

## Preparació

Cal Node.js 20.19 o superior (CI prova 20 i 22).

```bash
git clone https://github.com/jmedinafruitos/fecapa-sync.git
cd fecapa-sync
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

- `npm test` compila i executa `node --test test/*.test.mjs`. Els tests **no
  fan cap petició a la xarxa**: les respostes surten de `fixtures/` o d'un
  `fetch` fals.
- El codi és a `src/`, els tests a `test/`, les respostes desades a
  `fixtures/<font>/` (`sidgad-api`, `portal-config`, `legacy-html`) i les
  decisions de disseny a [`docs/ROADMAP.md`](docs/ROADMAP.md).
- `package-lock.json` només pot apuntar a `https://registry.npmjs.org/` (CI ho
  comprova). Si el teu npm fa servir un altre registre, instal·la amb
  `--registry=https://registry.npmjs.org/`.

## La FECAPA ha canviat

Quan un format canvia, la llibreria falla amb `SOURCE_FORMAT_CHANGED` i el nom
de la font, mai amb un resultat buit. El canari setmanal (`live-canary`) obre
llavors una incidència amb l'etiqueta `source-drift`. Per arreglar-ho:

1. **Captura** una resposta real, anonimitzada, amb una sola petició:

   ```bash
   npx fecapa-sync capture report <id del partit> --out fixtures/sidgad-api/2027-02-report-<descripcio>.json
   npx fecapa-sync capture calendar <id de la competició> --out fixtures/sidgad-api/2027-02-calendar-<descripcio>.json
   # també: leagues, clubs, rosters <id de la competició>
   ```

   `capture` fa una petició a l'API (dues sense token: primer llegeix el token
   públic del portal) amb el client educat de la llibreria. Abans de desar:
   - els noms de jugadors, entrenadors i àrbitres passen a noms inventats, i
     els seus ids a ids ≥ 900000;
   - els noms i ids d'equips i clubs, i les pistes, també passen a inventats
     (`--keep-teams` els conserva **només per depurar en local; no ho
     comitis mai**);
   - les dates, hores, marcadors, estats, `player_role`, ids de partit i noms
     de grup no es toquen, perquè els analitzadors els necessiten;
   - el mateix fitxer d'entrada sempre dona la mateixa sortida.

   Si queda algun nom o id original, no escriu res. Només escriu dins de
   `fixtures/` (si no, `--force`). La resposta es desa encara que
   l'analitzador falli, i la CLI diu quin error dona: aquest és el test que has
   d'escriure.

2. **Revisa el fitxer** abans de fer-ne commit: no hi ha d'haver cap nom
   real. Si dubtes, no el pugis.
3. **Escriu un test que falli** amb el fitxer nou. Només per posar-lo a
   `fixtures/` amb el nom `<font>/<aaaa>-<mm>-<tipus>-<descripcio>.json`,
   `test/all-fixtures.test.mjs` ja el passa per l'analitzador del seu tipus
   (vegeu [`fixtures/README.md`](fixtures/README.md)). Afegeix un test concret
   per al camp que ha canviat.
4. **Arregla l'analitzador o afegeix una font** a `src/parsers/` o
   `src/sources/`. Els fixtures antics s'han de continuar llegint: el test de
   tots els fixtures ho comprova.
5. **Obre una PR** amb la plantilla i **afegeix un changeset**:
   `npx changeset` (tipus `patch` per a un arreglament). Explica què ha canviat
   a la FECAPA amb camps i codis, no amb dades.

## Normes

- **Cap dada personal real.** Les actes i les plantilles contenen menors. Ni
  als fixtures, ni als tests, ni a les incidències, ni als registres de CI, ni
  a les PR. Els fixtures fan servir noms inventats i ids de jugador ≥ 900000
  (el test de fixtures ho comprova). Fes servir `capture`; no copiïs respostes
  a mà.
- **Cap token.** No posis mai un token SIDGAD al codi ni als fixtures (fes
  servir `public-token`). En local, `FECAPA_SIDGAD_TOKEN`.
- **Respecta els límits del client.** Una petició alhora, com a mínim 1 s
  entre peticions (2 s al canari), un `User-Agent` honest, sense imitar cap
  navegador, i aturada davant de 429/5xx o d'un rebuig de SIDGAD. Una funció
  que afegeixi peticions ha de justificar-les i tenir un pressupost. Per
  provar en viu, poques peticions i espaiades; mai en bucle.
- **Independent de qualsevol club.** Cap nom ni id de club, equip o
  competició real al codi, els tests, la documentació, els commits o les
  plantilles, excepte com a exemple públic.
- **Falla de manera visible.** Un canvi de format és
  `SOURCE_FORMAT_CHANGED`, no una llista buida.
- Missatges de commit en anglès, curts i en imperatiu (`fix: …`, `feat: …`,
  `docs: …`). Comentaris de codi en anglès.

## Publicació

Les versions es gestionen amb [changesets](https://github.com/changesets/changesets):

1. Cada PR que canvia el comportament porta un fitxer de `.changeset/`
   (`npx changeset`): `patch` per a arreglaments, `minor` per a funcions noves
   compatibles, `major` per a canvis incompatibles.
2. Quan es fusiona a `main`, el workflow `release` obre o actualitza la PR
   **«Version Packages»**, que puja la versió, escriu `CHANGELOG.md` i
   actualitza `src/version.ts`.
3. Quan el mantenidor fusiona aquesta PR, el mateix workflow publica a npm amb
   `npm publish --provenance --access public`. Si el secret `NPM_TOKEN` no hi
   és, la publicació se salta amb un avís.

Ningú no publica a mà.

---

## Contributing (English)

Thanks for helping. `fecapa-sync` is a club-agnostic library and CLI that
keeps a local copy of FECAPA roller hockey data. Most contributions start when
FECAPA or SIDGAD changes something and the library can no longer read it, so
there is a playbook for that.

**Setup.** Node.js ≥ 20.19 (CI runs 20 and 22). `npm ci`, then
`npm run lint && npm run typecheck && npm test && npm run build`. Tests never
touch the network: answers come from `fixtures/` or a fake `fetch`.
`package-lock.json` must only reference `https://registry.npmjs.org/` (CI
checks it).

**"FECAPA changed" playbook.** A format change fails loudly with
`SOURCE_FORMAT_CHANGED` and the source name; the weekly `live-canary` then
opens a `source-drift` issue.

1. **Capture** one live answer, anonymised:
   `npx fecapa-sync capture <calendar|report|leagues|clubs|rosters> [<id>] --out fixtures/sidgad-api/<yyyy-mm>-<kind>-<label>.json`.
   One API request through the polite client (two without a token: the portal
   page holds the public token). Player, staff and referee names become
   invented names and their ids ids ≥ 900000; team and club names and ids and
   venues are replaced too unless `--keep-teams` (local debugging only, never
   commit it). Dates, times, scores, statuses, `player_role`, match ids and
   group names are kept. The mapping is deterministic. Nothing is written if
   any input name or id survives, or outside `fixtures/` without `--force`.
   The file is saved even when the parser fails, and the CLI prints the error:
   that is your failing test.
2. **Check the file** before committing it. No real names. When in doubt,
   leave it out.
3. **Write a failing test.** A file named `<source>/<yyyy>-<mm>-<kind>-<label>.json`
   is already run through its parser by `test/all-fixtures.test.mjs` (see
   [`fixtures/README.md`](fixtures/README.md)); add a focused test for the
   field that changed.
4. **Fix the parser or add a source** in `src/parsers/` or `src/sources/`.
   Old fixtures must still parse.
5. **Open a PR** with the template and **add a changeset** (`npx changeset`,
   `patch` for a fix). Describe the change with field names and codes, not
   data.

**Rules.** No real personal data anywhere (fixtures, tests, issues, CI logs,
PRs): match reports and rosters involve minors. No tokens (`public-token` in
fixtures, `FECAPA_SIDGAD_TOKEN` locally). Keep the polite-client limits: one
request at a time, at least 1 s apart (2 s in the canary), an honest
User-Agent, no browser impersonation, stop on 429/5xx or a SIDGAD refusal; a
feature that adds requests needs a reason and a budget. Stay club-agnostic: no
real club, team or competition names or ids except as public examples. Commit
messages in English, short and imperative.

**Releases.** [Changesets](https://github.com/changesets/changesets): every PR
that changes behaviour adds a `.changeset/` file. On `main`, the `release`
workflow opens or updates a **"Version Packages"** PR (version bump,
`CHANGELOG.md`, `src/version.ts`). Merging it publishes to npm with
`npm publish --provenance --access public`; without the `NPM_TOKEN` secret the
publish is skipped with a notice. Nobody publishes by hand.

Security issues: see [`SECURITY.md`](SECURITY.md).
