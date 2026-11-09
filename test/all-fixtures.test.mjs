import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { parseCalendarHtml } from '../dist/parsers/legacy-html.js';
import { extractSidgadConfig } from '../dist/parsers/portal-config.js';
import { parseCalendarJson, parseClubsJson, parseLeaguesJson, parseReportOutcomeJson, toSideReport } from '../dist/parsers/sidgad-json.js';
import { parseRostersJson } from '../dist/parsers/sidgad-stats.js';
import { fixture, jsonFixture } from './helpers.mjs';

// Every stored fixture, old and new, goes through the parser for its kind, so
// a fix for a new format can't silently break an old one. A contributor only
// drops a file in: fixtures/<source>/<yyyy>[-<mm>]-<kind>[-<label>].json|html
// (e.g. sidgad-api/2027-02-report-shootout.json). fixtures/manifest.json
// lists the exceptions (a file whose kind isn't in its name, or one that must
// fail with a given code).

const ROOT = new URL('../fixtures/', import.meta.url);
const manifest = jsonFixture('manifest.json').files;
const SIDGAD_SOURCES = ['sidgad-api', 'portal-config'];

const PARSERS = {
  'sidgad-api': {
    calendar: (file, source) => {
      const matches = parseCalendarJson(jsonFixture(file), 1, source);
      assert.ok(matches.length > 0, 'a calendar fixture has at least one game');
    },
    report: (file, source) => {
      const outcome = parseReportOutcomeJson(jsonFixture(file), { matchId: 1, competitionId: 1 }, source);
      if (outcome.status === 'final') {
        for (const side of ['home', 'away']) if (outcome.report[side].length) toSideReport(outcome.report, side, source);
      }
    },
    leagues: (file, source) => assert.ok(parseLeaguesJson(jsonFixture(file), source).length > 0),
    clubs: (file, source) => assert.ok(parseClubsJson(jsonFixture(file), source, 'hp').length > 0),
    stats: (file, source) => parseRostersJson(jsonFixture(file), source),
    rosters: (file, source) => parseRostersJson(jsonFixture(file), source),
  },
  'portal-config': {
    calendar: (file) => assert.ok(extractSidgadConfig(fixture(file)), 'the page embeds SIDGAD_API_CONFIG'),
    page: (file) => assert.ok(extractSidgadConfig(fixture(file)), 'the page embeds SIDGAD_API_CONFIG'),
  },
  'legacy-html': {
    calendar: (file) => assert.ok(parseCalendarHtml(fixture(file), 1, 'https://portal.example').length > 0),
  },
};

const NAME = /^(\d{4})(?:-(\d{2}))?-([a-z]+)(?:-[a-z0-9-]+)?\.(json|html)$/;

function storedFixtures() {
  const files = [];
  for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of readdirSync(new URL(`${dir.name}/`, ROOT))) {
      if (!/\.(json|html)$/.test(name)) continue; // helpers such as report-fixture.mjs
      files.push(`${dir.name}/${name}`);
    }
  }
  return files.sort();
}

const fixtures = storedFixtures();

test('fixtures follow the naming convention or are listed in fixtures/manifest.json', () => {
  assert.ok(fixtures.length >= 10);
  for (const file of fixtures) {
    const [dir, name] = file.split('/');
    assert.ok(PARSERS[dir], `${file}: unknown source directory "${dir}" (expected ${Object.keys(PARSERS).join(', ')})`);
    const kind = manifest[file]?.kind ?? NAME.exec(name)?.[3];
    assert.ok(kind && PARSERS[dir][kind], `${file}: name it <yyyy>[-<mm>]-<kind>[-<label>] with a kind of ${Object.keys(PARSERS[dir]).join(', ')}, or list it in fixtures/manifest.json`);
  }
  for (const file of Object.keys(manifest)) assert.ok(fixtures.includes(file), `fixtures/manifest.json lists a missing file: ${file}`);
});

for (const file of fixtures) {
  const [dir, name] = file.split('/');
  const kind = manifest[file]?.kind ?? NAME.exec(name)?.[3];
  const parse = PARSERS[dir]?.[kind];
  if (!parse) continue; // reported by the naming test
  const expected = manifest[file]?.expect;
  const sources = dir === 'sidgad-api' ? SIDGAD_SOURCES : [dir];
  test(`fixture ${file} (${kind}) ${expected ? `fails with ${expected}` : 'parses'}`, () => {
    for (const source of sources) {
      if (expected) assert.throws(() => parse(file, source), { code: expected, source });
      else parse(file, source);
    }
  });
}

test('JSON fixtures hold only invented people: person ids >= 900000 and no real-looking token', () => {
  const ID_KEY = /^(player_?id|staff_?id|ref(eree)?_?id\d*)$/i;
  const check = (value, file, path) => {
    if (Array.isArray(value)) return value.forEach((item, index) => check(item, file, `${path}[${index}]`));
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (ID_KEY.test(key) && child !== null && child !== '' && /^\d+$/.test(String(child))) {
          assert.ok(Number(child) >= 900000, `${file} ${path}.${key}: person ids in fixtures must be >= 900000 (run them through "fecapa-sync capture")`);
        }
        check(child, file, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === 'string') assert.doesNotMatch(value, /eyJ[A-Za-z0-9_-]{10,}\./, `${file} ${path}: looks like a JWT`);
  };
  for (const file of fixtures) {
    if (file.endsWith('.json')) check(jsonFixture(file), file, '');
    else assert.doesNotMatch(fixture(file), /eyJ[A-Za-z0-9_-]{10,}\./, `${file}: looks like a JWT`);
  }
});
