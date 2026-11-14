import { commands, type GameCommand, type GameMessage } from "@rl/schema";

/**
 * Plays saved replays one after another so the sessionizer can turn each
 * playback into match data (see replays.ts). Only runs when asked, and gets
 * out of the way the moment live play starts.
 *
 * What the game does, from the 2026-11-01 playbacks: LoadReplay (by file
 * name, the replay ID) answers with ReplayCreated carrying that FileName, or
 * nothing at all when it fails. Playback sends ticks with a Frame. At the end
 * the replay pauses itself (MatchPaused) and frames stop advancing.
 */

/**
 * Playback speed for a match never recorded live: the replay is its only
 * source, and 2x misses up to 7% of the game's BallHit events (2026-11-06).
 */
export const BACKFILL_SPEED = 1;
/**
 * For a match recorded live: its touches come from the live recording, and a
 * playback adds only other players' car data and boost pickups, which 2x
 * keeps whole.
 */
export const BACKFILL_RECORDED_SPEED = 2;
/**
 * LoadReplay fails silently, so a replay that hasn't started by then is
 * skipped. Generous: loading takes a few seconds, more from the main menu.
 */
export const BACKFILL_LOAD_TIMEOUT_MS = 45_000;
/** Frames not advancing this long while not paused: stuck, move on. */
export const BACKFILL_STALL_MS = 30_000;
/** Paused this long after the replay's last frame means it ended (it pauses itself there). */
export const BACKFILL_END_PAUSE_MS = 3_000;
/**
 * After a run that ends with the game closed: how long from its last replay's
 * end to the quit, so that playback is saved and the game has settled.
 */
export const BACKFILL_QUIT_DELAY_MS = 5_000;
/** Live ticks in that wait that call the quit off: about a second of live play. */
const LIVE_TICKS_TO_KEEP_GAME = 30;
/** Consecutive live (not replay) ticks that mean live play started: 3 s at 30 a second. */
const LIVE_TICKS_TO_STOP = 90;
/** A pause before play has properly started (around frame 160) is not the end. */
const MIN_END_FRAME = 200;

export type BackfillState =
  | { kind: "idle" }
  | { kind: "loading"; replayId: string; since: number }
  | { kind: "playing"; replayId: string; lastFrame: number; lastAdvanceAt: number; pausedAt: number | null };

export interface BackfillProgress {
  running: boolean;
  /** The replay playing now. */
  current: string | null;
  done: number;
  failed: number;
  remaining: number;
  /** Estimated time to finish the queue, from each replay's length; null when idle. */
  remainingMs: number | null;
  /** The game is closed once this run finishes on its own (BackfillEvents.quit). */
  quitWhenDone: boolean;
}

/** A replay to play, with its match length (seconds of play, from its header) when known. */
export interface BackfillItem {
  replayId: string;
  seconds?: number | null;
  /** Playback speed; BACKFILL_SPEED when not given. */
  speed?: number;
}

/** Loading, the kickoff countdowns and the end pause, per replay, on top of its play. */
const OVERHEAD_MS = 20_000;
/** For a replay with no length in its header: about a five-minute match, plus a bit. */
const DEFAULT_PLAY_SECONDS = 320;
const speedOf = (item: BackfillItem) => item.speed ?? BACKFILL_SPEED;
const estimateMs = (item: BackfillItem) => ((item.seconds ?? DEFAULT_PLAY_SECONDS) * 1000) / speedOf(item) + OVERHEAD_MS;

export interface BackfillEvents {
  send: (cmd: GameCommand) => boolean;
  log?: (line: string) => void;
  /** Progress changed (a replay started, finished or failed; the run started or stopped). */
  onProgress?: (p: BackfillProgress) => void;
  /**
   * The run's last replay played to its end. It stays open in the game on its
   * final frame (no next LoadReplay closes it), so its playback must be ended
   * here or it isn't saved and still counts as unplayed (2026-11-13: "Play all 1").
   */
  onLastPlayed?: (replayId: string, at: number) => void;
  /**
   * Close the game: a run started (or switched) to quit when done ran out on
   * its own, BACKFILL_QUIT_DELAY_MS ago. Never after a stop (by hand, live
   * play starting, a Watch taking over, the game disconnecting), and called
   * off if live play or another replay starts in that wait.
   */
  quit?: () => void;
}

export class Backfill {
  private queue: BackfillItem[] = [];
  private currentItem: BackfillItem | null = null;
  private currentStartedAt = 0;
  /** Actual over estimated time, from replays finished in this run, to correct the rest. */
  private actualMs = 0;
  private estimatedMs = 0;
  private state: BackfillState = { kind: "idle" };
  private running = false;
  private done = 0;
  private failed = 0;
  private liveTicks = 0;
  private quitWhenDone = false;
  /** When to close the game after a finished run; null when not about to. */
  private quitAt: number | null = null;

  constructor(private readonly events: BackfillEvents) {}

  progress(at = Date.now()): BackfillProgress {
    let remainingMs: number | null = null;
    if (this.running) {
      const scale = this.estimatedMs > 0 ? this.actualMs / this.estimatedMs : 1;
      const current = this.currentItem ? Math.max(0, estimateMs(this.currentItem) * scale - (at - this.currentStartedAt)) : 0;
      remainingMs = Math.round(current + this.queue.reduce((n, item) => n + estimateMs(item) * scale, 0));
    }
    return {
      running: this.running,
      current: this.state.kind === "idle" ? null : this.state.replayId,
      done: this.done,
      failed: this.failed,
      remaining: this.queue.length,
      remainingMs,
      quitWhenDone: this.quitWhenDone,
    };
  }

  /** Start playing these replays in order. Replaces any queue already running. */
  start(items: readonly (string | BackfillItem)[], at: number, options: { quitWhenDone?: boolean } = {}): void {
    this.queue = items.map((i) => (typeof i === "string" ? { replayId: i } : i));
    this.quitWhenDone = options.quitWhenDone ?? false;
    this.quitAt = null;
    this.actualMs = 0;
    this.estimatedMs = 0;
    this.done = 0;
    this.failed = 0;
    this.running = true;
    this.events.log?.(`backfill: ${this.queue.length} replays`);
    this.next(at);
  }

  /** While running: whether the game is closed when the run finishes on its own. */
  setQuitWhenDone(on: boolean): void {
    if (!this.running || on === this.quitWhenDone) return;
    this.quitWhenDone = on;
    this.emit();
  }

  /** Stop after the current replay is left as it is. Calls off a quit, pending or to come. */
  stop(reason: string): void {
    this.quitAt = null;
    if (!this.running) return;
    this.quitWhenDone = false;
    this.running = false;
    this.queue = [];
    this.currentItem = null;
    this.state = { kind: "idle" };
    this.events.log?.(`backfill stopped: ${reason}`);
    this.emit();
  }

  /** Feed every message from the game, in order. */
  ingest(at: number, msg: GameMessage): void {
    if (this.quitAt !== null) {
      // Waiting to close the game: the player doing something else calls it off.
      if (msg.Event === "ReplayCreated" || msg.Event === "MatchCreated") this.quitAt = null;
      else if (msg.Event === "UpdateState") {
        this.liveTicks = msg.Data.Game.bReplay ? 0 : this.liveTicks + 1;
        if (this.liveTicks >= LIVE_TICKS_TO_KEEP_GAME) this.quitAt = null;
      }
    }
    if (!this.running) return;
    const s = this.state;
    switch (msg.Event) {
      case "ReplayCreated":
        if (s.kind === "loading" && msg.Data.FileName === s.replayId) {
          this.state = { kind: "playing", replayId: s.replayId, lastFrame: -1, lastAdvanceAt: at, pausedAt: null };
          this.events.send(commands.speed(this.currentItem ? speedOf(this.currentItem) : BACKFILL_SPEED));
          this.emit();
        }
        return;
      case "UpdateState": {
        const g = msg.Data.Game;
        // Live play means the player is back: get out of the way. A replay can
        // send the odd tick with bReplay false (two in the 2026-11-01 playback),
        // so it takes a few seconds of them.
        if (!g.bReplay) {
          this.liveTicks++;
          if (this.liveTicks >= LIVE_TICKS_TO_STOP) this.stop("live play started");
          return;
        }
        this.liveTicks = 0;
        if (s.kind !== "playing" || g.Frame === undefined) return;
        // Seeks can move frames while paused, so only MatchUnpaused clears a pause.
        if (g.Frame > s.lastFrame) {
          s.lastFrame = g.Frame;
          s.lastAdvanceAt = at;
        }
        return;
      }
      case "MatchPaused":
        if (s.kind === "playing") s.pausedAt = at;
        return;
      case "MatchUnpaused":
        if (s.kind === "playing") {
          s.pausedAt = null;
          s.lastAdvanceAt = at;
        }
        return;
    }
  }

  /** Call regularly (once a second is plenty): handles timeouts and the end of a replay. */
  tick(at: number): void {
    if (this.quitAt !== null && at >= this.quitAt && !this.running) {
      this.quitAt = null;
      this.events.log?.("backfill: closing the game");
      this.events.quit?.();
    }
    if (!this.running) return;
    const s = this.state;
    if (s.kind === "loading" && at - s.since > BACKFILL_LOAD_TIMEOUT_MS) {
      this.failed++;
      this.events.log?.(`backfill: ${s.replayId} didn't load, skipped`);
      return this.next(at);
    }
    if (s.kind !== "playing") return;
    const ended = s.pausedAt !== null && s.lastFrame >= MIN_END_FRAME && at - s.pausedAt >= BACKFILL_END_PAUSE_MS;
    if (ended) {
      this.done++;
      if (this.currentItem) {
        this.actualMs += at - this.currentStartedAt;
        this.estimatedMs += estimateMs(this.currentItem);
      }
      this.events.log?.(`backfill: ${s.replayId} played`);
      if (this.queue.length === 0) this.events.onLastPlayed?.(s.replayId, at);
      return this.next(at);
    }
    // Paused by hand (not at the end) waits; frames that stop without a pause are stuck.
    if (s.pausedAt === null && at - s.lastAdvanceAt > BACKFILL_STALL_MS) {
      this.failed++;
      this.events.log?.(`backfill: ${s.replayId} stopped advancing, skipped`);
      return this.next(at);
    }
  }

  private next(at: number) {
    const item = this.queue.shift();
    this.currentItem = item ?? null;
    this.currentStartedAt = at;
    const id = item?.replayId;
    if (!id) {
      this.running = false;
      this.state = { kind: "idle" };
      this.events.log?.(`backfill finished: ${this.done} played, ${this.failed} skipped`);
      if (this.quitWhenDone) this.quitAt = at + BACKFILL_QUIT_DELAY_MS;
      this.quitWhenDone = false;
      return this.emit();
    }
    if (!this.events.send(commands.load(id))) return this.stop("game not connected");
    this.state = { kind: "loading", replayId: id, since: at };
    this.emit();
  }

  private emit() {
    this.events.onProgress?.(this.progress(this.currentStartedAt || Date.now()));
  }
}
