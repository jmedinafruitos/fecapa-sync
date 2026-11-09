#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CATEGORIES } from "./categories.js";
import { isFecapaError } from "./errors.js";
import { DEFAULT_CONFIG_FILE, exampleConfig } from "./sync/config.js";
import { EXPORT_FORMATS, EXPORT_LEVELS, type ExportFormat, type ExportLevel, type ExportOptions } from "./sync/export.js";
import { writeTextAtomic } from "./sync/fs.js";
import { discover } from "./sync/discover.js";
import type { CategoryRecord, ClubRecord, LeagueRecord, TeamRecord } from "./sync/discovery.js";
import { createSync, type Changeset, type SyncResult, type SyncStatus } from "./sync/engine.js";

const USAGE = `Usage: fecapa-sync <command> [options]

Sync:
  init        One-time full sync. Creates a config template first if the file doesn't exist.
  sync        Incremental sync; only fetches what is due. Call this from cron.
  status      Last and next sync per level, backoff and store counts. No network.

Discover (read the local store; no network unless --live):
  leagues     [--category <name>]                Leagues of the season
  categories                                     Normalised categories and their raw names
  clubs                                          Clubs with their teams' categories
  teams       [--club <name|id>] [--category <name>] [--league <id>]
  find <query>                                   Clubs and teams whose name matches

Export (reads the local store; no network):
  export      --level games|actas|players|teams|clubs|leagues [--format json|csv|ics]
              [--team <name|id>] [--club <name|id>] [--category <name>] [--league <name|id>]
              [--out <file>]                     ICS is for games only. Default format json, to stdout.

Options:
  --config <file>  Config file (default: ${DEFAULT_CONFIG_FILE})
  --json           Print the full result as JSON
  --verbose        sync: print the setup notes even when they haven't changed
  --live           Discover commands only: ask SIDGAD instead of the store
                   (2 requests, 3 without a token). For choosing a scope before "init".

Exit codes: 0 ok (including nothing due, budget spent, backoff or another
run in progress), 1 the run failed, 2 usage or config error (including a
club or category name that matches nothing or several things).`;

const SYNC_COMMANDS = ["init", "sync", "status"];
const DISCOVER_COMMANDS = ["leagues", "categories", "clubs", "teams", "find"];
const EXPORT_COMMAND = "export";

type Args = {
  command: string | undefined;
  query: string | undefined;
  config: string;
  json: boolean;
  live: boolean;
  verbose: boolean;
  club: string | undefined;
  category: string | undefined;
  /** An id for the discover commands; an id or a name for export. */
  league: string | undefined;
  team: string | undefined;
  level: ExportLevel | undefined;
  format: ExportFormat;
  out: string | undefined;
};

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: undefined, query: undefined, config: DEFAULT_CONFIG_FILE, json: false, live: false, verbose: false, club: undefined, category: undefined, league: undefined,
    team: undefined, level: undefined, format: "json", out: undefined };
  const value = (i: number, flag: string) => {
    const next = argv[i];
    if (!next || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const take = () => inline ?? value(++i, flag);
    if (flag === "--config" || flag === "-c") args.config = take();
    else if (flag === "--club") args.club = take();
    else if (flag === "--category") args.category = take();
    else if (flag === "--league") args.league = take();
    else if (flag === "--team") args.team = take();
    else if (flag === "--out" || flag === "-o") args.out = take();
    else if (flag === "--level") {
      const raw = take();
      if (!(EXPORT_LEVELS as readonly string[]).includes(raw)) throw new UsageError(`--level must be one of ${EXPORT_LEVELS.join(", ")}`);
      args.level = raw as ExportLevel;
    } else if (flag === "--format") {
      const raw = take();
      if (!(EXPORT_FORMATS as readonly string[]).includes(raw)) throw new UsageError(`--format must be one of ${EXPORT_FORMATS.join(", ")}`);
      args.format = raw as ExportFormat;
    } else if (arg === "--json") args.json = true;
    else if (arg === "--live") args.live = true;
    else if (arg === "--verbose" || arg === "-v") args.verbose = true;
    else if (arg === "--help" || arg === "-h") args.command = "help";
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}`);
    else if (args.command === undefined) args.command = arg;
    else if (args.command === "find" && args.query === undefined) args.query = arg;
    else if (args.command === "find") args.query = `${args.query} ${arg}`;
    else throw new UsageError(`Unexpected argument ${arg}`);
  }
  if (args.command === "find" && !args.query) throw new UsageError("find needs a query, e.g. fecapa-sync find \"<club name>\"");
  if (args.command !== EXPORT_COMMAND && args.league !== undefined && !/^\d+$/.test(args.league)) throw new UsageError("--league needs a league id");
  if (args.command === EXPORT_COMMAND) {
    if (!args.level) throw new UsageError("export needs --level, e.g. fecapa-sync export --level games --format ics --team <id>");
    if (args.format === "ics" && args.level !== "games") throw new UsageError("--format ics is for --level games only");
  }
  return args;
}

const count = (changes: { created: unknown[]; updated: unknown[]; removed: unknown[] }) =>
  `+${changes.created.length} ~${changes.updated.length} -${changes.removed.length}`;

/**
 * Setup notes ("levels.x turned on…", "scope → …") are the same on every run,
 * which is noise in cron logs: they are printed on `init`, when they changed
 * since the last run, or with `--verbose`. `--json` always has them.
 */
function formatResult(command: string, result: SyncResult, verbose: boolean): string {
  const lines: string[] = [];
  const reason = result.reason ? ` (${result.reason})` : "";
  lines.push(`fecapa-sync ${command}: ${result.status}${reason}, ${result.requests} request${result.requests === 1 ? "" : "s"}`);
  if (result.status !== "skipped") {
    const levels = (Object.keys(result.changes) as Array<keyof Changeset>)
      .filter((level) => level === "games" || level === "actas" || Object.values(result.changes[level]).some((list) => list.length))
      .map((level) => `${level} ${count(result.changes[level])}`);
    if (result.status !== "failed" || result.requests > 0) lines.push(`  ${levels.join(", ")}`);
  }
  if (result.status === "partial") lines.push("  request budget spent; the rest continues next run");
  if (result.error) lines.push(`  error: ${result.error.code}: ${result.error.message}`);
  if (result.backoffUntil) lines.push(`  backoff: no requests before ${result.backoffUntil}`);
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (command === "init" || verbose || result.notesChanged) for (const note of result.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

function formatStatus(status: SyncStatus): string {
  const lines = [`fecapa-sync status: season ${status.season}, store ${status.dataDir}`];
  const on = (Object.keys(status.levels) as Array<keyof SyncStatus["levels"]>).filter((level) => status.levels[level]);
  lines.push(`  levels: ${on.join(", ")}; refresh ${on.map((level) => `${level} ${status.refresh[level]}`).join(", ")}; max ${status.maxRequestsPerRun} requests/run`);
  if (status.locked) lines.push("  a sync is running (sync.lock present)");
  if (status.backoff) lines.push(`  backoff: ${status.backoff.failures} failed run(s), no requests before ${status.backoff.until} (${status.backoff.lastError.code})`);
  if (status.lastRun) lines.push(`  last run: ${status.lastRun.status}${status.lastRun.reason ? ` (${status.lastRun.reason})` : ""} at ${status.lastRun.finishedAt}, ${status.lastRun.requests} requests`);
  for (const [level, info] of Object.entries(status.discovery)) {
    if (!info.enabled) continue;
    lines.push(`  ${level}: ${info.stored} stored (${info.removed} removed), last ${info.lastSuccessAt ?? "never"}, next due ${info.nextDueAt ?? "now"}`);
  }
  if (status.scope.error) lines.push(`  scope: not resolved: ${status.scope.error}`);
  for (const league of status.games.leagues) {
    lines.push(`  league ${league.id}: ${league.games} games (${league.rescheduled} rescheduled, ${league.removed} removed), last ${league.lastSuccessAt ?? "never"}, next due ${league.nextDueAt ?? "now"}`);
  }
  if (status.levels.actas) {
    lines.push(`  actas: ${status.actas.stored} stored, ${status.actas.due} due now, ${status.actas.pending} waiting, ${status.actas.gaveUp} given up${status.actas.nextAttemptAt ? `, next retry ${status.actas.nextAttemptAt}` : ""}`);
  }
  if (status.players.enabled) {
    const rosters = status.players.rosters;
    lines.push(`  players: ${status.players.stored} stored (${status.players.removed} removed), names ${status.players.names}, rosters ${rosters.enabled ? `on, ${rosters.due} league(s) due${rosters.nextDueAt ? `, next ${rosters.nextDueAt}` : ""}` : "off"}`);
  }
  for (const note of status.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

const categoryName = (key: keyof typeof CATEGORIES) => CATEGORIES[key].name;
const femaleMark = (record: { gender: string }) => (record.gender === "female" ? " [female]" : "");

const formatLeague = (league: LeagueRecord) =>
  `${league.id}  ${league.name}  [${categoryName(league.category)}]${femaleMark(league)}  ${league.teamIds.length} teams${league.zoneName ? `  (${league.zoneName})` : ""}`;
const formatCategory = (category: CategoryRecord) =>
  `${category.key.padEnd(10)} ${category.name}${femaleMark(category)}  ${category.leagueIds.length} leagues  raw: ${category.rawNames.join("; ") || "-"}`;
const formatClub = (club: ClubRecord) =>
  `${club.id}  ${club.name}${club.officialName && club.officialName !== club.teamName ? `  (teams: ${club.teamName})` : ""}  ${club.teamIds.length} teams: ${club.categories.map(categoryName).join(", ")}`;
const formatTeam = (team: TeamRecord) =>
  `${team.id}  ${team.name}  club ${team.clubId ?? "-"}  [${team.categories.map(categoryName).join(", ")}]${femaleMark(team)}  leagues ${team.leagueIds.join(", ")}`;

async function readLooseConfig(configPath: string): Promise<{ season?: string; token?: string | null }> {
  try {
    const json = JSON.parse(await readFile(configPath, "utf8")) as { season?: unknown; token?: unknown };
    return {
      ...(typeof json.season === "string" ? { season: json.season } : {}),
      ...(typeof json.token === "string" ? { token: json.token } : {}),
    };
  } catch {
    return {};
  }
}

type Listing = { leagues?: LeagueRecord[]; categories?: CategoryRecord[]; clubs?: ClubRecord[]; teams?: TeamRecord[] };

type MaybePromise<T> = T | Promise<T>;

/** What the store-backed `Sync` and a live `discover()` have in common. */
type Lister = {
  listLeagues(filter?: { category?: string }): MaybePromise<LeagueRecord[]>;
  listCategories(): MaybePromise<CategoryRecord[]>;
  listTeams(filter?: { club?: string | number; category?: string; league?: number }): MaybePromise<TeamRecord[]>;
  listClubs(): MaybePromise<ClubRecord[]>;
  findClub(query: string): MaybePromise<ClubRecord[]>;
  findTeam(query: string): MaybePromise<TeamRecord[]>;
};

async function list(lister: Lister, args: Args): Promise<Listing> {
  switch (args.command) {
    case "leagues": return { leagues: await lister.listLeagues(args.category !== undefined ? { category: args.category } : {}) };
    case "categories": return { categories: await lister.listCategories() };
    case "clubs": return { clubs: await lister.listClubs() };
    case "teams": return {
      teams: await lister.listTeams({
        ...(args.club !== undefined ? { club: /^\d+$/.test(args.club) ? Number(args.club) : args.club } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.league !== undefined ? { league: Number(args.league) } : {}),
      }),
    };
    default: return { clubs: await lister.findClub(args.query!), teams: await lister.findTeam(args.query!) };
  }
}

async function runDiscover(args: Args, configPath: string, out: (text: string) => void, err: (text: string) => void): Promise<void> {
  let lister: Lister;
  if (args.live) {
    const discovery = await discover(await readLooseConfig(configPath));
    err(`fecapa-sync ${args.command} --live: season ${discovery.season}, ${discovery.requests} requests (${discovery.source})`);
    lister = discovery;
  } else {
    lister = createSync({ configPath });
  }
  print(args, await list(lister, args), out);
}

function print(args: Args, listing: Listing, out: (text: string) => void): void {
  if (args.json) {
    out(JSON.stringify(args.command === "find" ? listing : Object.values(listing)[0], null, 2));
    return;
  }
  const lines: string[] = [];
  if (args.command === "find") {
    if (!listing.clubs?.length && !listing.teams?.length) lines.push(`Nothing matches "${args.query}".`);
    if (listing.clubs?.length) lines.push("Clubs:", ...listing.clubs.map((club) => `  ${formatClub(club)}`));
    if (listing.teams?.length) lines.push("Teams:", ...listing.teams.map((team) => `  ${formatTeam(team)}`));
  } else {
    lines.push(...(listing.leagues ?? []).map(formatLeague), ...(listing.categories ?? []).map(formatCategory),
      ...(listing.clubs ?? []).map(formatClub), ...(listing.teams ?? []).map(formatTeam));
    if (!lines.length) lines.push("Nothing found.");
  }
  out(lines.join("\n"));
}

async function runExport(args: Args, configPath: string, out: (text: string) => void, err: (text: string) => void, write: (text: string) => void): Promise<void> {
  const filters: Pick<ExportOptions, "team" | "club" | "category" | "league"> = {};
  for (const key of ["team", "club", "category", "league"] as const) if (args[key] !== undefined) filters[key] = args[key];
  const result = await createSync({ configPath }).export({ level: args.level!, format: args.format, ...filters });
  const what = `${result.records} ${args.format === "csv" && args.level === "actas" ? "lineup rows" : args.level}`;
  const reasons = [result.skippedNoDate ? `${result.skippedNoDate} without a date` : "", result.skippedNoTime ? `${result.skippedNoTime} without a time` : ""].filter(Boolean);
  const skipped = reasons.length ? ` (skipped: ${reasons.join(", ")})` : "";
  const notes = result.notes.filter((note) => !note.endsWith("skipped")).map((note) => `\n  ${note}`).join("");
  if (args.out) {
    const file = path.resolve(args.out);
    await writeTextAtomic(file, result.content);
    out(`fecapa-sync export: ${what} → ${file}${skipped}${notes}`);
  } else {
    write(result.content);
    err(`fecapa-sync export: ${what}${skipped}${notes}`);
  }
}

async function main(
  argv: string[], out: (text: string) => void = console.log, err: (text: string) => void = console.error,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.command === "help") {
    out(USAGE);
    return 0;
  }
  if (![...SYNC_COMMANDS, ...DISCOVER_COMMANDS, EXPORT_COMMAND].includes(args.command ?? "")) {
    err(args.command ? `Unknown command "${args.command}"\n\n${USAGE}` : USAGE);
    return 2;
  }
  if (args.live && !DISCOVER_COMMANDS.includes(args.command!)) {
    err(`--live only applies to ${DISCOVER_COMMANDS.join(", ")}\n\n${USAGE}`);
    return 2;
  }

  const configPath = path.resolve(args.config);
  if (args.command === "init" && !(await access(configPath).then(() => true, () => false))) {
    await writeFile(configPath, `${JSON.stringify(exampleConfig(), null, 2)}\n`, { flag: "wx" });
    out(`Created ${configPath}.
Replace "<club name>" in scope.clubs with your club (find it with: fecapa-sync find "<name>" --live),
adjust scope.categories (or remove it for every category), then run "fecapa-sync init" again.`);
    return 0;
  }

  try {
    if (DISCOVER_COMMANDS.includes(args.command!)) {
      await runDiscover(args, configPath, out, err);
      return 0;
    }
    if (args.command === EXPORT_COMMAND) {
      await runExport(args, configPath, out, err, write);
      return 0;
    }
    const sync = createSync({ configPath });
    if (args.command === "status") {
      const status = await sync.status();
      out(args.json ? JSON.stringify(status, null, 2) : formatStatus(status));
      return 0;
    }
    const result = args.command === "init" ? await sync.init() : await sync.run();
    out(args.json ? JSON.stringify(result, null, 2) : formatResult(args.command!, result, args.verbose));
    if (result.status !== "failed") return 0;
    return result.error?.code === "INVALID_CONFIG" || result.error?.code === "STORE_EMPTY" ? 2 : 1;
  } catch (error) {
    if (isFecapaError(error, "INVALID_CONFIG") || isFecapaError(error, "INVALID_ARGUMENT") || isFecapaError(error, "STORE_EMPTY")) {
      err(error.message);
      return 2;
    }
    err(`fecapa-sync ${args.command}: ${isFecapaError(error) ? `${error.code}: ` : ""}${(error as Error).message}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
