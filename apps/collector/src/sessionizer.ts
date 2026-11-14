import { isCasual, playlistMode, REGULATION_SECONDS, type GameMessage, type MessageOf, type PlayerRef, type TickPlayer } from "@rl/schema";
import type {
  BoostPickup,
  CarSummary,
  CollectorConfig,
  Goal,
  ReplayPlayback,
  Session,
  SessionKind,
  SessionPlayer,
  TrainingAttempt,
  Vec3,
} from "@rl/domain";

/**
 * Turns the raw message stream into sessions: online matches, freeplay,
 * training packs and saved replays. Every rule here comes from the
 * 2026-10-21..23 spike recordings; the tests replay those recordings and
 * check the results against known scorelines.
 *
 * Pure and synchronous: feed messages in order, receive finished sessions.
 */

/** Same-player BallHit events closer than this are one contact. */
export const TOUCH_COLLAPSE_MS = 100;
/** CrossbarHit fires every frame while the ball or puck rests on the bar. */
export const CROSSBAR_COLLAPSE_MS = 500;
/** A seek reloads the replay: MatchDestroyed then MatchCreated within ~0.5 s. */
const REPLAY_RELOAD_WINDOW_MS = 2000;
/** Freeplay ending this close to an online match starting was freeplay while queuing. */
const QUEUE_WARMUP_WINDOW_MS = 15_000;
/** Freeplay rounds shorter than this give unreliable game-speed samples. */
const MIN_SPEED_SAMPLE_SECONDS = 15;
/** Practice game speed only goes down from 100%; allow for whole-second rounding. */
const MAX_GAME_SPEED = 1.02;
/** PlayerLeft events this close to MatchDestroyed are the session tearing down, not players leaving. */
const TEARDOWN_WINDOW_MS = 250;
/**
 * Saved replays: a forward jump of more than this many frames skipped play.
 * Replays run at about 22 frames per game second and playback advances one
 * to six frames per tick (1x to 8x).
 */
const REPLAY_GAP_FRAMES = 66;
/** The first kickoff is around frame 160; starting later than this missed play. */
export const REPLAY_START_MAX_FRAME = 200;
/**
 * A replay of a forfeited match ends a few seconds after the last goal (about
 * 70 frames on 2026-11-01). Pausing and leaving this soon after a goal looks
 * the same, so this stays tight.
 */
const REPLAY_FORFEIT_END_FRAMES = 150;
/** Playback pauses itself at a replay's end: within a frame of the last one on 2026-11-01. */
const REPLAY_END_PAUSE_FRAMES = 10;

const vec = (v: { X: number; Y: number; Z: number }): Vec3 => ({ x: v.X, y: v.Y, z: v.Z });
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
/** Game speed settings come in 5% steps. */
const snapSpeed = (x: number) => Math.round(x * 20) / 20;
/** Ticks come about 30 a second; a longer gap isn't play. */
const PLAY_TICK_MAX_MS = 1_000;
/** Real seconds of fresh play needed to give a playback's speed. */
const MIN_SPEED_SECONDS = 10;

interface PendingTrainingGoal {
  at: number;
  scoresBefore: [number, number];
  speed: number;
  location: Vec3;
}

interface OpenAttempt {
  seq: number;
  startedAt: number;
  timeLimit: number | null;
  touches: number;
  pendingGoal: PendingTrainingGoal | null;
}

interface CarAcc {
  samples: number;
  ground: number;
  wall: number;
  air: number;
  boosting: number;
  supersonic: number;
  speedSum: number;
}

class Builder {
  kind: SessionKind;
  playlistId: number | null = null;
  arena: string | null = null;
  matchGuid: string | null = null;
  sawTick = false;
  ended = false;
  podium = false;
  winnerTeam: number | null = null;
  overtime = false;
  /** Milliseconds spent at each lobby size (the larger team's player count). */
  lobbyMs = new Map<number, number>();
  lobbyLast: { at: number; size: number } | null = null;
  scores: [number, number] | null = null;
  clock: number | null = null;
  clockOT = false;
  inLiveGoalReplay = false;
  roundActive = false;
  /** First kickoff. Players joining after it are drop-ins. */
  firstRoundAt: number | null = null;
  roundStartAt = 0;
  pausedInRoundMs = 0;
  paused = false;
  pauseStartedAt = 0;
  pausedMs = 0;
  players = new Map<string, SessionPlayer>();
  byShortcut = new Map<number, string>();
  byName = new Map<string, string>();
  pendingJoins = new Map<string, number>();
  leftAt = new Map<string, number>();
  goals: Goal[] = [];
  awaitingPhantom: Goal | null = null;
  touches: Session["touches"] = [];
  lastTouchAt = new Map<string, number>();
  crossbarHits: Session["crossbarHits"] = [];
  lastCrossbarAt = -Infinity;
  statEvents: Session["statEvents"] = [];
  attempts: TrainingAttempt[] = [];
  attempt: OpenAttempt | null = null;
  clockStepsMs: number[] = [];
  lastClockEvent: { at: number; value: number } | null = null;
  freeplaySpeedSamples: number[] = [];
  lastFreeplayGoal: { at: number; goalTime: number; pausedMs: number } | null = null;
  freeplayGameSeconds = 0;
  freeplayRealSeconds = 0;
  car = new Map<string, CarAcc>();
  replayFrames = new Map<number, number>();
  destroyedAt: number | null = null;
  forfeit = false;
  /** The clock jumped to 0:00 from more than a second out: a forfeit, about to be confirmed by MatchEnded. */
  clockJumpedToZero = false;
  boostPickups: BoostPickup[] = [];
  /** Saved replays: frame ranges watched so far, merged and sorted. */
  watched: [number, number][] = [];
  /** The previous tick's frame, to tell playing on from seeking. */
  prevFrame: number | null = null;
  /** This tick shows play not watched before; events are recorded only then. */
  fresh = false;
  /** The furthest frame watched, and the clock and score there. */
  maxFrame: number | null = null;
  maxFrameClock: number | null = null;
  maxFrameOT = false;
  /** The furthest frame at which playback paused. A replay pauses itself at its last frame. */
  maxPauseFrame: number | null = null;
  lastGoalFrame: number | null = null;
  /** Saved replays: replay game time (Elapsed). Event times count from the first value seen. */
  elapsedRef: number | null = null;
  minElapsed = Infinity;
  maxElapsed = -Infinity;
  lastElapsed = 0;
  lastTickAt = 0;
  /** Game seconds per real second between the last two ticks (the playback speed). */
  rate = 1;
  /** Fresh play watched, in game and real seconds, for the playback's speed. */
  playGameSeconds = 0;
  playRealSeconds = 0;

  constructor(
    readonly startedAt: number,
    kind: SessionKind,
    readonly replayId: string | null = null,
    readonly replayDate: string | null = null,
  ) {
    this.kind = kind;
  }

  matchTime(): number | null {
    if (this.clock === null) return null;
    if (this.kind === "match" || this.kind === "replay") {
      return this.clockOT ? REGULATION_SECONDS + this.clock : REGULATION_SECONDS - this.clock;
    }
    return this.kind === "freeplay" ? this.clock : null;
  }

  /**
   * Event time. Saved replays use game time from the replay (so playback
   * speed and pauses don't matter), counted from the session start.
   */
  eventAt(at: number): number {
    if (this.kind !== "replay" || this.elapsedRef === null) return at;
    const sinceTick = Math.min(Math.max(at - this.lastTickAt, 0), 250) * this.rate;
    return this.startedAt + Math.round((this.lastElapsed - this.elapsedRef) * 1000 + sinceTick);
  }

  keyFor(ref: PlayerRef | undefined): string | null {
    if (!ref || !ref.Name) return null;
    return this.byShortcut.get(ref.Shortcut) ?? this.byName.get(ref.Name) ?? `name:${ref.Name}`;
  }
}

export const playerKey = (primaryId: string, name: string) =>
  primaryId.startsWith("Unknown|") ? `bot:${name}` : primaryId;

export class Sessionizer {
  private current: Builder | null = null;
  /** Replay sessions survive seeks, which destroy and recreate the match. */
  private replayDestroyedAt: number | null = null;
  private awaitingReplayConfirm = false;
  private deferred: { session: Session; endedAt: number } | null = null;
  private lastAt = 0;
  private me: Set<string>;
  private teammates: Set<string>;
  private recordCasual: boolean;

  constructor(
    config: CollectorConfig,
    private readonly emit: (session: Session) => void,
    /** A match left out by the settings (casual), so its replay isn't played for nothing. */
    private readonly skipped: (session: Session) => void = () => {},
  ) {
    this.me = new Set(config.myPrimaryIds);
    this.teammates = new Set(config.knownTeammates.map((t) => t.primaryId));
    this.recordCasual = config.recordCasual ?? false;
  }

  /** The recordCasual setting changed: applies to matches that end from now on. */
  setRecordCasual(on: boolean): void {
    this.recordCasual = on;
  }

  /** My PrimaryIds changed (found from the camera on a new install): applies from the session in progress on. */
  setMe(ids: readonly string[]): void {
    this.me = new Set(ids);
    for (const p of this.current?.players.values() ?? []) p.isMe = this.me.has(p.primaryId);
  }

  /** Known teammates changed in the settings: applies from the session in progress on. */
  setTeammates(ids: readonly string[]): void {
    this.teammates = new Set(ids);
    for (const p of this.current?.players.values() ?? []) p.isKnownTeammate = this.teammates.has(p.primaryId);
  }

  /** The session in progress, for live views. */
  get active(): { kind: SessionKind; startedAt: number; playlistId: number | null } | null {
    const b = this.current;
    return b ? { kind: b.kind, startedAt: b.startedAt, playlistId: b.playlistId } : null;
  }

  ingest(at: number, msg: GameMessage): void {
    this.lastAt = at;
    this.expireTimers(at, msg);
    const b = this.current;

    switch (msg.Event) {
      case "ReplayCreated":
        if (b) this.close(b, b.destroyedAt ?? at);
        this.current = new Builder(at, "replay", msg.Data.FileName, msg.Data.Date);
        this.replayDestroyedAt = null;
        return;

      case "MatchCreated":
        if (b?.kind === "replay" && b.destroyedAt !== null && at - b.destroyedAt <= REPLAY_RELOAD_WINDOW_MS) {
          // A seek: same replay continues. Confirmed (or split) on the next tick.
          b.destroyedAt = null;
          this.replayDestroyedAt = null;
          this.awaitingReplayConfirm = true;
          return;
        }
        if (b?.kind === "replay" && b.destroyedAt === null) return; // first MatchCreated after ReplayCreated
        if (b) this.close(b, at);
        this.current = new Builder(at, "match");
        return;

      case "MatchDestroyed":
        if (!b) return;
        if (b.kind === "replay") {
          b.destroyedAt = at;
          this.replayDestroyedAt = at;
          return;
        }
        b.destroyedAt = at;
        this.close(b, at);
        return;
    }

    if (!b) return;

    switch (msg.Event) {
      case "UpdateState":
        return this.onTick(b, at, msg);
      case "ClockUpdatedSeconds":
        return this.onClock(b, at, msg.Data.TimeSeconds, msg.Data.bOvertime);
      case "CountdownBegin":
        this.finishAttempt(b, at);
        b.roundActive = false;
        return;
      case "RoundStarted":
        this.finishAttempt(b, at);
        b.roundActive = true;
        b.firstRoundAt ??= at;
        b.roundStartAt = at;
        b.pausedInRoundMs = 0;
        if (b.kind === "training") {
          b.attempt = {
            seq: b.attempts.length + 1,
            startedAt: at,
            timeLimit: b.clock,
            touches: 0,
            pendingGoal: null,
          };
        }
        return;
      case "GoalScored":
        return this.onGoal(b, at, msg);
      case "BallHit":
        return this.onBallHit(b, at, msg);
      case "CrossbarHit": {
        if (b.kind === "replay" ? !b.fresh : b.inLiveGoalReplay || b.ended) return;
        const t = b.eventAt(at);
        if (t - b.lastCrossbarAt < CROSSBAR_COLLAPSE_MS) {
          b.lastCrossbarAt = t;
          return;
        }
        b.lastCrossbarAt = t;
        b.crossbarHits.push({
          at: t,
          matchTime: b.matchTime(),
          location: vec(msg.Data.BallLocation),
          ballSpeed: msg.Data.BallSpeed,
          impactForce: msg.Data.ImpactForce,
          lastTouchKey: b.keyFor(msg.Data.BallLastTouch?.Player),
        });
        return;
      }
      case "StatfeedEvent":
        if (b.kind === "replay") return;
        b.statEvents.push({
          at,
          matchTime: b.matchTime(),
          eventName: msg.Data.EventName,
          label: msg.Data.Type,
          mainKey: b.keyFor(msg.Data.MainTarget),
          secondaryKey: b.keyFor(msg.Data.SecondaryTarget),
        });
        return;
      case "PlayerJoined": {
        if (b.kind === "replay" || b.ended) return;
        const key = playerKey(msg.Data.PrimaryId, msg.Data.PlayerName);
        // Players present at the start join before the first kickoff; later joins are drop-ins.
        if (b.firstRoundAt !== null) {
          const p = b.players.get(key);
          if (p) p.joinedAt ??= at;
          else b.pendingJoins.set(key, at);
        }
        b.leftAt.delete(key);
        return;
      }
      case "PlayerLeft":
        if (b.kind === "replay" || b.ended) return;
        b.leftAt.set(playerKey(msg.Data.PrimaryId, msg.Data.PlayerName), at);
        return;
      case "MatchEnded":
        b.ended = true;
        b.winnerTeam = msg.Data.WinnerTeamNum;
        // A forfeit ends the match with time left: the clock jumps to 0:00 just before MatchEnded.
        b.forfeit = b.kind === "match" && !b.clockOT && (b.clockJumpedToZero || (b.clock ?? 0) > 1);
        return;
      case "PodiumStart":
        b.podium = true;
        return;
      case "MatchPaused":
        if (b.kind === "replay" && b.prevFrame !== null) b.maxPauseFrame = Math.max(b.maxPauseFrame ?? 0, b.prevFrame);
        if (!b.paused) {
          b.paused = true;
          b.pauseStartedAt = at;
        }
        return;
      case "MatchUnpaused":
        if (b.paused) {
          b.paused = false;
          b.pausedMs += at - b.pauseStartedAt;
          if (b.roundActive) b.pausedInRoundMs += at - b.pauseStartedAt;
        }
        return;
      case "GoalReplayStart":
      case "GoalReplayEnd":
      case "GoalReplayWillEnd":
      case "MatchInitialized":
        return;
      case "BoostPickup":
        // Only saved replays send these.
        if (b.kind !== "replay" || !b.fresh) return;
        b.boostPickups.push({
          at: b.eventAt(at),
          matchTime: b.matchTime(),
          playerKey: b.keyFor(msg.Data.Player),
          boostType: msg.Data.BoostType,
          location: vec(msg.Data.Location),
        });
        return;
    }
  }

  /**
   * The game closed (or the connection dropped). Whatever was open ends at the
   * game's last message: a match still in progress counts as left early, and
   * nothing carries over into the next launch.
   */
  disconnect(): void {
    const b = this.current;
    if (b) this.close(b, b.destroyedAt ?? this.lastAt);
    this.current = null;
    this.awaitingReplayConfirm = false;
    this.replayDestroyedAt = null;
    this.releaseDeferred();
  }

  /**
   * The replay being watched is over but still open in the game (the last of a
   * batch stays on its final frame): end its session now instead of when it's
   * left. Its frames decide whether the playback is complete, as always.
   */
  endReplay(at: number): void {
    const b = this.current;
    if (b?.kind === "replay") this.close(b, at);
  }

  /** Call at the end of a recording or on shutdown. */
  flush(): void {
    if (this.current) this.close(this.current, this.current.destroyedAt ?? this.lastAt, true);
    this.current = null;
    this.releaseDeferred();
  }

  // --- internals -----------------------------------------------------------

  private expireTimers(at: number, msg: GameMessage) {
    const b = this.current;
    if (b?.kind === "replay" && this.replayDestroyedAt !== null && msg.Event !== "MatchCreated") {
      if (at - this.replayDestroyedAt > REPLAY_RELOAD_WINDOW_MS) {
        this.close(b, this.replayDestroyedAt);
      }
    }
    if (this.deferred && at - this.deferred.endedAt > QUEUE_WARMUP_WINDOW_MS) this.releaseDeferred();
  }

  private releaseDeferred() {
    if (this.deferred) this.emit(this.deferred.session);
    this.deferred = null;
  }

  private onTick(b: Builder, at: number, msg: MessageOf<"UpdateState">): void {
    const { Game: g, Players: players, MatchGuid: guid } = msg.Data;

    if (this.awaitingReplayConfirm && b.kind === "replay") {
      this.awaitingReplayConfirm = false;
      if (!g.bReplay) {
        // Not a seek after all: the replay was left and a new match began.
        this.close(b, at);
        const nb = new Builder(at, "match");
        this.current = nb;
        return this.onTick(nb, at, msg);
      }
    }

    if (!b.sawTick) {
      b.sawTick = true;
      b.playlistId = g.PlaylistId;
      b.arena = g.Arena;
      if (b.kind !== "replay") b.kind = playlistMode(g.PlaylistId);
      if (this.deferred) {
        if (b.kind === "match" && b.startedAt - this.deferred.endedAt <= QUEUE_WARMUP_WINDOW_MS) {
          this.deferred.session.queueWarmup = true;
        }
        this.releaseDeferred();
      }
    }
    b.clock = g.TimeSeconds;
    b.clockOT = g.bOvertime;
    b.inLiveGoalReplay = b.kind !== "replay" && g.bReplay;

    if (b.kind === "replay") {
      if (guid) b.matchGuid ??= guid;
      const mt = b.matchTime();
      if (g.Frame !== undefined && mt !== null) {
        const prev = b.replayFrames.get(mt);
        if (prev === undefined || g.Frame < prev) b.replayFrames.set(mt, g.Frame);
      }
      return this.onReplayTick(b, at, msg);
    }

    // After MatchEnded the game moves on: casual lobbies show the next match's
    // GUID during the podium, and Snow Day resets scores to 0-0.
    if (b.ended || b.podium) return;

    if (guid) b.matchGuid ??= guid;
    if (g.bOvertime) b.overtime = true;
    b.scores = [g.Teams.find((t) => t.TeamNum === 0)?.Score ?? 0, g.Teams.find((t) => t.TeamNum === 1)?.Score ?? 0];

    for (const p of players) this.upsertPlayer(b, at, p);
    if (b.kind === "match") this.trackLobby(b, at, players);

    if (b.kind === "training" && b.attempt?.pendingGoal) {
      const before = b.attempt.pendingGoal.scoresBefore;
      if (b.scores[0] !== before[0] || b.scores[1] !== before[1]) this.finishAttempt(b, at);
    }

    const live = b.roundActive && !b.paused && !g.bReplay;
    if (live) for (const p of players) this.sampleCar(b, p);
  }

  /**
   * Saved replays carry the whole match: every player's stats and car, the
   * ball and the events. Seeks show frames again (and a seek to the start
   * goes back to frame 1), so the frames watched are tracked as ranges and
   * only unwatched play is recorded. Final score and stats come from the
   * furthest frame watched.
   */
  private onReplayTick(b: Builder, at: number, msg: MessageOf<"UpdateState">) {
    const { Game: g, Players: players } = msg.Data;
    const frame = g.Frame;
    b.fresh = false;
    if (frame === undefined) return;
    const prev = b.prevFrame;
    b.prevFrame = frame;
    const playingOn = prev !== null && frame > prev && frame - prev <= REPLAY_GAP_FRAMES;
    b.fresh = !b.watched.some(([lo, hi]) => frame >= lo && frame <= hi);
    addRange(b.watched, playingOn ? [prev!, frame] : [frame, frame]);

    if (g.Elapsed !== undefined) {
      b.elapsedRef ??= g.Elapsed;
      if (playingOn && at > b.lastTickAt && g.Elapsed >= b.lastElapsed) {
        b.rate = Math.min((g.Elapsed - b.lastElapsed) / ((at - b.lastTickAt) / 1000), 16);
        // A long gap between ticks is a stall or a pause the game didn't announce, not play.
        if (b.fresh && at - b.lastTickAt <= PLAY_TICK_MAX_MS) {
          b.playGameSeconds += g.Elapsed - b.lastElapsed;
          b.playRealSeconds += (at - b.lastTickAt) / 1000;
        }
      }
      b.lastElapsed = g.Elapsed;
      b.lastTickAt = at;
      if (b.fresh) {
        b.minElapsed = Math.min(b.minElapsed, g.Elapsed);
        b.maxElapsed = Math.max(b.maxElapsed, g.Elapsed);
      }
    }
    if (!b.fresh) return;

    const t = b.eventAt(at);
    if (b.maxFrame === null || frame >= b.maxFrame) {
      b.maxFrame = frame;
      b.maxFrameClock = g.TimeSeconds;
      b.maxFrameOT = g.bOvertime;
      b.scores = [g.Teams.find((x) => x.TeamNum === 0)?.Score ?? 0, g.Teams.find((x) => x.TeamNum === 1)?.Score ?? 0];
      for (const p of players) this.upsertPlayer(b, t, p);
    } else {
      for (const p of players) if (!b.players.has(playerKey(p.PrimaryId, p.Name))) this.upsertPlayer(b, t, p);
    }
    if (g.bOvertime) b.overtime = true;
    this.trackLobby(b, at, players);
    if (b.roundActive && !b.paused) for (const p of players) this.sampleCar(b, p);
  }

  /**
   * Team size is the lobby size held longest. The most seen at once overcounts:
   * in casual lobbies a bot can stay for several seconds after the player
   * replacing it joins (a 3v3 Spooky Cube lobby showed 4v4 for 10 seconds).
   */
  private trackLobby(b: Builder, at: number, players: TickPlayer[]) {
    const size = Math.max(...[0, 1].map((team) => players.filter((p) => p.TeamNum === team).length));
    const last = b.lobbyLast;
    if (last && last.size > 0) b.lobbyMs.set(last.size, (b.lobbyMs.get(last.size) ?? 0) + (at - last.at));
    b.lobbyLast = { at, size };
  }

  private upsertPlayer(b: Builder, at: number, p: TickPlayer) {
    const key = playerKey(p.PrimaryId, p.Name);
    let sp = b.players.get(key);
    if (!sp) {
      sp = {
        key,
        primaryId: p.PrimaryId,
        name: p.Name,
        isBot: p.PrimaryId.startsWith("Unknown|"),
        isMe: this.me.has(p.PrimaryId),
        isKnownTeammate: this.teammates.has(p.PrimaryId),
        team: p.TeamNum,
        firstSeenAt: at,
        lastSeenAt: at,
        joinedAt: b.pendingJoins.get(key) ?? null,
        leftAt: null,
        stats: { score: 0, goals: 0, shots: 0, assists: 0, saves: 0, touches: 0, demos: 0 },
      };
      b.players.set(key, sp);
    }
    sp.name = p.Name;
    sp.team = p.TeamNum;
    sp.lastSeenAt = at;
    sp.stats = {
      score: p.Score,
      goals: p.Goals,
      shots: p.Shots,
      assists: p.Assists,
      saves: p.Saves,
      touches: p.Touches,
      demos: p.Demos,
    };
    b.byShortcut.set(p.Shortcut, key);
    b.byName.set(p.Name, key);
  }

  private sampleCar(b: Builder, p: TickPlayer) {
    if (p.Speed === undefined || !p.bHasCar || p.bDemolished) return;
    const key = playerKey(p.PrimaryId, p.Name);
    let acc = b.car.get(key);
    if (!acc) {
      acc = { samples: 0, ground: 0, wall: 0, air: 0, boosting: 0, supersonic: 0, speedSum: 0 };
      b.car.set(key, acc);
    }
    acc.samples++;
    // bOnWall arrives with bOnGround: true, so check the wall first.
    if (p.bOnWall) acc.wall++;
    else if (p.bOnGround) acc.ground++;
    else acc.air++;
    if (p.bBoosting) acc.boosting++;
    if (p.bSupersonic) acc.supersonic++;
    acc.speedSum += p.Speed;
  }

  private onClock(b: Builder, at: number, value: number, ot: boolean) {
    if (b.kind === "match" && !ot && value === 0 && (b.clock ?? 0) > 1) b.clockJumpedToZero = true;
    b.clock = value;
    b.clockOT = ot;
    const prev = b.lastClockEvent;
    // A step only counts when both ticks fall inside the round: the clock is
    // set at CountdownBegin, so the first step otherwise includes the countdown.
    if (b.kind === "training" && prev && prev.at >= b.roundStartAt && Math.abs(value - prev.value) === 1 && !b.paused && b.roundActive) {
      b.clockStepsMs.push(at - prev.at);
    }
    b.lastClockEvent = { at, value };
  }

  private onGoal(b: Builder, at: number, msg: MessageOf<"GoalScored">) {
    const d = msg.Data;
    const wasRoundActive = b.roundActive;
    b.roundActive = false;
    if (b.kind === "replay") {
      // One GoalScored per goal, with the correct location.
      if (!b.fresh || !d.Scorer.Name) return;
      b.lastGoalFrame = Math.max(b.lastGoalFrame ?? 0, b.prevFrame ?? 0);
      b.goals.push({
        at: b.eventAt(at),
        matchTime: b.matchTime(),
        team: d.Scorer.TeamNum,
        scorerKey: b.keyFor(d.Scorer),
        assisterKey: b.keyFor(d.Assister),
        lastTouchKey: b.keyFor(d.BallLastTouch?.Player),
        speedKmh: d.GoalSpeed,
        goalTime: d.GoalTime,
        location: vec(d.ImpactLocation),
        locationSource: "playback",
      });
      return;
    }

    if (b.kind === "training") {
      if (b.attempt && !b.attempt.pendingGoal) {
        b.attempt.pendingGoal = {
          at,
          scoresBefore: b.scores ?? [0, 0],
          speed: d.GoalSpeed,
          location: vec(d.ImpactLocation),
        };
      }
      return;
    }

    if (!d.Scorer.Name) {
      // Online matches: the blank-scorer twin at the end of the goal replay.
      // Its location is the reliable one (checked on 120 of 120 goals).
      if (b.awaitingPhantom) {
        b.awaitingPhantom.location = vec(d.ImpactLocation);
        b.awaitingPhantom.locationSource = "replay-end";
        b.awaitingPhantom = null;
      }
      return;
    }

    const goal: Goal = {
      at,
      matchTime: b.matchTime(),
      team: d.Scorer.TeamNum,
      scorerKey: b.keyFor(d.Scorer),
      assisterKey: b.keyFor(d.Assister),
      lastTouchKey: b.keyFor(d.BallLastTouch?.Player),
      speedKmh: d.GoalSpeed,
      goalTime: d.GoalTime,
      location: vec(d.ImpactLocation),
      locationSource: "goal",
    };
    b.goals.push(goal);
    if (b.kind === "match") b.awaitingPhantom = goal;

    if (b.kind === "freeplay") this.sampleFreeplaySpeed(b, at, d.GoalTime, wasRoundActive);
  }

  /**
   * Freeplay's clock runs in real time, but GoalTime is game time, so their
   * ratio is the game speed. GoalTime usually counts from the start of the
   * session (2026-10-23 recording), but after some settings changes it counts
   * from the round instead (2026-10-21). Both are sampled; at the end, any
   * per-round ratio above 100% (impossible: the game only slows down) shows
   * GoalTime was cumulative, and the between-goals measure is used.
   */
  private sampleFreeplaySpeed(b: Builder, at: number, goalTime: number, wasRoundActive: boolean) {
    const prev = b.lastFreeplayGoal;
    b.lastFreeplayGoal = { at, goalTime, pausedMs: b.pausedMs };
    if (prev && goalTime > prev.goalTime) {
      const realSeconds = (at - prev.at - (b.pausedMs - prev.pausedMs)) / 1000;
      if (realSeconds >= MIN_SPEED_SAMPLE_SECONDS) {
        b.freeplayGameSeconds += goalTime - prev.goalTime;
        b.freeplayRealSeconds += realSeconds;
      }
    }
    if (wasRoundActive && goalTime > 0) {
      // GoalTime is whole seconds, so short rounds are too imprecise to use.
      const realSeconds = (at - b.roundStartAt - b.pausedInRoundMs) / 1000;
      if (realSeconds >= MIN_SPEED_SAMPLE_SECONDS) b.freeplaySpeedSamples.push(goalTime / realSeconds);
    }
  }

  private onBallHit(b: Builder, at: number, msg: MessageOf<"BallHit">) {
    if (b.kind === "replay" ? !b.fresh : b.inLiveGoalReplay || b.ended) return;
    const t = b.eventAt(at);
    const simultaneous = msg.Data.Players.length > 1;
    for (const ref of msg.Data.Players) {
      const key = b.keyFor(ref);
      if (!key) continue;
      const last = b.lastTouchAt.get(key) ?? -Infinity;
      b.lastTouchAt.set(key, t);
      if (t - last < TOUCH_COLLAPSE_MS) continue;
      b.touches.push({
        at: t,
        matchTime: b.matchTime(),
        playerKey: key,
        preSpeed: msg.Data.Ball.PreHitSpeed,
        postSpeed: msg.Data.Ball.PostHitSpeed,
        location: vec(msg.Data.Ball.Location),
        simultaneous,
      });
      if (b.attempt) b.attempt.touches++;
    }
  }

  private finishAttempt(b: Builder, at: number) {
    const a = b.attempt;
    if (!a) return;
    b.attempt = null;
    let outcome: TrainingAttempt["outcome"] = "reset";
    if (a.pendingGoal) {
      const before = a.pendingGoal.scoresBefore;
      const now = b.scores ?? before;
      const myTeam = [...b.players.values()].find((p) => p.isMe)?.team ?? 0;
      const mine = now[myTeam as 0 | 1] - before[myTeam as 0 | 1];
      const theirs = now[(1 - myTeam) as 0 | 1] - before[(1 - myTeam) as 0 | 1];
      outcome = mine > 0 ? "scored" : theirs > 0 ? "conceded" : "none";
    }
    b.attempts.push({
      seq: a.seq,
      startedAt: a.startedAt,
      endedAt: a.pendingGoal?.at ?? at,
      timeLimit: a.timeLimit,
      outcome,
      ballSpeed: a.pendingGoal?.speed ?? null,
      location: a.pendingGoal?.location ?? null,
      touches: a.touches,
    });
  }

  private close(b: Builder, endedAt: number, endOfInput = false) {
    if (this.current === b) this.current = null;
    if (b.kind === "replay") this.replayDestroyedAt = null;
    this.finishAttempt(b, endedAt);
    if (b.paused) b.pausedMs += endedAt - b.pauseStartedAt;

    // A session that never sent a tick is a menu blip.
    if (!b.sawTick) return;

    const teardown = b.destroyedAt ?? endedAt;
    for (const [key, t] of b.leftAt) {
      const p = b.players.get(key);
      if (p && teardown - t > TEARDOWN_WINDOW_MS) p.leftAt = t;
    }

    const players = [...b.players.values()];
    const me = players.find((p) => p.isMe);
    const myTeam = me?.team ?? null;
    let outcome: Session["outcome"] = null;
    if (b.kind === "match") {
      if (b.ended && b.winnerTeam !== null && myTeam !== null) outcome = b.winnerTeam === myTeam ? "win" : "loss";
      else if (!b.ended && !endOfInput) outcome = "abandoned";
    }
    const playback = b.kind === "replay" ? replayPlayback(b) : null;
    if (b.kind === "replay") {
      // Seeks can record later play before earlier play.
      for (const xs of [b.goals, b.touches, b.crossbarHits, b.boostPickups] as { at: number }[][]) xs.sort((x, y) => x.at - y.at);
    }
    let winnerTeam = b.winnerTeam;
    if (playback?.complete && b.scores) {
      // Replays send no MatchEnded: the final score decides.
      winnerTeam = b.scores[0] > b.scores[1] ? 0 : 1;
      if (myTeam !== null) outcome = winnerTeam === myTeam ? "win" : "loss";
    }

    let gameSpeed: number | null = null;
    if (b.kind === "training" && b.clockStepsMs.length >= 3) gameSpeed = snapSpeed(1000 / median(b.clockStepsMs));
    if (b.kind === "freeplay") {
      // A per-round ratio above 100% means GoalTime is counting from the session start.
      const cumulative = b.freeplaySpeedSamples.some((r) => r > MAX_GAME_SPEED);
      if (cumulative && b.freeplayRealSeconds > 0) gameSpeed = snapSpeed(b.freeplayGameSeconds / b.freeplayRealSeconds);
      else if (!cumulative && b.freeplaySpeedSamples.length) gameSpeed = snapSpeed(median(b.freeplaySpeedSamples));
    }
    if (gameSpeed !== null && gameSpeed > MAX_GAME_SPEED) gameSpeed = null;

    const carSummaries: CarSummary[] = [...b.car].map(([playerKey, a]) => ({
      playerKey,
      samples: a.samples,
      ground: a.ground / a.samples,
      wall: a.wall / a.samples,
      air: a.air / a.samples,
      boosting: a.boosting / a.samples,
      supersonic: a.supersonic / a.samples,
      avgSpeed: a.speedSum / a.samples,
    }));

    const session: Session = {
      id: `${b.kind}-${b.startedAt}`,
      kind: b.kind,
      startedAt: b.startedAt,
      endedAt,
      playlistId: b.playlistId,
      arena: b.arena,
      matchGuid: b.matchGuid,
      replayId: b.replayId,
      replayDate: b.replayDate,
      myTeam,
      winnerTeam,
      outcome,
      scoreBlue: b.scores?.[0] ?? null,
      scoreOrange: b.scores?.[1] ?? null,
      overtime: b.overtime,
      partied: myTeam !== null && players.some((p) => p.isKnownTeammate && !p.isMe && p.team === myTeam),
      queueWarmup: false,
      gameSpeed,
      teamSize: b.kind === "match" || b.kind === "replay" ? ([...b.lobbyMs].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null) : null,
      pausedSeconds: b.pausedMs / 1000,
      source: "live",
      forfeit: b.forfeit || playback?.endReason === "forfeit",
      playback,
      boostPickups: b.boostPickups,
      players,
      goals: b.goals,
      touches: b.touches,
      crossbarHits: b.crossbarHits,
      statEvents: b.statEvents,
      trainingAttempts: b.attempts,
      carSummaries,
      replayFrames: [...b.replayFrames]
        .map(([matchTime, frame]) => ({ frame, matchTime }))
        .sort((x, y) => x.matchTime - y.matchTime),
    };

    // A match nobody touched the ball in never got going (a lobby that fell apart
    // at kickoff, recorded as a 0–0 forfeit): not a match worth keeping.
    if (neverStarted(session)) return;
    // Casual matches only when the settings ask for them (the raw log keeps them either way).
    if (session.kind === "match" && !this.recordCasual && isCasual(session.playlistId)) return void this.skipped(session);

    if (b.kind === "freeplay" && !endOfInput) {
      this.releaseDeferred();
      this.deferred = { session, endedAt };
    } else {
      this.emit(session);
    }
  }
}

/** A match with no touches and no goals: it ended before anyone played (2026-11-02, a Rumble lobby). */
export function neverStarted(s: Pick<Session, "kind" | "touches" | "goals" | "players">): boolean {
  return s.kind === "match" && s.touches.length === 0 && s.goals.length === 0 && s.players.every((p) => p.stats.touches === 0);
}

/** Add a frame range to a sorted list of ranges, merging overlaps. */
function addRange(ranges: [number, number][], [lo, hi]: [number, number]) {
  ranges.push([lo, hi]);
  ranges.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < ranges.length; ) {
    const p = ranges[i - 1]!;
    const c = ranges[i]!;
    if (c[0] <= p[1]) {
      p[1] = Math.max(p[1], c[1]);
      ranges.splice(i, 1);
    } else i++;
  }
}

function replayPlayback(b: Builder): ReplayPlayback {
  // Ranges closer than a normal tick's advance are continuous play.
  const holes = b.watched.slice(1).filter(([lo], i) => lo - b.watched[i]![1] > REPLAY_GAP_FRAMES).length;
  let endReason: ReplayPlayback["endReason"] = null;
  const decided = b.scores !== null && b.scores[0] !== b.scores[1];
  if (decided && b.maxFrame !== null) {
    // Overtime ends on the first goal, so a decided score in overtime is the end.
    if (b.maxFrameOT) endReason = "overtime";
    // The last tick can show 0:01 (the clock rounds up): seen on 2026-11-06, replay-ends-at-clock-1.
    else if (b.maxFrameClock !== null && b.maxFrameClock <= 1) endReason = "regulation";
    // A forfeit's replay ends soon after the last goal, and playback pauses there.
    else if (
      b.maxPauseFrame !== null &&
      b.maxFrame - b.maxPauseFrame <= REPLAY_END_PAUSE_FRAMES &&
      b.lastGoalFrame !== null &&
      b.maxFrame - b.lastGoalFrame <= REPLAY_FORFEIT_END_FRAMES
    ) {
      endReason = "forfeit";
    }
  }
  const firstFrame = b.watched[0]?.[0] ?? null;
  const seen = b.elapsedRef !== null && b.maxElapsed >= b.minElapsed;
  return {
    complete: endReason !== null && holes === 0 && firstFrame !== null && firstFrame <= REPLAY_START_MAX_FRAME,
    endReason,
    gaps: holes,
    firstFrame,
    lastFrame: b.maxFrame,
    startOffsetMs: seen ? Math.round((b.minElapsed - b.elapsedRef!) * 1000) : 0,
    endOffsetMs: seen ? Math.round((b.maxElapsed - b.elapsedRef!) * 1000) : 0,
    speed: b.playRealSeconds >= MIN_SPEED_SECONDS ? snapSpeed(b.playGameSeconds / b.playRealSeconds) : null,
  };
}

/** Convenience: run a whole message list through a fresh sessionizer. */
export function sessionize(config: CollectorConfig, entries: Iterable<{ at: number; msg: GameMessage }>): Session[] {
  const out: Session[] = [];
  const s = new Sessionizer(config, (x) => out.push(x));
  for (const e of entries) s.ingest(e.at, e.msg);
  s.flush();
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
