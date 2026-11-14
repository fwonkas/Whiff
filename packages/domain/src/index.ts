/** The domain records the sessionizer produces and the database stores. */

export type SessionKind = "match" | "freeplay" | "training" | "replay";
export type Outcome = "win" | "loss" | "abandoned";

export interface PlayerStats {
  score: number;
  goals: number;
  shots: number;
  assists: number;
  saves: number;
  touches: number;
  demos: number;
}

export interface SessionPlayer {
  /** PrimaryId, or "bot:<name>" for bots, which all share "Unknown|0|0". */
  key: string;
  primaryId: string;
  name: string;
  isBot: boolean;
  isMe: boolean;
  isKnownTeammate: boolean;
  team: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Set when the player joined after the session started (casual drop-ins). */
  joinedAt: number | null;
  /** Set when the player left before the match ended. */
  leftAt: number | null;
  stats: PlayerStats;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Goal {
  at: number;
  matchTime: number | null;
  team: number;
  scorerKey: string | null;
  assisterKey: string | null;
  lastTouchKey: string | null;
  speedKmh: number;
  goalTime: number;
  location: Vec3;
  /**
   * "replay-end": the second GoalScored in live play (reliable). "goal": the
   * first one (often stale). "playback": a saved replay's only GoalScored (reliable).
   */
  locationSource: "replay-end" | "goal" | "playback";
}

export interface Touch {
  at: number;
  matchTime: number | null;
  playerKey: string;
  preSpeed: number;
  postSpeed: number;
  location: Vec3;
  /** More than one player touched the ball on the same frame. */
  simultaneous: boolean;
}

export interface CrossbarHit {
  at: number;
  matchTime: number | null;
  location: Vec3;
  ballSpeed: number;
  impactForce: number;
  lastTouchKey: string | null;
}

export interface StatEvent {
  at: number;
  matchTime: number | null;
  eventName: string;
  label: string;
  mainKey: string | null;
  secondaryKey: string | null;
}

export interface TrainingAttempt {
  seq: number;
  startedAt: number;
  endedAt: number;
  /** The shot's time limit in game seconds. */
  timeLimit: number | null;
  /** scored/conceded come from the team score change; reset = restarted or skipped before it ended. */
  outcome: "scored" | "conceded" | "none" | "reset";
  ballSpeed: number | null;
  location: Vec3 | null;
  touches: number;
}

export interface BoostPickup {
  at: number;
  matchTime: number | null;
  playerKey: string | null;
  /** "Big" or "Small" as the game names them. */
  boostType: string;
  location: Vec3;
}

/** How much of a saved replay was watched, for replay sessions. */
export interface ReplayPlayback {
  /** Watched from before the first kickoff to the end, with no forward skips. */
  complete: boolean;
  /** How the match ended, when the playback reached the end. */
  /** "end": reached the replay file's last frame (see completeAtReplayEnd), however the match ended. */
  endReason: "regulation" | "overtime" | "forfeit" | "end" | null;
  /** Forward skips past unwatched play. */
  gaps: number;
  firstFrame: number | null;
  lastFrame: number | null;
  /**
   * Replay game time of the earliest and furthest play watched, as offsets
   * from the session start in the time base that event `at` values use.
   */
  startOffsetMs: number;
  endOffsetMs: number;
  /**
   * Playback speed: replay game seconds per real second over the play watched
   * for the first time, pauses left out (1 normal, 2 double). Null when too
   * little was watched to tell, or missing on playbacks saved before it was
   * measured (2026-11-06).
   */
  speed?: number | null;
}

/** One run of the game, launch to quit, from the collector's connection to it. */
export interface GameConnection {
  connectedAt: number;
  /** Null when the log ends with the game still running (the collector stopped first). */
  disconnectedAt: number | null;
}

export interface CarSummary {
  playerKey: string;
  samples: number;
  ground: number;
  wall: number;
  air: number;
  boosting: number;
  supersonic: number;
  avgSpeed: number;
}

export interface Session {
  id: string;
  kind: SessionKind;
  startedAt: number;
  endedAt: number;
  playlistId: number | null;
  arena: string | null;
  matchGuid: string | null;
  replayId: string | null;
  replayDate: string | null;
  myTeam: number | null;
  winnerTeam: number | null;
  outcome: Outcome | null;
  scoreBlue: number | null;
  scoreOrange: number | null;
  overtime: boolean;
  /** A known teammate was on my team. */
  partied: boolean;
  /** Freeplay that ended seconds before an online match started. */
  queueWarmup: boolean;
  /** Measured game speed for practice (e.g. 0.85); null when unknown or not practice. */
  gameSpeed: number | null;
  /**
   * Most players on one team at once, held for a few seconds (so a bot
   * leaving just after its replacement joins doesn't count). Matches only.
   */
  teamSize: number | null;
  /** Seconds the session spent paused. */
  pausedSeconds: number;
  /** Matches: "live" when recorded as played, "replay" when rebuilt from a saved replay. */
  source: "live" | "replay";
  /** The match ended early because a team forfeited. */
  forfeit: boolean;
  /** Replay sessions only. */
  playback: ReplayPlayback | null;
  /** Saved replays only: the live game doesn't send BoostPickup. */
  boostPickups: BoostPickup[];
  players: SessionPlayer[];
  goals: Goal[];
  touches: Touch[];
  crossbarHits: CrossbarHit[];
  statEvents: StatEvent[];
  trainingAttempts: TrainingAttempt[];
  carSummaries: CarSummary[];
  /** Replay sessions: (frame, matchTime) pairs, one per match-clock second. */
  replayFrames: { frame: number; matchTime: number }[];
}

export interface CollectorConfig {
  myPrimaryIds: string[];
  knownTeammates: { primaryId: string; name?: string }[];
  /** My usual practice game speed (e.g. 0.85), for sessions where it can't be measured. */
  practiceGameSpeed?: number | null;
  /** Warn about an unsaved match this many matches before it drops out of Match History. Default 5. */
  matchHistoryWarn?: number;
  /** Seconds before a moment that a replay jump starts. Default 10. */
  replayLeadSeconds?: number;
  /** Keep casual matches (unranked matchmaking). Off by default: they're left out. */
  recordCasual?: boolean;
}
