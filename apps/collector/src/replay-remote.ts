import { commands, type GameCommand, type GameMessage } from "@rl/schema";

/**
 * Jump to a moment in a saved replay from the web app: load the replay if it
 * isn't the one open, then seek to a frame and play at normal speed, pausing
 * after the goal. again() goes back to the last jump's start.
 *
 * From the spike: SeekReplay's TimeSeconds lands on frame TimeSeconds × 30,
 * LoadReplay answers with ReplayCreated (or nothing when it fails), and a
 * replay needs a moment after loading before a seek takes.
 */

/** Wait after ReplayCreated before seeking. */
export const SEEK_AFTER_LOAD_MS = 2_000;
export const REMOTE_LOAD_TIMEOUT_MS = 45_000;
/** Replays run at about 22 frames per second of play (2026-11-01), for lead time before a moment. */
export const REPLAY_FRAMES_PER_SECOND = 22;
/** Seconds before a moment a jump starts, unless the settings say otherwise. */
export const DEFAULT_REPLAY_LEAD_SECONDS = 10;
/** Play starts at most this long after a jump even if bringing the game forward hasn't finished. */
export const PLAY_AFTER_FOCUS_TIMEOUT_MS = 4_000;
/** A beat after the game is in front, so the first moments aren't missed while the eye moves. */
export const PLAY_AFTER_FOCUS_MS = 300;
/**
 * After a jump to a goal, the replay pauses where it cuts from the goal to the
 * next kickoff. That cut sends GoalReplayStart and CountdownBegin together
 * about 3 s (66 frames) after GoalScored, or only CountdownBegin, about 86
 * frames after (2026-11-04). A seek also sends CountdownBegin, with ticks still
 * showing the frame from before it, so the stop only counts once a tick has
 * shown play between the jump's start and the goal. One this many frames
 * before the goal belongs to an earlier goal and is ignored.
 */
const STOP_FRAME_SLACK = 30;
/**
 * Pause this many frames after the goal, just before the cut (66 frames on),
 * when ticks show it: paused at the cut itself, the game has already handed
 * the camera to the free "Fly" camera (2026-11-04).
 */
const STOP_AFTER_GOAL_FRAMES = 58;
/** A seek has taken once the game sends MatchDestroyed; until then ticks show the frame from before it. Or after this long. */
const SEEK_TAKES_MS = 2_000;
/** Give up on pausing once play is this far past the goal (the replay was scrubbed on). */
const STOP_GIVE_UP_FRAMES = 15 * REPLAY_FRAMES_PER_SECOND;
/** Consecutive live (not replay) ticks that mean the replay was left. */
const LIVE_TICKS_LEFT = 90;
/** A seek recreates the match, usually within half a second (3.1 s seen); longer with no MatchCreated, the replay was left. */
const REPLAY_LEFT_MS = 5_000;

export type GotoResult = { ok: true; status: "seeking" | "loading" | "open" } | { ok: false; reason: string };

/**
 * The camera after a jump. A seek leaves the replay's free camera ("Fly"), so
 * the camera is set once the replay shows the new frame.
 * mine: my car, from my own view. director: the game's director camera.
 * keep: whatever the seek leaves.
 */
export type ReplayCamera = "mine" | "director" | "keep";
/**
 * Set the camera once a tick shows a frame near the target (the seek has
 * taken: a tick from before a backward seek would show a later frame), or
 * this long after the seek.
 */
const POV_FRAME_SLACK = 30;
const POV_FRAME_AHEAD = 150;
const POV_AFTER_MS = 3_000;
/**
 * Pointing the camera at my car doesn't always work. After a seek past a
 * player leaving (2s, 2026-11-15, a teammate gone at 2:41), ticks say I'm
 * shortcut 1 (I'd been 2) and Joe's own key press attaches to me as 1, yet
 * `ChangePOV` Focus 1 leaves Target empty, five times running (2026-11-21),
 * and Focus 2 too; Focus 0 found me. So the camera works through shortcuts
 * (see `aimAttempts`) until the game's Target has named me for POV_HOLD_MS,
 * giving each POV_CHECK_MS, logs which one worked or what each showed, and
 * falls back to the director camera rather than leaving it on nothing.
 */
const POV_CHECK_MS = 800;
const POV_HOLD_MS = 1_000;

export interface ReplayRemoteEvents {
  send: (cmd: GameCommand) => boolean;
  log?: (line: string) => void;
  /** Called before taking over the game, so a backfill run can stop. */
  beforeControl?: () => void;
  /** My PrimaryIds, to point the camera at my car. */
  me?: () => readonly string[];
  /**
   * Bring the game's window to the front after a jump. Resolves once it's in
   * front (or gave up), so play can wait for it.
   */
  focusGame?: () => Promise<unknown> | void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Jump {
  replayId: string;
  /** Where play starts (the lead time before the moment). */
  target: number;
  /** The moment itself: the goal's frame. */
  frame: number;
  camera: ReplayCamera;
}

export class ReplayRemote {
  /** The replay open in the game, if any. */
  private open: string | null = null;
  private pending: { replayId: string; frame: number; since: number; camera: ReplayCamera } | null = null;
  private pov: { camera: ReplayCamera; frame: number; since: number } | null = null;
  private timer: unknown = null;
  private liveTicks = 0;
  /** Bringing the game forward, started with a load and waited on after the seek. */
  private focused: Promise<unknown> | null = null;
  private seekCount = 0;
  /** The last jump, for again(). */
  private last: Jump | null = null;
  /** The goal to pause after, while armed. */
  private stopAfter: number | null = null;
  /** A tick has shown play between the jump's start and the goal, so the seek took. */
  private reached = false;
  private frame: number | undefined;
  /** When the last seek was sent, until MatchDestroyed says it took. */
  private seekSentAt: number | null = null;
  /** The time of the last message, for steps that run later on a timer. */
  private now = 0;
  /** A replay opened by watch(): set to normal speed once it opens ("Play all" may have left 2x). */
  private watching: string | null = null;
  /** Pointing the camera at my car until the game's Target has named me for a while. */
  private aim: { name: string; attempts: AimAttempt[]; tried: number; since: number; heldSince: number | null; seen: string[] } | null = null;
  /** The last MatchDestroyed not followed by a MatchCreated: a seek in progress, or the replay was left. */
  private destroyedAt: number | null = null;

  constructor(private readonly events: ReplayRemoteEvents) {}

  get openReplay(): string | null {
    return this.open;
  }

  /** Go to `frame` of the replay, `leadSeconds` early so the play leading up to it shows. */
  goto(replayId: string, frame: number, leadSeconds: number, at: number, camera: ReplayCamera = "mine"): GotoResult {
    const target = Math.max(0, Math.round(frame - leadSeconds * REPLAY_FRAMES_PER_SECOND));
    return this.jump({ replayId: replayId.toUpperCase(), target, frame, camera }, at);
  }

  /** Open a replay to watch from the start, without jumping anywhere. Already open: just bring the game forward. */
  watch(replayId: string, at: number = this.now): GotoResult {
    const id = replayId.toUpperCase();
    this.events.beforeControl?.();
    this.stopAfter = null;
    if (this.isOpen(id, at)) {
      void this.focus();
      return { ok: true, status: "open" };
    }
    if (!this.events.send(commands.load(id))) return { ok: false, reason: "Rocket League isn't connected" };
    this.pending = null;
    this.watching = id;
    void this.focus();
    this.events.log?.(`replay remote: opening ${id}`);
    return { ok: true, status: "loading" };
  }

  /** Back to where the last jump started, to watch the goal again. */
  again(at: number): GotoResult {
    if (!this.last) return { ok: false, reason: "there's no jump to go back to" };
    return this.jump(this.last, at);
  }

  private jump(j: Jump, at: number): GotoResult {
    const { replayId: id, target, camera } = j;
    this.events.beforeControl?.();
    this.last = j;
    if (this.isOpen(id, at)) {
      if (!this.seek(target, camera, at)) return { ok: false, reason: "Rocket League isn't connected" };
      this.arm(j);
      this.playWhenFocused(this.focus());
      return { ok: true, status: "seeking" };
    }
    if (!this.events.send(commands.load(id))) return { ok: false, reason: "Rocket League isn't connected" };
    this.arm(j);
    this.focused = this.focus();
    this.pending = { replayId: id, frame: target, since: at, camera };
    this.events.log?.(`replay remote: loading ${id}`);
    return { ok: true, status: "loading" };
  }

  /**
   * Leaving a replay for the menu sends MatchDestroyed and then nothing (no
   * ticks), so a match destroyed and not recreated soon after means it's closed.
   */
  private isOpen(id: string, at: number): boolean {
    if (this.open !== null && this.destroyedAt !== null && at - this.destroyedAt > REPLAY_LEFT_MS) this.open = null;
    return this.open === id;
  }

  ingest(at: number, msg: GameMessage): void {
    this.now = at;
    if (msg.Event === "MatchCreated" || msg.Event === "ReplayCreated") this.destroyedAt = null;
    switch (msg.Event) {
      case "ReplayCreated": {
        this.open = msg.Data.FileName.toUpperCase();
        this.liveTicks = 0;
        if (this.watching === this.open) this.events.send(commands.speed(1));
        this.watching = null;
        const p = this.pending;
        if (p && p.replayId === this.open) {
          this.pending = null;
          const focused = this.focused ?? Promise.resolve();
          this.focused = null;
          const run = () => {
            if (this.seek(p.frame, p.camera, this.now)) this.playWhenFocused(focused);
          };
          if (this.events.setTimer) this.timer = this.events.setTimer(run, SEEK_AFTER_LOAD_MS);
          else run();
        }
        return;
      }
      case "MatchDestroyed":
        // A seek rebuilds the match: ticks from here on show the new frame.
        this.seekSentAt = null;
        this.destroyedAt = at;
        return;
      case "GoalReplayStart":
      case "CountdownBegin":
        // The cut to the next kickoff after the goal that was jumped to, if ticks didn't catch it first.
        if (this.stopAfter !== null && this.reached && this.frame !== undefined && this.frame >= this.stopAfter - STOP_FRAME_SLACK) this.stop();
        return;
      case "UpdateState":
        if (msg.Data.Game.bReplay || msg.Data.Game.Frame !== undefined) this.destroyedAt = null;
        if (this.seekSentAt !== null && at - this.seekSentAt > SEEK_TAKES_MS) this.seekSentAt = null;
        if (msg.Data.Game.bReplay) {
          this.liveTicks = 0;
          this.frame = msg.Data.Game.Frame;
          const f = this.frame;
          if (this.stopAfter !== null && f !== undefined && this.seekSentAt === null) {
            if (!this.reached && this.last && f >= this.last.target - POV_FRAME_SLACK && f <= this.stopAfter) this.reached = true;
            else if (this.reached && f >= this.stopAfter + STOP_AFTER_GOAL_FRAMES && f <= this.stopAfter + STOP_GIVE_UP_FRAMES) this.stop();
            else if (this.reached && f > this.stopAfter + STOP_GIVE_UP_FRAMES) this.stopAfter = null;
          }
          this.maybeSetCamera(at, msg);
          this.checkAim(at, msg);
        } else if (msg.Data.Game.Frame === undefined && ++this.liveTicks >= LIVE_TICKS_LEFT) {
          // Live play (no replay frame). A replay paused at the cut to a
          // kickoff sends bReplay false too, but with its frame: still open.
          this.open = null;
        }
        if (this.pending && at - this.pending.since > REMOTE_LOAD_TIMEOUT_MS) {
          this.events.log?.(`replay remote: ${this.pending.replayId} didn't load`);
          this.pending = null;
        }
        return;
    }
  }

  /** The game closed. */
  reset(): void {
    this.open = null;
    this.destroyedAt = null;
    this.pending = null;
    this.stopAfter = null;
    if (this.timer !== null) this.events.clearTimer?.(this.timer);
    this.timer = null;
  }

  private stop() {
    this.stopAfter = null;
    this.events.send(commands.pause(true));
    this.events.log?.("replay remote: paused after the goal");
  }

  private arm(j: Jump) {
    this.stopAfter = j.frame;
    this.reached = false;
  }

  /** Bring the game forward; resolves when it's in front, or after a timeout. */
  private focus(): Promise<unknown> {
    const focusing = Promise.resolve(this.events.focusGame?.()).catch(() => {});
    if (!this.events.focusGame) return focusing;
    const timeout = new Promise((resolve) => {
      if (this.events.setTimer) this.events.setTimer(() => resolve(undefined), PLAY_AFTER_FOCUS_TIMEOUT_MS);
      else resolve(undefined);
    });
    return Promise.race([focusing.then(() => this.delay(PLAY_AFTER_FOCUS_MS)), timeout]);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => (this.events.setTimer ? this.events.setTimer(resolve, ms) : resolve()));
  }

  /** The jump lands paused; play starts once the game is in front. */
  private playWhenFocused(focused: Promise<unknown>) {
    const seekId = ++this.seekCount;
    void focused.then(() => {
      // A later jump takes over.
      if (seekId === this.seekCount) this.events.send(commands.pause(false));
    });
  }

  private seek(frame: number, camera: ReplayCamera, at: number): boolean {
    const ok = this.events.send(commands.speed(1)) && this.events.send(commands.seekToFrame(frame)) && this.events.send(commands.pause(true));
    if (ok) {
      this.seekSentAt = at;
      this.events.log?.(`replay remote: seek to frame ${frame}`);
      this.pov = camera === "keep" ? null : { camera, frame, since: at };
      this.aim = null;
    }
    return ok;
  }

  private maybeSetCamera(at: number, msg: Extract<GameMessage, { Event: "UpdateState" }>) {
    const pov = this.pov;
    if (!pov) return;
    const frame = msg.Data.Game.Frame;
    const arrived = this.seekSentAt === null && frame !== undefined && frame >= pov.frame - POV_FRAME_SLACK && frame <= pov.frame + POV_FRAME_AHEAD;
    if (!arrived && at - pov.since < POV_AFTER_MS) return;
    this.pov = null;
    if (pov.camera === "director") {
      this.events.send({ Command: "ChangePOV", Data: { Perspective: "Camera_Director" } });
      return;
    }
    const mine = this.mine(msg);
    if (!mine) return void this.events.log?.("replay remote: I'm not in this replay; camera left as is");
    const attempts = aimAttempts(mine.Shortcut, mine.TeamNum);
    this.aim = { name: mine.Name, attempts, tried: 0, since: at, heldSince: null, seen: [] };
    for (const c of attempts[0]!.commands) this.events.send(c);
  }

  private mine(msg: Extract<GameMessage, { Event: "UpdateState" }>) {
    const me = new Set(this.events.me?.() ?? []);
    return msg.Data.Players.find((p) => me.has(p.PrimaryId));
  }

  /** Has the camera landed on my car, and stayed there? If not, aim another way; after the last, the director camera. */
  private checkAim(at: number, msg: Extract<GameMessage, { Event: "UpdateState" }>) {
    const aim = this.aim;
    if (!aim) return;
    const target = msg.Data.Game.Target?.Name || "none";
    const label = aim.attempts[aim.tried]!.label;
    const seen = `${label}: ${target}`;
    if (aim.seen.at(-1) !== seen) aim.seen.push(seen);
    if (target === aim.name) {
      aim.heldSince ??= at;
      if (at - aim.heldSince < POV_HOLD_MS) return;
      if (aim.tried > 0) this.events.log?.(`replay remote: the camera held on my car with ${label} (${aim.seen.join(", ")})`);
      this.aim = null;
      return;
    }
    aim.heldSince = null;
    if (at - aim.since < POV_CHECK_MS) return;
    if (++aim.tried < aim.attempts.length) {
      aim.since = at;
      for (const c of aim.attempts[aim.tried]!.commands) this.events.send(c);
      return;
    }
    this.aim = null;
    this.events.send({ Command: "ChangePOV", Data: { Perspective: "Camera_Director" } });
    this.events.log?.(`replay remote: the camera didn't stay on my car; director camera instead (${aim.seen.join(", ")})`);
  }


}

interface AimAttempt {
  label: string;
  commands: GameCommand[];
}

/**
 * Ways to point the camera at my car, in order: my shortcut as ticks show it
 * (all that's needed normally), then 0, then every other shortcut, my team's
 * first (the game's Target says which one is me). After a seek past my
 * teammate leaving (2s, 2026-11-21), ticks said I was 1 but Focus 1 found
 * nothing (no perspective, Fly first and HardAttach didn't either) and Focus
 * 0 was me; the opponents still answered to their 5 and 6.
 */
export function aimAttempts(shortcut: number, team: number): AimAttempt[] {
  const mine = team === 1 ? [5, 6, 7, 8] : [1, 2, 3, 4];
  const others = team === 1 ? [1, 2, 3, 4] : [5, 6, 7, 8];
  const order = [...new Set([shortcut, 0, ...mine, ...others])];
  return order.map((s) => ({ label: `Focus ${s}`, commands: [commands.pov(s, "PlayerView")] }));
}
