import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { discover } from '../dist/index.js';
import { jsonFixture } from './helpers.mjs';
import { calendarBody, callNames, DAY, fakeApi, fakeClock, gamesFile, HOUR, readJsonFile, stateFile, testSync } from './sync-helpers.mjs';

const NOW = '2026-11-09T12:00:00.000Z';
const LEAGUES = () => jsonFixture('sidgad-api/2026-11-leagues.json');
const CLUBS = () => jsonFixture('sidgad-api/2026-11-clubs.json');
const BASE_GAMES = [
  { id: 900501, date: '2026-11-01', time: '12:30', home: 900101, away: 900102 },
  { id: 900502, date: '2026-11-08', time: '17:00', home: 900102, away: 900103 },
  { id: 900503, date: '2026-11-15', time: '10:00', home: 900103, away: 900101 },
  { id: 900504, date: null, home: 900104, away: 900101 },
];
const CALENDARS = () => ({
  4811: calendarBody(BASE_GAMES, { phaseId: 4951, phaseName: 'BCN BENJAMÍ PLATA 1' }),
  4812: calendarBody([{ id: 900601, date: '2026-11-07', time: '10:00', home: 900105, away: 900106 }], { phaseId: 4960, phaseName: 'BENJAMÍ OR 1' }),
  4789: calendarBody([{ id: 900701, date: '2026-11-07', time: '11:00', home: 900110, away: 900111 }], { phaseId: 4970, phaseName: 'ALEVÍ OR FEMENINA' }),
  4806: calendarBody([{ id: 900801, date: '2026-11-07', time: '12:00', home: 900107, away: 900108 }], { phaseId: 5001, phaseName: 'FEM 11 OR' }),
});
const level = (dataDir, name) => readJsonFile(path.join(dataDir, '2026-2027', `${name}.json`))[name];

function setup(scope, { config = {}, leagues = LEAGUES(), clubs = CLUBS() } = {}) {
  const clock = fakeClock(NOW);
  const api = fakeApi({ calendars: CALENDARS(), leagues, clubs });
  const { sync, dataDir } = testSync({ season: '2026/2027', scope, ...config }, { api, clock });
  return { clock, api, sync, dataDir };
}

test('from a club name and a category name to synced games, without knowing any id', async () => {
  const { sync, api, dataDir } = setup({ clubs: ['cp prova'], categories: ['Benjamí'] });
  const result = await sync.init();
  assert.equal(result.status, 'ok', JSON.stringify(result.error));
  // One request lists leagues+teams, one names the clubs, then only the club's Benjamí calendars.
  assert.deepEqual(callNames(api.calls), ['leagues:', 'clubs:', 'calendar:4811', 'calendar:4812']);
  assert.equal(result.requests, 4);
  assert.ok(result.notes.some((note) => note.includes('scope.clubs → PROVA, C.P. (9001)')));
  assert.ok(result.notes.some((note) => note.includes('scope → 2 league(s): 4811, 4812')));

  // Only games involving the club's teams.
  assert.deepEqual(Object.keys(gamesFile(dataDir, 4811).games).sort(), ['900501', '900503', '900504']);
  assert.deepEqual(Object.keys(gamesFile(dataDir, 4812).games), ['900601']);
  assert.equal(existsSync(path.join(dataDir, '2026-2027', 'games', '4806.json')), false);

  const status = await sync.status();
  assert.deepEqual(status.scope, { leagues: [4811, 4812], teams: [900101, 900105, 900107, 900109, 900112], error: null });
  assert.equal(status.discovery.clubs.stored, 6);
  assert.equal(status.discovery.leagues.nextDueAt, '2026-11-16T12:00:00.000Z');
  assert.equal(status.discovery.clubs.nextDueAt, '2026-12-09T12:00:00.000Z');
});

test('the four levels are stored by federation id, with raw names, inferred gender and firstSeenAt/updatedAt', async () => {
  const { sync, dataDir } = setup({ clubs: ['CP Prova'], categories: ['Benjamí'] });
  const result = await sync.init();

  const leagues = level(dataDir, 'leagues');
  assert.deepEqual(Object.keys(leagues).sort(), ['4775', '4789', '4806', '4811', '4812', '5014', '5076']); // 2025/2026 left out
  assert.deepEqual(leagues[4806], {
    id: 4806, name: 'FEM 11 OR', category: 'fem11', categoryRaw: 'FEM 11 OR', sidgadCategory: 'BENJAMI', sidgadSex: 'FEMENINA',
    zoneId: 1, zoneName: 'FEDERACIÓ', gender: 'female', genderSource: 'inferred', teamIds: [900107, 900108], groups: [],
    firstSeenAt: NOW, updatedAt: NOW, removedAt: null,
  });
  assert.deepEqual([leagues[4775].category, leagues[4775].gender], ['senior', 'female']);
  assert.deepEqual([leagues[5014].category, leagues[5014].gender], ['senior', 'unknown']);
  assert.deepEqual([leagues[5076].category, leagues[5076].categoryRaw], ['unknown', 'YOUTH GOLDEN CAT']);
  assert.deepEqual([leagues[4811].gender, leagues[4811].sidgadSex], ['unknown', 'MIXTA']);
  // Groups come from the calendars the games level fetched anyway.
  assert.deepEqual(leagues[4811].groups, [{ id: 4951, name: 'BCN BENJAMÍ PLATA 1', category: 'benjami', categoryRaw: 'BCN BENJAMÍ PLATA 1', gender: 'unknown', genderSource: 'inferred' }]);

  const categories = level(dataDir, 'categories');
  assert.deepEqual(Object.keys(categories), ['benjami', 'alevi', 'senior', 'fem11', 'unknown']);
  assert.deepEqual(categories.fem11.leagueIds, [4806]);
  assert.equal(categories.fem11.gender, 'female');
  assert.equal(categories.fem11.ageGroup, 'benjami');
  assert.equal(categories.benjami.gender, 'unknown');
  assert.deepEqual(categories.benjami.rawNames, ['BCN BENJAMÍ PLATA 1', 'BENJAMÍ OR 1', 'BENJAMÍ OR BARCELONA', 'BENJAMÍ PLATA BARCELONA']);
  assert.deepEqual(categories.unknown.rawNames, ['YOUTH GOLDEN CAT']);

  const teams = level(dataDir, 'teams');
  assert.deepEqual(teams[900109], {
    id: 900109, name: 'CP PROVA', shortName: 'PRO', clubId: 9001, leagueIds: [4775], categories: ['senior'],
    gender: 'female', genderSource: 'inferred', firstSeenAt: NOW, updatedAt: NOW, removedAt: null,
  });
  assert.equal(teams[900101].gender, 'unknown');
  assert.equal(teams[900104].name, 'PATIN INVENTAT');

  // Clubs are grouped across teams and leagues by the federation's club id.
  const clubs = level(dataDir, 'clubs');
  assert.deepEqual(clubs[9001], {
    id: 9001, name: 'PROVA, C.P.', officialName: 'PROVA, C.P.', teamName: 'CP PROVA', aliases: ['CP PROVA'],
    teamIds: [900101, 900105, 900107, 900109, 900112], leagueIds: [4775, 4806, 4811, 4812, 5014],
    categories: ['benjami', 'senior', 'fem11'], firstSeenAt: NOW, updatedAt: NOW, removedAt: null,
  });
  assert.equal('gender' in clubs[9001], false);
  // Not in the clubs list (a guest team): the name comes from its teams.
  assert.deepEqual([clubs[9100009].name, clubs[9100009].officialName, clubs[9100009].teamIds], ['SELECCIÓ INVENTADA', null, [900114, 900116]]);
  // Clubs without a team this season are never stored, whatever the clubs list holds.
  assert.equal(clubs[9006], undefined);
  assert.equal(clubs[9007], undefined);

  assert.deepEqual(['leagues', 'categories', 'teams', 'clubs'].map((name) => result.changes[name].created.length), [7, 5, 16, 6]);
});

test('a run with nothing due makes 0 requests; each level refreshes on its own interval', async () => {
  const { sync, api, clock } = setup({ clubs: ['CP Prova'], categories: ['Benjamí'] });
  await sync.init();
  assert.equal(api.calls.length, 4);
  clock.advance(HOUR);
  const idle = await sync.run();
  assert.equal(idle.requests, 0);
  assert.equal(api.calls.length, 4);
  assert.equal(idle.status, 'ok');

  clock.advance(DAY); // games (24h) are due, the discovery levels (7d, 30d) are not
  await sync.run();
  assert.deepEqual(callNames(api.calls.slice(4)), ['calendar:4811', 'calendar:4812']);

  clock.set('2026-11-16T12:00:00.000Z'); // leagues/teams (7d): one leagues request, still no clubs
  await sync.run();
  assert.deepEqual(callNames(api.calls.slice(6)), ['leagues:', 'calendar:4811', 'calendar:4812']);

  clock.set('2026-12-09T12:00:00.000Z'); // clubs (30d)
  await sync.run();
  assert.deepEqual(callNames(api.calls.slice(9)), ['leagues:', 'clubs:', 'calendar:4811', 'calendar:4812']);

  const names = callNames(api.calls.slice(9));
  assert.equal(new Set(names).size, names.length);
});

test('nothing is fetched twice in a run, and a federation-wide scope costs 2 + one calendar per league', async () => {
  const leagues = LEAGUES();
  // Keep the leagues whose calendars the fake API knows.
  leagues.idcs = leagues.idcs.filter((league) => ['4811', '4812', '4789', '4806', '4700'].includes(league.idc));
  const { sync, api } = setup({ leagues: 'all' }, { config: { levels: { games: true, categories: true, clubs: true } }, leagues });
  const result = await sync.init();
  assert.equal(result.status, 'ok', JSON.stringify(result.error));
  const names = callNames(api.calls);
  assert.deepEqual(names, ['leagues:', 'clubs:', 'calendar:4789', 'calendar:4806', 'calendar:4811', 'calendar:4812']);
  assert.equal(new Set(names).size, names.length);
});

test('a category alone selects its leagues and keeps all their games', async () => {
  const { sync, api, dataDir } = setup({ categories: ['Alevín'] });
  const result = await sync.init();
  assert.equal(result.status, 'ok');
  assert.deepEqual(callNames(api.calls), ['leagues:', 'calendar:4789']);
  assert.deepEqual(Object.keys(gamesFile(dataDir, 4789).games), ['900701']);
  // A group named "… FEMENINA" inside a mixed league is female; the league stays unknown.
  const league = level(dataDir, 'leagues')[4789];
  assert.deepEqual([league.gender, league.groups[0].gender, league.groups[0].category], ['unknown', 'female', 'alevi']);
});

test('ambiguous or unmatched names fail with the closest candidates, keep what was discovered and make no more requests', async () => {
  const { sync, api, dataDir } = setup({ clubs: ['Prova'] });
  const result = await sync.init();
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'INVALID_CONFIG');
  assert.match(result.error.message, /club "Prova" is ambiguous: it matches 2 clubs \(PROVA SANTS, C\.P\. \(9005\); PROVA, C\.P\. \(9001\)\)/);
  assert.deepEqual(callNames(api.calls), ['leagues:', 'clubs:']);
  // No backoff: the origin did nothing wrong. The levels are kept for choosing a name.
  assert.equal(stateFile(dataDir).backoff, null);
  assert.equal(stateFile(dataDir).lastRun.error.code, 'INVALID_CONFIG');
  assert.equal(Object.keys(level(dataDir, 'clubs')).length, 6);
  const again = await sync.run();
  assert.equal(again.status, 'failed');
  assert.equal(again.requests, 0);

  const missing = setup({ clubs: ['Club Prova Sans'] });
  const unmatched = await missing.sync.init();
  assert.match(unmatched.error.message, /No club matches "Club Prova Sans"\. Closest: PROVA SANTS, C\.P\. \(9005\)/);

  const category = setup({ categories: ['Cadet'] });
  const bad = await category.sync.init();
  assert.equal(bad.error.code, 'INVALID_CONFIG');
  assert.match(bad.error.message, /Category "Cadet" is not recognised\. Closest: /);
  const empty = setup({ categories: ['Juvenil'] });
  assert.match((await empty.sync.init()).error.message, /No league of this season is in category "Juvenil"/);
});

test('a club id works like a name; a template placeholder fails before any request', async () => {
  const { sync, api } = setup({ clubs: [9005] });
  assert.equal((await sync.init()).status, 'ok');
  assert.deepEqual(callNames(api.calls), ['leagues:', 'clubs:', 'calendar:4789']);

  const template = setup({ clubs: ['<club name>'], categories: ['Benjamí'] });
  await assert.rejects(template.sync.init(), { code: 'INVALID_CONFIG', message: /replace the placeholder "<club name>"/ });
  assert.equal(template.api.calls.length, 0);
});

test('leagues, teams and clubs that disappear are marked removedAt, not deleted', async () => {
  const { sync, api, clock, dataDir } = setup({ clubs: ['CP Prova'], categories: ['Benjamí'] });
  await sync.init();
  const fewer = LEAGUES();
  fewer.idcs = fewer.idcs.filter((league) => !['4812', '5076'].includes(league.idc));
  api.leagues = fewer;
  clock.set('2026-11-16T12:00:00.000Z');
  const result = await sync.run();
  const at = '2026-11-16T12:00:00.000Z';
  assert.deepEqual(result.changes.leagues.removed.map((league) => league.id), [4812, 5076]);
  assert.deepEqual(result.changes.teams.removed.map((team) => team.id).sort(), [900105, 900106, 900114, 900116]);
  assert.deepEqual(result.changes.clubs.removed.map((club) => club.id), [9100009]);
  assert.ok(result.changes.clubs.updated.some((club) => club.id === 9001));
  const league = level(dataDir, 'leagues')[4812];
  assert.equal(league.removedAt, at);
  assert.equal(league.firstSeenAt, NOW);
  assert.equal(level(dataDir, 'clubs')[9001].teamIds.includes(900105), false);
  // The scope no longer includes the removed league; its stored games are left alone.
  assert.deepEqual(callNames(api.calls.slice(4)), ['leagues:', 'calendar:4811']);
  assert.deepEqual((await sync.listLeagues()).map((l) => l.id).includes(4812), false);

  api.leagues = LEAGUES();
  clock.set('2026-11-23T12:00:00.000Z');
  const back = await sync.run();
  assert.deepEqual(back.changes.leagues.updated.map((l) => l.id).sort(), [4812, 5076]);
  assert.equal(level(dataDir, 'leagues')[4812].removedAt, null);
});

test('a small budget stops cleanly after discovery and continues next run', async () => {
  const { sync, api, clock } = setup({ clubs: ['CP Prova'], categories: ['Benjamí'] }, { config: { limits: { maxRequestsPerRun: 5 } } });
  const first = await sync.init();
  assert.equal(first.status, 'partial');
  assert.deepEqual(callNames(api.calls), ['leagues:', 'clubs:', 'calendar:4811']);
  clock.advance(HOUR);
  await sync.run();
  assert.deepEqual(callNames(api.calls.slice(3)), ['calendar:4812']);
});

test('explicit league ids still need no discovery request (0.2 configs keep working)', async () => {
  const { sync, api, dataDir } = setup({ leagues: [4811], teams: [900101] });
  await sync.init();
  assert.deepEqual(callNames(api.calls), ['calendar:4811']);
  assert.equal(existsSync(path.join(dataDir, '2026-2027', 'leagues.json')), false);
});

// --- discovery API --------------------------------------------------------

test('the discovery API reads the store, and asks for init when it is empty', async () => {
  const { sync, api } = setup({ clubs: ['CP Prova'], categories: ['Benjamí'] });
  await assert.rejects(sync.listClubs(), { code: 'STORE_EMPTY', message: /fecapa-sync init/ });
  await sync.init();
  const calls = api.calls.length;

  assert.deepEqual((await sync.listLeagues()).map((league) => league.id), [4812, 4811, 4789, 4775, 5014, 4806, 5076]);
  assert.deepEqual((await sync.listLeagues({ category: 'fem 11' })).map((league) => league.id), [4806]);
  assert.deepEqual((await sync.listCategories()).map((category) => category.key), ['benjami', 'alevi', 'senior', 'fem11', 'unknown']);
  assert.deepEqual((await sync.listClubs()).map((club) => club.id), [9002, 9003, 9004, 9005, 9001, 9100009]);
  assert.deepEqual((await sync.listTeams({ club: 'CP Prova', category: 'Benjamí' })).map((team) => team.id), [900105, 900101]);
  assert.deepEqual((await sync.listTeams({ league: 4806 })).map((team) => team.id), [900108, 900107]);
  assert.deepEqual((await sync.findClub('prova')).map((club) => club.id).sort(), [9001, 9005]);
  // Exact matches first, then names containing every word.
  assert.deepEqual((await sync.findClub('Prova, C.P.')).map((club) => club.id), [9001, 9005]);
  assert.deepEqual((await sync.findClub('nothing like it')), []);
  assert.deepEqual((await sync.findTeam('fictici b')).map((team) => team.id), [900106]);
  assert.deepEqual((await sync.findTeam(900111)).map((team) => team.name), ['CP PROVA SANTS']);
  await assert.rejects(sync.listTeams({ club: 'prova' }), { code: 'INVALID_ARGUMENT', message: /ambiguous/ });
  assert.equal(api.calls.length, calls);
});

test('discover() lists a season live (2 requests with a token) and writes nothing', async () => {
  const api = fakeApi({ leagues: LEAGUES(), clubs: CLUBS() });
  const found = await discover({ season: '2026/2027', token: 't' }, { fetch: api.fetch, sleep: async () => {} });
  assert.equal(found.requests, 2);
  assert.equal(found.source, 'sidgad-api');
  assert.deepEqual(found.findClub('CP Prova').map((club) => club.id), [9001, 9005]);
  assert.equal(found.listLeagues().length, 7);
  const old = await discover({ season: '2025/2026', token: 't' }, { fetch: api.fetch, sleep: async () => {} });
  assert.deepEqual(old.listLeagues().map((league) => league.id), [4700]);
});

