export {
  createClient,
  DEFAULT_API_URL,
  DEFAULT_BASE_URL,
  DEFAULT_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  type ClientOptions,
  type FecapaClient,
  type GetFullReportOptions,
  type GetReportOptions,
} from "./client.js";
export {
  CATEGORIES,
  CATEGORY_KEYS,
  categoryOf,
  foldText,
  inferGender,
  normalizeCategory,
  type CategoryDefinition,
  type CategoryKey,
  type NormalizedCategory,
} from "./categories.js";
export { ErrorCode, FecapaError, isFecapaError, type FecapaErrorContext, type SourceAttempt } from "./errors.js";
export { sameFixture, type FixtureKey } from "./fixtures.js";
export type { FetchLike } from "./http.js";
export { matchPlayer, normalizePlayerName, type RosterPlayer } from "./players.js";
export type { CalendarSource, ReportSource, SourceContext } from "./sources/types.js";
export type { FullReportRequest, ReportOutcome, ReportRequest } from "./parsers/sidgad-json.js";
export { currentSeason, toStartsAt } from "./time.js";
export {
  SOURCE_NAMES,
  type CalendarResult,
  type ClubInfo,
  type ClubsResult,
  type ExpectTeams,
  type FullReport,
  type FullReportResult,
  type Gender,
  type GenderInfo,
  type LeagueInfo,
  type LeaguesResult,
  type Match,
  type Participant,
  type Report,
  type ReportResult,
  type ReportStatus,
  type RosterEntry,
  type RostersResult,
  type Side,
  type SourceName,
  type TeamInfo,
} from "./types.js";
export { DEFAULT_USER_AGENT, VERSION } from "./version.js";
export {
  createSync,
  type Changeset,
  type CreateSyncOptions,
  type LeagueStatus,
  type LevelChanges,
  type LevelStatus,
  type Sync,
  type SyncResult,
  type SyncRuntime,
  type SyncStatus,
} from "./sync/engine.js";
export {
  AVAILABLE_LEVELS,
  DEFAULT_MAX_REQUESTS_PER_RUN,
  LEVELS,
  MIN_SYNC_DELAY_MS,
  REFRESH_DEFAULTS,
  REFRESH_FLOORS,
  loadConfigFile,
  resolveConfig,
  type AvailableLevel,
  type Level,
  type ResolvedConfig,
  type SyncConfig,
} from "./sync/config.js";
export { ACTA_GRACE_MS, ACTA_MAX_ATTEMPTS, ACTA_MAX_RETRY_SPACING_MS, type ActaRecord, type PendingActa } from "./sync/actas.js";
export { discover, type DiscoverOptions, type Discovery } from "./sync/discover.js";
export { type DirectoryView, type LeagueFilter, type TeamFilter } from "./sync/directory.js";
export {
  clubNameFromTeams,
  teamBaseName,
  type CategoriesFile,
  type CategoryRecord,
  type ClubRecord,
  type ClubsFile,
  type Directory,
  type GroupRecord,
  type LeagueRecord,
  type LeaguesFile,
  type RecordMeta,
  type TeamRecord,
  type TeamsFile,
} from "./sync/discovery.js";
export { mergeCalendar, type GameHistoryEntry, type GameRecord, type GamesFile, type MergeResult } from "./sync/games.js";
export { BACKOFF_BASE_MS, BACKOFF_MAX_MS, type Backoff, type LeagueState, type LevelState, type RunError, type RunSummary, type SyncState } from "./sync/state.js";
