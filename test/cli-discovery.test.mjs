import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createSync } from '../dist/index.js';
import { jsonFixture } from './helpers.mjs';
import { calendarBody, fakeApi, tempDir } from './sync-helpers.mjs';

// No network: the store is filled in-process with a fake API, then the CLI reads it.
const NOW = '2026-11-09T12:00:00.000Z';
const LEAGUES = () => jsonFixture('sidgad-api/2026-11-leagues.json');
const CLUBS = () => jsonFixture('sidgad-api/2026-11-clubs.json');
const CALENDARS = () => ({
  4811: calendarBody([{ id: 900501, date: '2026-11-01', time: '12:30', home: 900101, away: 900102 }], { phaseId: 4951, phaseName: 'BCN BENJAMÍ PLATA 1' }),
  4812: calendarBody([{ id: 900601, date: '2026-11-07', time: '10:00', home: 900105, away: 900106 }], { phaseId: 4960, phaseName: 'BENJAMÍ OR 1' }),
});

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const cli = async (args, cwd) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, FECAPA_SIDGAD_TOKEN: '' } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
};

test('CLI discovery commands read the store, with --json, and never reach the network', async () => {
  const dir = tempDir();
  const config = { season: '2026/2027', dataDir: './store', scope: { clubs: ['CP Prova'], categories: ['Benjamí'] } };
  const file = path.join(dir, 'fecapa-sync.config.json');
  writeFileSync(file, JSON.stringify(config));
  const empty = await cli(['clubs', '--config', file]);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /No clubs stored for season 2026\/2027\. Run "fecapa-sync init"/);

  const api = fakeApi({ calendars: CALENDARS(), leagues: LEAGUES(), clubs: CLUBS() });
  await createSync({ configPath: file }, { fetch: api.fetch, sleep: async () => {}, env: { FECAPA_SIDGAD_TOKEN: 't' }, sources: ['sidgad-api'], now: () => new Date(NOW) }).init();

  const clubs = await cli(['clubs', '--config', file]);
  assert.equal(clubs.code, 0, clubs.stderr);
  assert.match(clubs.stdout, /^9001 {2}PROVA, C\.P\. {2}\(teams: CP PROVA\) {2}5 teams: Benjamí, Sènior, FEM11$/m);
  const teams = await cli(['teams', '--config', file, '--club', 'cp prova', '--category', 'benjamin', '--json']);
  assert.deepEqual(JSON.parse(teams.stdout).map((team) => team.id), [900105, 900101]);
  const leagues = await cli(['leagues', '--config', file, '--category', 'FEM11']);
  assert.match(leagues.stdout, /^4806 {2}FEM 11 OR {2}\[FEM11\] \[female\] {2}2 teams {2}\(FEDERACIÓ\)$/m);
  const categories = await cli(['categories', '--config', file]);
  assert.match(categories.stdout, /^unknown +Unknown {2}1 leagues {2}raw: YOUTH GOLDEN CAT$/m);
  const find = await cli(['find', 'prova', '--config', file, '--json']);
  assert.deepEqual(JSON.parse(find.stdout).clubs.map((club) => club.id).sort(), [9001, 9005]);
  const ambiguous = await cli(['teams', '--config', file, '--club', 'prova']);
  assert.equal(ambiguous.code, 2);
  assert.match(ambiguous.stderr, /ambiguous/);
  assert.equal((await cli(['find', '--config', file])).code, 2);
  assert.equal((await cli(['sync', '--live', '--config', file])).code, 2);
  const status = await cli(['status', '--config', file]);
  assert.match(status.stdout, /clubs: 6 stored \(0 removed\)/);
  assert.match(status.stdout, /league 4812: 1 games/);
});

test('CLI sync with the template placeholder exits 2 before any request', async () => {
  const dir = tempDir();
  assert.equal((await cli(['init'], dir)).code, 0);
  const result = await cli(['sync'], dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /replace the placeholder "<club name>"/);
  assert.equal(existsSync(path.join(dir, 'fecapa-data')), false);
});
