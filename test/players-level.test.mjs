import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { initials } from '../dist/index.js';
import { jsonFixture } from './helpers.mjs';
import {
  actaPath, calendarBody, callNames, DAY, fakeApi, fakeClock, HOUR, readJsonFile, TEAMS, testSync,
} from './sync-helpers.mjs';

// Every name and id here is invented; player ids are ≥ 900000.
const NOW = '2026-11-09T12:00:00.000Z';
const GAMES_4811 = [
  { id: 900501, date: '2026-11-01', time: '12:30', home: 900101, away: 900102 },
  { id: 900502, date: '2026-11-08', time: '17:00', home: 900102, away: 900103 },
  { id: 900503, date: '2026-11-22', time: '10:00', home: 900103, away: 900101 },
];
const GAMES_4806 = [{ id: 900801, date: '2026-11-07', time: '12:00', home: 900107, away: 900108 }];

const row = (id, name, { role = null, goals = 0, yellow = 0, blue = 0, red = 0 } = {}) => ({
  player_id: String(id), player_name: name, player_number: '1', player_role: role,
  goals: String(goals), yellow_card: yellow, blue_card: blue, red_card: red,
});

function report(id, home, away, homeRoster, awayRoster, tournament = 'LLIGA PROVA 1') {
  return {
    game_data: {
      game_id: String(id), game_completed: 'true', tournament_name: tournament, venue_info: 'PAVELLO PROVA',
      home_team_name: TEAMS[home], away_team_name: TEAMS[away], home_team_score: '3', away_team_score: '2',
      home_roster: homeRoster, away_roster: awayRoster, home_goalies: [], away_goalies: [],
    },
  };
}

const REPORTS = () => ({
  900501: report(900501, 900101, 900102,
    [row(900001, 'PROVA PRIMER,JUGADOR', { role: 'P' }), row(900002, 'PROVA SEGON,JUGADORA', { goals: 2, yellow: 1 })],
    [row(900003, 'FICTICI TERCER,JUGADOR', { goals: 1, blue: 1 }), row(900004, 'FICTICI QUART,PORTER', { role: 'P' })]),
  900502: report(900502, 900102, 900103,
    [row(900003, 'FICTICI TERCER,JUGADOR', { goals: 2, red: 1 }), row(900004, 'FICTICI QUART,PORTER', { goals: 1 })],
    [row(900005, 'IMAGINARI CINQUE,JUGADOR')]),
  900801: report(900801, 900107, 900108,
    [row(900002, 'PROVA SEGON,JUGADORA', { goals: 4 })],
    [row(900006, 'IMAGINARI SISENA,JUGADORA', { role: 'P' })], 'FEM 11 OR'),
});

const CONFIG = { season: '2026/2027', scope: { leagues: [4811, 4806] }, levels: { players: true } };

function setup({ config = CONFIG, reports = REPORTS(), rosters = {}, leagues } = {}) {
  const clock = fakeClock(NOW);
  const api = fakeApi({
    calendars: { 4811: calendarBody(GAMES_4811), 4806: calendarBody(GAMES_4806, { phaseId: 5001, phaseName: 'FEM 11 OR' }) },
    reports, rosters, leagues,
  });
  const { sync, dataDir } = testSync(config, { api, clock });
  return { clock, api, sync, dataDir };
}

const playersOf = (dataDir) => readJsonFile(path.join(dataDir, '2026-2027', 'players.json')).players;

test('players are built from the stored actas with per-season stats, at no extra request', async () => {
  const { sync, api, dataDir } = setup();
  const result = await sync.init();
  assert.equal(result.status, 'ok', JSON.stringify(result.error));
  // Calendars and actas only: the players level costs nothing.
  assert.deepEqual(callNames(api.calls).sort(), ['calendar:4806', 'calendar:4811', 'report:900501', 'report:900502', 'report:900801']);
  const players = playersOf(dataDir);
  assert.deepEqual(Object.keys(players), ['900001', '900002', '900003', '900004', '900005', '900006']);

  const scorer = players['900003'];
  assert.equal(scorer.name, 'JUGADOR FICTICI TERCER');
  assert.equal(scorer.season, '2026/2027');
  assert.deepEqual(scorer.stats, { games: 2, goals: 3, yellowCards: 0, blueCards: 1, redCards: 1, gamesAsGoalkeeper: 0 });
  assert.deepEqual(scorer.teamIds, [900102]);
  assert.deepEqual(scorer.leagueIds, [4811]);
  assert.deepEqual(scorer.sources, ['actas']);
  assert.equal(scorer.isGoalkeeper, false);
  assert.deepEqual([scorer.firstSeenAt, scorer.updatedAt, scorer.removedAt], [NOW, NOW, null]);

  // Two teams and two leagues in one season.
  const twoTeams = players['900002'];
  assert.deepEqual(twoTeams.teamIds, [900101, 900107]);
  assert.deepEqual(twoTeams.leagueIds, [4806, 4811]);
  assert.deepEqual(twoTeams.teams.map((team) => [team.id, team.name, team.games]), [[900101, 'CP PROVA B', 1], [900107, 'CP PROVA', 1]]);
  assert.deepEqual(twoTeams.stats, { games: 2, goals: 6, yellowCards: 1, blueCards: 0, redCards: 0, gamesAsGoalkeeper: 0 });
  assert.deepEqual(result.changes.players.created.map((player) => player.id), [900001, 900002, 900003, 900004, 900005, 900006]);
});

test('goalkeeper detection is aggregated over the season: "P" once is enough, and the count is kept', async () => {
  const { sync, dataDir } = setup();
  await sync.init();
  const players = playersOf(dataDir);
  // Marked "P" in one of two actas.
  assert.equal(players['900004'].isGoalkeeper, true);
  assert.equal(players['900004'].stats.gamesAsGoalkeeper, 1);
  assert.equal(players['900004'].stats.games, 2);
  assert.equal(players['900001'].isGoalkeeper, true);
  assert.equal(players['900005'].isGoalkeeper, false);
});

test('stats never double count: re-reading the same actas on later runs leaves players unchanged', async () => {
  const { sync, dataDir, clock } = setup();
  await sync.init();
  const first = playersOf(dataDir);
  for (let i = 0; i < 3; i++) {
    clock.advance(DAY);
    const result = await sync.run();
    assert.deepEqual(result.changes.players, { created: [], updated: [], removed: [] });
  }
  assert.deepEqual(playersOf(dataDir), first);
  // Even if an acta file is rewritten with the same content.
  await sync.init();
  assert.deepEqual(playersOf(dataDir)['900003'].stats, first['900003'].stats);
});

test('a name that changes keeps the earlier spelling as an alias', async () => {
  const { sync, api, dataDir, clock } = setup();
  await sync.init();
  // The next game spells the player differently.
  api.reports[900503] = report(900503, 900103, 900101, [row(900005, 'IMAGINARI CINQUE,JUGADOR')],
    [row(900002, 'PROVA-SEGON,JÚLIA', { goals: 1 })]);
  clock.set('2026-11-23T12:00:00.000Z');
  const result = await sync.run();
  const player = playersOf(dataDir)['900002'];
  assert.equal(player.name, 'JÚLIA PROVA-SEGON');
  assert.deepEqual(player.aliases, ['JUGADORA PROVA SEGON']);
  assert.equal(player.stats.games, 3);
  assert.equal(player.updatedAt, '2026-11-23T12:00:00.000Z');
  assert.deepEqual(result.changes.players.updated.map((p) => p.id).sort(), [900002, 900005]);
});

test('gender: a player seen with a women\'s team is female (inferred); everyone else unknown, never male', async () => {
  const { sync, dataDir } = setup();
  await sync.init();
  const players = playersOf(dataDir);
  // The FEM 11 group of the acta makes the team female.
  assert.deepEqual([players['900002'].gender, players['900002'].genderSource], ['female', 'inferred']);
  assert.equal(players['900006'].gender, 'female');
  assert.deepEqual(players['900002'].teams.map((team) => team.gender), ['unknown', 'female']);
  for (const id of ['900001', '900003', '900004', '900005']) assert.equal(players[id].gender, 'unknown');
  assert.equal(Object.values(players).some((player) => player.gender === 'male'), false);
});

test('gender: SIDGAD\'s FEMENINA label on a league counts too, without any FEM or "Femenina" in the names', async () => {
  const leagues = jsonFixture('sidgad-api/2026-11-leagues.json');
  const fem = leagues.idcs.find((league) => String(league.idc) === '4806');
  fem.nombre_idc = 'LLIGA PROVA';
  fem.nombre_categoria = 'BENJAMI';
  const clock = fakeClock(NOW);
  const reports = REPORTS();
  reports[900801].game_data.tournament_name = 'LLIGA PROVA';
  const api = fakeApi({ calendars: { 4811: calendarBody(GAMES_4811), 4806: calendarBody(GAMES_4806, { phaseName: 'LLIGA PROVA' }) }, reports, leagues });
  const { sync, dataDir } = testSync({ ...CONFIG, levels: { players: true, leagues: true } }, { api, clock });
  await sync.init();
  const players = playersOf(dataDir);
  assert.equal(players['900006'].gender, 'female');
  assert.equal(players['900002'].gender, 'female');
  assert.equal(players['900003'].gender, 'unknown');
});

test('players.names "initials" and "none" store no full names, in players.json nor in the actas', async () => {
  const initialsRun = setup({ config: { ...CONFIG, players: { names: 'initials' } } });
  await initialsRun.sync.init();
  const players = playersOf(initialsRun.dataDir);
  assert.equal(players['900003'].name, 'J. F. T.');
  assert.deepEqual(players['900003'].stats.goals, 3);
  const acta = readJsonFile(actaPath(initialsRun.dataDir, 900501));
  assert.deepEqual(acta.home.map((p) => p.name), ['J. P. P.', 'J. P. S.']);
  assert.equal(initials('J. P. S.'), 'J. P. S.');

  const none = setup({ config: { ...CONFIG, players: { names: 'none' } } });
  await none.sync.init();
  const anonymous = playersOf(none.dataDir);
  assert.deepEqual(Object.values(anonymous).map((player) => [player.name, player.aliases]), Array(6).fill([null, []]));
  assert.equal(anonymous['900004'].isGoalkeeper, true);
  assert.equal(JSON.stringify(readJsonFile(actaPath(none.dataDir, 900502))).includes('FICTICI TERCER'), false);
});

test('switching players.names to "none" rewrites what is already stored, without any request', async () => {
  const { sync, api, dataDir, clock } = setup();
  await sync.init();
  assert.equal(readJsonFile(actaPath(dataDir, 900501)).home[0].name, 'JUGADOR PROVA PRIMER');
  const calls = api.calls.length;
  clock.advance(HOUR);
  const { sync: strict } = testSync({ ...CONFIG, players: { names: 'none' } }, { api, clock, dataDir });
  const result = await strict.run();
  assert.equal(api.calls.length, calls);
  assert.equal(result.requests, 0);
  assert.equal(readJsonFile(actaPath(dataDir, 900501)).home[0].name, null);
  assert.equal(result.changes.actas.updated.length, 3);
  assert.deepEqual(Object.values(playersOf(dataDir)).map((player) => player.name), Array(6).fill(null));
  assert.deepEqual(Object.values(playersOf(dataDir)).map((player) => player.aliases), Array(6).fill([]));
});

test('rosters (opt-in) add players who have not played yet; one request per league every refresh.players', async () => {
  const rosters = { 4811: jsonFixture('sidgad-api/2026-11-stats.json') };
  const config = { ...CONFIG, players: { rosters: true } };
  const { sync, api, dataDir, clock } = setup({ config, rosters });
  await sync.init();
  assert.deepEqual(callNames(api.calls).filter((name) => name.startsWith('stats')).sort(), ['stats:4806', 'stats:4811']);
  const players = playersOf(dataDir);
  const newcomer = players['900050'];
  assert.deepEqual(newcomer.sources, ['rosters']);
  assert.equal(newcomer.name, 'ALUMNA NOVA INVENTADA');
  assert.deepEqual(newcomer.stats, { games: 0, goals: 0, yellowCards: 0, blueCards: 0, redCards: 0, gamesAsGoalkeeper: 0 });
  assert.deepEqual(newcomer.teams, [{ id: 900101, name: null, leagueIds: [4811], games: 0, inRoster: true, gender: 'unknown', genderSource: 'inferred' }]);
  // Stats still come from the actas only; the roster adds membership.
  assert.deepEqual(players['900004'].sources, ['actas']);
  assert.deepEqual(players['900003'].sources, ['actas', 'rosters']);
  assert.equal(players['900003'].stats.goals, 3);
  assert.equal((await sync.status()).players.rosters.nextDueAt, '2026-11-16T12:00:00.000Z');

  // Nothing due: 0 requests.
  let before = api.calls.length;
  clock.advance(HOUR);
  assert.equal((await sync.run()).requests, 0);
  assert.equal(api.calls.length, before);
  // Calendars are due after 24h, rosters only after 7 days (the default).
  clock.advance(DAY);
  await sync.run();
  assert.deepEqual(callNames(api.calls.slice(before)).filter((name) => !name.startsWith('report')).sort(), ['calendar:4806', 'calendar:4811']);
  before = api.calls.length;
  clock.set('2026-11-16T12:00:00.000Z');
  await sync.run();
  assert.deepEqual(callNames(api.calls.slice(before)).filter((name) => name.startsWith('stats')).sort(), ['stats:4806', 'stats:4811']);

  // A player dropped from the roster who never played is kept with removedAt.
  api.rosters[4811] = { stats: { rosters: [] } };
  clock.set('2026-11-23T12:00:00.000Z');
  const result = await sync.run();
  assert.equal(playersOf(dataDir)['900050'].removedAt, '2026-11-23T12:00:00.000Z');
  assert.ok(result.changes.players.removed.some((player) => player.id === 900050));
});

test('rosters respect a configured refresh.players and its 24h floor', async () => {
  const rosters = { 4811: jsonFixture('sidgad-api/2026-11-stats.json') };
  const { sync, api, clock } = setup({ config: { ...CONFIG, players: { rosters: true }, refresh: { players: '1h' } }, rosters });
  const result = await sync.init();
  assert.ok(result.notes.some((note) => /refresh\.players "1h" raised to the minimum "24h"/.test(note)));
  const stats = () => callNames(api.calls).filter((name) => name.startsWith('stats')).length;
  assert.equal(stats(), 2);
  clock.advance(23 * HOUR);
  await sync.run();
  assert.equal(stats(), 2);
  clock.advance(HOUR);
  await sync.run();
  assert.equal(stats(), 4);
});

test('a scope by team keeps only that team\'s players, from actas and rosters', async () => {
  const rosters = { 4811: jsonFixture('sidgad-api/2026-11-stats.json') };
  const { sync, dataDir } = setup({ config: { ...CONFIG, scope: { leagues: [4811], teams: [900101] }, players: { rosters: true } }, rosters });
  await sync.init();
  // 900001/900002 played for 900101; 900050 is in its roster. Opponents are left out.
  assert.deepEqual(Object.keys(playersOf(dataDir)), ['900001', '900002', '900050']);
});

test('without levels.players no players.json is written and status says so', async () => {
  const { sync, dataDir } = setup({ config: { ...CONFIG, levels: { actas: true } } });
  await sync.init();
  assert.throws(() => playersOf(dataDir), { code: 'ENOENT' });
  const status = await sync.status();
  assert.deepEqual([status.players.enabled, status.players.stored, status.players.names], [false, 0, 'full']);
});
