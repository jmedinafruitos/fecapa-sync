import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { CSV_COLUMNS, csvField, foldLine, gameRevision, gamesToIcs, mergeCalendar, toCsv } from '../dist/index.js';
import { jsonFixture } from './helpers.mjs';
import { validateIcs } from './ics-validator.mjs';
import { calendarBody, DAY, fakeApi, fakeClock, reportBody, TEAMS, tempDir, testSync } from './sync-helpers.mjs';

// Every name and id is invented. One team gets a long name with commas,
// quotes and a semicolon to exercise folding, escaping and CSV quoting.
TEAMS[900120] = 'CLUB "PROVA", SECCIÓ D\'HOQUEI; NOM MOLT LLARG AMB ACCENTS ÀÉÍÒÚ PER PLEGAR LA LÍNIA';

const NOW = '2026-11-09T12:00:00.000Z';
const GAMES_4811 = [
  { id: 900501, date: '2026-11-01', time: '12:30', home: 900101, away: 900102 },
  { id: 900502, date: '2026-11-14', home: 900101, away: 900103 }, // no time yet: left out of ICS
  { id: 900503, date: null, home: 900104, away: 900101 }, // no date: skipped in ICS
  { id: 900504, date: '2026-11-21', time: '10:00', home: 900103, away: 900101 },
  { id: 900505, date: '2026-11-28', time: '18:00', home: 900101, away: 900120, venue: 'PISTA, "NOVA"' },
];
const GAMES_4812 = [{ id: 900601, date: '2026-11-07', time: '10:00', home: 900105, away: 900106 }];

function setup() {
  const clock = fakeClock(NOW);
  const api = fakeApi({
    calendars: {
      4811: calendarBody(GAMES_4811, { phaseId: 4951, phaseName: 'BCN BENJAMÍ PLATA 1' }),
      4812: calendarBody(GAMES_4812, { phaseId: 4960, phaseName: 'BENJAMÍ OR 1' }),
    },
    reports: { 900501: reportBody(900501), 900601: reportBody(900601, { home: 900105, away: 900106 }) },
    leagues: jsonFixture('sidgad-api/2026-11-leagues.json'),
    clubs: jsonFixture('sidgad-api/2026-11-clubs.json'),
  });
  const config = { season: '2026/2027', scope: { clubs: ['CP Prova'], categories: ['Benjamí'] }, levels: { players: true, categories: true } };
  const { sync, dataDir } = testSync(config, { api, clock });
  return { sync, api, clock, dataDir, config };
}

const events = (calendar) => Object.fromEntries(calendar.events.map((event) => [event.props.UID.value, event.props]));
const uid = (id, league = 4811) => `fecapa-${league}-${id}@fecapa-sync`;

test('ICS: valid RFC 5545 with stable UIDs and UTC times; games without a date or a time are skipped and counted', async () => {
  const { sync } = setup();
  await sync.init();
  const result = await sync.export({ level: 'games', format: 'ics' });
  const calendar = validateIcs(result.content);
  assert.equal(result.records, 4);
  assert.deepEqual([result.skipped, result.skippedNoDate, result.skippedNoTime], [2, 1, 1]);
  assert.ok(result.notes.includes('1 game(s) without a date skipped'));
  assert.ok(result.notes.includes('1 game(s) without a time skipped'));
  // No all-day events at all.
  assert.doesNotMatch(result.content, /VALUE=DATE/);
  const byUid = events(calendar);
  assert.deepEqual(Object.keys(byUid).sort(), [uid(900501), uid(900504), uid(900505), uid(900601, 4812)]);

  const played = byUid[uid(900501)];
  assert.equal(played.DTSTART.value, '20261101T113000Z');
  assert.equal(played.DTEND.value, '20261101T130000Z');
  assert.equal(played.SUMMARY.value, 'CP PROVA B - CH FICTICI');
  // The calendar has no venue; the acta's is used. Score from the acta.
  assert.equal(played.LOCATION.value, 'PAVELLO PROVA');
  assert.match(played.DESCRIPTION.value, /BENJAMÍ PLATA BARCELONA · BCN BENJAMÍ PLATA 1\nJornada 1\nResultat: 3 - 2/);
  assert.deepEqual([played.SEQUENCE.value, played.STATUS.value], ['0', 'CONFIRMED']);

  // JSON and CSV still include the game without a time, with an empty time.
  const json = JSON.parse((await sync.export({ level: 'games' })).content);
  assert.deepEqual(json.filter((game) => game.matchId === 900502).map((game) => [game.date, game.time]), [['2026-11-14', null]]);
  assert.match((await sync.export({ level: 'games', format: 'csv' })).content, /\r\n900502,900502,4811,[^\r]*,2026-11-14,,2026-11-13T23:00:00\.000Z,/);

  // Escaping and folding of long values round-trip exactly.
  const long = byUid[uid(900505)];
  assert.equal(long.SUMMARY.value, `CP PROVA B - ${TEAMS[900120]}`);
  assert.equal(long.LOCATION.value, 'PISTA, "NOVA"');
  assert.match(result.content, /SUMMARY:CP PROVA B - CLUB "PROVA"\\, SECCIÓ D'HOQUEI\\; NOM/);
  assert.match(result.content, /\r\n [^\r\n]/); // folded somewhere

  // The same store exported again gives the same bytes; a later run keeps the UIDs.
  assert.equal((await sync.export({ level: 'games', format: 'ics' })).content, result.content);
});

test('ICS: a game without a time appears with its normal UID once a later sync brings the time', async () => {
  const { sync, api, clock } = setup();
  await sync.init();
  assert.equal(events(validateIcs((await sync.export({ level: 'games', format: 'ics' })).content))[uid(900502)], undefined);
  clock.advance(DAY);
  api.calendars[4811] = calendarBody(GAMES_4811.map((game) => (game.id === 900502 ? { ...game, time: '11:00' } : game)),
    { phaseId: 4951, phaseName: 'BCN BENJAMÍ PLATA 1' });
  await sync.run();
  const result = await sync.export({ level: 'games', format: 'ics' });
  const event = events(validateIcs(result.content))[uid(900502)];
  assert.equal(event.DTSTART.value, '20261114T100000Z');
  // A first publication of the time is not a reschedule.
  assert.equal(event.SEQUENCE.value, '1');
  assert.deepEqual([result.skippedNoDate, result.skippedNoTime], [1, 0]);
});

test('ICS: SEQUENCE grows with each reschedule and removed games are exported as CANCELLED', async () => {
  const { sync, api, clock } = setup();
  await sync.init();
  const moved = (changes) => calendarBody(GAMES_4811.map((game) => ({ ...game, ...(changes[game.id] ?? {}) })).filter((game) => !changes[game.id]?.gone),
    { phaseId: 4951, phaseName: 'BCN BENJAMÍ PLATA 1' });
  clock.advance(DAY);
  api.calendars[4811] = moved({ 900504: { date: '2026-11-22', time: '18:00' }, 900505: { gone: true } });
  await sync.run();
  let byUid = events(validateIcs((await sync.export({ level: 'games', format: 'ics' })).content));
  assert.deepEqual([byUid[uid(900504)].SEQUENCE.value, byUid[uid(900504)].DTSTART.value], ['1', '20261122T170000Z']);
  assert.deepEqual([byUid[uid(900505)].STATUS.value, byUid[uid(900505)].SEQUENCE.value], ['CANCELLED', '1']);
  assert.equal(byUid[uid(900505)].DTSTART.value, '20261128T170000Z');

  clock.advance(DAY);
  api.calendars[4811] = moved({ 900504: { date: '2026-11-22', time: '19:00' }, 900505: { gone: true } });
  await sync.run();
  byUid = events(validateIcs((await sync.export({ level: 'games', format: 'ics' })).content));
  assert.equal(byUid[uid(900504)].SEQUENCE.value, '2');
  assert.equal(byUid[uid(900504)].DTSTAMP.value, '20261111T120000Z');
  assert.equal(byUid[uid(900501)].SEQUENCE.value, '0');
});

test('ICS: SEQUENCE never goes down when a removed game reappears', async () => {
  const { sync, api, clock } = setup();
  await sync.init();
  const sequence = async () => events(validateIcs((await sync.export({ level: 'games', format: 'ics' })).content))[uid(900505)].SEQUENCE.value;
  const calendar = (games) => calendarBody(games, { phaseId: 4951, phaseName: 'BCN BENJAMÍ PLATA 1' });
  assert.equal(await sequence(), '0');
  clock.advance(DAY);
  api.calendars[4811] = calendar(GAMES_4811.filter((game) => game.id !== 900505));
  await sync.run();
  assert.equal(await sequence(), '1'); // removed: CANCELLED
  clock.advance(DAY);
  api.calendars[4811] = calendar(GAMES_4811);
  await sync.run();
  assert.equal(await sequence(), '2'); // back, same schedule: it used to drop to 0
  clock.advance(DAY);
  api.calendars[4811] = calendar(GAMES_4811.map((game) => (game.id === 900505 ? { ...game, time: '19:00' } : game)));
  await sync.run();
  assert.equal(await sequence(), '3');
});

test('ICS: a store written before 1.0 (no revision counter) loads and continues from the old SEQUENCE', () => {
  const at = (day) => `2026-11-${day}T12:00:00.000Z`;
  const match = { matchId: 900701, competitionId: 4811, phaseId: null, phaseName: null, round: 1, homeId: 900101, awayId: 900102,
    homeName: 'CP PROVA B', awayName: 'CH FICTICI', date: '2026-11-28', time: '18:00', startsAt: '2026-11-28T17:00:00.000Z', venue: null };
  const legacy = { ...mergeCalendar({}, [match], at(10)).games['900701'] };
  delete legacy.revision;
  const removedLegacy = { ...legacy, history: [{ date: '2026-11-27', time: '18:00', startsAt: '2026-11-27T17:00:00.000Z', venue: null, homeId: 900101, awayId: 900102, observedAt: at(11) }], removedAt: at(12) };
  // Old rule: history length + 1 once removed.
  assert.equal(gameRevision(removedLegacy), 2);
  assert.match(gamesToIcs([removedLegacy]).content, /\r\nSEQUENCE:2\r\n/);
  const back = mergeCalendar({ 900701: removedLegacy }, [match], at(13)).games['900701'];
  assert.deepEqual([back.removedAt, back.revision], [null, 3]);
  assert.match(gamesToIcs([back]).content, /\r\nSEQUENCE:3\r\n/);
  // A rename shown in SUMMARY is a new revision too; an unchanged calendar is not.
  const renamed = mergeCalendar({ 900701: back }, [{ ...match, homeName: 'CP PROVA C' }], at(14)).games['900701'];
  assert.equal(renamed.revision, 4);
  assert.equal(mergeCalendar({ 900701: renamed }, [{ ...match, homeName: 'CP PROVA C' }], at(15)).games['900701'].revision, 4);
});

test('ICS writer: folding counts octets, never splits a character, and the validator catches bad output', () => {
  const line = `SUMMARY:${'À'.repeat(100)}`;
  const folded = foldLine(line);
  for (const part of folded.slice(0, -2).split('\r\n')) assert.ok(Buffer.byteLength(part) <= 75);
  assert.equal(folded.replace(/\r\n /g, '').replace(/\r\n$/, ''), line);
  assert.throws(() => validateIcs('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n'), /CRLF/);
  assert.throws(() => validateIcs(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nX-WR-CALNAME:${'x'.repeat(80)}\r\nEND:VCALENDAR\r\n`), /75 octets/);
  assert.throws(() => validateIcs('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20261101T000000Z\r\nSUMMARY:a, b\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'), /unescaped/);
  const game = { key: '1', competitionId: 1, date: null, startsAt: null };
  assert.deepEqual(gamesToIcs([game]).skipped, 1);
  const noTime = gamesToIcs([{ ...game, date: '2026-11-14', time: null, startsAt: '2026-11-13T23:00:00.000Z' }]);
  assert.deepEqual([noTime.events, noTime.noDate, noTime.noTime], [0, 0, 1]);
});

test('export filters take names (team, club, category, league) like the 0.3 discovery, or ids', async () => {
  const { sync } = setup();
  await sync.init();
  const ids = async (options) => JSON.parse((await sync.export({ level: 'games', ...options })).content).map((game) => game.matchId);
  assert.deepEqual(await ids({}), [900501, 900601, 900502, 900504, 900505, 900503]);
  assert.deepEqual(await ids({ team: 'cp prova a' }), [900601]);
  assert.deepEqual(await ids({ team: 900105 }), [900601]);
  assert.deepEqual(await ids({ league: 'Benjamí Or Barcelona' }), [900601]);
  assert.deepEqual(await ids({ league: '4811' }), [900501, 900502, 900504, 900505, 900503]);
  assert.deepEqual(await ids({ club: 'cp prova' }), [900501, 900601, 900502, 900504, 900505, 900503]);
  assert.deepEqual(await ids({ club: 'ch fictici', category: 'benjamin' }), [900501, 900601]);
  assert.deepEqual(await ids({ category: 'FEM11' }), []);
  await assert.rejects(ids({ category: 'Hoquei gel' }), { code: 'INVALID_ARGUMENT' });
  // A name matching several teams is refused with the candidates, never guessed.
  await assert.rejects(sync.export({ level: 'games', team: 'CP Prova' }), (error) => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, /ambiguous/);
    return true;
  });
  const result = await sync.export({ level: 'games', format: 'ics', club: 'cp prova', category: 'Benjamí' });
  assert.match(result.content, /X-WR-CALNAME:PROVA\\, C\.P\. · Benjamí/);
  assert.deepEqual(result.notes.slice(0, 2), ['club → PROVA, C.P. (9001)', 'category → Benjamí']);
  // Other levels filter too.
  const players = JSON.parse((await sync.export({ level: 'players', team: 'CP Prova A' })).content);
  assert.ok(players.length > 0);
  assert.ok(players.every((player) => player.teamIds.includes(900105)));
  assert.deepEqual(JSON.parse((await sync.export({ level: 'teams', club: 9002 })).content).map((team) => team.id), [900102, 900106, 900113, 900115]);
  await assert.rejects(sync.export({ level: 'players', format: 'ics' }), { code: 'INVALID_ARGUMENT' });
});

test('exports read the local store only: no request, even with every level due', async () => {
  const { sync, api, clock } = setup();
  await sync.init();
  const before = api.calls.length;
  clock.advance(60 * DAY);
  for (const level of ['games', 'actas', 'players', 'teams', 'clubs', 'leagues']) {
    for (const format of level === 'games' ? ['json', 'csv', 'ics'] : ['json', 'csv']) await sync.export({ level, format });
  }
  assert.equal(api.calls.length, before);
});

/** A strict RFC 4180 reader: CRLF records, quoted fields with doubled quotes. */
function parseCsv(text) {
  assert.ok(text.endsWith('\r\n'));
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (char === '"') { quoted = false; i++; assert.ok([',', '\r'].includes(text[i]), 'quote must close a field'); continue; }
      field += char; i++; continue;
    }
    if (char === '"') { assert.equal(field, '', 'quote inside an unquoted field'); quoted = true; i++; continue; }
    if (char === ',') { row.push(field); field = ''; i++; continue; }
    if (char === '\r') { assert.equal(text[i + 1], '\n'); row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    assert.notEqual(char, '\n', 'bare LF');
    field += char; i++;
  }
  return rows;
}

test('CSV: RFC 4180 quoting, a header row with the documented columns, CRLF, UTF-8', async () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(false), 'false');
  assert.equal(toCsv(['a', 'b'], [['x', 'y,z']]), 'a,b\r\nx,"y,z"\r\n');

  const { sync } = setup();
  await sync.init();
  const games = parseCsv((await sync.export({ level: 'games', format: 'csv' })).content);
  assert.deepEqual(games[0], [...CSV_COLUMNS.games]);
  const long = games.find((row) => row[1] === '900505');
  assert.equal(long[games[0].indexOf('awayName')], TEAMS[900120]);
  assert.equal(long[games[0].indexOf('venue')], 'PISTA, "NOVA"');
  const played = games.find((row) => row[1] === '900501');
  assert.deepEqual([played[games[0].indexOf('homeScore')], played[games[0].indexOf('awayScore')], played[games[0].indexOf('league')]], ['3', '2', 'BENJAMÍ PLATA BARCELONA']);

  const clubs = parseCsv((await sync.export({ level: 'clubs', format: 'csv' })).content);
  assert.deepEqual(clubs[0], [...CSV_COLUMNS.clubs]);
  assert.equal(clubs.find((row) => row[0] === '9001')[1], 'PROVA, C.P.');

  const lineups = parseCsv((await sync.export({ level: 'actas', format: 'csv' })).content);
  assert.deepEqual(lineups[0], [...CSV_COLUMNS.actas]);
  assert.equal(lineups.length, 1 + 8); // two actas, four players each

  const players = parseCsv((await sync.export({ level: 'players', format: 'csv' })).content);
  assert.deepEqual(players[0], [...CSV_COLUMNS.players]);
  assert.ok(players.slice(1).every((row) => row.length === CSV_COLUMNS.players.length));
});

test('CLI export writes the file atomically, prints a summary and never needs the network', async () => {
  const { sync, dataDir } = setup();
  await sync.init();
  const dir = path.dirname(dataDir);
  const config = path.join(dir, `${path.basename(dataDir)}.config.json`);
  writeFileSync(config, JSON.stringify({ season: '2026/2027', dataDir: path.basename(dataDir), scope: { clubs: ['CP Prova'] }, levels: { players: true } }));
  const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
  const run = async (args) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args, '--config', config], { env: { ...process.env, FECAPA_SIDGAD_TOKEN: '' } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const out = path.join(tempDir(), 'team.ics');
  const ics = await run(['export', '--level', 'games', '--format', 'ics', '--team', 'CP Prova B', '--out', out]);
  assert.equal(ics.code, 0, ics.stderr);
  assert.match(ics.stdout, /3 games → .*team\.ics \(skipped: 1 without a date, 1 without a time\)/);
  assert.match(ics.stdout, /team → CP PROVA B \(900101\)/);
  assert.equal(validateIcs(readFileSync(out, 'utf8')).events.length, 3);

  const csv = await run(['export', '--level', 'players', '--format', 'csv', '--league', '4812']);
  assert.equal(csv.code, 0, csv.stderr);
  assert.equal(parseCsv(csv.stdout)[0].join(','), CSV_COLUMNS.players.join(','));
  assert.match(csv.stderr, /fecapa-sync export: \d+ players/);

  assert.equal((await run(['export', '--level', 'players', '--format', 'ics'])).code, 2);
  assert.equal((await run(['export', '--format', 'csv'])).code, 2);
  const ambiguous = await run(['export', '--level', 'games', '--team', 'CP Prova']);
  assert.equal(ambiguous.code, 2);
  assert.match(ambiguous.stderr, /ambiguous/);
});
