import { access } from "node:fs/promises";
import path from "node:path";
import { createClient, type ClientOptions } from "../client.js";
import { FecapaError, isFecapaError } from "../errors.js";
import type { FetchLike } from "../http.js";
import { actaDue, recordActaAttempt, type ActaRecord, type PendingActa } from "./actas.js";
import { AVAILABLE_LEVELS, checkPlaceholders, loadConfigFile, resolveConfig, type AvailableLevel, type ResolvedConfig, type SyncConfig } from "./config.js";
import { directoryView, type DirectoryView, type LeagueFilter, type TeamFilter } from "./directory.js";
import {
  buildCategories, buildClubs, buildLeagues, buildTeams, diffRecords, DIRECTORY_LEVELS, groupsFromMatches, isSeason, mergeRecords, officialNames,
  type CategoryRecord, type ClubRecord, type Directory, type DirectoryLevel, type LeagueRecord, type TeamRecord,
} from "./discovery.js";
import { formatDuration } from "./duration.js";
import { acquireLock, listFiles, readJson, writeJsonAtomic } from "./fs.js";
import { inTeamScope, mergeCalendar, type GameRecord, type GamesFile } from "./games.js";
import { resolveScope, type ResolvedScope } from "./resolve.js";
import { backoffDelay, emptySeason, parseState, type Backoff, type LeagueState, type RunError, type RunSummary, type SyncState } from "./state.js";

/** Created, updated and removed records of one level in one run. */
export type LevelChanges<T> = { created: T[]; updated: T[]; removed: T[] };

/** What a run changed in the local store. Apply it instead of re-reading everything. */
export type Changeset = {
  leagues: LevelChanges<LeagueRecord>;
  categories: LevelChanges<CategoryRecord>;
  teams: LevelChanges<TeamRecord>;
  clubs: LevelChanges<ClubRecord>;
  games: LevelChanges<GameRecord>;
  actas: LevelChanges<ActaRecord>;
};

export type SyncResult = {
  /**
   * - `ok`: everything that was due is done (possibly nothing, with 0 requests).
   * - `partial`: the request budget ran out; the rest continues next run.
   * - `skipped`: no request was made because of a backoff or another running sync.
   * - `failed`: the run stopped on an error. No data file was changed and a backoff was recorded.
   */
  status: "ok" | "partial" | "skipped" | "failed";
  reason: "budget" | "backoff" | "locked" | null;
  startedAt: string;
  finishedAt: string;
  /** HTTP requests made by this run. */
  requests: number;
  changes: Changeset;
  /** When the next run may make requests again, if a backoff is active. */
  backoffUntil: string | null;
  error: RunError | null;
  /** Non-fatal problems, e.g. an acta that failed validation and will be retried. */
  warnings: string[];
  /** Config adjustments (values raised to a floor, levels turned on as dependencies). */
  notes: string[];
};

export type LeagueStatus = {
  id: number;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  games: number;
  removed: number;
  rescheduled: number;
};

/** Last and next sync of a discovery level, and how many records are stored. */
export type LevelStatus = {
  enabled: boolean;
  stored: number;
  removed: number;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  due: boolean;
};

export type SyncStatus = {
  season: string;
  dataDir: string;
  levels: Record<AvailableLevel, boolean>;
  refresh: Record<AvailableLevel, string>;
  maxRequestsPerRun: number;
  locked: boolean;
  backoff: Backoff | null;
  lastRun: RunSummary | null;
  discovery: Record<DirectoryLevel, LevelStatus>;
  /** The scope resolved against the stored levels, or why it can't be yet. */
  scope: { leagues: number[]; teams: number[]; error: string | null };
  games: { leagues: LeagueStatus[]; due: number };
  actas: { stored: number; pending: number; gaveUp: number; due: number; nextAttemptAt: string | null };
  notes: string[];
};

export type Sync = {
  /** One-time full sync of the configured scope: every league is refetched now, whatever its refresh interval. */
  init(): Promise<SyncResult>;
  /** Scheduled incremental sync. Only fetches what is due; with nothing due it makes no request. */
  run(): Promise<SyncResult>;
  /** Last and next sync per level, backoff and store counts. Reads local files only. */
  status(): Promise<SyncStatus>;
  /** Leagues of the season from the local store, by category then name. `STORE_EMPTY` before the first `init`. */
  listLeagues(filter?: LeagueFilter): Promise<LeagueRecord[]>;
  /** Categories of the season from the local store. */
  listCategories(): Promise<CategoryRecord[]>;
  /** Teams from the local store, optionally of one league, club (name or id) and/or category. */
  listTeams(filter?: TeamFilter): Promise<TeamRecord[]>;
  /** Clubs from the local store, by name. */
  listClubs(): Promise<ClubRecord[]>;
  /** Clubs matching a name or id, best first (local store). */
  findClub(query: string | number): Promise<ClubRecord[]>;
  /** Teams matching a name or id, best first (local store). */
  findTeam(query: string | number): Promise<TeamRecord[]>;
};

export type CreateSyncOptions = { configPath: string } | SyncConfig;

/** Injection points, mostly for tests. */
export type SyncRuntime = Pick<ClientOptions, "baseUrl" | "apiUrl" | "userAgent" | "sources" | "timeoutMs" | "sleep"> & {
  fetch?: FetchLike;
  /** Clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Base directory for a relative `dataDir` of an in-code config. Default: the working directory. */
  baseDir?: string;
  /** Environment used for `FECAPA_SIDGAD_TOKEN`. Default: `process.env`. */
  env?: Record<string, string | undefined>;
};

/** Worst case for one calendar or acta: token API, portal page, portal API. */
const OPERATION_COST = 3;

/** Problems with one acta's content; the acta is retried later instead of failing the run. */
const ACTA_DATA_ERRORS = new Set<string>(["INCOMPLETE_PLAYER", "DUPLICATE_LINEUP", "EMPTY_LINEUP", "TEAMS_MISMATCH"]);

class Budget {
  used = 0;
  spent = false;
  constructor(readonly max: number) {}
  wrap(fetch: FetchLike): FetchLike {
    return (url, init) => {
      if (this.used >= this.max) {
        this.spent = true;
        return Promise.reject(new Error("fecapa-sync: request budget for this run is spent"));
      }
      this.used++;
      return fetch(url, init);
    };
  }
  canAfford(requests: number): boolean {
    return this.max - this.used >= requests;
  }
}

const noChanges = () => ({ created: [], updated: [], removed: [] });
const emptyChanges = (): Changeset => ({
  leagues: noChanges(), categories: noChanges(), teams: noChanges(), clubs: noChanges(), games: noChanges(), actas: noChanges(),
});

/** Discovery levels that come from the one `leagues` request. */
const LIST_LEVELS = ["leagues", "categories", "teams"] as const;

export const emptyDirectory = (): Directory => ({ leagues: {}, categories: {}, teams: {}, clubs: {} });

function parseLevelFile(input: unknown, file: string, level: DirectoryLevel): Record<string, never> {
  if (input === null) return {};
  const value = input as { version?: unknown } & Record<string, unknown>;
  const records = value?.[level];
  if (value?.version !== 1 || typeof records !== "object" || records === null) {
    throw new FecapaError("STORE_CORRUPT", `${file} doesn't look like a fecapa-sync ${level} file`, { detail: file });
  }
  return records as Record<string, never>;
}

const STORE_EMPTY_HINT = 'Run "fecapa-sync init" (or sync.init()) with a scope by club or category, or with levels.leagues/teams/clubs on.';

function toRunError(error: unknown): RunError {
  if (isFecapaError(error)) {
    const result: RunError = { code: error.code, message: error.message };
    if (error.status !== undefined) result.status = error.status;
    if (error.source !== undefined) result.source = error.source;
    if (error.retryAfterMs !== undefined) result.retryAfterMs = error.retryAfterMs;
    return result;
  }
  return { code: "UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
}

function isConfigPath(options: CreateSyncOptions): options is { configPath: string } {
  return typeof (options as { configPath?: unknown }).configPath === "string";
}

function parseGamesFile(input: unknown, file: string, competitionId: number): GamesFile {
  if (input === null) return { version: 1, competitionId, updatedAt: "", games: {} };
  const value = input as Partial<GamesFile>;
  if (value?.version !== 1 || typeof value.games !== "object" || value.games === null) {
    throw new FecapaError("STORE_CORRUPT", `${file} doesn't look like a fecapa-sync games file`, { detail: file });
  }
  return value as GamesFile;
}

const exists = (file: string) => access(file).then(() => true, () => false);

/**
 * Keeps a local JSON copy of the configured FECAPA data up to date.
 *
 * ```ts
 * const sync = createSync({ configPath: "./fecapa-sync.config.json" });
 * await sync.init();
 * const result = await sync.run();
 * ```
 */
export function createSync(options: CreateSyncOptions, runtime: SyncRuntime = {}): Sync {
  const clock = runtime.now ?? (() => new Date());
  let configPromise: Promise<ResolvedConfig> | undefined;
  const config = () => {
    configPromise ??= isConfigPath(options)
      ? loadConfigFile(options.configPath, { now: clock(), ...(runtime.env ? { env: runtime.env } : {}) })
      : Promise.resolve().then(() => resolveConfig(options, { now: clock(), ...(runtime.baseDir ? { baseDir: runtime.baseDir } : {}), ...(runtime.env ? { env: runtime.env } : {}) }));
    return configPromise;
  };

  const paths = (cfg: ResolvedConfig) => {
    const season = path.join(cfg.dataDir, cfg.seasonDir);
    return {
      state: path.join(cfg.dataDir, "state.json"),
      lock: path.join(cfg.dataDir, "sync.lock"),
      games: (idc: number) => path.join(season, "games", `${idc}.json`),
      level: (level: DirectoryLevel) => path.join(season, `${level}.json`),
      actasDir: path.join(season, "actas"),
      acta: (key: string) => path.join(season, "actas", `${key}.json`),
    };
  };

  async function loadGames(cfg: ResolvedConfig, leagues: number[]): Promise<Map<number, GamesFile>> {
    const files = new Map<number, GamesFile>();
    for (const idc of leagues) {
      const file = paths(cfg).games(idc);
      files.set(idc, parseGamesFile(await readJson(file), file, idc));
    }
    return files;
  }

  async function storedActas(cfg: ResolvedConfig): Promise<Set<string>> {
    const names = await listFiles(paths(cfg).actasDir);
    return new Set(names.filter((name) => /^\d+\.json$/.test(name)).map((name) => name.slice(0, -".json".length)));
  }

  async function loadDirectory(cfg: ResolvedConfig): Promise<Directory> {
    const directory = emptyDirectory();
    for (const level of DIRECTORY_LEVELS) {
      const file = paths(cfg).level(level);
      directory[level] = parseLevelFile(await readJson(file), file, level);
    }
    return directory;
  }

  const hasLeagues = (directory: Directory) => Object.values(directory.leagues).some((league) => league.removedAt === null);

  /** The scope's league and team ids from the stored levels (no network). */
  function scopeFrom(cfg: ResolvedConfig, directory: Directory): ResolvedScope {
    return resolveScope(cfg.scope, hasLeagues(directory) ? directory : null);
  }

  const leagueDue = (league: LeagueState | undefined, now: Date) =>
    !league?.nextDueAt || Date.parse(league.nextDueAt) <= now.getTime();

  async function execute(force: boolean): Promise<SyncResult> {
    const cfg = await config();
    checkPlaceholders(cfg.scope);
    const files = paths(cfg);
    const startedAt = clock();
    const result: SyncResult = {
      status: "ok", reason: null, startedAt: startedAt.toISOString(), finishedAt: startedAt.toISOString(), requests: 0,
      changes: emptyChanges(), backoffUntil: null, error: null, warnings: [], notes: cfg.notes,
    };
    const finish = () => {
      result.finishedAt = clock().toISOString();
      return result;
    };

    const lock = await acquireLock(files.lock, startedAt);
    if (!lock) {
      result.status = "skipped";
      result.reason = "locked";
      return finish();
    }
    try {
      const state = parseState(await readJson(files.state), files.state);
      if (state.backoff && Date.parse(state.backoff.until) > startedAt.getTime()) {
        result.status = "skipped";
        result.reason = "backoff";
        result.backoffUntil = state.backoff.until;
        return finish();
      }

      // Everything below is staged in memory and written only if the run doesn't fail.
      const draft: SyncState = structuredClone(state);
      const season = (draft.seasons[cfg.season] ??= emptySeason());
      const writes = new Map<string, unknown>();
      const budget = new Budget(cfg.maxRequestsPerRun);
      const fetchImpl = runtime.fetch ?? globalThis.fetch.bind(globalThis);
      const client = createClient({
        fetch: budget.wrap(fetchImpl),
        delayMs: cfg.delayMs,
        ...(cfg.token ? { token: cfg.token } : {}),
        ...Object.fromEntries(Object.entries({
          baseUrl: runtime.baseUrl, apiUrl: runtime.apiUrl, userAgent: runtime.userAgent,
          sources: runtime.sources, timeoutMs: runtime.timeoutMs, sleep: runtime.sleep,
        }).filter(([, value]) => value !== undefined)),
      });
      const changes = emptyChanges();
      const directoryBefore = await loadDirectory(cfg);
      const directory = structuredClone(directoryBefore);
      const touched = new Set<DirectoryLevel>();
      let scopeError: unknown = null;

      try {
        // Discovery: leagues, categories and teams come from one `leagues`
        // request, made when any of them is due; club names from one `clubs` request.
        const levelDue = (level: DirectoryLevel) => force || leagueDue(season.levels[level], startedAt);
        const listLevels = LIST_LEVELS.filter((level) => cfg.levels[level]);
        let teamsRebuilt = false;
        let categoriesStale = false;
        const fetchDirectory = async <T>(levels: readonly DirectoryLevel[], call: () => Promise<T & { source: LeagueState["source"] }>): Promise<T | null> => {
          if (!budget.canAfford(OPERATION_COST)) {
            result.reason = "budget";
            return null;
          }
          const attemptAt = clock().toISOString();
          for (const level of levels) (season.levels[level] ??= { lastAttemptAt: null, lastSuccessAt: null, nextDueAt: null, source: null }).lastAttemptAt = attemptAt;
          let value;
          try {
            value = await call();
          } catch (error) {
            if (budget.spent) {
              result.reason = "budget";
              return null;
            }
            throw error;
          }
          const now = clock();
          for (const level of levels) {
            const levelState = season.levels[level]!;
            levelState.lastSuccessAt = now.toISOString();
            levelState.nextDueAt = new Date(now.getTime() + cfg.refreshMs[level]).toISOString();
            levelState.source = value.source;
          }
          return value;
        };

        if (listLevels.length && listLevels.some(levelDue)) {
          const listed = await fetchDirectory(listLevels, () => client.getLeagues());
          if (listed) {
            const now = clock().toISOString();
            if (!listed.leagues.some((league) => isSeason(league.season, cfg.season))) {
              result.warnings.push(`SIDGAD lists no league for season ${cfg.season} yet`);
            }
            directory.leagues = mergeRecords(directory.leagues, buildLeagues(listed.leagues, cfg.season, directory.leagues), now);
            touched.add("leagues");
            if (cfg.levels.teams) {
              directory.teams = mergeRecords(directory.teams, buildTeams(listed.leagues, cfg.season, directory.leagues), now);
              touched.add("teams");
              teamsRebuilt = true;
            }
            categoriesStale = true;
          }
        }
        if (cfg.levels.clubs && result.reason === null) {
          let official: Map<number, string> | null = null;
          if (levelDue("clubs")) {
            const listed = await fetchDirectory(["clubs"], () => client.getClubs());
            if (listed) official = officialNames(listed.clubs);
          }
          if (official || teamsRebuilt) {
            directory.clubs = mergeRecords(directory.clubs, buildClubs(directory.teams, official, directory.clubs), clock().toISOString());
            touched.add("clubs");
          }
        }

        const rebuildCategories = () => {
          if (!cfg.levels.categories || !categoriesStale) return;
          directory.categories = mergeRecords(directory.categories, buildCategories(directory.leagues), clock().toISOString());
          touched.add("categories");
          categoriesStale = false;
        };
        rebuildCategories();

        // Names in the scope are resolved against the discovered levels.
        let scope: ResolvedScope = { leagues: cfg.leagues, teams: cfg.teams, notes: [] };
        if (cfg.levels.games) {
          try {
            scope = scopeFrom(cfg, directory);
          } catch (error) {
            if (result.reason === "budget" && isFecapaError(error, "STORE_EMPTY")) scope = { leagues: [], teams: [], notes: [] };
            else if (isFecapaError(error, "INVALID_CONFIG") || isFecapaError(error, "STORE_EMPTY") || isFecapaError(error, "INVALID_ARGUMENT")) scopeError = error;
            else throw error;
          }
          result.notes = [...cfg.notes, ...scope.notes];
        }

        const games = await loadGames(cfg, scopeError ? [] : scope.leagues);

        if (cfg.levels.games && !scopeError) {
          const due = scope.leagues
            .filter((idc) => force || leagueDue(season.games.leagues[idc], startedAt))
            .sort((a, b) => (season.games.leagues[a]?.nextDueAt ?? "").localeCompare(season.games.leagues[b]?.nextDueAt ?? ""));
          for (const idc of due) {
            if (!budget.canAfford(OPERATION_COST)) {
              result.reason = "budget";
              break;
            }
            const league = (season.games.leagues[idc] ??= { lastAttemptAt: null, lastSuccessAt: null, nextDueAt: null, source: null });
            league.lastAttemptAt = clock().toISOString();
            let calendar;
            try {
              calendar = await client.getCalendar(idc);
            } catch (error) {
              if (budget.spent) {
                result.reason = "budget";
                break;
              }
              throw error;
            }
            const now = clock();
            const merged = mergeCalendar(games.get(idc)!.games, calendar.matches.filter((match) => inTeamScope(match, scope.teams)), now.toISOString());
            const file: GamesFile = { version: 1, competitionId: idc, updatedAt: now.toISOString(), games: merged.games };
            games.set(idc, file);
            writes.set(files.games(idc), file);
            changes.games.created.push(...merged.created);
            changes.games.updated.push(...merged.updated);
            changes.games.removed.push(...merged.removed);
            league.lastSuccessAt = now.toISOString();
            league.nextDueAt = new Date(now.getTime() + cfg.refreshMs.games).toISOString();
            league.source = calendar.source;
            // The calendar also shows the league's groups: kept on the league record at no extra request.
            const stored = directory.leagues[idc];
            if (cfg.levels.leagues && stored && stored.removedAt === null) {
              const groups = groupsFromMatches(stored, calendar.matches);
              if (JSON.stringify(groups) !== JSON.stringify(stored.groups)) {
                directory.leagues[idc] = { ...stored, groups, updatedAt: now.toISOString() };
                touched.add("leagues");
                categoriesStale = true;
              }
            }
          }
        }
        rebuildCategories();

        if (cfg.levels.actas && result.reason === null && !scopeError) {
          const stored = await storedActas(cfg);
          const pending = season.actas.pending;
          const now = clock();
          const due = [...games.values()]
            .flatMap((file) => Object.values(file.games))
            .filter((game) => !stored.has(game.key) && actaDue(game, pending[game.key], now))
            .sort((a, b) => a.startsAt!.localeCompare(b.startsAt!));
          for (const game of due) {
            if (!budget.canAfford(OPERATION_COST)) {
              result.reason = "budget";
              break;
            }
            const key = game.key;
            let outcome;
            try {
              outcome = await client.getFullReport(game.matchId!, { idc: game.competitionId });
            } catch (error) {
              if (budget.spent) {
                result.reason = "budget";
                break;
              }
              if (isFecapaError(error) && ACTA_DATA_ERRORS.has(error.code)) {
                pending[key] = recordActaAttempt(pending[key], game, { status: "error", error: error.code }, clock(), cfg.refreshMs.actas);
                result.warnings.push(`acta ${key}: ${error.code} (${error.message}); attempt ${pending[key].attempts}`);
                continue;
              }
              throw error;
            }
            if (outcome.status === "final") {
              const at = clock().toISOString();
              const record: ActaRecord = {
                ...outcome.report, homeId: game.homeId, awayId: game.awayId, startsAt: game.startsAt,
                source: outcome.source, firstSeenAt: at, updatedAt: at,
              };
              writes.set(files.acta(key), record);
              changes.actas.created.push(record);
              delete pending[key];
            } else {
              pending[key] = recordActaAttempt(pending[key], game, { status: outcome.status }, clock(), cfg.refreshMs.actas);
            }
          }
        }
      } catch (error) {
        // Leave every data file as it was; only record the failure and back off.
        const failures = (state.backoff?.failures ?? 0) + 1;
        const now = clock();
        const runError = toRunError(error);
        const delay = Math.max(backoffDelay(failures), runError.retryAfterMs ?? 0);
        const backoff: Backoff = { failures, until: new Date(now.getTime() + delay).toISOString(), lastError: runError };
        result.status = "failed";
        result.reason = null;
        result.requests = budget.used;
        result.error = runError;
        result.backoffUntil = backoff.until;
        finish();
        await writeJsonAtomic(files.state, {
          ...state, backoff,
          lastRun: { startedAt: result.startedAt, finishedAt: result.finishedAt, status: "failed", requests: budget.used, error: runError },
        } satisfies SyncState);
        return result;
      }

      const levelWrittenAt = clock().toISOString();
      for (const level of touched) {
        writes.set(files.level(level), { version: 1, season: cfg.season, updatedAt: levelWrittenAt, [level]: directory[level] });
        Object.assign(changes[level], diffRecords(directoryBefore[level] as Record<string, never>, directory[level] as Record<string, never>));
      }
      for (const [file, data] of writes) await writeJsonAtomic(file, data);
      result.requests = budget.used;
      result.changes = changes;
      if (result.reason === "budget") result.status = "partial";
      if (scopeError) {
        // The discovered levels are kept (fixing the config costs no new
        // request), but nothing was synced: the run fails without a backoff,
        // since the origin did nothing wrong.
        result.status = "failed";
        result.reason = null;
        result.error = toRunError(scopeError);
      }
      if (budget.used > 0) draft.backoff = null;
      finish();
      const summary: RunSummary = { startedAt: result.startedAt, finishedAt: result.finishedAt, status: result.status, requests: result.requests };
      if (result.reason) summary.reason = result.reason;
      if (result.error) summary.error = result.error;
      draft.lastRun = summary;
      await writeJsonAtomic(files.state, draft);
      return result;
    } finally {
      await lock.release();
    }
  }

  async function view(): Promise<DirectoryView> {
    const cfg = await config();
    return directoryView(await loadDirectory(cfg), cfg.season, STORE_EMPTY_HINT);
  }

  return {
    init: () => execute(true),
    run: () => execute(false),
    listLeagues: async (filter) => (await view()).listLeagues(filter),
    listCategories: async () => (await view()).listCategories(),
    listTeams: async (filter) => (await view()).listTeams(filter),
    listClubs: async () => (await view()).listClubs(),
    findClub: async (query) => (await view()).findClub(query),
    findTeam: async (query) => (await view()).findTeam(query),
    async status() {
      const cfg = await config();
      const files = paths(cfg);
      const now = clock();
      const state = parseState(await readJson(files.state), files.state);
      const season = state.seasons[cfg.season] ?? emptySeason();
      const directory = await loadDirectory(cfg);
      let scope: { leagues: number[]; teams: number[]; error: string | null };
      try {
        const resolved = scopeFrom(cfg, directory);
        scope = { leagues: resolved.leagues, teams: resolved.teams, error: null };
      } catch (error) {
        scope = { leagues: [], teams: [], error: error instanceof Error ? error.message : String(error) };
      }
      const games = await loadGames(cfg, scope.leagues);
      const stored = await storedActas(cfg);
      const pendingList: Array<[string, PendingActa]> = Object.entries(season.actas.pending);
      const allGames = [...games.values()].flatMap((file) => Object.values(file.games));
      const nextAttempts = pendingList.map(([, p]) => p.nextAttemptAt).filter((at): at is string => at !== null).sort();
      return {
        season: cfg.season,
        dataDir: cfg.dataDir,
        levels: cfg.levels,
        refresh: Object.fromEntries(AVAILABLE_LEVELS.map((level) => [level, formatDuration(cfg.refreshMs[level])])) as Record<AvailableLevel, string>,
        maxRequestsPerRun: cfg.maxRequestsPerRun,
        locked: await exists(files.lock),
        backoff: state.backoff,
        lastRun: state.lastRun,
        discovery: Object.fromEntries(DIRECTORY_LEVELS.map((level) => {
          const records = Object.values(directory[level] as Record<string, { removedAt: string | null }>);
          const levelState = season.levels[level];
          return [level, {
            enabled: cfg.levels[level],
            stored: records.filter((record) => record.removedAt === null).length,
            removed: records.filter((record) => record.removedAt !== null).length,
            lastSuccessAt: levelState?.lastSuccessAt ?? null,
            nextDueAt: levelState?.nextDueAt ?? null,
            due: cfg.levels[level] && leagueDue(levelState, now),
          }];
        })) as Record<DirectoryLevel, LevelStatus>,
        scope,
        games: {
          due: cfg.levels.games ? scope.leagues.filter((idc) => leagueDue(season.games.leagues[idc], now)).length : 0,
          leagues: scope.leagues.map((id) => {
            const records = Object.values(games.get(id)!.games);
            const league = season.games.leagues[id];
            return {
              id,
              lastSuccessAt: league?.lastSuccessAt ?? null,
              nextDueAt: league?.nextDueAt ?? null,
              games: records.filter((game) => game.removedAt === null).length,
              removed: records.filter((game) => game.removedAt !== null).length,
              rescheduled: records.filter((game) => game.rescheduled).length,
            };
          }),
        },
        actas: {
          stored: stored.size,
          pending: pendingList.filter(([, p]) => !p.gaveUp).length,
          gaveUp: pendingList.filter(([, p]) => p.gaveUp).length,
          due: cfg.levels.actas ? allGames.filter((game) => !stored.has(game.key) && actaDue(game, season.actas.pending[game.key], now)).length : 0,
          nextAttemptAt: nextAttempts[0] ?? null,
        },
        notes: cfg.notes,
      };
    },
  };
}
