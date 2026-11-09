import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { anonymise, capture, DEFAULT_USER_AGENT, findLeaks, parseCaptured } from '../dist/index.js';
import { fakeFetch, fixture, html, json, jsonFixture } from './helpers.mjs';
import { tempDir } from './sync-helpers.mjs';

// Stand-ins for a live answer. Every name is a placeholder made up for this
// test, shaped like SIDGAD's ("SURNAME(S),GIVEN"); ids are below 900000 like
// real ones, so the test proves they are replaced.
const PERSON = ['ORIGCOGNOM PRIMER,ORIGNOM', 'ORIGCOGNOM SEGON,ALTRENOM', 'ORIGPORTER TERCER,TERCERNOM', 'ORIGVISITANT,QUARTNOM'];
const STAFF = 'ORIGENTRENADOR,STAFFNOM';
const REFEREE = 'ORIGARBITRE REFNOM';
const TEAM = { home: 'CP ORIGPOBLE B', away: 'CH ORIGCIUTAT' };
const VENUE = 'PAVELLO ORIGPOBLE';

const player = (id, name, extra = {}) => ({
  player_id: String(id), player_name: name, player_number: '7', player_role: null, player_flag: null, is_captain: false,
  goals: '1', asist: '0', penals: '0', direct: '0', yellow_card: 0, blue_card: '1', red_card: 0, ...extra,
});

const liveReport = () => ({
  game_data: {
    game_id: '345678', season_id: '41', tournament_name: `BENJAMÍ PLATA 1 · ${TEAM.home}`, game_info: '',
    ref_name1: REFEREE, ref_name2: '', venue_info: VENUE,
    home_team_id: '45601', away_team_id: '45602', home_team_name: TEAM.home, away_team_name: TEAM.away,
    home_logo: 'https://sidgad.example/logos/45601.png', away_logo: '',
    period_name: 'FINAL', period: '4', home_team_score: '3', away_team_score: '0',
    game_date: '26/09/2026', game_hour: '12:30', game_time: '00:00', game_completed: 'true', shootout: null,
    home_roster: [player(123456, PERSON[0], { goals: '3' }), player(123457, PERSON[1]), player(123458, PERSON[2], { player_role: 'P', goals: '' })],
    home_goalies: [],
    home_staff: [{ staff_id: '777001', staff_name: STAFF, staff_role: 'E1', staff_flag: null }],
    away_roster: [player(123459, PERSON[3])],
    away_goalies: [player(123459, PERSON[3])],
    away_staff: [],
    // Free text a future SIDGAD version might add: names and ids inside sentences.
    events: [{ minute: '12', text: `Gol de ${PERSON[0]} (123456) per ${TEAM.home}` }, { minute: '30', note: `Targeta blava 123457 a ${VENUE}` }],
    last_update: '2026-09-26 14:10:00',
  },
});

const liveStats = () => ({
  stats: {
    goals: [{ order: '1', team_id: '45601', team_name: TEAM.home, player_id: '123456', player_name: PERSON[0], goals: '3', played: '1' }],
    rosters: [
      { team_id: '45601', team_name: TEAM.home, team_logo: 'https://sidgad.example/logos/45601.png', player_id: '123456', player_name: PERSON[0], played: '1', goals: '3', blue_cards: '', red_cards: '' },
      { team_id: '45603', team_name: 'CP ORIGPOBLE A', player_id: '123456', player_name: PERSON[0], played: null, goals: '', blue_cards: '', red_cards: '' },
      { team_id: '45601', team_name: TEAM.home, player_id: '123460', player_name: 'ORIGNOVA,CINQUENOM', played: null, goals: '', blue_cards: '', red_cards: '' },
    ],
    staff: [{ team_id: '45601', team_name: TEAM.home, staff_id: '777001', staff_name: STAFF, staff_flag: '', role: null }],
  },
});

const liveClubs = () => ({
  clubes: [
    { id_club: '3001', modals: 'hp', nameclub: 'ORIGPOBLE, C.P.', logoclub: 'https://sidgad.example/logos_clubes/3001.png' },
    { id_club: '3002', modals: '3p', nameclub: 'ORIGATLETA INDIVIDUAL,SISENOM', logoclub: 'https://sidgad.example/logos_clubes/3002.png' },
  ],
});

const liveCalendar = () => ({
  games: [
    { idp: '0', dia_partido: 'FASE', hora_partido: '4951', home_name: 'BCN BENJAMÍ PLATA 1', away_name: '--', home_id: '--', away_id: '--', pista: '--' },
    { idp: '0', dia_partido: 'JORNADA', hora_partido: '_', home_name: 'JORNADA 1', away_name: '--', home_id: null, away_id: null, pista: null },
    { idp: '345678', dia_partido: '26/09/2026', hora_partido: '12:30', home_name: TEAM.home, away_name: TEAM.away, home_id: '45601', away_id: '45602',
      home_club_id: '3001', away_club_id: '3003', home_logo: 'https://sidgad.example/logos/45601.png', result: '3:0', pista: VENUE },
    { idp: '345679', dia_partido: '00/00/0000', hora_partido: '', home_name: TEAM.away, away_name: TEAM.home, home_id: '45602', away_id: '45601', result: '', pista: null },
  ],
});

const liveLeagues = () => ({
  idcs: [{
    idc: '4811', nombre_idc: 'BENJAMÍ PLATA BARCELONA', id_temp: '41', nombre_temp: '2026/2027', id_zone: '20', zone_name: 'BARCELONA',
    id_categoria: '1', nombre_categoria: 'BENJAMI', nombre_sexo: 'MIXTA', agrupada: false, ids_teams: '45601,45602',
    teams: [
      { name: TEAM.home, teamId: '45601', clubId: '3001', team_logo: 'https://sidgad.example/logos_clubes/3001.png', name_short: 'ORI' },
      { name: TEAM.away, teamId: '45602', clubId: '3003', team_logo: '', name_short: 'CIU' },
    ],
  }],
});

const SAMPLES = { report: liveReport, rosters: liveStats, clubs: liveClubs, calendar: liveCalendar, leagues: liveLeagues };
const PEOPLE = [...PERSON, STAFF, REFEREE, 'ORIGNOVA,CINQUENOM', 'ORIGATLETA INDIVIDUAL,SISENOM'];
const PERSON_IDS = ['123456', '123457', '123458', '123459', '123460', '777001'];
const TEAM_TEXT = [TEAM.home, TEAM.away, 'CP ORIGPOBLE A', 'ORIGPOBLE, C.P.', VENUE, 'ORIGPOBLE', 'ORIGCIUTAT'];
const TEAM_IDS = ['45601', '45602', '45603', '3001', '3002', '3003'];

// Every name fragment and id, searched in the serialised output: independent of findLeaks.
const fragments = (names) => names.flatMap((name) => name.split(/[ ,]+/)).filter((part) => part.startsWith('ORIG') || /NOM$/.test(part));
const survivors = (data, values) => values.filter((value) => JSON.stringify(data).includes(value));
const idSurvivors = (data, ids) => ids.filter((id) => new RegExp(`(?<!\\d)${id}(?!\\d)`).test(JSON.stringify(data)));

for (const [kind, sample] of Object.entries(SAMPLES)) {
  test(`anonymise ${kind}: no input name or person, team or club id survives, and the parser still parses it`, () => {
    const input = sample();
    const { data } = anonymise(input);
    assert.deepEqual(findLeaks(input, data), []);
    assert.deepEqual(survivors(data, fragments(PEOPLE)), []);
    assert.deepEqual(survivors(data, fragments(TEAM_TEXT)), []);
    assert.deepEqual(idSurvivors(data, [...PERSON_IDS, ...TEAM_IDS]), []);
    const parsed = parseCaptured(kind, data, 345678);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    // The input object is not modified.
    assert.deepEqual(input, sample());
  });
}

test('anonymise is deterministic and the mapping is stable within a file', () => {
  const first = anonymise(liveStats());
  assert.deepEqual(anonymise(liveStats()), first);
  const { goals, rosters, staff } = first.data.stats;
  // The same player in two teams and in a ranking keeps one invented id and name.
  assert.equal(goals[0].player_id, rosters[0].player_id);
  assert.equal(rosters[0].player_id, rosters[1].player_id);
  assert.equal(goals[0].player_name, rosters[1].player_name);
  assert.notEqual(rosters[2].player_id, rosters[0].player_id);
  assert.notEqual(rosters[2].player_name, rosters[0].player_name);
  // A club's teams share an invented base name and keep their letter.
  assert.match(rosters[0].team_name, / B$/);
  assert.match(rosters[1].team_name, / A$/);
  assert.equal(rosters[0].team_name.slice(0, -2), rosters[1].team_name.slice(0, -2));
  assert.equal(rosters[0].team_id, staff[0].team_id);
  for (const row of rosters) assert.ok(Number(row.player_id) >= 900000);
  assert.ok(Number(staff[0].staff_id) >= 900000);
  // The report: a goalie listed twice keeps one id; names keep SIDGAD's "SURNAME,GIVEN" shape.
  const report = anonymise(liveReport()).data.game_data;
  assert.equal(report.away_roster[0].player_id, report.away_goalies[0].player_id);
  for (const row of report.home_roster) assert.match(row.player_name, /^[^,]+,[^,]+$/);
  assert.match(report.events[0].text, new RegExp(`${report.home_roster[0].player_id}`));
});

test('anonymise never touches what the parsers need: dates, times, scores, statuses, roles, match ids, group names', () => {
  const report = anonymise(liveReport()).data.game_data;
  const original = liveReport().game_data;
  for (const key of ['game_id', 'game_date', 'game_hour', 'game_completed', 'home_team_score', 'away_team_score', 'period_name', 'last_update']) {
    assert.equal(report[key], original[key], key);
  }
  assert.deepEqual(report.home_roster.map((row) => [row.player_role, row.goals, row.blue_card, row.player_number]),
    original.home_roster.map((row) => [row.player_role, row.goals, row.blue_card, row.player_number]));
  assert.match(report.tournament_name, /^BENJAMÍ PLATA 1 · /);
  const calendar = anonymise(liveCalendar()).data.games;
  assert.deepEqual(calendar.slice(0, 2), liveCalendar().games.slice(0, 2));
  assert.deepEqual(calendar.slice(2).map((game) => [game.idp, game.dia_partido, game.hora_partido, game.result]),
    liveCalendar().games.slice(2).map((game) => [game.idp, game.dia_partido, game.hora_partido, game.result]));
  const leagues = anonymise(liveLeagues()).data.idcs[0];
  for (const key of ['idc', 'nombre_idc', 'id_temp', 'nombre_temp', 'zone_name', 'id_categoria', 'nombre_categoria', 'nombre_sexo']) {
    assert.equal(leagues[key], liveLeagues().idcs[0][key], key);
  }
  assert.deepEqual(leagues.ids_teams.split(','), leagues.teams.map((team) => team.teamId));
  // The individual athlete in the clubs list is a person, not a club: replaced even with keepTeams.
  const clubs = anonymise(liveClubs(), { keepTeams: true }).data.clubes;
  assert.equal(clubs[0].nameclub, 'ORIGPOBLE, C.P.');
  assert.doesNotMatch(clubs[1].nameclub, /ORIG|SISENOM/);
  assert.notEqual(clubs[1].id_club, '3002');
});

test('anonymise keepTeams keeps team and club names and ids but still replaces every person', () => {
  const input = liveReport();
  const { data } = anonymise(input, { keepTeams: true });
  assert.equal(data.game_data.home_team_name, TEAM.home);
  assert.equal(data.game_data.home_team_id, '45601');
  assert.equal(data.game_data.venue_info, VENUE);
  assert.deepEqual(findLeaks(input, data, { keepTeams: true }), []);
  assert.deepEqual(survivors(data, fragments(PEOPLE)), []);
  assert.deepEqual(idSurvivors(data, PERSON_IDS), []);
  // Without keepTeams the same output is a leak, reported by path and kind only.
  const leaks = findLeaks(input, data);
  assert.ok(leaks.some((leak) => leak.kind === 'team-name' && leak.path === 'game_data.home_team_name'));
  assert.ok(leaks.some((leak) => leak.kind === 'team-id' && leak.path === 'game_data.home_team_id'));
  assert.doesNotMatch(JSON.stringify(leaks), /ORIG/);
});

test('every stored fixture still parses the same after anonymisation', () => {
  const cases = [
    ['calendar', 'sidgad-api/2026-11-calendar.json'], ['report', 'sidgad-api/2026-11-report-finished.json'],
    ['report', 'sidgad-api/2026-11-report-pending.json'], ['leagues', 'sidgad-api/2026-11-leagues.json'],
    ['clubs', 'sidgad-api/2026-11-clubs.json'], ['rosters', 'sidgad-api/2026-11-stats.json'],
  ];
  for (const [kind, file] of cases) {
    const input = jsonFixture(file);
    const { data } = anonymise(input);
    assert.deepEqual(findLeaks(input, data), [], file);
    assert.deepEqual(parseCaptured(kind, data, 900501), parseCaptured(kind, input, 900501), file);
  }
});

// capture(): one live request through the polite client, with a fake fetch.

const PORTAL = 'https://www.hoqueipatins.fecapa.cat';
const PORTAL_API = 'https://api.sidgad.test/fecapa/v1/hp/';
const TOKEN_API = 'https://api.sidgad.com/fecapa/v1/hp/';

function workspace() {
  const cwd = tempDir();
  mkdirSync(path.join(cwd, 'fixtures'));
  return cwd;
}

test('capture without a token: reads the portal page for the public token, then one API request; writes an anonymised fixture', async () => {
  const cwd = workspace();
  const sleeps = [];
  const { fetch, calls } = fakeFetch([
    [(url) => url.startsWith(PORTAL), () => html(fixture('portal-config/2026-11-calendar-page.html'))],
    [`${PORTAL_API}report/`, () => json(liveReport())],
  ]);
  const result = await capture({ kind: 'report', id: 345678, out: 'fixtures/sidgad-api/2026-11-report-new.json', cwd, fetch, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(result.requests, 2);
  assert.equal(calls.length, 2);
  assert.equal(result.source, 'portal-config');
  assert.equal(new URL(calls[1].url).searchParams.get('id'), '345678');
  for (const call of calls) assert.equal(call.headers['user-agent'], DEFAULT_USER_AGENT);
  assert.equal(calls[1].headers.origin, PORTAL);
  // Two requests, 2 s apart.
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 1000 && sleeps[0] <= 2000);
  assert.deepEqual(result.parse, { ok: true, summary: 'final report, 3+1 players' });
  const written = readFileSync(result.file, 'utf8');
  assert.equal(result.file, path.join(cwd, 'fixtures/sidgad-api/2026-11-report-new.json'));
  assert.doesNotMatch(written, /ORIG|NOM"|123456|45601|public-token/);
  assert.deepEqual(JSON.parse(written), anonymise(liveReport()).data);
  assert.ok(result.counts.people >= 6 && result.counts.players === 5);
});

test('capture with a token makes exactly one request; a format change is still saved and reported', async () => {
  const cwd = workspace();
  const { fetch, calls } = fakeFetch([[`${TOKEN_API}calendar/`, () => json({ partidos: [] })]]);
  const result = await capture({ kind: 'calendar', id: 4811, token: 'secret', cwd, fetch, now: new Date('2026-12-03T10:00:00Z') });
  assert.equal(calls.length, 1);
  assert.equal(result.requests, 1);
  assert.equal(result.file, path.join(cwd, 'fixtures/sidgad-api/2026-12-calendar.json'));
  assert.deepEqual(result.parse, { ok: false, code: 'SOURCE_FORMAT_CHANGED', detail: 'games: Invalid input: expected array, received undefined' });
  assert.doesNotMatch(readFileSync(result.file, 'utf8'), /secret/);
});

test('capture refuses to write outside fixtures/ or over an existing file before making any request', async () => {
  const cwd = workspace();
  const { fetch, calls } = fakeFetch([[`${TOKEN_API}clubs/`, () => json(liveClubs())]]);
  for (const out of ['elsewhere.json', '../fixtures/x.json', 'fixtures', path.join(tempDir(), 'fixtures', 'x.json')]) {
    await assert.rejects(capture({ kind: 'clubs', token: 't', out, cwd, fetch }), { code: 'INVALID_ARGUMENT', argument: 'out' }, out);
  }
  await assert.rejects(capture({ kind: 'report', token: 't', cwd, fetch }), { code: 'INVALID_ARGUMENT', argument: 'id' });
  writeFileSync(path.join(cwd, 'fixtures', 'taken.json'), '{}');
  await assert.rejects(capture({ kind: 'clubs', token: 't', out: 'fixtures/taken.json', cwd, fetch }), /already exists/);
  assert.equal(calls.length, 0);
  // --force allows both.
  const result = await capture({ kind: 'clubs', token: 't', out: 'elsewhere.json', force: true, cwd, fetch });
  assert.ok(existsSync(result.file));
  assert.deepEqual(result.parse, { ok: true, summary: '1 clubs' });
  await capture({ kind: 'clubs', token: 't', out: 'fixtures/taken.json', force: true, cwd, fetch });
  assert.equal(calls.length, 2);
});

test('CLI capture: usage errors and the fixtures/ guard exit 2 without any request', async () => {
  const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
  const run = async (args, cwd) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, FECAPA_SIDGAD_TOKEN: '' } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const cwd = workspace();
  assert.equal((await run(['capture'], cwd)).code, 2);
  assert.equal((await run(['capture', 'players', '1'], cwd)).code, 2);
  assert.equal((await run(['capture', 'report'], cwd)).code, 2);
  assert.equal((await run(['capture', 'leagues', '12'], cwd)).code, 2);
  assert.equal((await run(['sync', '--keep-teams'], cwd)).code, 2);
  const outside = await run(['capture', 'report', '12', '--out', 'x.json'], cwd);
  assert.equal(outside.code, 2);
  assert.match(outside.stderr, /only writes inside .*fixtures/);
  assert.match((await run(['--help'], cwd)).stdout, /capture +<calendar\|report\|leagues\|clubs\|rosters>/);
});
