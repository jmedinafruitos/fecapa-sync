import { CATEGORIES, normalizeCategory, type CategoryKey } from "../categories.js";
import { FecapaError } from "../errors.js";
import { csvList, toCsv, type CsvValue } from "../export/csv.js";
import { gamesToIcs } from "../export/ics.js";
import type { ActaRecord } from "./actas.js";
import type { CategoryRecord, Directory, LeagueRecord } from "./discovery.js";
import type { GameRecord } from "./games.js";
import type { PlayerRecord } from "./players.js";
import { inCategory, resolveCategory, resolveClub, resolveLeague, resolveTeam } from "./resolve.js";

export const EXPORT_LEVELS = ["games", "actas", "players", "teams", "clubs", "leagues"] as const;
export type ExportLevel = (typeof EXPORT_LEVELS)[number];
export const EXPORT_FORMATS = ["json", "csv", "ics"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type ExportOptions = {
  level: ExportLevel;
  /** Default `"json"`. `"ics"` is for games only. */
  format?: ExportFormat;
  /** Team id or name. A name that matches several teams is an error listing them. */
  team?: string | number;
  /** Club id or name. */
  club?: string | number;
  /** Category name or key (`"Benjamí"`, `"fem13"`…). */
  category?: string;
  /** League id or name. */
  league?: string | number;
  /** ICS only: `X-WR-CALNAME`. Defaults to the filters, e.g. `"EXEMPLE, C.P. · Benjamí"`, or `"FECAPA <season>"`. */
  calendarName?: string;
  /** ICS only: length of a game with a known kickoff, in minutes. Default 90. */
  durationMinutes?: number;
};

export type ExportResult = {
  level: ExportLevel;
  format: ExportFormat;
  /** The exported text (JSON, CSV or iCalendar). */
  content: string;
  /** Records exported: games, actas (CSV: lineup rows), players, teams, clubs or leagues. */
  records: number;
  /** ICS only: games without a date, which can't be calendar events. */
  skipped: number;
  /** What the filters resolved to. */
  notes: string[];
};

/** What an export reads: the local store of one season. */
export type StoreSnapshot = {
  season: string;
  directory: Directory;
  games: GameRecord[];
  actas: Map<string, ActaRecord>;
  players: Record<string, PlayerRecord>;
};

/** CSV columns per level, in this order. Documented in the README; only ever appended to. */
export const CSV_COLUMNS = {
  games: ["key", "matchId", "competitionId", "league", "phaseId", "phaseName", "round", "date", "time", "startsAt", "homeId", "homeName",
    "awayId", "awayName", "venue", "homeScore", "awayScore", "rescheduleCount", "removedAt", "updatedAt"],
  actas: ["matchId", "competitionId", "phaseName", "startsAt", "homeId", "homeName", "awayId", "awayName", "homeScore", "awayScore",
    "side", "teamId", "playerId", "playerName", "isGoalkeeper", "goals", "yellowCards", "blueCards", "redCards"],
  players: ["id", "name", "aliases", "gender", "isGoalkeeper", "games", "goals", "yellowCards", "blueCards", "redCards", "gamesAsGoalkeeper",
    "teamIds", "teamNames", "leagueIds", "sources", "firstSeenAt", "updatedAt", "removedAt"],
  teams: ["id", "name", "shortName", "clubId", "leagueIds", "categories", "gender", "firstSeenAt", "updatedAt", "removedAt"],
  clubs: ["id", "name", "officialName", "teamName", "aliases", "teamIds", "leagueIds", "categories", "firstSeenAt", "updatedAt", "removedAt"],
  leagues: ["id", "name", "category", "sidgadCategory", "sidgadSex", "zoneId", "zoneName", "gender", "teamIds", "groups", "firstSeenAt", "updatedAt", "removedAt"],
} as const satisfies Record<ExportLevel, readonly string[]>;

type Filters = {
  leagueIds: Set<number> | null;
  teamIds: Set<number> | null;
  category: CategoryKey | null;
  notes: string[];
  /** Short names of what was filtered on, for the ICS calendar name. */
  labels: string[];
};

const isId = (value: string | number) => typeof value === "number" || /^\s*\d+\s*$/.test(value);
const active = <T extends { removedAt: string | null }>(records: Record<string, T>) => Object.values(records).filter((record) => record.removedAt === null);

function resolveFilters(options: ExportOptions, directory: Directory, season: string): Filters {
  const need = (level: keyof Directory, why: string) => {
    if (!active(directory[level] as Record<string, { removedAt: string | null }>).length) {
      throw new FecapaError("STORE_EMPTY", `${why} needs the ${level} level, but no ${level} are stored for season ${season}. Use an id, or turn levels.${level} on and run "fecapa-sync init".`, { detail: level });
    }
  };
  const notes: string[] = [];
  const labels: string[] = [];
  let leagueIds: Set<number> | null = null;
  let teamIds: Set<number> | null = null;
  if (options.league !== undefined) {
    if (isId(options.league)) {
      leagueIds = new Set([Number(options.league)]);
      labels.push(directory.leagues[Number(options.league)]?.name ?? `league ${Number(options.league)}`);
    } else {
      need("leagues", "--league by name");
      const league = resolveLeague(options.league, directory.leagues);
      leagueIds = new Set([league.id]);
      notes.push(`league → ${league.name} (${league.id})`);
      labels.push(league.name);
    }
  }
  if (options.team !== undefined) {
    if (isId(options.team)) {
      teamIds = new Set([Number(options.team)]);
      labels.push(directory.teams[Number(options.team)]?.name ?? `team ${Number(options.team)}`);
    } else {
      need("teams", "--team by name");
      const team = resolveTeam(options.team, directory.teams);
      teamIds = new Set([team.id]);
      notes.push(`team → ${team.name} (${team.id})`);
      labels.push(team.name);
    }
  }
  if (options.club !== undefined) {
    let clubTeams: number[];
    if (active(directory.clubs).length || !isId(options.club)) {
      need("clubs", "--club by name");
      const club = resolveClub(options.club, directory.clubs);
      clubTeams = club.teamIds;
      notes.push(`club → ${club.name} (${club.id})`);
      labels.push(club.name);
    } else {
      need("teams", "--club");
      clubTeams = active(directory.teams).filter((team) => team.clubId === Number(options.club)).map((team) => team.id);
      if (!clubTeams.length) throw new FecapaError("INVALID_ARGUMENT", `No team of club ${options.club} is stored`, { detail: "club" });
      labels.push(`club ${Number(options.club)}`);
    }
    teamIds = teamIds ? new Set(clubTeams.filter((id) => teamIds!.has(id))) : new Set(clubTeams);
  }
  let category: CategoryKey | null = null;
  if (options.category !== undefined) {
    need("leagues", "--category");
    const categories: Record<string, CategoryRecord> = active(directory.categories).length ? directory.categories : derivedCategories(directory.leagues);
    category = resolveCategory(options.category, categories);
    notes.push(`category → ${CATEGORIES[category].name}`);
    labels.push(CATEGORIES[category].name);
  }
  return { leagueIds, teamIds, category, notes, labels };
}

function derivedCategories(leagues: Record<string, LeagueRecord>): Record<string, CategoryRecord> {
  const out: Record<string, CategoryRecord> = {};
  for (const league of active(leagues)) {
    for (const key of [league.category, ...league.groups.map((group) => group.category)]) {
      out[key] ??= {
        key, name: CATEGORIES[key].name, gender: CATEGORIES[key].gender, genderSource: "inferred", ageGroup: null, rawNames: [], leagueIds: [],
        firstSeenAt: league.firstSeenAt, updatedAt: league.updatedAt, removedAt: null,
      };
    }
  }
  return out;
}

type GameLike = { competitionId: number; homeId: number; awayId: number; phaseId: number | null; phaseName: string | null };

/** The categories a game belongs to: its league's, its group's, and the one its group name says. */
function gameCategories(game: GameLike, directory: Directory): Set<CategoryKey> {
  const league = directory.leagues[game.competitionId];
  const keys = new Set<CategoryKey>();
  if (league) keys.add(league.category);
  const group = league?.groups.find((g) => (game.phaseId !== null && g.id === game.phaseId) || (game.phaseName !== null && g.name === game.phaseName));
  if (group) keys.add(group.category);
  if (game.phaseName) keys.add(normalizeCategory(game.phaseName).category);
  keys.delete("unknown");
  return keys;
}

function gameMatches(game: GameLike, filters: Filters, directory: Directory): boolean {
  if (filters.leagueIds && !filters.leagueIds.has(game.competitionId)) return false;
  if (filters.teamIds && !filters.teamIds.has(game.homeId) && !filters.teamIds.has(game.awayId)) return false;
  if (filters.category && !gameCategories(game, directory).has(filters.category)) return false;
  return true;
}

const intersects = (values: readonly number[], wanted: Set<number> | null) => !wanted || values.some((value) => wanted.has(value));

function leaguesInCategory(directory: Directory, key: CategoryKey | null): Set<number> | null {
  if (!key) return null;
  return new Set(Object.values(directory.leagues).filter((league) => inCategory(league, key)).map((league) => league.id));
}

const byStart = (a: GameRecord, b: GameRecord) =>
  (a.startsAt ?? "9999").localeCompare(b.startsAt ?? "9999") || a.competitionId - b.competitionId || a.key.localeCompare(b.key);
const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
const json = (records: unknown[]) => `${JSON.stringify(records, null, 2)}\n`;

/** Exports one level of a store snapshot. Reads no network. */
export function exportSnapshot(store: StoreSnapshot, options: ExportOptions): ExportResult {
  const format = options.format ?? "json";
  if (!(EXPORT_LEVELS as readonly string[]).includes(options.level)) {
    throw new FecapaError("INVALID_ARGUMENT", `level must be one of ${EXPORT_LEVELS.join(", ")}`, { argument: "level" });
  }
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new FecapaError("INVALID_ARGUMENT", `format must be one of ${EXPORT_FORMATS.join(", ")}`, { argument: "format" });
  }
  if (format === "ics" && options.level !== "games") {
    throw new FecapaError("INVALID_ARGUMENT", "ICS is for games only (--level games)", { argument: "format" });
  }
  const { directory } = store;
  const filters = resolveFilters(options, directory, store.season);
  const result = (content: string, records: number, skipped = 0): ExportResult => ({
    level: options.level, format, content, records, skipped, notes: filters.notes,
  });
  const leagueName = (id: number) => directory.leagues[id]?.name ?? null;
  const categoryLeagues = leaguesInCategory(directory, filters.category);

  switch (options.level) {
    case "games": {
      const games = store.games.filter((game) => gameMatches(game, filters, directory)).sort(byStart);
      const acta = (game: GameRecord) => (game.matchId !== null ? store.actas.get(String(game.matchId)) : undefined);
      if (format === "ics") {
        const ics = gamesToIcs(games, {
          calendarName: options.calendarName ?? (filters.labels.length ? filters.labels.join(" · ") : `FECAPA ${store.season}`),
          ...(options.durationMinutes !== undefined ? { durationMinutes: options.durationMinutes } : {}),
          extra: (game) => {
            const report = acta(game);
            return { leagueName: leagueName(game.competitionId), venue: report?.venue ?? null, score: report ? { home: report.homeScore, away: report.awayScore } : null };
          },
        });
        if (ics.skipped) filters.notes.push(`${ics.skipped} game(s) without a date skipped`);
        return result(ics.content, ics.events, ics.skipped);
      }
      if (format === "json") return result(json(games), games.length);
      return result(toCsv(CSV_COLUMNS.games, games.map((game) => {
        const report = acta(game);
        return [game.key, game.matchId, game.competitionId, leagueName(game.competitionId), game.phaseId, game.phaseName, game.round, game.date,
          game.time, game.startsAt, game.homeId, game.homeName, game.awayId, game.awayName, game.venue ?? report?.venue, report?.homeScore,
          report?.awayScore, game.rescheduleCount, game.removedAt, game.updatedAt];
      })), games.length);
    }
    case "actas": {
      const actas = [...store.actas.values()]
        .filter((acta) => gameMatches({ ...acta, phaseId: null }, filters, directory))
        .sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? "") || a.matchId - b.matchId);
      if (format === "json") return result(json(actas), actas.length);
      const rows: CsvValue[][] = [];
      for (const acta of actas) {
        for (const side of ["home", "away"] as const) {
          for (const player of acta[side]) {
            rows.push([acta.matchId, acta.competitionId, acta.phaseName, acta.startsAt, acta.homeId, acta.homeName, acta.awayId, acta.awayName,
              acta.homeScore, acta.awayScore, side, side === "home" ? acta.homeId : acta.awayId, player.fecapaId, player.name, player.isGoalkeeper,
              player.goals, player.yellowCards, player.blueCards, player.redCards]);
          }
        }
      }
      return result(toCsv(CSV_COLUMNS.actas, rows), rows.length);
    }
    case "players": {
      const players = Object.values(store.players)
        .filter((player) => intersects(player.leagueIds, filters.leagueIds) && intersects(player.teamIds, filters.teamIds) && intersects(player.leagueIds, categoryLeagues))
        .sort(byId);
      if (format === "json") return result(json(players), players.length);
      return result(toCsv(CSV_COLUMNS.players, players.map((p) => [
        p.id, p.name, csvList(p.aliases), p.gender, p.isGoalkeeper, p.stats.games, p.stats.goals, p.stats.yellowCards, p.stats.blueCards,
        p.stats.redCards, p.stats.gamesAsGoalkeeper, csvList(p.teamIds), csvList(p.teams.map((team) => team.name)), csvList(p.leagueIds),
        csvList(p.sources), p.firstSeenAt, p.updatedAt, p.removedAt,
      ])), players.length);
    }
    case "teams": {
      const teams = Object.values(directory.teams)
        .filter((team) => intersects(team.leagueIds, filters.leagueIds) && intersects([team.id], filters.teamIds)
          && (!filters.category || team.categories.includes(filters.category) || intersects(team.leagueIds, categoryLeagues)))
        .sort(byId);
      if (format === "json") return result(json(teams), teams.length);
      return result(toCsv(CSV_COLUMNS.teams, teams.map((t) => [
        t.id, t.name, t.shortName, t.clubId, csvList(t.leagueIds), csvList(t.categories), t.gender, t.firstSeenAt, t.updatedAt, t.removedAt,
      ])), teams.length);
    }
    case "clubs": {
      const clubs = Object.values(directory.clubs)
        .filter((club) => intersects(club.leagueIds, filters.leagueIds) && intersects(club.teamIds, filters.teamIds)
          && (!filters.category || club.categories.includes(filters.category)))
        .sort(byId);
      if (format === "json") return result(json(clubs), clubs.length);
      return result(toCsv(CSV_COLUMNS.clubs, clubs.map((c) => [
        c.id, c.name, c.officialName, c.teamName, csvList(c.aliases), csvList(c.teamIds), csvList(c.leagueIds), csvList(c.categories),
        c.firstSeenAt, c.updatedAt, c.removedAt,
      ])), clubs.length);
    }
    case "leagues": {
      const leagues = Object.values(directory.leagues)
        .filter((league) => (!filters.leagueIds || filters.leagueIds.has(league.id)) && intersects(league.teamIds, filters.teamIds)
          && (!filters.category || inCategory(league, filters.category)))
        .sort(byId);
      if (format === "json") return result(json(leagues), leagues.length);
      return result(toCsv(CSV_COLUMNS.leagues, leagues.map((l) => [
        l.id, l.name, l.category, l.sidgadCategory, l.sidgadSex, l.zoneId, l.zoneName, l.gender, csvList(l.teamIds),
        csvList(l.groups.map((group) => group.name)), l.firstSeenAt, l.updatedAt, l.removedAt,
      ])), leagues.length);
    }
  }
}
