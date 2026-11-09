import { z } from "zod";
import { FecapaError } from "../errors.js";
import type { RosterEntry, SourceName } from "../types.js";
import { clean, formatChanged, optionalText } from "./common.js";

// Only the roster fields we read are declared. The `stats` object also holds
// per-stat rankings (`goals`, `asist`, `blue_cards`, …) and `staff`, which are
// never read: staff are adults' personal data the library doesn't need.
const idValue = z.union([z.string(), z.number()]);
const countValue = z.union([z.number(), z.string()]).nullish();

export const statsSchema = z.object({
  stats: z.object({
    rosters: z.array(z.object({
      team_id: idValue.nullish(),
      player_id: idValue.nullish(),
      player_name: z.string().nullish(),
      played: countValue,
      goals: countValue,
      blue_cards: countValue,
      red_cards: countValue,
    })).nullish(),
  }),
});

const DIGITS = /^\d+$/;

function count(value: unknown, source: SourceName, field: string): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && DIGITS.test(value.trim())) return Number(value.trim());
  throw formatChanged(source, `stats.rosters.${field} is not a count`);
}

function id(value: unknown, source: SourceName, field: string): number {
  const text = value === null || value === undefined ? "" : clean(String(value));
  if (!DIGITS.test(text) || text === "0") throw formatChanged(source, `stats.rosters.${field} "${text}" is not an id`);
  return Number(text);
}

/** SIDGAD writes `"SURNAME(S),GIVEN"`; the library uses `"GIVEN SURNAME(S)"` like the actas. */
function rosterName(value: string | null | undefined): string | null {
  const text = optionalText(value);
  if (!text) return null;
  const [surname, ...givenParts] = text.split(",");
  const given = clean(givenParts.join(" "));
  const last = clean(surname ?? "");
  return given && last ? `${given} ${last}` : clean(text.replace(/,/g, " "));
}

/**
 * Maps the per-league `stats` answer of SIDGAD to roster entries: every
 * player registered with a team of the league, including those who haven't
 * played yet (`played` is null for them). `{"status":"NO FILE"}` (a league
 * without stats yet, or an unknown id) is an empty roster; any other bare
 * status is a refusal.
 */
export function parseRostersJson(input: unknown, source: SourceName): RosterEntry[] {
  const parsed = statsSchema.safeParse(input);
  if (!parsed.success) {
    const status = input && typeof input === "object" && !("stats" in input) ? (input as { status?: unknown }).status : undefined;
    if (status === "NO FILE") return [];
    if (typeof status === "string") throw new FecapaError("SOURCE_REJECTED", `${source}: SIDGAD refused the request (${status})`, { source, status });
    const issue = parsed.error.issues[0];
    throw formatChanged(source, issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "schema mismatch");
  }
  const entries: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const row of parsed.data.stats.rosters ?? []) {
    const fecapaId = id(row.player_id, source, "player_id");
    const teamId = id(row.team_id, source, "team_id");
    const key = `${teamId}:${fecapaId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      fecapaId,
      teamId,
      name: rosterName(row.player_name),
      played: count(row.played, source, "played"),
      goals: count(row.goals, source, "goals"),
      blueCards: count(row.blue_cards, source, "blue_cards"),
      redCards: count(row.red_cards, source, "red_cards"),
    });
  }
  return entries;
}
