import type { CarSummary, Outcome, PlayerStats, SessionKind } from "@rl/domain";
import type {
  FreeplaySummary,
  MatchMetrics,
  PackType,
  MatchSetStats,
  ReplaySetStats,
  ReplayAnalysis,
  SeriesMetric,
  SeriesPoint,
  Split,
  TouchOwner,
  TrainingSummary,
} from "@rl/metrics";

/** Response shapes. Types only: the server builds them, the web app consumes them. */

export interface Pack {
  code: string;
  name: string;
  type: PackType;
}

export interface Record3 {
  wins: number;
  losses: number;
  abandoned: number;
}

export interface SessionListItem {
  id: string;
  kind: Exclude<SessionKind, "replay">;
  startedAt: number;
  durationSeconds: number;
  playlistId: number | null;
  playlistName: string | null;
  arena: string | null;
  outcome: Outcome | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
  overtime: boolean;
  /** Ended early by a forfeit. */
  forfeit: boolean;
  /** I left before the end, but marked the result as settled: outcome is what the score shows. */
  leftSettled: boolean;
  /** I left before the end, but after all my teammates had: outcome is what the score shows. */
  teammatesLeft: boolean;
  /** Starred in the app (a favorite). */
  starred: boolean;
  /** "replay": rebuilt from a saved replay, not recorded live (no stat feed, about 93% of touches). */
  source: "live" | "replay";
  partied: boolean;
  queueWarmup: boolean;
  /** Practice only: measured, or my practice speed setting when it couldn't be measured. */
  gameSpeed: number | null;
  gameSpeedSource: "measured" | "setting" | null;
  /** My end-of-match stats (game counts). Null for sessions I'm not found in. */
  me: (PlayerStats & { team: number }) | null;
  /** 0..1, null in 1v1 and practice. */
  touchShare: number | null;
  /** I was the match's MVP. Null outside matches. */
  mvp: boolean | null;
  /** Where the match's replay stands. Null outside matches. */
  replay: SessionReplay | null;
  /** Names of known teammates on my team. */
  teammates: string[];
  pack: Pack | null;
  /** The sitting this session belongs to (see PlaySessionItem). */
  playSessionId: string | null;
}

/**
 * One sitting: from the first match or practice to the last before a break
 * of 40 minutes, or 10 minutes after quitting the game.
 */
export interface PlaySessionItem {
  id: string;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  /** All matches, including private matches and other modes. */
  matches: number;
  /** Standard play only, like the summary. */
  record: Record3;
  practiceSeconds: number;
  /** Playlists played, most played first. */
  playlists: { id: number; name: string; count: number }[];
  /** Matches and practice in order. */
  sessionIds: string[];
}

export interface PlaySessionsResponse {
  items: PlaySessionItem[];
  nextCursor: number | null;
}

export interface SessionsResponse {
  items: SessionListItem[];
  /** Pass as `before` to get the next page; null at the end. */
  nextCursor: number | null;
}

export interface SummaryResponse {
  matches: number;
  record: Record3;
  solo: Record3;
  partied: Record3;
  byTeamSize: Partial<Record<"1" | "2" | "3", Record3>>;
  practiceSeconds: number;
  firstStartedAt: number | null;
  lastStartedAt: number | null;
  /**
   * Matches for each filter combination, whatever this query's filters, so
   * the filter chips can turn off the ones that would show nothing or change
   * nothing. "all" is every team size.
   */
  filterCounts: Record<"all" | "1" | "2" | "3", { total: number; solo: number; party: number }>;
  /** Extra modes with matches (tournaments, Rumble, Snow Day, private…), for their own filter chips. */
  modes: { playlistId: number; name: string; matches: number }[];
  /** Matches here I was MVP in. Never 1s, where the winner is always MVP. */
  mvps: number;
  /**
   * What an MVP share is out of: wins with the same filters but any result,
   * leaving out 1s (no MVP there). 0 hides the share.
   */
  mvpWins: number;
  /** Per-match numbers, overtime and margins for the decided matches here. */
  stats: MatchSetStats;
  /** From replay analysis (subtr-actor), for the decided matches here that have one. */
  replayStats: ReplaySetStats;
  /** For this query's matches as the list shows them: how many each result filter would leave. */
  resultCounts: { total: number; win: number; loss: number; mvp: number };
  /** The same, for each replay filter (every other filter applied). */
  replayCounts: { total: number; attention: number; saved: number };
  /** Matches listed with every filter but the star, and how many of them are starred. */
  starredCounts: { total: number; starred: number };
}

export interface DetailPlayer extends PlayerStats {
  key: string;
  name: string;
  team: number;
  isMe: boolean;
  isBot: boolean;
  isKnownTeammate: boolean;
  /** Set for drop-ins and early leavers. */
  joinedAt: number | null;
  leftAt: number | null;
}

/** Locations are rotated so my team attacks toward +y (see @rl/metrics attackUp). */
export interface DetailTouch {
  at: number;
  matchTime: number | null;
  owner: TouchOwner;
  playerKey: string;
  x: number;
  y: number;
  z: number;
  postSpeed: number;
}

export interface DetailGoal {
  matchTime: number | null;
  forUs: boolean;
  scorerName: string | null;
  assisterName: string | null;
  speedKmh: number;
  x: number;
  y: number;
  z: number;
  /** False when only the (often stale) first GoalScored location exists. */
  locationReliable: boolean;
}

export interface SessionDetailResponse {
  session: SessionListItem & { note: string | null; endedAt: number; pausedSeconds: number };
  players: DetailPlayer[];
  goals: DetailGoal[];
  touches: DetailTouch[];
  statEvents: { matchTime: number | null; eventName: string; label: string; playerName: string | null }[];
  /**
   * Time on ground, wall and in the air, boosting and supersonic, per player.
   * Live play covers my team only; a saved replay of the match adds everyone.
   */
  cars: (CarSummary & { name: string | null })[];
  /** From a saved replay of the match only. Rotated like touches (my team attacks toward +y). */
  boostPickups: { matchTime: number | null; playerKey: string | null; playerName: string | null; boostType: string; x: number; y: number; z: number }[];
  metrics: MatchMetrics | null;
  practice: FreeplaySummary | TrainingSummary | null;
  /** A saved replay of this match, if one was ever loaded while the collector ran. */
  replay: { sessionId: string; replayId: string } | null;
  /** The matches (or practice sessions) just before and after this one, for previous/next links. */
  neighbors: { previous: NeighborSession | null; next: NeighborSession | null };
}

export interface NeighborSession {
  id: string;
  startedAt: number;
  playlistId: number | null;
  playlistName: string | null;
  outcome: Outcome | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
}

/** A moment worth jumping to in a match's replay. */
export interface ReviewMoment {
  id: string;
  kind: "goal-against" | "goal-for";
  matchTime: number | null;
  playerName: string | null;
  /** Replay frame of the moment; null when neither the replay's header nor a playback gives one. */
  frame: number | null;
}

export interface ReviewResponse {
  /**
   * The match's replay. `saved`: the file is in the replays folder, so the
   * game can load it. `played`: a full playback was recorded, so its data is in.
   * `playedFast`: as SessionReplay's.
   */
  replay: { replayId: string; saved: boolean; played: boolean; playedFast?: boolean } | null;
  /** Goals for and against, in match order. */
  moments: ReviewMoment[];
}

/** "launching": Rocket League wasn't running; it's starting, and the replay opens once it's up. */
export type ReplayGotoResponse = { ok: true; status: "seeking" | "loading" | "open" | "launching" } | { ok: false; reason: string };

export interface TrendsResponse {
  matches: number;
  series: Partial<Record<SeriesMetric, { label: string; unit: string; points: SeriesPoint[] }>>;
}

export interface SplitsResponse {
  splits: { name: string; split: Split }[];
}

export type PracticeItem = (FreeplaySummary | TrainingSummary) & { pack: Pack | null; arena: string | null };

export interface PracticeResponse {
  items: PracticeItem[];
  packs: Pack[];
}

/** Messages on the /live WebSocket. Send `{ command: GameCommand }` the other way. */
export type LiveMessage =
  | { type: "game"; receivedAt: number; event: string; data: unknown }
  | { type: "session"; session: { id: string; kind: SessionKind; startedAt: number; outcome: Outcome | null } }
  | { type: "status"; gameConnected: boolean }
  | { type: "error"; error: string };

/** Settings the web app uses, from the settings file. */
export interface SettingsResponse {
  /** Seconds before a moment that a replay jump starts. */
  replayLeadSeconds: number;
  /** Whether POST /api/game/launch can start the game (only in the desktop app). */
  canLaunchGame: boolean;
  /** Whether a replay run can close the game when it finishes (only in the desktop app, on Windows). */
  canQuitGame: boolean;
  /** The desktop app's shortcut for going back to the last replay jump (e.g. "Ctrl+Alt+R"), if any. */
  replayAgainShortcut: string | null;
  /** A ballchasing API key is set, so missing replays can be downloaded from there. */
  ballchasing: boolean;
}

/** Downloading a match's replay from ballchasing (POST /api/sessions/:id/replay/ballchasing). */
export type BallchasingFetchResponse = { ok: true; replayId: string } | { ok: false; reason: string };

/**
 * What a launch request did. focused: the game was already running and was
 * brought forward. cancelled: the person said no in the desktop app's dialog.
 */
export type LaunchGameResponse = { ok: true; status: "launching" | "focused" | "cancelled" } | { ok: false; reason: string };

export interface HealthResponse {
  ok: true;
  gameConnected: boolean;
  sessions: number;
}

/** Where a match's replay stands (GET /api/replays). */
export type ReplayState =
  /** The file is in the replays folder: the game can open it. */
  | "saved"
  /** No file, but the game's Match History still has it: save it there. */
  | "in-history"
  /** No file and out of Match History: only ballchasing (or nowhere) has it. */
  | "missing";

/** A match's replay, as both Sessions and Replays show it. */
export interface SessionReplay {
  state: ReplayState;
  replayId: string | null;
  /** A full playback was recorded, so opponents' car data and boost pickups are in. */
  played: boolean;
  /**
   * A match not recorded live whose only full playbacks ran faster than
   * normal speed, so it misses a few touches: watching it through at 1x fills them in.
   */
  playedFast?: boolean;
  /** For in-history: its place in Match History (1 = newest, 20 = next to drop) and days until it ages out. */
  history: { position: number; daysLeft: number; atRisk: boolean } | null;
  /** Ballchasing was asked and doesn't have it among my uploads. */
  notOnBallchasing: boolean;
}

export interface ReplayMatchItem extends SessionReplay {
  sessionId: string;
  startedAt: number;
  playlistId: number | null;
  playlistName: string | null;
  arena: string | null;
  outcome: Outcome | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
  mvp: boolean;
  /** Recorded live, or only known from playing its replay. */
  source: "live" | "replay";
}

export interface ReplaysResponse {
  matches: ReplayMatchItem[];
  counts: { matches: number; saved: number; played: number; inHistory: number; atRisk: number; missing: number };
  /** Saved replays not played through yet: of matches never recorded (new matches) and of recorded ones (extra data). */
  /** `seconds`: real time to play them, at the speed each plays (recorded ones at 2x). */
  toPlay: { unrecorded: number; recorded: number; seconds: number };
  backfill: {
    running: boolean;
    current: string | null;
    done: number;
    failed: number;
    remaining: number;
    remainingMs: number | null;
    /** Rocket League is closed once this run finishes on its own (see canQuitGame). */
    quitWhenDone: boolean;
  };
  ballchasing: {
    configured: boolean;
    running: boolean;
    done: number;
    total: number;
    found: number;
    /** Uploading saved replays: on (a key and the setting), how many wait, how many went up since the app started, and why it's waiting if it is. */
    upload: { enabled: boolean; pending: number; uploaded: number; waiting: string | null };
  };
  gameConnected: boolean;
  replayDirs: string[];
}

export type ReplayActionResponse = { ok: true; queued?: number } | { ok: false; reason: string };

/** A match's gameplay analysis from its saved replay (subtr-actor), or where it stands. */
export type ReplayAnalysisResponse =
  | { state: "ready"; replayId: string; analysis: ReplayAnalysis }
  /** The replay is saved and waits its turn (replays are analyzed one at a time, not while you play). */
  | { state: "pending"; replayId: string }
  | { state: "failed"; replayId: string; error: string }
  /** No saved replay to analyze. */
  | { state: "no-replay" };
