import { CATEGORIES, categoryOf, foldText, type CategoryKey } from "../categories.js";
import { FecapaError, type ErrorCode } from "../errors.js";
import type { CategoryRecord, ClubRecord, Directory, LeagueRecord, TeamRecord } from "./discovery.js";

const MAX_CANDIDATES = 5;

const tokens = (value: string) => new Set(foldText(value).split(" ").filter(Boolean));

function bigrams(value: string): string[] {
  const text = ` ${foldText(value)} `;
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2));
  return out;
}

/** Dice coefficient of character bigrams on folded text, 0…1. */
export function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.length || !right.length) return 0;
  const counts = new Map<string, number>();
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let shared = 0;
  for (const gram of right) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      shared++;
      counts.set(gram, count - 1);
    }
  }
  return (2 * shared) / (left.length + right.length);
}

type Named<T> = { item: T; label: string; names: string[]; id: number | string };

/** Exact matches (id, or a name equal after folding) and token matches (every query word is a word of a name). */
function matchNamed<T>(query: string | number, entries: Named<T>[]): { exact: Named<T>[]; partial: Named<T>[] } {
  const text = String(query).trim();
  if (typeof query === "number" || /^\d+$/.test(text)) {
    return { exact: entries.filter((entry) => String(entry.id) === text), partial: [] };
  }
  const folded = foldText(text);
  const words = tokens(text);
  const exact = entries.filter((entry) => entry.names.some((name) => foldText(name) === folded));
  const partial = words.size
    ? entries.filter((entry) => !exact.includes(entry) && entry.names.some((name) => {
      const nameWords = tokens(name);
      return [...words].every((word) => nameWords.has(word));
    }))
    : [];
  return { exact, partial };
}

function closest<T>(query: string | number, entries: Named<T>[]): string[] {
  return entries
    .map((entry) => ({ entry, score: Math.max(...entry.names.map((name) => similarity(String(query), name))) }))
    .filter(({ score }) => score > 0.2)
    .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
    .slice(0, MAX_CANDIDATES)
    .map(({ entry }) => entry.label);
}

/** One entry for a query, or an error naming the candidates. Never guesses between several. */
function resolveOne<T>(kind: string, query: string | number, entries: Named<T>[], code: ErrorCode, detail: string): T {
  const { exact, partial } = matchNamed(query, entries);
  const pick = exact.length ? exact : partial;
  if (pick.length === 1) return pick[0]!.item;
  if (pick.length > 1) {
    const candidates = pick.map((entry) => entry.label).sort((a, b) => a.localeCompare(b));
    const shown = candidates.slice(0, 10);
    throw new FecapaError(code, `${kind} "${query}" is ambiguous: it matches ${pick.length} ${kind}s (${shown.join("; ")}${candidates.length > shown.length ? "; …" : ""}). Use a longer name or the id.`, { detail, candidates });
  }
  const candidates = closest(query, entries);
  const hint = candidates.length ? ` Closest: ${candidates.join("; ")}.` : "";
  throw new FecapaError(code, `No ${kind} matches "${query}".${hint}`, { detail, candidates });
}

const clubEntry = (club: ClubRecord): Named<ClubRecord> => ({
  item: club, id: club.id, label: `${club.name} (${club.id})`,
  names: [club.name, club.teamName, ...club.aliases, ...(club.officialName ? [club.officialName] : [])],
});

const teamEntry = (team: TeamRecord): Named<TeamRecord> => ({ item: team, id: team.id, label: `${team.name} (${team.id})`, names: [team.name, ...(team.shortName ? [team.shortName] : [])] });

const active = <T extends { removedAt: string | null }>(records: Record<string, T>) => Object.values(records).filter((record) => record.removedAt === null);

/** Clubs matching a name or id, best first: exact matches, then those whose names contain every word of the query. */
export function findClubs(query: string | number, clubs: Record<string, ClubRecord>): ClubRecord[] {
  const { exact, partial } = matchNamed(query, active(clubs).map(clubEntry));
  return [...exact, ...partial.sort((a, b) => a.label.localeCompare(b.label))].map((entry) => entry.item);
}

/** Teams matching a name or id, best first. */
export function findTeams(query: string | number, teams: Record<string, TeamRecord>): TeamRecord[] {
  const { exact, partial } = matchNamed(query, active(teams).map(teamEntry));
  return [...exact, ...partial.sort((a, b) => a.label.localeCompare(b.label))].map((entry) => entry.item);
}

export function resolveClub(query: string | number, clubs: Record<string, ClubRecord>, code: ErrorCode = "INVALID_ARGUMENT", detail = "club"): ClubRecord {
  return resolveOne("club", query, active(clubs).map(clubEntry), code, detail);
}

/** A category key from a name or key (any accent, case, Catalan or Spanish spelling). Must exist in `categories`. */
export function resolveCategory(query: string, categories: Record<string, CategoryRecord>, code: ErrorCode = "INVALID_ARGUMENT", detail = "category"): CategoryKey {
  const present = active(categories);
  const key = categoryOf(query);
  const known = key !== "unknown" || foldText(query) === "unknown";
  if (known && present.some((category) => category.key === key)) return key;
  const names = present.map((category) => `${category.name} (${category.key})`);
  if (known) {
    throw new FecapaError(code, `No league of this season is in category "${CATEGORIES[key].name}" ("${query}"). Categories: ${names.join("; ")}.`, { detail, candidates: names });
  }
  const candidates = present
    .map((category) => ({ label: `${category.name} (${category.key})`, score: Math.max(...[category.name, category.key, ...category.rawNames].map((name) => similarity(query, name))) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map(({ label }) => label);
  throw new FecapaError(code, `Category "${query}" is not recognised. Closest: ${candidates.join("; ")}.`, { detail, candidates });
}

/** Leagues whose own category, or one of whose groups' categories, is `key`. */
export const inCategory = (league: LeagueRecord, key: CategoryKey) => league.category === key || league.groups.some((group) => group.category === key);

export type ScopeInput = {
  leagues: number[] | "all";
  teams: number[];
  clubs: Array<string | number>;
  categories: string[];
};

export type ResolvedScope = {
  /** League ids whose calendars the `games` level syncs. */
  leagues: number[];
  /** Keep only games involving one of these teams; empty means every game of those leagues. */
  teams: number[];
  /** What the names resolved to, for the run notes. */
  notes: string[];
};

/** Whether this scope needs the discovered levels to be resolved. */
export function scopeNeedsDirectory(scope: ScopeInput): boolean {
  return scope.leagues === "all" || scope.clubs.length > 0 || scope.categories.length > 0 || (scope.teams.length > 0 && scope.leagues.length === 0);
}

/**
 * Turns the configured scope into league and team ids. Filters combine as an
 * intersection: `clubs` + `categories` means that club's leagues in those
 * categories. Names that match nothing or several things are errors listing
 * the closest candidates.
 */
export function resolveScope(scope: ScopeInput, directory: Directory | null): ResolvedScope {
  const explicit = scope.leagues === "all" ? [] : scope.leagues;
  if (!scopeNeedsDirectory(scope)) return { leagues: [...explicit], teams: [...scope.teams], notes: [] };
  if (!directory || !active(directory.leagues).length) {
    throw new FecapaError("STORE_EMPTY", "The scope uses club or category names (or all leagues), but no leagues are stored for this season yet. Run `fecapa-sync init`.", { detail: "leagues" });
  }
  const notes: string[] = [];
  let leagues = active(directory.leagues);
  if (explicit.length) {
    const unknown = explicit.filter((id) => !directory.leagues[id] || directory.leagues[id]!.removedAt !== null);
    if (unknown.length) throw new FecapaError("INVALID_CONFIG", `scope.leagues ${unknown.join(", ")} not found among this season's leagues; remove them or the club/category filters`, { detail: "scope.leagues" });
    leagues = leagues.filter((league) => explicit.includes(league.id));
  }
  if (scope.categories.length) {
    const keys = new Set(scope.categories.map((query) => resolveCategory(query, directory.categories, "INVALID_CONFIG", "scope.categories")));
    leagues = leagues.filter((league) => [...keys].some((key) => inCategory(league, key)));
    notes.push(`scope.categories → ${[...keys].join(", ")}`);
  }
  let teams: number[] = [...scope.teams];
  if (scope.clubs.length) {
    const clubs = scope.clubs.map((query) => resolveClub(query, directory.clubs, "INVALID_CONFIG", "scope.clubs"));
    const clubTeams = new Set(clubs.flatMap((club) => club.teamIds));
    teams = teams.length ? teams.filter((id) => clubTeams.has(id)) : [...clubTeams];
    if (!teams.length) throw new FecapaError("INVALID_CONFIG", "scope.teams has no team of the clubs in scope.clubs", { detail: "scope.teams" });
    notes.push(`scope.clubs → ${clubs.map((club) => `${club.name} (${club.id})`).join(", ")}`);
  }
  if (teams.length) {
    const wanted = new Set(teams);
    leagues = leagues.filter((league) => league.teamIds.some((id) => wanted.has(id)));
  }
  if (!leagues.length) throw new FecapaError("INVALID_CONFIG", "The scope matches no league of this season", { detail: "scope" });
  const ids = leagues.map((league) => league.id).sort((a, b) => a - b);
  notes.push(`scope → ${ids.length} league(s): ${ids.join(", ")}`);
  return { leagues: ids, teams, notes };
}
