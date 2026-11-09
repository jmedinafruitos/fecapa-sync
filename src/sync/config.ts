import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { FecapaError } from "../errors.js";
import { currentSeason } from "../time.js";
import { DAY_MS, formatDuration, HOUR_MS, parseDuration } from "./duration.js";
import { NAME_MODES, type NameMode } from "./players.js";
import { scopeNeedsDirectory, type ScopeInput } from "./resolve.js";

export const LEVELS = ["leagues", "categories", "teams", "clubs", "games", "actas", "players"] as const;
export type Level = (typeof LEVELS)[number];

/** Levels this version can sync. */
export const AVAILABLE_LEVELS = ["leagues", "categories", "teams", "clubs", "games", "actas", "players"] as const;
export type AvailableLevel = (typeof AVAILABLE_LEVELS)[number];

/** The milestone in which each level that isn't available yet is planned. */
export const PLANNED_IN: Partial<Record<Level, string>> = {};

/**
 * Levels each level needs. `games` needs leagues only when the scope names
 * clubs or categories (or all leagues); explicit `scope.leagues` ids work
 * without the `leagues` level.
 */
export const DEPENDS_ON: Partial<Record<Level, Level[]>> = {
  categories: ["leagues"], teams: ["leagues"], clubs: ["teams"], actas: ["games"], players: ["actas"],
};

/**
 * Minimum refresh interval per level, enforced by the library: a configured
 * value below the floor is raised to it. For `actas`, the interval is the
 * spacing before the first retry of an acta that wasn't available yet.
 */
export const REFRESH_FLOORS: Record<Level, number> = {
  leagues: DAY_MS, categories: 7 * DAY_MS, teams: DAY_MS, clubs: 7 * DAY_MS,
  games: 12 * HOUR_MS, actas: 6 * HOUR_MS, players: DAY_MS,
};

/** Default refresh interval per level. */
export const REFRESH_DEFAULTS: Record<Level, number> = {
  leagues: 7 * DAY_MS, categories: 30 * DAY_MS, teams: 7 * DAY_MS, clubs: 30 * DAY_MS,
  games: DAY_MS, actas: 12 * HOUR_MS, players: 7 * DAY_MS,
};

export const DEFAULT_MAX_REQUESTS_PER_RUN = 200;
/** One operation (calendar or acta) can take up to 3 requests when sources fall back. */
export const MIN_MAX_REQUESTS_PER_RUN = 5;
export const DEFAULT_SYNC_DELAY_MS = 1000;
/** Pause between requests during a sync. Lower values are raised to this. */
export const MIN_SYNC_DELAY_MS = 1000;
export const DEFAULT_DATA_DIR = "./fecapa-data";
export const DEFAULT_CONFIG_FILE = "fecapa-sync.config.json";

const positiveId = z.number().int().positive();
const levelFlags = z.object(Object.fromEntries(LEVELS.map((level) => [level, z.boolean().optional()])) as Record<Level, z.ZodOptional<z.ZodBoolean>>).strict();
const refreshValues = z.object(Object.fromEntries(LEVELS.map((level) => [level, z.string().optional()])) as Record<Level, z.ZodOptional<z.ZodString>>).strict();

export const configSchema = z.object({
  $schema: z.string().optional(),
  /** `"2026/2027"`. Defaults to the current season (it changes on 1 July). */
  season: z.string().regex(/^\d{4}\/\d{4}$/, 'expected "YYYY/YYYY"').optional(),
  /** Where the local store lives. Relative to the config file, or to the working directory for an in-code config. */
  dataDir: z.string().min(1).optional(),
  scope: z.object({
    /** Competition ids (`liga` in the portal URL), or `"all"` for every league of the season. */
    leagues: z.array(positiveId).min(1, 'list at least one league id, or "all" (scope.leagues)').optional(),
    /** Team ids. When set, only games involving one of these teams are kept. */
    teams: z.array(positiveId).optional(),
    /** Category names or keys (`"Benjamí"`, `"alevin"`, `"FEM13"`…). Only leagues of these categories. */
    categories: z.array(z.string().trim().min(1)).optional(),
    /** Club names or federation club ids. Only these clubs' leagues, and only games involving their teams. */
    clubs: z.array(z.union([z.string().trim().min(1), positiveId])).optional(),
  }).strict().optional(),
  levels: levelFlags.optional(),
  refresh: refreshValues.optional(),
  players: z.object({
    /** How player names are stored: `"full"` (default), `"initials"` or `"none"` (ids and stats only). */
    names: z.enum(NAME_MODES).optional(),
    /** Also fetch each league's roster (one request per league every `refresh.players`), for players who haven't played yet. Default false. */
    rosters: z.boolean().optional(),
  }).strict().optional(),
  limits: z.object({
    maxRequestsPerRun: z.number().int().min(MIN_MAX_REQUESTS_PER_RUN).optional(),
    delayMs: z.number().int().min(0).optional(),
  }).strict().optional(),
  /** SIDGAD token. Prefer the `FECAPA_SIDGAD_TOKEN` environment variable; never commit a token. */
  token: z.string().min(1).nullable().optional(),
}).strict();

type SchemaInput = z.input<typeof configSchema>;

/** The config file / object, as written by the user. */
export type SyncConfig = Omit<SchemaInput, "scope"> & {
  scope?: Omit<NonNullable<SchemaInput["scope"]>, "leagues"> & { leagues?: number[] | "all" };
};

/** The config after validation, defaults, floors and dependencies. */
export type ResolvedConfig = {
  season: string;
  /** Season directory name, e.g. `"2026-2027"`. */
  seasonDir: string;
  /** Absolute path of the store root. */
  dataDir: string;
  /** Explicit league ids from `scope.leagues` (empty for `"all"` or none). */
  leagues: number[];
  teams: number[];
  /** The scope as configured; names are resolved against the discovered levels at run time. */
  scope: ScopeInput;
  levels: Record<AvailableLevel, boolean>;
  /** Effective refresh intervals, in ms. */
  refreshMs: Record<AvailableLevel, number>;
  maxRequestsPerRun: number;
  delayMs: number;
  token: string | null;
  /** The `players` options with their defaults. */
  players: { names: NameMode; rosters: boolean };
  /** Human-readable notes about values that were raised to a floor or levels turned on as dependencies. */
  notes: string[];
};

function invalid(message: string, detail?: string): FecapaError {
  return new FecapaError("INVALID_CONFIG", `Invalid fecapa-sync config: ${message}`, detail ? { detail } : {});
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const PLACEHOLDER = /<[^>]*>/;

export function resolveConfig(input: unknown, options: { baseDir?: string; now?: Date; env?: Record<string, string | undefined> } = {}): ResolvedConfig {
  // `scope.leagues: "all"` is taken out before validation so that a bad id
  // still reports its exact path (`scope.leagues.0`).
  const allLeagues = isObject(input) && isObject(input.scope) && input.scope.leagues === "all";
  const parsed = configSchema.safeParse(allLeagues ? { ...input, scope: { ...(input.scope as object), leagues: undefined } } : input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.join(".") || "(root)";
    throw invalid(`${where}: ${issue.message}`, where);
  }
  const config = parsed.data;
  const notes: string[] = [];

  const season = config.season ?? currentSeason(options.now);
  const [start, end] = season.split("/").map(Number) as [number, number];
  if (end !== start + 1) throw invalid(`season "${season}" must be two consecutive years`, "season");

  const scope: ScopeInput = {
    leagues: allLeagues ? "all" : [...new Set(config.scope?.leagues ?? [])],
    teams: [...new Set(config.scope?.teams ?? [])],
    clubs: [...new Set(config.scope?.clubs ?? [])],
    categories: [...new Set(config.scope?.categories ?? [])],
  };

  const enabled = new Set<Level>(LEVELS.filter((level) => config.levels?.[level] === true));
  if (!config.levels) enabled.add("games");

  // A scope given by names (or all leagues) needs the levels it is resolved against.
  const needed: Array<[Level, string]> = [];
  if (scopeNeedsDirectory(scope)) needed.push(["leagues", scope.leagues === "all" ? 'scope.leagues "all"' : "the scope"]);
  if (scope.categories.length) needed.push(["categories", "scope.categories"]);
  if (scope.clubs.length) needed.push(["clubs", "scope.clubs"]);
  if (scope.teams.length && !allLeagues && !scope.leagues.length) needed.push(["teams", "scope.teams without scope.leagues"]);
  if (enabled.has("games") || enabled.has("actas")) {
    for (const [level, reason] of needed) {
      if (enabled.has(level)) continue;
      if (config.levels?.[level] === false) throw invalid(`${reason} needs levels.${level}, which is set to false`, `levels.${level}`);
      enabled.add(level);
      notes.push(`levels.${level} turned on because ${reason} needs it`);
    }
  }

  // Turn on what the requested levels depend on.
  for (let changed = true; changed;) {
    changed = false;
    for (const level of [...enabled]) {
      for (const dependency of DEPENDS_ON[level] ?? []) {
        if (!enabled.has(dependency)) {
          if (config.levels?.[dependency] === false) throw invalid(`levels.${level} needs levels.${dependency}, which is set to false`, `levels.${dependency}`);
          enabled.add(dependency);
          changed = true;
          notes.push(`levels.${dependency} turned on because levels.${level} needs it`);
        }
      }
    }
  }
  const unavailable = [...enabled].filter((level) => PLANNED_IN[level]);
  if (unavailable.length) {
    const list = unavailable.map((level) => `"${level}" (${PLANNED_IN[level]})`).join(", ");
    throw invalid(`level ${list} is not available yet in this version. Set it to false.`, `levels.${unavailable[0]}`);
  }
  if (!enabled.size) throw invalid('no level is enabled; enable at least "games"', "levels");
  const hasScope = scope.leagues === "all" || scope.leagues.length > 0 || scope.teams.length > 0 || scope.clubs.length > 0 || scope.categories.length > 0;
  if (enabled.has("games") && !hasScope) {
    throw invalid('"games" needs a scope: list scope.clubs, scope.categories, scope.leagues (ids, or "all" for the whole federation) or scope.teams', "scope");
  }

  const refreshMs = {} as Record<AvailableLevel, number>;
  for (const level of LEVELS) {
    const raw = config.refresh?.[level];
    const value = raw === undefined ? REFRESH_DEFAULTS[level] : parseDuration(raw, `refresh.${level}`);
    const effective = Math.max(value, REFRESH_FLOORS[level]);
    if (raw !== undefined && effective > value) {
      notes.push(`refresh.${level} "${raw}" raised to the minimum "${formatDuration(effective)}"`);
    }
    if ((AVAILABLE_LEVELS as readonly string[]).includes(level)) refreshMs[level as AvailableLevel] = effective;
  }

  const players = { names: config.players?.names ?? "full", rosters: config.players?.rosters ?? false };
  if (players.rosters && !enabled.has("players")) notes.push("players.rosters has no effect while levels.players is off");

  const delay = config.limits?.delayMs ?? DEFAULT_SYNC_DELAY_MS;
  if (delay < MIN_SYNC_DELAY_MS) notes.push(`limits.delayMs ${delay} raised to the minimum ${MIN_SYNC_DELAY_MS}`);

  const env = options.env ?? process.env;
  const baseDir = options.baseDir ?? process.cwd();
  return {
    season,
    seasonDir: season.replace("/", "-"),
    dataDir: path.resolve(baseDir, config.dataDir ?? DEFAULT_DATA_DIR),
    leagues: scope.leagues === "all" ? [] : scope.leagues,
    teams: scope.teams,
    scope,
    levels: Object.fromEntries(AVAILABLE_LEVELS.map((level) => [level, enabled.has(level)])) as Record<AvailableLevel, boolean>,
    refreshMs,
    maxRequestsPerRun: config.limits?.maxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN,
    delayMs: Math.max(delay, MIN_SYNC_DELAY_MS),
    token: config.token ?? env.FECAPA_SIDGAD_TOKEN ?? null,
    players,
    notes,
  };
}

/**
 * Fails on a template placeholder such as `"<club name>"` left in the scope.
 * Checked when a sync starts (before any request), not when the config is
 * read, so the read-only commands still work with a fresh template.
 */
export function checkPlaceholders(scope: ScopeInput): void {
  for (const field of ["clubs", "categories"] as const) {
    const placeholder = scope[field].find((value) => typeof value === "string" && PLACEHOLDER.test(value));
    if (placeholder !== undefined) {
      throw invalid(`scope.${field}: replace the placeholder "${placeholder}" with a real name. "fecapa-sync find <name> --live" looks it up.`, `scope.${field}`);
    }
  }
}

/** Reads and resolves a JSON config file. `dataDir` is relative to the file. */
export async function loadConfigFile(configPath: string, options: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<ResolvedConfig> {
  const absolute = path.resolve(configPath);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    throw new FecapaError("INVALID_CONFIG", `Cannot read config file ${absolute}`, { detail: absolute }, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new FecapaError("INVALID_CONFIG", `Config file ${absolute} is not valid JSON`, { detail: absolute }, { cause: error });
  }
  return resolveConfig(json, { ...options, baseDir: path.dirname(absolute) });
}

/** A starting config for `fecapa-sync init`. */
export function exampleConfig(): SyncConfig {
  return {
    season: currentSeason(),
    dataDir: DEFAULT_DATA_DIR,
    scope: { clubs: ["<club name>"], categories: ["Benjamí"] },
    levels: { games: true, actas: false },
    refresh: { games: "24h" },
    limits: { maxRequestsPerRun: DEFAULT_MAX_REQUESTS_PER_RUN, delayMs: DEFAULT_SYNC_DELAY_MS },
    token: null,
  };
}
