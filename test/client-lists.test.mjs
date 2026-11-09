import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '../dist/index.js';
import { fakeFetch, fixture, html, json, jsonFixture } from './helpers.mjs';

const PORTAL = 'https://www.hoqueipatins.fecapa.cat';
const LEAGUES = () => jsonFixture('sidgad-api/2026-11-leagues.json');
const CLUBS = () => jsonFixture('sidgad-api/2026-11-clubs.json');

test('getLeagues reads every league of every season with SIDGAD category, sex label and teams (one request)', async () => {
  const { fetch, calls } = fakeFetch([['https://api.sidgad.com/fecapa/v1/hp/leagues/', () => json(LEAGUES())]]);
  const { source, leagues } = await createClient({ fetch, delayMs: 0, token: 't' }).getLeagues();
  assert.equal(source, 'sidgad-api');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sidgad.com/fecapa/v1/hp/leagues/?jwt=t');
  assert.equal(calls[0].headers.origin, PORTAL);
  assert.equal(leagues.length, 8);
  const alevi = leagues.find((league) => league.id === 4789);
  assert.equal(alevi.name, 'ALEVÍ OR');
  assert.deepEqual([alevi.season, alevi.seasonId, alevi.categoryId, alevi.categoryName, alevi.sexName], ['2026/2027', 41, 2, 'ALEVÍ', 'MIXTA']);
  const cup = leagues.find((league) => league.id === 5014);
  assert.deepEqual([cup.categoryId, cup.categoryName, cup.sexName], [null, null, null]);
  assert.deepEqual(leagues.find((league) => league.id === 4811).teams.at(-1), { id: 900104, name: 'PATIN INVENTAT', shortName: 'INV', clubId: 9004 });
});

test('getClubs keeps only clubs of the modality; individual athletes of other modalities are never returned', async () => {
  const { fetch } = fakeFetch([['/clubs/', () => json(CLUBS())]]);
  const { clubs } = await createClient({ fetch, delayMs: 0, token: 't' }).getClubs();
  assert.deepEqual(clubs.map((club) => club.id), [9001, 9002, 9003, 9004, 9005]);
  assert.equal(clubs.some((club) => club.name === 'PERSONA INVENTADA'), false);
});

test('without a token the list endpoints use the public config from the portal home page', async () => {
  const { fetch, calls } = fakeFetch([
    [(url) => url.startsWith(PORTAL), () => html(fixture('portal-config/2026-11-calendar-page.html'))],
    ['/leagues/', () => json(LEAGUES())],
    ['/clubs/', () => json(CLUBS())],
  ]);
  const client = createClient({ fetch, delayMs: 0 });
  assert.equal((await client.getLeagues()).source, 'portal-config');
  await client.getClubs();
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/', '/fecapa/v1/hp/leagues/', '/fecapa/v1/hp/clubs/']);
  await assert.rejects(createClient({ fetch, delayMs: 0, sources: ['legacy-html'] }).getLeagues(), { code: 'NO_SOURCE_AVAILABLE' });
  const { fetch: changed } = fakeFetch([['/leagues/', () => json({ idcs: [{ idc: 'x', nombre_idc: 'X' }] })]]);
  await assert.rejects(createClient({ fetch: changed, delayMs: 0, token: 't', sources: ['sidgad-api'] }).getLeagues(), { code: 'SOURCE_FORMAT_CHANGED' });
});

