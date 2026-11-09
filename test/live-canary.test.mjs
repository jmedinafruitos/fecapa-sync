import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSources, ISSUE_TITLE, LABEL, main, MAX_REQUESTS, safeDetail } from '../scripts/live-canary.mjs';
import { fixture, html, json, jsonFixture } from './helpers.mjs';

// Offline: FECAPA and GitHub are both fakes behind one injected fetch.

const NOW = new Date('2026-11-09T12:00:00Z');
const ENV = { GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42', GITHUB_SERVER_URL: 'https://github.com' };
// Every person name in the fixtures the canary reads: none may reach a log or an issue.
const PEOPLE = ['PROVA TEST', 'JÚLIA', 'FICTICI SEGON', 'PROVA TERCER', 'ENTRENADORA PROVA', 'ARBITRE PROVA'];

function fakeGithub() {
  const issues = [];
  const comments = [];
  const labels = new Set();
  const calls = [];
  const handle = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, pathname, auth: init.headers?.authorization });
    let match;
    if (method === 'GET' && pathname === '/repos/owner/repo/issues') {
      const query = new URL(url).searchParams;
      return json(issues.filter((issue) => issue.state === query.get('state') && issue.labels.includes(query.get('labels'))));
    }
    if (method === 'POST' && pathname === '/repos/owner/repo/labels') {
      if (labels.has(body.name)) return json({ message: 'exists' }, 422);
      labels.add(body.name);
      return json(body, 201);
    }
    if (method === 'POST' && pathname === '/repos/owner/repo/issues') {
      const issue = { number: issues.length + 1, state: 'open', title: body.title, body: body.body, labels: body.labels };
      issues.push(issue);
      return json(issue, 201);
    }
    if ((match = /^\/repos\/owner\/repo\/issues\/(\d+)$/.exec(pathname)) && method === 'PATCH') {
      const issue = issues.find((item) => item.number === Number(match[1]));
      Object.assign(issue, body);
      return json(issue);
    }
    if ((match = /^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/.exec(pathname)) && method === 'POST') {
      comments.push({ issue: Number(match[1]), body: body.body });
      return json({ id: comments.length }, 201);
    }
    throw new Error(`Unexpected GitHub call in test: ${method} ${url}`);
  };
  return { issues, comments, labels, calls, handle };
}

function fakeFecapa({ calendar = () => json(jsonFixture('sidgad-api/2026-11-calendar.json')), leagues = () => json(jsonFixture('sidgad-api/2026-11-leagues.json')) } = {}) {
  const calls = [];
  const handle = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} });
    if (url.startsWith('https://www.hoqueipatins.fecapa.cat')) return html(fixture('portal-config/2026-11-calendar-page.html'));
    if (url.includes('/leagues/')) return leagues();
    if (url.includes('/clubs/')) return json(jsonFixture('sidgad-api/2026-11-clubs.json'));
    if (url.includes('/calendar/')) return calendar();
    if (url.includes('/report/')) return json(jsonFixture('sidgad-api/2026-11-report-finished.json'));
    throw new Error(`Unexpected FECAPA call in test: ${url}`);
  };
  return { calls, handle };
}

function harness(fecapaOptions) {
  const fecapa = fakeFecapa(fecapaOptions);
  const gh = fakeGithub();
  const logs = [];
  const sleeps = [];
  const fetch = (url, init) => (String(url).startsWith('https://api.github.com') ? gh.handle(String(url), init) : fecapa.handle(String(url), init));
  const run = (env = ENV) => main({ env, fetch, log: (line) => logs.push(line), sleep: async (ms) => { sleeps.push(ms); }, now: NOW });
  return { fecapa, gh, logs, sleeps, run };
}

const noPeople = (text) => {
  for (const name of PEOPLE) assert.ok(!text.includes(name), 'a person name reached a log or an issue');
};

test('a healthy run: leagues, clubs, a calendar and a report in at most 5 requests, 2 s apart, nothing personal logged, no issue', async () => {
  const h = harness();
  assert.equal(await h.run(), 0);
  assert.ok(h.fecapa.calls.length <= MAX_REQUESTS);
  assert.equal(h.fecapa.calls.length, 5);
  assert.ok(h.sleeps.length >= 1 && h.sleeps.every((ms) => ms > 1000 && ms <= 2000));
  for (const call of h.fecapa.calls) assert.match(call.headers['user-agent'], /^fecapa-sync\//);
  assert.match(h.logs[0], /ok, 5 live request/);
  assert.match(h.logs.join('\n'), /report: ok \(portal-config; final, 2\+1 players\)/);
  noPeople(h.logs.join('\n'));
  assert.deepEqual(h.gh.issues, []);
  assert.match(h.logs.at(-1), /issue: none/);
  assert.ok(h.gh.calls.every((call) => call.auth === 'Bearer test-token'));
});

test('a format change opens one source-drift issue, later failures update it, and a passing run comments and closes it', async () => {
  let broken = true;
  const h = harness({ calendar: () => json(broken ? { partidos: [] } : jsonFixture('sidgad-api/2026-11-calendar.json')) });
  assert.equal(await h.run(), 1);
  assert.equal(h.gh.issues.length, 1);
  const [issue] = h.gh.issues;
  assert.deepEqual([issue.title, issue.labels, issue.state], [ISSUE_TITLE, [LABEL], 'open']);
  assert.match(issue.body, /\| calendar \| \*\*failed\*\* \| portal-config \| SOURCE_FORMAT_CHANGED \| – \| games: Invalid input/);
  assert.match(issue.body, /actions\/runs\/42/);
  assert.ok(h.gh.labels.has(LABEL));
  // The failed step stops the run: no report request.
  assert.equal(h.fecapa.calls.filter((call) => call.url.includes('/report/')).length, 0);

  assert.equal(await h.run(), 1);
  assert.equal(h.gh.issues.length, 1, 'deduplicated by title');
  assert.equal(h.gh.comments.length, 1);
  assert.match(h.gh.comments[0].body, /Still failing on 2026-11-09: calendar SOURCE_FORMAT_CHANGED/);

  broken = false;
  assert.equal(await h.run(), 0);
  assert.equal(h.gh.issues[0].state, 'closed');
  assert.match(h.gh.comments.at(-1).body, /passed again/);
  // A later passing run has nothing to do.
  assert.equal(await h.run(), 0);
  assert.equal(h.gh.comments.length, 2);
  noPeople([...h.logs, ...h.gh.issues.map((i) => i.body), ...h.gh.comments.map((c) => c.body)].join('\n'));
});

test('a closed drift issue is not reused: a new failure opens a new one', async () => {
  let broken = true;
  const h = harness({ calendar: () => json(broken ? { partidos: [] } : jsonFixture('sidgad-api/2026-11-calendar.json')) });
  await h.run();
  broken = false;
  await h.run();
  broken = true;
  await h.run();
  assert.deepEqual(h.gh.issues.map((issue) => [issue.number, issue.state]), [[1, 'closed'], [2, 'open']]);
});

test('CANARY_SIMULATE_DRIFT exercises the issue flow with no live request', async () => {
  const h = harness();
  assert.equal(await h.run({ ...ENV, CANARY_SIMULATE_DRIFT: 'true' }), 1);
  assert.equal(h.fecapa.calls.length, 0);
  assert.match(h.gh.issues[0].body, /\*\*simulated\*\*/);
  assert.match(h.gh.issues[0].body, /\| leagues \| \*\*failed\*\* \| portal-config \| SOURCE_FORMAT_CHANGED \| – \| idcs: Invalid input/);
});

test('a refusal (HTTP 429) stops at once and reports the status; without a GitHub token the issue is not touched', async () => {
  const h = harness({ leagues: () => json({}, 429) });
  assert.equal(await h.run({}), 1);
  assert.equal(h.fecapa.calls.length, 2);
  assert.match(h.logs.join('\n'), /leagues: FAILED HTTP_ERROR source=portal-config status=429/);
  assert.match(h.logs.at(-1), /not synced/);
  assert.equal(h.gh.calls.length, 0);
});

test('a SIDGAD player error never carries a name; quoted values in details are blanked', async () => {
  const report = jsonFixture('sidgad-api/2026-11-report-finished.json');
  report.game_data.home_roster[0].player_name = 'PROVA TEST'; // no comma: not SURNAME,GIVEN
  const fecapa = fakeFecapa();
  const fetch = async (url, init) => (String(url).includes('/report/') ? json(report) : fecapa.handle(String(url), init));
  const result = await checkSources({ fetch, sleep: async () => {}, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps.at(-1), { step: 'report', ok: false, code: 'INCOMPLETE_PLAYER', source: 'portal-config', status: null, path: 'name is not SURNAME,GIVEN' });
  noPeople(JSON.stringify(result));
  assert.equal(safeDetail('games: unexpected dia_partido "JÚLIA PROVA"'), 'games: unexpected dia_partido "…"');
});
