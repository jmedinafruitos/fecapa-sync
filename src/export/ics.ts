import type { GameRecord } from "../sync/games.js";
import { VERSION } from "../version.js";

/** Escapes an RFC 5545 TEXT value: backslash, semicolon, comma and line breaks. */
export function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * Folds a content line at 75 octets (RFC 5545 §3.1): continuation lines start
 * with one space. Never splits a UTF-8 character. Lines end with CRLF.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = parts.length ? 74 : 75; // continuation lines spend one octet on the leading space
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return `${parts.join("\r\n ")}\r\n`;
}

/** `2026-11-01T11:30:00.000Z` → `20261101T113000Z`. */
const utcStamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** `2026-11-01` → `20261101`. */
const dateValue = (date: string) => date.replace(/-/g, "");

function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/** Extra per-game details the store knows beside the game record. */
export type IcsGameExtra = {
  /** League name, for the description. */
  leagueName?: string | null;
  /** Venue from the acta when the calendar had none. */
  venue?: string | null;
  /** Final score from the acta. */
  score?: { home: number; away: number } | null;
};

export type IcsOptions = {
  /** `X-WR-CALNAME`. Default `"fecapa-sync"`. */
  calendarName?: string;
  /** Length of an event with a known kickoff, in minutes. Default 90. */
  durationMinutes?: number;
  extra?: (game: GameRecord) => IcsGameExtra;
};

export type IcsResult = {
  content: string;
  /** Events written (cancelled ones included). */
  events: number;
  /** Games skipped because they have no date yet. */
  skipped: number;
};

/** A stable UID for a game: its league and store key (the match id, or the fixture key for a game without one). */
export const gameUid = (game: Pick<GameRecord, "competitionId" | "key">) => `fecapa-${game.competitionId}-${game.key.replace(/[^A-Za-z0-9-]/g, "-")}@fecapa-sync`;

/**
 * An iCalendar (RFC 5545) feed of games. Times are UTC; a game without a
 * published time is an all-day event; a game without a date is skipped and
 * counted. `SEQUENCE` grows with the game's schedule history (and once more
 * when it leaves the calendar), so calendar apps apply reschedules; a removed
 * game is exported with `STATUS:CANCELLED` instead of being dropped.
 */
export function gamesToIcs(games: readonly GameRecord[], options: IcsOptions = {}): IcsResult {
  const duration = options.durationMinutes ?? 90;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//fecapa-sync//fecapa-sync ${VERSION}//CA`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(options.calendarName ?? "fecapa-sync")}`,
  ];
  let events = 0;
  let skipped = 0;
  for (const game of games) {
    if (game.date === null || game.startsAt === null) {
      skipped++;
      continue;
    }
    const extra = options.extra?.(game) ?? {};
    const venue = game.venue ?? extra.venue ?? null;
    const description = [
      [extra.leagueName, game.phaseName].filter(Boolean).join(" · "),
      game.round !== null ? `Jornada ${game.round}` : "",
      extra.score ? `Resultat: ${extra.score.home} - ${extra.score.away}` : "",
    ].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${gameUid(game)}`,
      `DTSTAMP:${utcStamp(game.updatedAt)}`,
      `LAST-MODIFIED:${utcStamp(game.updatedAt)}`,
      `SEQUENCE:${game.history.length + (game.removedAt !== null ? 1 : 0)}`,
    );
    if (game.time === null) {
      lines.push(`DTSTART;VALUE=DATE:${dateValue(game.date)}`, `DTEND;VALUE=DATE:${dateValue(nextDay(game.date))}`, "TRANSP:TRANSPARENT");
    } else {
      const end = new Date(Date.parse(game.startsAt) + duration * 60_000).toISOString();
      lines.push(`DTSTART:${utcStamp(game.startsAt)}`, `DTEND:${utcStamp(end)}`);
    }
    lines.push(`SUMMARY:${escapeText(`${game.homeName} - ${game.awayName}`)}`);
    if (venue) lines.push(`LOCATION:${escapeText(venue)}`);
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    lines.push(`STATUS:${game.removedAt !== null ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT");
    events++;
  }
  lines.push("END:VCALENDAR");
  return { content: lines.map(foldLine).join(""), events, skipped };
}
