import { createClient } from "../client.js";
import { currentSeason } from "../time.js";
import type { SourceName } from "../types.js";
import { MIN_SYNC_DELAY_MS } from "./config.js";
import { directoryView, type DirectoryView } from "./directory.js";
import { buildCategories, buildClubs, buildLeagues, buildTeams, mergeRecords, officialNames, type Directory } from "./discovery.js";
import type { SyncRuntime } from "./engine.js";

export type DiscoverOptions = {
  /** `"2026/2027"`. Defaults to the current season. */
  season?: string;
  /** SIDGAD token. Defaults to `FECAPA_SIDGAD_TOKEN`; without one the public portal config is used (one more request). */
  token?: string | null;
};

export type Discovery = DirectoryView & {
  /** Leagues, categories, teams and clubs of the season, as they would be stored. */
  directory: Directory;
  /** HTTP requests made: 2 with a token, 3 without (the portal page holds the public token). */
  requests: number;
  source: SourceName;
};

/**
 * Live discovery, for choosing a scope before the first `init`: fetches the
 * league list and the club list (2–3 requests) and returns them in memory.
 * Writes nothing. Prefer the local store (`sync.listClubs()`…) once synced.
 */
export async function discover(options: DiscoverOptions = {}, runtime: SyncRuntime = {}): Promise<Discovery> {
  const clock = runtime.now ?? (() => new Date());
  const season = options.season ?? currentSeason(clock());
  const env = runtime.env ?? process.env;
  const token = options.token === undefined ? env.FECAPA_SIDGAD_TOKEN || null : options.token;
  let requests = 0;
  const fetchImpl = runtime.fetch ?? globalThis.fetch.bind(globalThis);
  const client = createClient({
    fetch: (url, init) => {
      requests++;
      return fetchImpl(url, init);
    },
    delayMs: MIN_SYNC_DELAY_MS,
    ...(token ? { token } : {}),
    ...Object.fromEntries(Object.entries({
      baseUrl: runtime.baseUrl, apiUrl: runtime.apiUrl, userAgent: runtime.userAgent,
      sources: runtime.sources, timeoutMs: runtime.timeoutMs, sleep: runtime.sleep,
    }).filter(([, value]) => value !== undefined)),
  });
  const listed = await client.getLeagues();
  const clubs = await client.getClubs();
  const now = clock().toISOString();
  const directory: Directory = { leagues: {}, categories: {}, teams: {}, clubs: {} };
  directory.leagues = mergeRecords({}, buildLeagues(listed.leagues, season, {}), now);
  directory.categories = mergeRecords({}, buildCategories(directory.leagues), now);
  directory.teams = mergeRecords({}, buildTeams(listed.leagues, season, directory.leagues), now);
  directory.clubs = mergeRecords({}, buildClubs(directory.teams, officialNames(clubs.clubs), {}), now);
  const view = directoryView(directory, season, "SIDGAD lists nothing for this season yet.");
  return { ...view, directory, requests, source: listed.source };
}
