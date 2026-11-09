import { CATEGORIES, CATEGORY_KEYS, inferGender, normalizeCategory, type CategoryKey } from "../categories.js";
import { clean } from "../parsers/common.js";
import type { ClubInfo, Gender, LeagueInfo, Match } from "../types.js";

/** Store bookkeeping on every record of the discovery levels. */
export type RecordMeta = {
  firstSeenAt: string;
  updatedAt: string;
  /** When the record was last seen missing from its source, or null. Records are never deleted. */
  removedAt: string | null;
};

/** A group ("FASE") inside a league, seen in its calendar. */
export type GroupRecord = {
  id: number | null;
  name: string | null;
  category: CategoryKey;
  /** The group name the category came from, or the league's category when the group name has none. */
  categoryRaw: string | null;
  gender: Gender;
  genderSource: "inferred";
};

export type LeagueRecord = RecordMeta & {
  /** Competition id (`idc`). */
  id: number;
  name: string;
  category: CategoryKey;
  /** The raw name the category was read from (league name, then SIDGAD's category), or the league name when unknown. */
  categoryRaw: string | null;
  /** SIDGAD's own category name, raw, or null. */
  sidgadCategory: string | null;
  /** SIDGAD's sex label, raw (`MIXTA`, `MASCULINA`, `FEMENINA`), or null. Only "FEMENINA" counts towards `gender`. */
  sidgadSex: string | null;
  zoneId: number | null;
  zoneName: string | null;
  gender: Gender;
  genderSource: "inferred";
  teamIds: number[];
  /** Groups seen in the league calendar (filled by the `games` level, at no extra request). */
  groups: GroupRecord[];
};

export type CategoryRecord = RecordMeta & {
  key: CategoryKey;
  name: string;
  gender: Gender;
  genderSource: "inferred";
  ageGroup: CategoryKey | null;
  /** Every raw name that mapped to this category this season. */
  rawNames: string[];
  leagueIds: number[];
};

export type TeamRecord = RecordMeta & {
  id: number;
  name: string;
  shortName: string | null;
  clubId: number | null;
  leagueIds: number[];
  categories: CategoryKey[];
  /** `female` when any of its leagues is; `unknown` otherwise. */
  gender: Gender;
  genderSource: "inferred";
};

export type ClubRecord = RecordMeta & {
  /** Federation club id. */
  id: number;
  /** The official name when SIDGAD lists the club, otherwise `teamName`. */
  name: string;
  /** Name from the SIDGAD `clubs` list, or null when the club isn't listed (guests, national teams). */
  officialName: string | null;
  /** Name derived from its teams' names, with suffixes like " B" removed. */
  teamName: string;
  /** Every distinct team-derived name, most used first. Used for matching. */
  aliases: string[];
  teamIds: number[];
  leagueIds: number[];
  categories: CategoryKey[];
};

export type LevelFile<K extends string, T> = { version: 1; season: string; updatedAt: string } & Record<K, Record<string, T>>;
export type LeaguesFile = LevelFile<"leagues", LeagueRecord>;
export type CategoriesFile = LevelFile<"categories", CategoryRecord>;
export type TeamsFile = LevelFile<"teams", TeamRecord>;
export type ClubsFile = LevelFile<"clubs", ClubRecord>;

/** The four discovery levels as maps keyed by id (category key for categories). */
export type Directory = {
  leagues: Record<string, LeagueRecord>;
  categories: Record<string, CategoryRecord>;
  teams: Record<string, TeamRecord>;
  clubs: Record<string, ClubRecord>;
};

export const DIRECTORY_LEVELS = ["leagues", "categories", "teams", "clubs"] as const;
export type DirectoryLevel = (typeof DIRECTORY_LEVELS)[number];

type Content<T> = Omit<T, keyof RecordMeta>;

const categoryOrder = (a: CategoryKey, b: CategoryKey) => CATEGORY_KEYS.indexOf(a) - CATEGORY_KEYS.indexOf(b);
const sortedNumbers = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);
const sortedCategories = (values: Iterable<CategoryKey>) => [...new Set(values)].sort(categoryOrder);

/** JSON with sorted keys, to compare records regardless of key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : item);
}

function contentOf<T extends RecordMeta>(record: T): Content<T> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { firstSeenAt, updatedAt, removedAt, ...content } = record;
  return content;
}

/**
 * Merges freshly built records into the stored ones: new ids get
 * `firstSeenAt`, changed records get a new `updatedAt`, and ids missing from
 * `fresh` get `removedAt` (they are kept, and restored if they come back).
 */
export function mergeRecords<T extends RecordMeta>(existing: Record<string, T>, fresh: Map<string, Content<T>>, now: string): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const [key, content] of fresh) {
    const previous = existing[key];
    if (!previous) {
      merged[key] = { ...content, firstSeenAt: now, updatedAt: now, removedAt: null } as T;
    } else if (previous.removedAt === null && canonical(contentOf(previous)) === canonical(content)) {
      merged[key] = previous;
    } else {
      merged[key] = { ...content, firstSeenAt: previous.firstSeenAt, updatedAt: now, removedAt: null } as T;
    }
  }
  for (const [key, previous] of Object.entries(existing)) {
    if (fresh.has(key)) continue;
    merged[key] = previous.removedAt === null ? { ...previous, removedAt: now, updatedAt: now } : previous;
  }
  return merged;
}

/** Created, updated and removed records between two versions of a level. */
export function diffRecords<T extends RecordMeta>(before: Record<string, T>, after: Record<string, T>): { created: T[]; updated: T[]; removed: T[] } {
  const created: T[] = [];
  const updated: T[] = [];
  const removed: T[] = [];
  for (const [key, record] of Object.entries(after)) {
    const previous = before[key];
    if (!previous) created.push(record);
    else if (record.removedAt !== null && previous.removedAt === null) removed.push(record);
    else if (record.updatedAt !== previous.updatedAt) updated.push(record);
  }
  return { created, updated, removed };
}

const SEASON_RE = /^(\d{4})\s*[/-]\s*(\d{4})$/;

/** Whether a SIDGAD season name (`"2026/2027"`) is `season`. */
export function isSeason(name: string | null, season: string): boolean {
  const match = name ? SEASON_RE.exec(name.trim()) : null;
  return match !== null && `${match[1]}/${match[2]}` === season;
}

/** Builds league records (without meta) from the `leagues` list of one season. Groups are carried over from `existing`. */
export function buildLeagues(infos: LeagueInfo[], season: string, existing: Record<string, LeagueRecord>): Map<string, Content<LeagueRecord>> {
  const leagues = new Map<string, Content<LeagueRecord>>();
  for (const info of infos) {
    if (!isSeason(info.season, season)) continue;
    const { category, categoryRaw } = normalizeCategory(info.name, info.categoryName);
    const groups = existing[info.id]?.groups ?? [];
    leagues.set(String(info.id), {
      id: info.id,
      name: info.name,
      category,
      categoryRaw,
      sidgadCategory: info.categoryName,
      sidgadSex: info.sexName,
      zoneId: info.zoneId,
      zoneName: info.zoneName,
      ...leagueGender(category, info.name, info.sexName),
      teamIds: sortedNumbers(info.teams.map((team) => team.id)),
      groups,
    });
  }
  return leagues;
}

// SIDGAD's sex label "FEMENINA" contains "Femenina", so it counts like a name;
// "MASCULINA" and "MIXTA" never make anything male.
const leagueGender = (category: CategoryKey, name: string, sex: string | null) => inferGender(category, [name, sex]);

/** Groups of a league from its calendar matches, in calendar order. */
export function groupsFromMatches(league: Pick<LeagueRecord, "category" | "categoryRaw" | "gender">, matches: Match[]): GroupRecord[] {
  const groups = new Map<string, GroupRecord>();
  for (const match of matches) {
    if (match.phaseId === null && match.phaseName === null) continue;
    const key = match.phaseId !== null ? `id:${match.phaseId}` : `name:${match.phaseName}`;
    if (groups.has(key)) continue;
    const own = normalizeCategory(match.phaseName);
    const category = own.category !== "unknown" ? own.category : league.category;
    const categoryRaw = own.category !== "unknown" ? own.categoryRaw : league.categoryRaw;
    const gender = league.gender === "female" ? { gender: "female" as const, genderSource: "inferred" as const } : inferGender(category, [match.phaseName]);
    groups.set(key, { id: match.phaseId, name: match.phaseName, category, categoryRaw, ...gender });
  }
  return [...groups.values()];
}

/** Category records from the season's (active) leagues and their groups. */
export function buildCategories(leagues: Record<string, LeagueRecord>): Map<string, Content<CategoryRecord>> {
  const found = new Map<CategoryKey, { raw: Set<string>; leagues: Set<number> }>();
  const add = (key: CategoryKey, raw: string | null, leagueId: number) => {
    const entry = found.get(key) ?? { raw: new Set<string>(), leagues: new Set<number>() };
    if (raw) entry.raw.add(clean(raw));
    entry.leagues.add(leagueId);
    found.set(key, entry);
  };
  for (const league of Object.values(leagues)) {
    if (league.removedAt !== null) continue;
    add(league.category, league.categoryRaw, league.id);
    for (const group of league.groups) add(group.category, group.categoryRaw, league.id);
  }
  const categories = new Map<string, Content<CategoryRecord>>();
  for (const key of [...found.keys()].sort(categoryOrder)) {
    const entry = found.get(key)!;
    const definition = CATEGORIES[key];
    categories.set(key, {
      key,
      name: definition.name,
      ...inferGender(key),
      ageGroup: definition.ageGroup,
      rawNames: [...entry.raw].sort((a, b) => a.localeCompare(b)),
      leagueIds: sortedNumbers(entry.leagues),
    });
  }
  return categories;
}

/** Team records from the season's leagues (a team can play in several). */
export function buildTeams(infos: LeagueInfo[], season: string, leagues: Record<string, LeagueRecord>): Map<string, Content<TeamRecord>> {
  const teams = new Map<string, Content<TeamRecord>>();
  for (const info of infos) {
    if (!isSeason(info.season, season)) continue;
    const league = leagues[info.id];
    if (!league) continue;
    for (const team of info.teams) {
      const previous = teams.get(String(team.id));
      const leagueIds = [...(previous?.leagueIds ?? []), info.id];
      const categories = [...(previous?.categories ?? []), league.category];
      const female = previous?.gender === "female" || league.gender === "female";
      teams.set(String(team.id), {
        id: team.id,
        name: previous?.name ?? team.name,
        shortName: previous?.shortName ?? team.shortName,
        clubId: previous?.clubId ?? team.clubId,
        leagueIds: sortedNumbers(leagueIds),
        categories: sortedCategories(categories),
        gender: female ? "female" : "unknown",
        genderSource: "inferred",
      });
    }
  }
  return teams;
}

// A trailing team letter: " B", " 'A'", ' "C"'. Applied repeatedly ("X A A" → "X").
const TEAM_SUFFIX = /\s+["'«]?\p{Lu}["'»]?$/u;

/** A team name without its team suffix: `"CP EXEMPLE B"` → `"CP EXEMPLE"`. Never returns an empty name. */
export function teamBaseName(name: string): string {
  let base = clean(name);
  for (;;) {
    const next = base.replace(TEAM_SUFFIX, "").trim();
    if (next === base || !next) return base;
    base = next;
  }
}

const nonAscii = (value: string) => [...value].filter((char) => char.charCodeAt(0) > 127).length;

/**
 * A club name from its teams' names: suffixes removed, spellings that differ
 * only in accents grouped, and the most used one kept (on a tie, the one with
 * accents, then alphabetical). Also returns every distinct base name.
 */
export function clubNameFromTeams(teamNames: string[]): { name: string; aliases: string[] } {
  const variants = new Map<string, number>();
  for (const name of teamNames) {
    const base = teamBaseName(name);
    variants.set(base, (variants.get(base) ?? 0) + 1);
  }
  const ranked = [...variants].sort(([a, countA], [b, countB]) => countB - countA || nonAscii(b) - nonAscii(a) || a.localeCompare(b));
  const folded = new Map<string, number>();
  for (const [name, count] of ranked) {
    const key = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    folded.set(key, (folded.get(key) ?? 0) + count);
  }
  const bestKey = [...folded].sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))[0]?.[0];
  const best = ranked.find(([name]) => name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase() === bestKey)?.[0] ?? "";
  return { name: best, aliases: ranked.map(([name]) => name) };
}

/**
 * Club records from the (active) teams. Official names come from `official`
 * (this run's `clubs` list) or, when that wasn't fetched, from the stored
 * records. Only clubs that field a team are kept.
 */
export function buildClubs(teams: Record<string, TeamRecord>, official: Map<number, string> | null, existing: Record<string, ClubRecord>): Map<string, Content<ClubRecord>> {
  const byClub = new Map<number, TeamRecord[]>();
  for (const team of Object.values(teams)) {
    if (team.removedAt !== null || team.clubId === null) continue;
    byClub.set(team.clubId, [...(byClub.get(team.clubId) ?? []), team]);
  }
  const clubs = new Map<string, Content<ClubRecord>>();
  for (const id of [...byClub.keys()].sort((a, b) => a - b)) {
    const clubTeams = byClub.get(id)!;
    const derived = clubNameFromTeams(clubTeams.map((team) => team.name));
    const officialName = official ? official.get(id) ?? null : existing[id]?.officialName ?? null;
    clubs.set(String(id), {
      id,
      name: officialName ?? derived.name,
      officialName,
      teamName: derived.name,
      aliases: derived.aliases,
      teamIds: sortedNumbers(clubTeams.map((team) => team.id)),
      leagueIds: sortedNumbers(clubTeams.flatMap((team) => team.leagueIds)),
      categories: sortedCategories(clubTeams.flatMap((team) => team.categories)),
    });
  }
  return clubs;
}

/** Official names by club id. */
export const officialNames = (clubs: ClubInfo[]) => new Map(clubs.map((club) => [club.id, club.name]));
