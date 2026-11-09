import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfigFile, REFRESH_FLOORS, resolveConfig } from '../dist/index.js';
import { tempDir } from './sync-helpers.mjs';

const HOUR = 3_600_000;
const base = { scope: { leagues: [4811] } };
const resolve = (config, options = {}) => resolveConfig(config, { baseDir: '/srv/app', env: {}, now: new Date('2026-11-09T12:00:00Z'), ...options });

test('defaults: current season, games only, 24h games refresh, 200 requests per run, 1 s between requests', () => {
  const config = resolve(base);
  assert.equal(config.season, '2026/2027');
  assert.equal(config.seasonDir, '2026-2027');
  assert.equal(config.dataDir, path.resolve('/srv/app', 'fecapa-data'));
  assert.deepEqual(config.levels, { leagues: false, categories: false, teams: false, clubs: false, games: true, actas: false });
  assert.deepEqual(config.refreshMs, {
    leagues: 7 * 24 * HOUR, categories: 30 * 24 * HOUR, teams: 7 * 24 * HOUR, clubs: 30 * 24 * HOUR, games: 24 * HOUR, actas: 12 * HOUR,
  });
  assert.equal(config.maxRequestsPerRun, 200);
  assert.equal(config.delayMs, 1000);
  assert.equal(config.token, null);
  assert.deepEqual(config.notes, []);
});

test('the season changes on 1 July', () => {
  assert.equal(resolve(base, { now: new Date('2027-06-30T12:00:00Z') }).season, '2026/2027');
  assert.equal(resolve(base, { now: new Date('2027-07-01T12:00:00Z') }).season, '2027/2028');
});

test('refresh values below the floor are raised to it, with a note', () => {
  const config = resolve({ ...base, levels: { actas: true }, refresh: { games: '5m', actas: '1h' }, limits: { delayMs: 0 } });
  assert.equal(config.refreshMs.games, REFRESH_FLOORS.games);
  assert.equal(config.refreshMs.games, 12 * HOUR);
  assert.equal(config.refreshMs.actas, 6 * HOUR);
  assert.equal(config.delayMs, 1000);
  assert.ok(config.notes.some((note) => note.includes('refresh.games "5m" raised to the minimum "12h"')));
  assert.ok(config.notes.some((note) => note.includes('limits.delayMs 0 raised')));
  assert.equal(resolve({ ...base, refresh: { games: '3d' } }).refreshMs.games, 72 * HOUR);
});

test('levels pull in their dependencies: actas turns games on', () => {
  const config = resolve({ ...base, levels: { actas: true } });
  assert.deepEqual(config.levels, { leagues: false, categories: false, teams: false, clubs: false, games: true, actas: true });
  assert.match(config.notes[0], /levels\.games turned on because levels\.actas needs it/);
  assert.throws(() => resolve({ ...base, levels: { actas: true, games: false } }), { code: 'INVALID_CONFIG', message: /levels\.actas needs levels\.games/ });
});

test('levels that are not available yet are refused with the milestone, not ignored', () => {
  for (const [level, version] of [['players', '0.4']]) {
    assert.throws(() => resolve({ ...base, levels: { games: true, [level]: true } }), (error) => {
      assert.equal(error.code, 'INVALID_CONFIG');
      assert.match(error.message, new RegExp(`"${level}" \\(${version.replace('.', '\\.')}\\)`));
      assert.match(error.message, /not available yet/);
      return true;
    });
  }
  // Explicitly off is fine.
  assert.doesNotThrow(() => resolve({ ...base, levels: { games: true, leagues: false, players: false } }));
});

test('category and club filters turn on the levels they are resolved against (0.3)', () => {
  const byCategory = resolve({ scope: { categories: ['Benjamí'] } });
  assert.deepEqual(byCategory.levels, { leagues: true, categories: true, teams: false, clubs: false, games: true, actas: false });
  assert.deepEqual(byCategory.scope, { leagues: [], teams: [], clubs: [], categories: ['Benjamí'] });
  assert.ok(byCategory.notes.some((note) => /levels\.categories turned on because scope\.categories needs it/.test(note)));
  const byClub = resolve({ scope: { clubs: ['CP Exemple', 9001] } });
  assert.deepEqual(byClub.levels, { leagues: true, categories: false, teams: true, clubs: true, games: true, actas: false });
  assert.deepEqual(resolve({ scope: { leagues: 'all' } }).scope.leagues, 'all');
  assert.equal(resolve({ scope: { leagues: 'all' } }).levels.leagues, true);
  // Explicit league ids still need no discovery level.
  assert.equal(resolve({ scope: { leagues: [4811], categories: [], clubs: [] } }).levels.leagues, false);
  assert.throws(() => resolve({ scope: { clubs: ['X'] }, levels: { games: true, clubs: false } }), { code: 'INVALID_CONFIG', message: /scope\.clubs needs levels\.clubs/ });
  assert.throws(() => resolve({ scope: {} }), { code: 'INVALID_CONFIG', detail: 'scope' });
  // Discovery levels alone need no scope.
  assert.doesNotThrow(() => resolve({ levels: { games: false, clubs: true } }));
});

test('invalid configs are INVALID_CONFIG with the field', () => {
  const cases = [
    [{}, 'scope'],
    [{ scope: { leagues: [] } }, 'scope.leagues'],
    [{ scope: { leagues: ['4811'] } }, 'scope.leagues.0'],
    [{ ...base, season: '2026-2027' }, 'season'],
    [{ ...base, season: '2026/2028' }, 'season'],
    [{ ...base, refresh: { games: 'daily' } }, 'refresh.games'],
    [{ ...base, limits: { maxRequestsPerRun: 2 } }, 'limits.maxRequestsPerRun'],
    [{ ...base, levels: {} }, 'levels'],
    [{ ...base, unknown: true }, '(root)'],
  ];
  for (const [config, detail] of cases) {
    assert.throws(() => resolve(config), (error) => error.code === 'INVALID_CONFIG' && error.detail === detail, JSON.stringify(config));
  }
});

test('the token comes from the config or from FECAPA_SIDGAD_TOKEN', () => {
  assert.equal(resolve({ ...base, token: 'from-config' }, { env: { FECAPA_SIDGAD_TOKEN: 'from-env' } }).token, 'from-config');
  assert.equal(resolve(base, { env: { FECAPA_SIDGAD_TOKEN: 'from-env' } }).token, 'from-env');
});

test('a config file: dataDir is relative to the file; unreadable or invalid JSON is INVALID_CONFIG', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'fecapa-sync.config.json');
  writeFileSync(file, JSON.stringify({ ...base, dataDir: './store' }));
  const config = await loadConfigFile(file, { env: {} });
  assert.equal(config.dataDir, path.join(dir, 'store'));
  writeFileSync(file, '{ "scope": ');
  await assert.rejects(loadConfigFile(file), { code: 'INVALID_CONFIG', message: /not valid JSON/ });
  await assert.rejects(loadConfigFile(path.join(dir, 'missing.json')), { code: 'INVALID_CONFIG', message: /Cannot read/ });
});
