/**
 * Deterministic anonymisation of raw SIDGAD answers, for fixtures.
 *
 * People (players, staff, referees, individual athletes in the clubs list)
 * always get invented names and player ids ≥ 900000. Teams, clubs and venues
 * get invented names and ids too, unless `keepTeams` is set (local debugging
 * only). The mapping is stable within one file: the same input always gives
 * the same output, and the same player gets the same invented id and name
 * wherever they appear. Fields the parsers need and that identify nobody
 * (dates, times, scores, statuses, roles such as `player_role`, match and
 * competition ids, group names) are never touched.
 *
 * It works on key names, not on one schema, so a new or renamed field that
 * holds a person's name or id is still caught when its name says so; a
 * final sweep replaces any known name or id left in other text fields, and
 * `findLeaks` checks the result.
 */

export type AnonymiseOptions = {
  /** Keep team and club names and ids (and venues). For local debugging only: never commit the result. */
  keepTeams?: boolean;
  /** Modality of the clubs list rows that are clubs (`hp`); other rows are individual athletes. Default `"hp"`. */
  modality?: string;
};

export type AnonymiseCounts = { players: number; people: number; teams: number; clubs: number; venues: number };

export type AnonymiseResult = { data: unknown; counts: AnonymiseCounts };

/** One value that survived anonymisation. Never contains the value itself, only where it is. */
export type Leak = { path: string; kind: "person-name" | "player-id" | "team-name" | "team-id" | "club-name" | "club-id" | "venue" };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const PLACEHOLDERS = new Set(["", "--", "-", "_", "0", "null", "undefined"]);
const isPlaceholder = (value: unknown) => value === null || value === undefined || value === 0 || (typeof value === "string" && PLACEHOLDERS.has(value.trim()));

// Key classification. Lower-cased key names.
// Player, staff and referee ids all get invented ids ≥ 900000.
const PLAYER_ID = /^(player_?id|id_?player|id_jugador|jugador_id|staff_?id|id_?staff|ref(eree)?_?id\d*|id_arbitro\d*)$/;
const PERSON_NAME = (key: string) =>
  /^(player_name|staff_name|ref_name\d*|referee(_name)?\d*|arbitro\d*|nombre_jugador|jugador|entrenador|delegado|coach(_name)?)$/.test(key)
  || (/name|nombre/.test(key) && /player|staff|ref|arbit|jugador|coach|delegad|entrenad|person/.test(key));
const TEAM_ID = /^(home_id|away_id|home_team_id|away_team_id|team_?id|id_?team|id_equipo|equipo_id)$/;
const TEAM_NAME = /^(home_name|away_name|home_team_name|away_team_name|team_name|nombre_equipo|name_short|short_name)$/;
const CLUB_ID = /^(home_club_id|away_club_id|club_?id|id_?club)$/;
const CLUB_NAME = /^(nameclub|club_name|nombre_club|name_club)$/;
const TEAM_ID_LIST = /^(ids_teams|team_ids)$/;
const VENUE = /^(venue_info|venue|pista|pabellon|pavello)$/;
const LOGO = /logo|photo|foto|image|imagen/;

// Invented vocabulary: Greek letters, so no output can be mistaken for a real club, town or surname.
const GREEK = ["ALFA", "BETA", "GAMMA", "DELTA", "ÈPSILON", "ZETA", "ETA", "THETA", "IOTA", "KAPPA",
  "LAMBDA", "MI", "NI", "XI", "ÒMICRON", "PI", "RO", "SIGMA", "TAU", "ÍPSILON", "FI", "KHI", "PSI", "OMEGA"];
const GIVEN = ["ANNA", "PAU", "JÚLIA", "NIL", "MARTA", "ARNAU", "LAIA", "POL", "CLARA", "BIEL",
  "NÚRIA", "ORIOL", "ONA", "MARC", "EMMA", "JAN", "AINA", "ROC", "MIREIA", "GERARD"];

/** A unique word sequence for n ≥ 0: ALFA, BETA, …, OMEGA, ALFA ALFA, … */
function words(n: number): string {
  const parts: string[] = [];
  let rest = n;
  do {
    parts.push(GREEK[rest % GREEK.length]!);
    rest = Math.floor(rest / GREEK.length) - 1;
  } while (rest >= 0);
  return parts.reverse().join(" ");
}

function personName(n: number, original: string): string {
  const given = GIVEN[n % GIVEN.length]!;
  const surnames = words(Math.floor(n / GIVEN.length) + GREEK.length); // always two words
  return original.includes(",") ? `${surnames},${given}` : `${given} ${surnames}`;
}

const norm = (value: string) => value.replace(/\s+/g, " ").trim().toUpperCase();

// "CP EXEMPLE B", "CP EXEMPLE 'A'", "CP EXEMPLE A A" → base + suffix, so a club's teams keep one base.
const TEAM_SUFFIX = /^(.+?)((?:\s+(?:"[A-Z]"|'[A-Z]'|[A-Z]))+)$/;

class Allocator {
  private next: number;
  readonly map = new Map<string, number>();
  constructor(start: number, private readonly reserved: Set<string>) {
    this.next = start;
  }
  get(key: string): number {
    let value = this.map.get(key);
    if (value === undefined) {
      while (this.reserved.has(String(this.next))) this.next++;
      value = this.next++;
      this.map.set(key, value);
    }
    return value;
  }
}

class Indexer {
  readonly map = new Map<string, number>();
  get(key: string): number {
    let value = this.map.get(key);
    if (value === undefined) {
      value = this.map.size;
      this.map.set(key, value);
    }
    return value;
  }
}

type Path = Array<string | number>;
const pathText = (path: Path) => path.map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`)).join("").replace(/^\./, "") || "(root)";

/** Calendar separator rows (`idp` "0": FASE/JORNADA) carry a group or round name in `home_name`, not a team. */
function isSeparatorRow(row: Record<string, Json>): boolean {
  const idp = row.idp;
  return idp !== undefined && !/^[1-9]\d*$/.test(String(idp ?? "").trim());
}

/** A clubs-list row of another modality is an individual athlete: their name is a person's name. */
function isPersonClubRow(row: Record<string, Json>, modality: string): boolean {
  if (!("nameclub" in row) || !("modals" in row)) return false;
  const modals = String(row.modals ?? "").split(",").map((value) => value.trim());
  return !modals.includes(modality);
}

type Context = { separator: boolean; personRow: boolean };

function collectNumbers(value: Json, into: Set<string>): void {
  if (typeof value === "number" && Number.isInteger(value)) into.add(String(value));
  else if (typeof value === "string") for (const token of value.match(/\d+/g) ?? []) into.add(String(Number(token)));
  else if (Array.isArray(value)) value.forEach((item) => collectNumbers(item, into));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectNumbers(item, into));
}

class Anonymiser {
  readonly players: Allocator;
  readonly teams: Allocator;
  readonly clubs: Allocator;
  readonly people = new Indexer();
  readonly teamBases = new Indexer();
  readonly clubNames = new Indexer();
  readonly venues = new Indexer();
  /** Original text (normalised) → replacement, for the free-text sweep. */
  readonly names = new Map<string, string>();
  readonly keepTeams: boolean;
  readonly modality: string;

  constructor(input: Json, options: AnonymiseOptions) {
    const reserved = new Set<string>();
    collectNumbers(input, reserved);
    this.players = new Allocator(900001, reserved);
    this.teams = new Allocator(800001, reserved);
    this.clubs = new Allocator(700001, reserved);
    this.keepTeams = options.keepTeams === true;
    this.modality = options.modality ?? "hp";
  }

  private remember(original: string, replacement: string): string {
    const key = norm(original);
    if (key.length >= 4 && !this.names.has(key)) this.names.set(key, replacement);
    return replacement;
  }

  playerId(value: Json): Json {
    if (isPlaceholder(value) || !/^\d+$/.test(String(value).trim())) return value;
    const id = this.players.get(String(Number(String(value).trim())));
    return typeof value === "number" ? id : String(id);
  }

  person(value: Json, row: Record<string, Json> | null): Json {
    if (typeof value !== "string" || isPlaceholder(value)) return value;
    const id = row ? Object.entries(row).find(([key]) => PLAYER_ID.test(key.toLowerCase()))?.[1] : undefined;
    const key = id !== undefined && !isPlaceholder(id) ? `id:${String(id).trim()}` : `name:${norm(value)}`;
    return this.remember(value, personName(this.people.get(key), value));
  }

  teamId(value: Json): Json {
    if (this.keepTeams || isPlaceholder(value) || !/^\d+$/.test(String(value).trim())) return value;
    const id = this.teams.get(String(Number(String(value).trim())));
    return typeof value === "number" ? id : String(id);
  }

  clubId(value: Json, force = false): Json {
    if ((this.keepTeams && !force) || isPlaceholder(value) || !/^\d+$/.test(String(value).trim())) return value;
    const id = this.clubs.get(String(Number(String(value).trim())));
    return typeof value === "number" ? id : String(id);
  }

  teamName(value: Json): Json {
    if (this.keepTeams || typeof value !== "string" || isPlaceholder(value)) return value;
    const text = norm(value);
    const [, base = text, suffix = ""] = TEAM_SUFFIX.exec(text) ?? [];
    const invented = `EQUIP ${words(this.teamBases.get(base))}${suffix}`;
    this.remember(base, `EQUIP ${words(this.teamBases.get(base))}`);
    return this.remember(value, invented);
  }

  clubName(value: Json): Json {
    if (this.keepTeams || typeof value !== "string" || isPlaceholder(value)) return value;
    return this.remember(value, `CLUB ${words(this.clubNames.get(norm(value)))}`);
  }

  venue(value: Json): Json {
    if (this.keepTeams || typeof value !== "string" || isPlaceholder(value)) return value;
    return this.remember(value, `PAVELLÓ ${words(this.venues.get(norm(value)))}`);
  }

  teamIdList(value: Json): Json {
    if (this.keepTeams) return value;
    if (Array.isArray(value)) return value.map((item) => this.teamId(item));
    if (typeof value === "string") return value.replace(/\d+/g, (id) => String(this.teams.get(String(Number(id)))));
    return value;
  }

  /** Pass 1 and 2 share this walk: structural fields are mapped, everything else is copied (text swept later). */
  walk(value: Json, path: Path, ctx: Context, row: Record<string, Json> | null, key: string | null): Json {
    if (Array.isArray(value)) return value.map((item, index) => this.walk(item, [...path, index], ctx, null, null));
    if (value && typeof value === "object") {
      const objectCtx: Context = { separator: isSeparatorRow(value), personRow: isPersonClubRow(value, this.modality) };
      const out: Record<string, Json> = {};
      for (const [childKey, child] of Object.entries(value)) out[childKey] = this.walk(child, [...path, childKey], objectCtx, value, childKey);
      return out;
    }
    if (key === null) return value;
    const k = key.toLowerCase();
    // A parent key such as `teams[]` makes a bare `name` a team name.
    const parent = typeof path[path.length - 2] === "number" ? String(path[path.length - 3] ?? "") : String(path[path.length - 2] ?? "");
    if (PLAYER_ID.test(k)) return this.playerId(value);
    if (PERSON_NAME(k)) return this.person(value, row);
    if (ctx.personRow && CLUB_NAME.test(k)) return this.person(value, null);
    if (ctx.personRow && CLUB_ID.test(k)) return this.clubId(value, true);
    if (LOGO.test(k)) return typeof value === "string" && !isPlaceholder(value) ? "https://sidgad.example/logo.png" : value;
    if (ctx.separator && (k === "home_name" || k === "away_name")) return value;
    if (TEAM_ID.test(k)) return this.teamId(value);
    if (CLUB_ID.test(k)) return this.clubId(value);
    if (TEAM_ID_LIST.test(k)) return this.teamIdList(value);
    if (TEAM_NAME.test(k) || (k === "name" && /^teams?$/i.test(parent))) return this.teamName(value);
    if (CLUB_NAME.test(k) || (k === "name" && /^club(es|s)?$/i.test(parent))) return this.clubName(value);
    if (VENUE.test(k)) return this.venue(value);
    return value;
  }

  /**
   * Replaces known names, and ids of 4+ digits inside free text, in every
   * string the structural pass copied unchanged (`original` is the input at
   * the same path). Short numbers such as "PLATA 1" are never touched.
   */
  sweep(value: Json, original: Json): Json {
    if (Array.isArray(value)) return value.map((item, index) => this.sweep(item, Array.isArray(original) ? original[index] ?? null : null));
    if (value && typeof value === "object") {
      const source = original && typeof original === "object" && !Array.isArray(original) ? original : {};
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, this.sweep(child, source[key] ?? null)]));
    }
    // Only text the structural pass copied unchanged.
    if (typeof value !== "string" || value !== original || !/\p{L}/u.test(value)) return value;
    let text = value;
    const upper = () => text.toUpperCase();
    for (const [name, replacement] of [...this.names].sort((a, b) => b[0].length - a[0].length)) {
      let at = upper().indexOf(name);
      while (at !== -1) {
        text = text.slice(0, at) + replacement + text.slice(at + name.length);
        at = upper().indexOf(name, at + replacement.length);
      }
    }
    return text.replace(/\d{4,}/g, (token) => {
      const key = String(Number(token));
      const player = this.players.map.get(key);
      if (player !== undefined) return String(player);
      if (this.keepTeams) return token;
      return String(this.teams.map.get(key) ?? this.clubs.map.get(key) ?? token);
    });
  }
}

/**
 * Anonymises a raw SIDGAD answer (calendar, report, leagues, clubs or
 * stats/rosters). Deterministic: the same input and options always give the
 * same output.
 */
export function anonymise(input: unknown, options: AnonymiseOptions = {}): AnonymiseResult {
  const json = JSON.parse(JSON.stringify(input ?? null)) as Json;
  const anonymiser = new Anonymiser(json, options);
  const mapped = anonymiser.walk(json, [], { separator: false, personRow: false }, null, null);
  const data = anonymiser.sweep(mapped, json);
  return {
    data,
    counts: {
      players: anonymiser.players.map.size,
      people: anonymiser.people.map.size,
      teams: anonymiser.keepTeams ? 0 : anonymiser.teamBases.map.size,
      clubs: anonymiser.keepTeams ? 0 : anonymiser.clubs.map.size + anonymiser.clubNames.map.size,
      venues: anonymiser.venues.map.size,
    },
  };
}

type Sensitive = {
  names: Array<{ text: string; kind: Leak["kind"] }>;
  ids: Map<string, Leak["kind"]>;
};

function collectSensitive(value: Json, options: AnonymiseOptions, into: Sensitive, path: Path = [], ctx: Context = { separator: false, personRow: false }): void {
  const modality = options.modality ?? "hp";
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSensitive(item, options, into, [...path, index], ctx));
    return;
  }
  if (value && typeof value === "object") {
    const objectCtx = { separator: isSeparatorRow(value), personRow: isPersonClubRow(value, modality) };
    for (const [key, child] of Object.entries(value)) collectSensitive(child, options, into, [...path, key], objectCtx);
    return;
  }
  const key = String(path[path.length - 1] ?? "").toLowerCase();
  const parent = typeof path[path.length - 2] === "number" ? String(path[path.length - 3] ?? "") : String(path[path.length - 2] ?? "");
  const addName = (kind: Leak["kind"]) => {
    if (typeof value === "string" && !isPlaceholder(value) && norm(value).length >= 4) into.names.push({ text: norm(value), kind });
  };
  const addId = (kind: Leak["kind"]) => {
    if (!isPlaceholder(value) && /^\d+$/.test(String(value).trim())) into.ids.set(String(Number(String(value).trim())), kind);
  };
  if (PLAYER_ID.test(key)) addId("player-id");
  else if (PERSON_NAME(key) || (ctx.personRow && CLUB_NAME.test(key))) addName("person-name");
  else if (ctx.personRow && CLUB_ID.test(key)) addId("club-id");
  else if (options.keepTeams) return;
  else if (ctx.separator && (key === "home_name" || key === "away_name")) return;
  else if (TEAM_ID.test(key)) addId("team-id");
  else if (CLUB_ID.test(key)) addId("club-id");
  else if (TEAM_NAME.test(key) || (key === "name" && /^teams?$/i.test(parent))) addName("team-name");
  else if (CLUB_NAME.test(key) || (key === "name" && /^club(es|s)?$/i.test(parent))) addName("club-name");
  else if (VENUE.test(key)) addName("venue");
}

/**
 * Every place in `output` where a person's name or player id from `input`
 * survived (and, without `keepTeams`, a team or club name or id, or a
 * venue). Empty means the anonymisation is complete. The result names paths
 * and kinds only, never the values.
 */
export function findLeaks(input: unknown, output: unknown, options: AnonymiseOptions = {}): Leak[] {
  const sensitive: Sensitive = { names: [], ids: new Map() };
  collectSensitive(JSON.parse(JSON.stringify(input ?? null)) as Json, options, sensitive);
  const leaks: Leak[] = [];
  const visit = (value: Json, path: Path) => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, [...path, index]));
    if (value && typeof value === "object") return Object.entries(value).forEach(([key, child]) => visit(child, [...path, key]));
    const key = String(path[path.length - 1] ?? "").toLowerCase();
    if (typeof value === "string") {
      const text = norm(value);
      for (const name of sensitive.names) if (text.includes(name.text)) leaks.push({ path: pathText(path), kind: name.kind });
      if (/\p{L}/u.test(value)) {
        for (const token of value.match(/\d{4,}/g) ?? []) {
          const kind = sensitive.ids.get(String(Number(token)));
          if (kind) leaks.push({ path: pathText(path), kind });
        }
      }
    }
    const idKind = PLAYER_ID.test(key) ? "player-id" : TEAM_ID.test(key) ? "team-id" : CLUB_ID.test(key) ? "club-id" : null;
    if (idKind && !isPlaceholder(value) && /^\d+$/.test(String(value).trim())) {
      const kind = sensitive.ids.get(String(Number(String(value).trim())));
      if (kind) leaks.push({ path: pathText(path), kind });
    }
    if (TEAM_ID_LIST.test(key) && typeof value === "string") {
      for (const token of value.match(/\d+/g) ?? []) {
        const kind = sensitive.ids.get(String(Number(token)));
        if (kind) leaks.push({ path: pathText(path), kind });
      }
    }
  };
  visit(JSON.parse(JSON.stringify(output ?? null)) as Json, []);
  return leaks;
}
