import type { Session } from "@rl/domain";
import { AERIAL_Z } from "./field.ts";
import { median } from "./stats.ts";

/** A training pack's type decides what counts as success. */
export type PackType = "offense" | "defense";

/** "measured" from the session, "setting" from my configured practice speed, null when neither. */
export type GameSpeedSource = "measured" | "setting" | null;

export interface PracticeOptions {
  packType?: PackType | null;
  /**
   * My usual practice speed (e.g. 0.85), used when a session's speed can't be
   * measured: freeplay with no goals, or with Disable Goal Reset on (the game
   * sends no goal events then; checked 2026-11-03).
   */
  defaultGameSpeed?: number | null;
}

/** The speed to use for a practice session, and where it came from. */
export function practiceSpeed(s: Pick<Session, "gameSpeed">, defaultGameSpeed?: number | null): { gameSpeed: number | null; gameSpeedSource: GameSpeedSource } {
  if (s.gameSpeed !== null) return { gameSpeed: s.gameSpeed, gameSpeedSource: "measured" };
  if (defaultGameSpeed) return { gameSpeed: defaultGameSpeed, gameSpeedSource: "setting" };
  return { gameSpeed: null, gameSpeedSource: null };
}

export interface FreeplaySummary {
  kind: "freeplay";
  sessionId: string;
  startedAt: number;
  durationSeconds: number;
  /** Duration minus pauses. */
  activeSeconds: number;
  gameSpeed: number | null;
  gameSpeedSource: GameSpeedSource;
  queueWarmup: boolean;
  touches: number;
  goals: number;
  /** Per minute of game time, so 85%-speed sessions aren't penalized. Null when speed is unknown. */
  touchesPerGameMinute: number | null;
  medianTouchSpeed: number | null;
  aerialTouches: number;
  air: number | null;
}

export interface TrainingSummary {
  kind: "training";
  sessionId: string;
  startedAt: number;
  durationSeconds: number;
  gameSpeed: number | null;
  gameSpeedSource: GameSpeedSource;
  arena: string | null;
  /** Shots that ended, plus restarts after a touch (counted as misses). */
  attempts: number;
  scored: number;
  conceded: number;
  noGoal: number;
  /** All restarts. Only those after a touch count as attempts. */
  restarted: number;
  /** Restarted after touching the ball: a flubbed shot, so it counts as a miss. */
  restartedAfterTouch: number;
  /**
   * Needs the pack type: scoring is success in offense packs, no goal is
   * success in defense packs. Restarting right after a goal doesn't affect
   * it, because the attempt already ended with the goal.
   */
  successRate: number | null;
}

export function practiceSummary(s: Session, options: PracticeOptions = {}): FreeplaySummary | TrainingSummary | null {
  const packType = options.packType ?? null;
  const { gameSpeed, gameSpeedSource } = practiceSpeed(s, options.defaultGameSpeed);
  const me = s.players.find((p) => p.isMe);
  const durationSeconds = (s.endedAt - s.startedAt) / 1000;
  if (s.kind === "freeplay") {
    const mine = s.touches.filter((t) => !me || t.playerKey === me.key);
    const activeSeconds = Math.max(0, durationSeconds - s.pausedSeconds);
    const car = me ? s.carSummaries.find((c) => c.playerKey === me.key) : undefined;
    return {
      kind: "freeplay",
      sessionId: s.id,
      startedAt: s.startedAt,
      durationSeconds,
      activeSeconds,
      gameSpeed,
      gameSpeedSource,
      queueWarmup: s.queueWarmup,
      touches: mine.length,
      // Online Freeplay can have a party in it: count only my goals.
      goals: s.goals.filter((g) => !me || g.scorerKey === null || g.scorerKey === me.key).length,
      touchesPerGameMinute: gameSpeed && activeSeconds > 0 ? mine.length / ((activeSeconds * gameSpeed) / 60) : null,
      medianTouchSpeed: median(mine.map((t) => t.postSpeed)),
      aerialTouches: mine.filter((t) => t.location.z > AERIAL_Z).length,
      air: car?.air ?? null,
    };
  }
  if (s.kind === "training") {
    const count = (o: string) => s.trainingAttempts.filter((a) => a.outcome === o).length;
    const scored = count("scored");
    const conceded = count("conceded");
    const noGoal = count("none");
    const restartedAfterTouch = s.trainingAttempts.filter((a) => a.outcome === "reset" && a.touches > 0).length;
    // A restart before any touch is a bad start or a redo of the setup, so it isn't an attempt.
    const attempts = scored + conceded + noGoal + restartedAfterTouch;
    const successes = packType === "offense" ? scored : packType === "defense" ? noGoal : null;
    return {
      kind: "training",
      sessionId: s.id,
      startedAt: s.startedAt,
      durationSeconds,
      gameSpeed,
      gameSpeedSource,
      arena: s.arena,
      attempts,
      scored,
      conceded,
      noGoal,
      restarted: count("reset"),
      restartedAfterTouch,
      successRate: successes !== null && attempts > 0 ? successes / attempts : null,
    };
  }
  return null;
}
