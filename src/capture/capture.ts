import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_API_URL, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "../client.js";
import { FecapaError, isFecapaError } from "../errors.js";
import { HttpClient, type FetchLike } from "../http.js";
import { apiBaseFromConfig, extractSidgadConfig, modalityOf, sidgadUrl } from "../parsers/portal-config.js";
import { parseCalendarJson, parseClubsJson, parseLeaguesJson, parseReportOutcomeJson } from "../parsers/sidgad-json.js";
import { parseRostersJson } from "../parsers/sidgad-stats.js";
import { homePageUrl } from "../sources/types.js";
import type { SourceName } from "../types.js";
import { DEFAULT_USER_AGENT } from "../version.js";
import { anonymise, findLeaks, type AnonymiseCounts } from "./anonymise.js";

export const CAPTURE_KINDS = ["calendar", "report", "leagues", "clubs", "rosters"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** Kinds that take a competition id (`calendar`, `rosters`) or a match id (`report`). */
export const CAPTURE_NEEDS_ID: readonly CaptureKind[] = ["calendar", "report", "rosters"];

/** Pause between the portal page and the API request: 2 s, like the live canary. */
export const CAPTURE_DELAY_MS = 2000;

const RESOURCE = { calendar: "calendar", report: "report", leagues: "leagues", clubs: "clubs", rosters: "stats" } as const;

export type CaptureOptions = {
  kind: CaptureKind;
  /** Competition id for `calendar` and `rosters`, match id for `report`. Not used by `leagues` and `clubs`. */
  id?: number;
  /** Where to write. Default `fixtures/sidgad-api/<yyyy-mm>-<kind>.json`. Must be inside `fixtures/` unless `force`. */
  out?: string;
  /** Allow writing outside `fixtures/` and overwriting an existing file. */
  force?: boolean;
  /** Keep team and club names and ids (and venues). For local debugging only: never commit the result. */
  keepTeams?: boolean;
  /** SIDGAD token. Without it the public token is read from the portal page (one more request). */
  token?: string;
  baseUrl?: string;
  apiUrl?: string;
  fetch?: FetchLike;
  userAgent?: string;
  /** At least (and by default) 2000 ms. */
  delayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Base for relative paths and for `fixtures/`. Default `process.cwd()`. */
  cwd?: string;
  now?: Date;
};

/** What the library's own parser made of the anonymised answer. Counts and codes only, never names. */
export type CaptureParse =
  | { ok: true; summary: string }
  | { ok: false; code: string; detail: string | null };

export type CaptureResult = {
  file: string;
  kind: CaptureKind;
  /** Live requests made: 1 with a token, 2 without (the portal page holds the public token). */
  requests: number;
  source: SourceName;
  bytes: number;
  counts: AnonymiseCounts;
  keepTeams: boolean;
  parse: CaptureParse;
};

const yearMonth = (date: Date) => date.toISOString().slice(0, 7);

/** The default file name for a capture: `fixtures/sidgad-api/<yyyy-mm>-<kind>.json`. */
export function defaultCapturePath(kind: CaptureKind, now = new Date()): string {
  return path.join("fixtures", "sidgad-api", `${yearMonth(now)}-${kind}.json`);
}

/** Resolves `out` and refuses a path outside `<cwd>/fixtures/` unless `force`. */
export function resolveCapturePath(out: string, cwd: string, force: boolean): string {
  const file = path.resolve(cwd, out);
  const fixtures = path.resolve(cwd, "fixtures");
  const relative = path.relative(fixtures, file);
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!inside && !force) {
    throw new FecapaError("INVALID_ARGUMENT", `capture only writes inside ${fixtures}${path.sep} (use --force to write elsewhere)`, { argument: "out" });
  }
  if (!file.endsWith(".json")) throw new FecapaError("INVALID_ARGUMENT", "capture writes JSON: --out must end in .json", { argument: "out" });
  return file;
}

/** Runs the parser the library uses for this kind on an (anonymised) answer. */
export function parseCaptured(kind: CaptureKind, data: unknown, id: number | undefined, source: SourceName = "sidgad-api", modality = "hp"): CaptureParse {
  try {
    switch (kind) {
      case "calendar": {
        const matches = parseCalendarJson(data, id ?? 1, source);
        return { ok: true, summary: `${matches.length} games` };
      }
      case "report": {
        const outcome = parseReportOutcomeJson(data, { matchId: id ?? 1, competitionId: 1 }, source);
        return { ok: true, summary: outcome.status === "final" ? `final report, ${outcome.report.home.length}+${outcome.report.away.length} players` : outcome.status };
      }
      case "leagues": return { ok: true, summary: `${parseLeaguesJson(data, source).length} leagues` };
      case "clubs": return { ok: true, summary: `${parseClubsJson(data, source, modality).length} clubs` };
      case "rosters": return { ok: true, summary: `${parseRostersJson(data, source).length} roster rows` };
    }
  } catch (error) {
    if (!isFecapaError(error)) throw error;
    return { ok: false, code: error.code, detail: typeof error.detail === "string" ? error.detail : null };
  }
}

/**
 * Captures one live SIDGAD answer as an anonymised fixture: one API request
 * through the polite client (plus one portal page without a token), then
 * `anonymise`, a leak check (nothing is written if any input name or id
 * survives), and the library's parser on the result. The answer is saved even
 * when the parser fails: that is the fixture a "FECAPA changed" fix starts
 * from.
 */
export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const { kind } = options;
  if (!CAPTURE_KINDS.includes(kind)) throw new FecapaError("INVALID_ARGUMENT", `kind must be one of ${CAPTURE_KINDS.join(", ")}`, { argument: "kind" });
  const id = options.id;
  if (CAPTURE_NEEDS_ID.includes(kind) && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
    throw new FecapaError("INVALID_ARGUMENT", `capture ${kind} needs a positive id`, { argument: "id" });
  }
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const force = options.force === true;
  const keepTeams = options.keepTeams === true;
  // Check the destination before any request is made.
  const file = resolveCapturePath(options.out ?? defaultCapturePath(kind, now), cwd, force);
  if (!force && (await exists(file))) {
    throw new FecapaError("INVALID_ARGUMENT", `${file} already exists (use --force to overwrite)`, { argument: "out" });
  }

  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new FecapaError("INVALID_ARGUMENT", "No fetch implementation available", { argument: "fetch" });
  const http = new HttpClient({
    fetch: fetchImpl,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    delayMs: Math.max(CAPTURE_DELAY_MS, options.delayMs ?? CAPTURE_DELAY_MS),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  let requests = 0;
  let apiBase = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  let token = options.token;
  let source: SourceName = "sidgad-api";
  if (!token) {
    source = "portal-config";
    requests++;
    const config = extractSidgadConfig(await http.getText(homePageUrl(baseUrl), { accept: "text/html" }));
    if (!config) throw new FecapaError("SOURCE_FORMAT_CHANGED", "portal-config: page has no SIDGAD_API_CONFIG", { source, detail: "page has no SIDGAD_API_CONFIG" });
    apiBase = apiBaseFromConfig(config);
    token = config.token;
  }
  requests++;
  const raw = await http.getJson(sidgadUrl(apiBase, RESOURCE[kind], CAPTURE_NEEDS_ID.includes(kind) ? id! : null, token), source, {
    origin: new URL(baseUrl).origin,
  });

  const modality = modalityOf(apiBase);
  const { data, counts } = anonymise(raw, { keepTeams, modality });
  const leaks = findLeaks(raw, data, { keepTeams, modality });
  if (leaks.length) {
    const where = [...new Set(leaks.map((leak) => `${leak.kind} at ${leak.path}`))].slice(0, 5).join("; ");
    throw new FecapaError("INVALID_ARGUMENT", `capture: anonymisation incomplete, nothing written (${where})`, { detail: where });
  }
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { flag: force ? "w" : "wx" });
  return {
    file, kind, requests, source, bytes: Buffer.byteLength(content), counts, keepTeams,
    parse: parseCaptured(kind, data, id, source, modality),
  };
}

const exists = (file: string) => access(file).then(() => true, () => false);
