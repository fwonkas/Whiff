import type { Outcome, PlayerStats, Session } from "@rl/domain";
import { PLAYLISTS } from "@rl/schema";
import { AERIAL_Z, lane, third, type Lane } from "./field.ts";
import { median, ratio } from "./stats.ts";

/** A touch that leaves the ball at this speed or faster counts as hard. */
export const HARD_TOUCH_KMH = 90;
/** An opponent touching the ball this close to one of mine makes it contested (a 50-50 proxy). */
export const CONTESTED_MS = 150;

export type TouchOwner = "me" | "teammate" | "opponent";

export interface ConcededGoal {
  matchTime: number | null;
  speedKmh: number;
  /** Who touched the ball last before it went in. */
  lastTouch: TouchOwner | null;
  /** Where it crossed the line, seen from my end. Null when the location is unreliable. */
  lane: Lane | null;
  aerial: boolean | null;
}

export interface MatchMetrics {
  sessionId: string;
  startedAt: number;
  durationSeconds: number;
  playlistId: number | null;
  teamSize: number | null;
  arena: string | null;
  outcome: Outcome | null;
  overtime: boolean;
  partied: boolean;
  goalsFor: number;
  goalsAgainst: number;
  /** The game's own end-of-match numbers for me. */
  me: PlayerStats;
  /** My share of my team's touches (game counts). Null in 1v1, where it is always 100%. */
  touchShare: number | null;
  shotConversion: number | null;
  /** Distinct contacts from BallHit events (repeats within 100 ms collapsed). */
  contacts: number;
  medianTouchSpeed: number | null;
  hardTouches: number;
  aerialTouches: number;
  contestedTouches: number;
  /** Runs of 2+ touches by me with no opponent touch in between; a teammate's touch doesn't break a run. */
  possessionRuns: number;
  longestRun: number;
  thirds: Record<"attacking" | "middle" | "defending", number>;
  /** Shares of live play from car state; null when no car data (it always exists for me in live play). */
  car: { air: number; wall: number; ground: number; supersonic: number; boosting: number; avgSpeed: number } | null;
  conceded: ConcededGoal[];
}

/** Metrics for one completed or abandoned match, from my point of view. Null when I wasn't in it. */
export function matchMetrics(s: Session): MatchMetrics | null {
  if (s.kind !== "match") return null;
  const me = s.players.find((p) => p.isMe);
  if (!me || s.myTeam === null) return null;
  const myTeam = s.myTeam;
  const teamKeys = new Set(s.players.filter((p) => p.team === myTeam).map((p) => p.key));
  const owner = (key: string | null): TouchOwner | null =>
    key === null ? null : key === me.key ? "me" : teamKeys.has(key) ? "teammate" : "opponent";

  const mine = s.touches.filter((t) => t.playerKey === me.key);
  const opponentTimes = s.touches.filter((t) => owner(t.playerKey) === "opponent").map((t) => t.at);

  let run = 0;
  let runs = 0;
  let longest = 0;
  for (const t of s.touches) {
    const o = owner(t.playerKey);
    if (o === "me") {
      run++;
      if (run === 2) runs++;
      longest = Math.max(longest, run);
    } else if (o === "opponent") run = 0;
  }

  const thirds = { attacking: 0, middle: 0, defending: 0 };
  for (const t of mine) thirds[third(t.location, myTeam)]++;

  const teamTouches = s.players.filter((p) => p.team === myTeam).reduce((n, p) => n + p.stats.touches, 0);
  const teamSize = (s.playlistId !== null ? PLAYLISTS[s.playlistId]?.teamSize : undefined) ?? s.teamSize;
  const car = s.carSummaries.find((c) => c.playerKey === me.key);

  const goalsFor = myTeam === 0 ? (s.scoreBlue ?? 0) : (s.scoreOrange ?? 0);
  const goalsAgainst = myTeam === 0 ? (s.scoreOrange ?? 0) : (s.scoreBlue ?? 0);

  return {
    sessionId: s.id,
    startedAt: s.startedAt,
    durationSeconds: (s.endedAt - s.startedAt) / 1000,
    playlistId: s.playlistId,
    teamSize,
    arena: s.arena,
    outcome: s.outcome,
    overtime: s.overtime,
    partied: s.partied,
    goalsFor,
    goalsAgainst,
    me: me.stats,
    touchShare: teamSize === 1 ? null : ratio(me.stats.touches, teamTouches),
    shotConversion: ratio(me.stats.goals, me.stats.shots),
    contacts: mine.length,
    medianTouchSpeed: median(mine.map((t) => t.postSpeed)),
    hardTouches: mine.filter((t) => t.postSpeed >= HARD_TOUCH_KMH).length,
    aerialTouches: mine.filter((t) => t.location.z > AERIAL_Z).length,
    contestedTouches: mine.filter((t) => opponentTimes.some((o) => Math.abs(o - t.at) <= CONTESTED_MS)).length,
    possessionRuns: runs,
    longestRun: longest,
    thirds,
    car: car
      ? { air: car.air, wall: car.wall, ground: car.ground, supersonic: car.supersonic, boosting: car.boosting, avgSpeed: car.avgSpeed }
      : null,
    conceded: s.goals
      .filter((g) => g.team !== myTeam)
      .map((g) => ({
        matchTime: g.matchTime,
        speedKmh: g.speedKmh,
        lastTouch: owner(g.lastTouchKey),
        // Seen from my end: the scoring team attacks toward my goal.
        lane: g.locationSource !== "goal" ? lane(g.location, g.team) : null,
        aerial: g.locationSource !== "goal" ? g.location.z > AERIAL_Z : null,
      })),
  };
}

