import { CATEGORIES, CATEGORY_KEYS } from "../categories.js";
import { FecapaError } from "../errors.js";
import type { CategoryRecord, ClubRecord, Directory, DirectoryLevel, LeagueRecord, TeamRecord } from "./discovery.js";
import { findClubs, findTeams, inCategory, resolveCategory, resolveClub } from "./resolve.js";

export type TeamFilter = {
  /** League id. */
  league?: number;
  /** Club name or federation club id. A name matching several clubs is an error listing them. */
  club?: string | number;
  /** Category name or key (`"Benjamí"`, `"alevin"`, `"fem13"`…). */
  category?: string;
};

export type LeagueFilter = { category?: string };

/** Lists and searches over the discovery levels. Removed records are left out. */
export type DirectoryView = {
  season: string;
  listLeagues(filter?: LeagueFilter): LeagueRecord[];
  listCategories(): CategoryRecord[];
  listTeams(filter?: TeamFilter): TeamRecord[];
  listClubs(): ClubRecord[];
  /** Clubs matching a name (any accent or case, any word order) or id, best first. Empty when nothing matches. */
  findClub(query: string | number): ClubRecord[];
  /** Teams matching a name or id, best first. Empty when nothing matches. */
  findTeam(query: string | number): TeamRecord[];
};

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "ca");
const active = <T extends { removedAt: string | null }>(records: Record<string, T>) => Object.values(records).filter((record) => record.removedAt === null);

/**
 * A view over a directory. `emptyHint` is appended to the `STORE_EMPTY`
 * error raised when a level has no records.
 */
export function directoryView(directory: Directory, season: string, emptyHint: string): DirectoryView {
  const need = <T extends { removedAt: string | null }>(level: DirectoryLevel): T[] => {
    const records = active(directory[level] as unknown as Record<string, T>);
    if (!records.length) {
      throw new FecapaError("STORE_EMPTY", `No ${level} stored for season ${season}. ${emptyHint}`, { detail: level });
    }
    return records;
  };
  const leagueOrder = (a: LeagueRecord, b: LeagueRecord) => CATEGORY_KEYS.indexOf(a.category) - CATEGORY_KEYS.indexOf(b.category) || byName(a, b);

  return {
    season,
    listLeagues(filter = {}) {
      let leagues = need<LeagueRecord>("leagues");
      if (filter.category !== undefined) {
        const categories = active(directory.categories).length ? directory.categories : categoriesFromLeagues(leagues);
        const key = resolveCategory(filter.category, categories);
        leagues = leagues.filter((league) => inCategory(league, key));
      }
      return leagues.sort(leagueOrder);
    },
    listCategories() {
      return need<CategoryRecord>("categories").sort((a, b) => CATEGORY_KEYS.indexOf(a.key) - CATEGORY_KEYS.indexOf(b.key));
    },
    listTeams(filter = {}) {
      let teams = need<TeamRecord>("teams");
      if (filter.league !== undefined) teams = teams.filter((team) => team.leagueIds.includes(filter.league!));
      if (filter.club !== undefined) {
        const club = resolveClub(filter.club, Object.fromEntries(need<ClubRecord>("clubs").map((record) => [record.id, record])));
        teams = teams.filter((team) => team.clubId === club.id);
      }
      if (filter.category !== undefined) {
        const key = resolveCategory(filter.category, Object.fromEntries(need<CategoryRecord>("categories").map((record) => [record.key, record])));
        teams = teams.filter((team) => team.categories.includes(key) || team.leagueIds.some((id) => {
          const league = directory.leagues[id];
          return league !== undefined && inCategory(league, key);
        }));
      }
      return teams.sort(byName);
    },
    listClubs() {
      return need<ClubRecord>("clubs").sort(byName);
    },
    findClub(query) {
      need<ClubRecord>("clubs");
      return findClubs(query, directory.clubs);
    },
    findTeam(query) {
      need<TeamRecord>("teams");
      return findTeams(query, directory.teams);
    },
  };
}

// Without the categories level, a category filter on leagues still works from the leagues' own categories.
function categoriesFromLeagues(leagues: LeagueRecord[]): Record<string, CategoryRecord> {
  const out: Record<string, CategoryRecord> = {};
  for (const league of leagues) {
    for (const key of [league.category, ...league.groups.map((group) => group.category)]) {
      out[key] ??= {
        key, name: CATEGORIES[key].name, gender: "unknown", genderSource: "inferred", ageGroup: null, rawNames: [], leagueIds: [],
        firstSeenAt: league.firstSeenAt, updatedAt: league.updatedAt, removedAt: null,
      };
    }
  }
  return out;
}
