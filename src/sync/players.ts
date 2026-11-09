import { inferGender, normalizeCategory } from "../categories.js";
import { clean } from "../parsers/common.js";
import type { Gender, RosterEntry, SourceName } from "../types.js";
import type { ActaRecord, StoredParticipant } from "./actas.js";
import type { Directory, LevelFile, RecordMeta } from "./discovery.js";

/**
 * How player names are stored (`players.names` in the config):
 * - `full`: as the federation publishes them (default);
 * - `initials`: only initials, e.g. `"J. P. T."`;
 * - `none`: no names at all, only ids and stats.
 *
 * Applies to `players.json`, to the lineups of the stored actas and to the
 * stored rosters. Switching to a stricter mode rewrites what is already stored
 * on the next run; switching back can't restore names that were dropped.
 */
export const NAME_MODES = ["full", "initials", "none"] as const;
export type NameMode = (typeof NAME_MODES)[number];

/** `"Júlia Prova-Test"` → `"J. P. T."`. Idempotent: initials of initials are the same initials. */
export function initials(name: string): string {
  return name
    .split(/[\s.\-'’]+/)
    .filter(Boolean)
    .map((word) => `${[...word][0]!.toLocaleUpperCase("ca")}.`)
    .join(" ");
}

/** A name as stored under `mode`. */
export function storedName(name: string | null, mode: NameMode): string | null {
  if (name === null || mode === "none") return null;
  const text = clean(name);
  if (!text) return null;
  return mode === "initials" ? initials(text) : text;
}

/** Stats of one player in one season, recomputed from the stored actas on every run. */
export type PlayerStats = {
  /** Actas the player is listed in. */
  games: number;
  goals: number;
  yellowCards: number;
  blueCards: number;
  redCards: number;
  /** Actas where the player is marked "P" (`player_role === "P"`). */
  gamesAsGoalkeeper: number;
};

/** A team the player was seen with this season. */
export type PlayerTeam = {
  id: number;
  /** Team name from the `teams` level, else from the acta; null when only a roster lists the player and no team name is stored. */
  name: string | null;
  leagueIds: number[];
  /** Actas with this team. */
  games: number;
  /** Listed in a stored roster of this team. */
  inRoster: boolean;
  gender: Gender;
  genderSource: "inferred";
};

/** A player in `players.json`, keyed by the federation player id. One file per season. */
export type PlayerRecord = RecordMeta & {
  /** Federation player id (`Participant.fecapaId`). Stable across seasons and name changes. */
  id: number;
  season: string;
  /** Latest name seen (as stored under `players.names`), or null. */
  name: string | null;
  /** Earlier spellings, oldest first. Kept when the federation changes a name. */
  aliases: string[];
  teamIds: number[];
  leagueIds: number[];
  teams: PlayerTeam[];
  stats: PlayerStats;
  /** Marked "P" in at least one stored acta this season (`stats.gamesAsGoalkeeper > 0`). */
  isGoalkeeper: boolean;
  /** `female` when the player appears with a women's team (FEM category, "Femenina" league or group, SIDGAD's FEMENINA label); `unknown` otherwise, never male. */
  gender: Gender;
  genderSource: "inferred";
  /** Where the player was seen: stored actas and/or stored rosters. */
  sources: Array<"actas" | "rosters">;
};

export type PlayersFile = LevelFile<"players", PlayerRecord>;

/** `rosters/<idc>.json`: the last roster answer for one league, filtered to the scope's teams. */
export type RosterFile = {
  version: 1;
  competitionId: number;
  updatedAt: string;
  source: SourceName;
  players: RosterEntry[];
};

type Content<T> = Omit<T, keyof RecordMeta>;

type Sighting = { name: string | null; at: string };

type Building = {
  id: number;
  sightings: Sighting[];
  teams: Map<number, { name: string | null; leagueIds: Set<number>; games: number; inRoster: boolean; female: boolean }>;
  matches: Set<number>;
  stats: PlayerStats;
  sources: Set<"actas" | "rosters">;
};

const sorted = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);

/** Applies a name mode to every participant of an acta. Returns null when nothing changes. */
export function scrubActa(acta: ActaRecord, mode: NameMode): ActaRecord | null {
  if (mode === "full") return null;
  const side = (players: StoredParticipant[]) => players.map((player) => ({ ...player, name: storedName(player.name, mode) }));
  const home = side(acta.home);
  const away = side(acta.away);
  const same = (a: StoredParticipant[], b: StoredParticipant[]) => a.every((player, i) => player.name === b[i]!.name);
  return same(acta.home, home) && same(acta.away, away) ? null : { ...acta, home, away };
}

/** Applies a name mode to a stored roster. Returns null when nothing changes. */
export function scrubRoster(roster: RosterFile, mode: NameMode): RosterFile | null {
  if (mode === "full") return null;
  const players = roster.players.map((player) => ({ ...player, name: storedName(player.name, mode) }));
  return players.every((player, i) => player.name === roster.players[i]!.name) ? null : { ...roster, players };
}

export type BuildPlayersInput = {
  season: string;
  actas: ActaRecord[];
  rosters: RosterFile[];
  directory: Directory;
  existing: Record<string, PlayerRecord>;
  names: NameMode;
  /** When not empty, only players seen with one of these teams are kept. */
  teams: readonly number[];
};

/**
 * Player records from the stored actas (and rosters, when enabled). Stats are
 * recomputed from scratch every time, so re-reading an acta never counts it
 * twice. Aliases carry over from `existing`.
 */
export function buildPlayers(input: BuildPlayersInput): Map<string, Content<PlayerRecord>> {
  const { directory } = input;
  const players = new Map<number, Building>();
  const get = (id: number) => {
    let player = players.get(id);
    if (!player) {
      player = {
        id, sightings: [], teams: new Map(), matches: new Set(), sources: new Set(),
        stats: { games: 0, goals: 0, yellowCards: 0, blueCards: 0, redCards: 0, gamesAsGoalkeeper: 0 },
      };
      players.set(id, player);
    }
    return player;
  };
  const leagueFemale = (competitionId: number) => directory.leagues[competitionId]?.gender === "female";
  const teamFemale = (teamId: number) => directory.teams[teamId]?.gender === "female";
  const groupFemale = (phaseName: string | null) => phaseName !== null && inferGender(normalizeCategory(phaseName).category, [phaseName]).gender === "female";
  const join = (player: Building, teamId: number, teamName: string | null, competitionId: number, female: boolean) => {
    const team = player.teams.get(teamId) ?? { name: null, leagueIds: new Set<number>(), games: 0, inRoster: false, female: false };
    team.name = directory.teams[teamId]?.name ?? team.name ?? teamName;
    team.leagueIds.add(competitionId);
    team.female ||= female;
    player.teams.set(teamId, team);
    return team;
  };

  const actas = [...input.actas].sort((a, b) => (a.startsAt ?? a.firstSeenAt).localeCompare(b.startsAt ?? b.firstSeenAt) || a.matchId - b.matchId);
  for (const acta of actas) {
    const at = acta.startsAt ?? acta.firstSeenAt;
    for (const [lineup, teamId, teamName] of [[acta.home, acta.homeId, acta.homeName], [acta.away, acta.awayId, acta.awayName]] as const) {
      const female = teamFemale(teamId) || leagueFemale(acta.competitionId) || groupFemale(acta.phaseName);
      for (const participant of lineup) {
        const player = get(participant.fecapaId);
        player.sources.add("actas");
        player.sightings.push({ name: participant.name, at });
        const team = join(player, teamId, teamName, acta.competitionId, female);
        // One acta counts once per player, whatever its lineups say.
        if (player.matches.has(acta.matchId)) continue;
        player.matches.add(acta.matchId);
        team.games++;
        player.stats.games++;
        player.stats.goals += participant.goals;
        player.stats.yellowCards += participant.yellowCards;
        player.stats.blueCards += participant.blueCards;
        player.stats.redCards += participant.redCards;
        if (participant.isGoalkeeper) player.stats.gamesAsGoalkeeper++;
      }
    }
  }
  for (const roster of input.rosters) {
    for (const entry of roster.players) {
      const player = get(entry.fecapaId);
      player.sources.add("rosters");
      player.sightings.push({ name: entry.name, at: roster.updatedAt });
      join(player, entry.teamId, null, roster.competitionId, teamFemale(entry.teamId) || leagueFemale(roster.competitionId)).inRoster = true;
    }
  }

  const wanted = new Set(input.teams);
  const out = new Map<string, Content<PlayerRecord>>();
  for (const player of [...players.values()].sort((a, b) => a.id - b.id)) {
    if (wanted.size && ![...player.teams.keys()].some((id) => wanted.has(id))) continue;
    const { name, aliases } = names(player.sightings, input.existing[player.id], input.names);
    const teams: PlayerTeam[] = [...player.teams.entries()].sort(([a], [b]) => a - b).map(([id, team]) => ({
      id,
      name: team.name,
      leagueIds: sorted(team.leagueIds),
      games: team.games,
      inRoster: team.inRoster,
      gender: team.female ? "female" : "unknown",
      genderSource: "inferred",
    }));
    out.set(String(player.id), {
      id: player.id,
      season: input.season,
      name,
      aliases,
      teamIds: teams.map((team) => team.id),
      leagueIds: sorted(teams.flatMap((team) => team.leagueIds)),
      teams,
      stats: player.stats,
      isGoalkeeper: player.stats.gamesAsGoalkeeper > 0,
      gender: teams.some((team) => team.gender === "female") ? "female" : "unknown",
      genderSource: "inferred",
      sources: (["actas", "rosters"] as const).filter((source) => player.sources.has(source)),
    });
  }
  return out;
}

/** The latest name and the earlier spellings (previous aliases first, then new ones oldest first). */
function names(sightings: Sighting[], previous: PlayerRecord | undefined, mode: NameMode): { name: string | null; aliases: string[] } {
  if (mode === "none") return { name: null, aliases: [] };
  const seen = sightings
    .map((sighting) => ({ ...sighting, name: storedName(sighting.name, mode) }))
    .filter((sighting): sighting is Sighting & { name: string } => sighting.name !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  const latest = seen.at(-1)?.name ?? storedName(previous?.name ?? null, mode);
  const aliases: string[] = [];
  const add = (value: string | null) => {
    const name = storedName(value, mode);
    if (name !== null && name !== latest && !aliases.includes(name)) aliases.push(name);
  };
  for (const alias of previous?.aliases ?? []) add(alias);
  add(previous?.name ?? null);
  for (const sighting of seen) add(sighting.name);
  return { name: latest, aliases };
}
