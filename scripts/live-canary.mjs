#!/usr/bin/env node
// Weekly live canary: checks that the public FECAPA/SIDGAD answers still
// parse, with a tiny request budget, and keeps one "source-drift" issue in
// sync with the result. Run by .github/workflows/live-canary.yml; tested
// offline in test/live-canary.test.mjs with an injected fetch.
//
// Privacy: nothing personal is stored, printed or posted. Logs and issue
// bodies hold step names, counts, error codes, source names, HTTP statuses
// and field paths only; never names, never error messages (they can quote
// values).

import { pathToFileURL } from 'node:url';
import { createClient, currentSeason, isFecapaError } from '../dist/index.js';

export const ISSUE_TITLE = 'Live canary: FECAPA source drift';
export const LABEL = 'source-drift';
/** Live requests per run: portal page, leagues, clubs, one calendar, one report. */
export const MAX_REQUESTS = 5;
export const DELAY_MS = 2000;

/** Field paths and codes only: quoted values are blanked, long details cut. */
export function safeDetail(detail) {
  if (typeof detail !== 'string') return null;
  return detail.replace(/"[^"]*"/g, '"…"').replace(/[^\w .,:/\-[\]()…"]/g, '').slice(0, 160);
}

/** What may leave the runner about an error. */
export function safeError(error) {
  if (!isFecapaError(error)) {
    const code = typeof error?.code === 'string' && /^[A-Z_]{2,40}$/.test(error.code) ? error.code : 'UNEXPECTED';
    return { code, source: null, status: null, path: null };
  }
  const status = typeof error.status === 'number' || (typeof error.status === 'string' && /^[A-Z ]{2,40}$/.test(error.status)) ? error.status : null;
  return { code: error.code, source: error.source ?? null, status, path: safeDetail(error.detail) };
}

/** Offline stand-ins used by CANARY_SIMULATE_DRIFT: a portal page, then a leagues answer whose shape changed. No live request. */
function simulatedFetch() {
  return async (url) => {
    if (String(url).includes('/leagues/')) return new Response(JSON.stringify({ idcs: { changed: true } }), { status: 200 });
    const page = '<script>const SIDGAD_API_CONFIG = {"url":"https://api.sidgad.test","version":"v1","cliente":"fecapa","token":"public-token","idm":"hp"};</script>';
    return new Response(page, { status: 200 });
  };
}

/** A fetch that refuses to go over the budget. */
function budgeted(fetchImpl, max, counter) {
  return async (url, init) => {
    if (counter.requests >= max) throw new Error(`live-canary: request budget of ${max} spent`);
    counter.requests++;
    return fetchImpl(url, init);
  };
}

const today = (now) => now.toISOString().slice(0, 10);

/**
 * Checks leagues, clubs, one calendar and one report on live data, with the
 * public portal config only (no token). Stops at the first failure.
 */
export async function checkSources({ fetch: fetchImpl = globalThis.fetch, sleep, now = new Date(), simulateDrift = false, delayMs = DELAY_MS } = {}) {
  const counter = { requests: 0 };
  const client = createClient({
    fetch: budgeted(simulateDrift ? simulatedFetch() : fetchImpl, MAX_REQUESTS, counter),
    sources: ['portal-config'],
    delayMs: Math.max(DELAY_MS, delayMs),
    ...(sleep ? { sleep } : {}),
  });
  const steps = [];
  const step = async (name, run) => {
    try {
      const { source, summary } = await run();
      steps.push({ step: name, ok: true, source, summary });
      return true;
    } catch (error) {
      steps.push({ step: name, ok: false, ...safeError(error) });
      return false;
    }
  };

  const season = currentSeason(now);
  let league = null;
  let game = null;
  const ok = await step('leagues', async () => {
    const result = await client.getLeagues();
    const current = result.leagues.filter((item) => item.season === season && item.teams.length >= 2).sort((a, b) => a.id - b.id);
    if (!current.length) throw Object.assign(new Error('no league'), { code: 'NO_LEAGUE' });
    // The season's league with the most teams: public, and likely to have played games.
    league = current.reduce((best, item) => (item.teams.length > best.teams.length ? item : best));
    return { source: result.source, summary: `${result.leagues.length} leagues, ${current.length} in ${season}` };
  })
    && await step('clubs', async () => {
      const result = await client.getClubs();
      if (!result.clubs.length) throw Object.assign(new Error('no clubs'), { code: 'EMPTY' });
      return { source: result.source, summary: `${result.clubs.length} clubs` };
    })
    && await step('calendar', async () => {
      const result = await client.getCalendar(league.id);
      const played = result.matches.filter((match) => match.matchId !== undefined && match.startsAt !== null && Date.parse(match.startsAt) < now.getTime() - 86_400_000);
      game = played.sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))[0] ?? null;
      return { source: result.source, summary: `${result.matches.length} games, ${played.length} played` };
    })
    && await step('report', async () => {
      if (!game) return { source: null, summary: 'skipped: no played game yet' };
      const result = await client.getFullReport(game.matchId, { idc: league.id });
      const summary = result.status === 'final' ? `final, ${result.report.home.length}+${result.report.away.length} players` : result.status;
      return { source: result.source, summary };
    });
  return { ok, steps, requests: counter.requests, simulated: simulateDrift, date: today(now) };
}

const cell = (value) => (value === null || value === undefined || value === '' ? '–' : String(value).replace(/\|/g, '\\|'));

/** The issue body: a table of steps. Codes, sources, statuses and paths only. */
export function issueBody(result, runUrl) {
  const rows = result.steps.map((s) => `| ${s.step} | ${s.ok ? 'ok' : '**failed**'} | ${cell(s.source)} | ${cell(s.ok ? s.summary : s.code)} | ${cell(s.status)} | ${cell(s.path)} |`);
  return [
    `The weekly live canary failed on ${result.date}${result.simulated ? ' (**simulated** format change, no live request)' : ''}: FECAPA or SIDGAD may have changed a format.`,
    '',
    '| Step | Result | Source | Summary / code | HTTP status | Field path |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    `Requests: ${result.requests} of ${MAX_REQUESTS}.${runUrl ? ` Run: ${runUrl}` : ''}`,
    '',
    'Next: follow the "FECAPA changed" playbook in CONTRIBUTING.md (capture → failing test → fix → PR → changeset).',
    'The canary updates this issue while it keeps failing and closes it when a run passes again.',
    '',
    '_No personal data is collected: this issue only ever lists codes, sources, statuses and field paths._',
  ].join('\n');
}

/** Minimal GitHub REST client over an injected fetch. */
function github({ fetch: fetchImpl, token, repo, apiUrl = 'https://api.github.com' }) {
  return async (method, path, body) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repo}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fecapa-sync-live-canary',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, json: text ? JSON.parse(text) : null };
  };
}

/**
 * Keeps one open issue titled ISSUE_TITLE in sync with the result: a failure
 * opens it (or updates its body and comments when it is already open); a
 * success after a failure comments and closes it. Deduplicated by title
 * among open issues with the label.
 */
export async function syncIssue(result, { fetch: fetchImpl, token, repo, apiUrl, runUrl } = {}) {
  const api = github({ fetch: fetchImpl, token, repo, apiUrl });
  const list = await api('GET', `/issues?state=open&labels=${LABEL}&per_page=100`);
  if (!list.ok) throw new Error(`GitHub API: listing issues answered HTTP ${list.status}`);
  const open = list.json.find((issue) => !issue.pull_request && issue.title === ISSUE_TITLE) ?? null;
  const check = (response, what) => {
    if (!response.ok) throw new Error(`GitHub API: ${what} answered HTTP ${response.status}`);
    return response;
  };
  if (!result.ok) {
    const body = issueBody(result, runUrl);
    if (open) {
      check(await api('PATCH', `/issues/${open.number}`, { body }), 'updating the issue');
      const failed = result.steps.find((s) => !s.ok);
      check(await api('POST', `/issues/${open.number}/comments`, { body: `Still failing on ${result.date}: ${failed.step} ${failed.code}${failed.status ? ` (${failed.status})` : ''}.${runUrl ? ` Run: ${runUrl}` : ''}` }), 'commenting');
      return { action: 'updated', number: open.number };
    }
    const label = await api('POST', '/labels', { name: LABEL, color: 'd93f0b', description: 'FECAPA or SIDGAD changed a format (opened by the live canary)' });
    if (!label.ok && label.status !== 422) throw new Error(`GitHub API: creating the label answered HTTP ${label.status}`);
    const created = check(await api('POST', '/issues', { title: ISSUE_TITLE, body, labels: [LABEL] }), 'opening the issue');
    return { action: 'opened', number: created.json.number };
  }
  if (open) {
    check(await api('POST', `/issues/${open.number}/comments`, { body: `The live canary passed again on ${result.date}${runUrl ? ` (${runUrl})` : ''}. Closing.` }), 'commenting');
    check(await api('PATCH', `/issues/${open.number}`, { state: 'closed', state_reason: 'completed' }), 'closing the issue');
    return { action: 'closed', number: open.number };
  }
  return { action: 'none', number: null };
}

const formatStep = (s) => `  ${s.step}: ${s.ok ? `ok (${s.source ?? '-'}; ${s.summary})` : `FAILED ${s.code}${s.source ? ` source=${s.source}` : ''}${s.status ? ` status=${s.status}` : ''}${s.path ? ` path=${s.path}` : ''}`}`;

/** The whole run. Returns the process exit code: 0 ok, 1 drift (after the issue is synced). */
export async function main({ env = process.env, fetch: fetchImpl = globalThis.fetch, log = console.log, sleep, now = new Date() } = {}) {
  const simulateDrift = env.CANARY_SIMULATE_DRIFT === 'true';
  const result = await checkSources({ fetch: fetchImpl, sleep, now, simulateDrift });
  log(`live-canary ${result.date}: ${result.ok ? 'ok' : 'DRIFT'}, ${result.requests} live request(s)${simulateDrift ? ' (simulated drift)' : ''}`);
  for (const s of result.steps) log(formatStep(s));
  if (env.GITHUB_TOKEN && env.GITHUB_REPOSITORY) {
    const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
    const issue = await syncIssue(result, { fetch: fetchImpl, token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL, runUrl });
    log(`  issue: ${issue.action}${issue.number ? ` #${issue.number}` : ''}`);
  } else {
    log('  issue: not synced (no GITHUB_TOKEN/GITHUB_REPOSITORY)');
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.log(`live-canary: could not finish (${error?.name ?? 'error'}: ${String(error?.message ?? '').replace(/"[^"]*"/g, '"…"').slice(0, 200)})`);
    process.exitCode = 2;
  });
}
