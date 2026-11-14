import type { MatchMetrics } from "./match.ts";
import type { PlayerReplayMetrics } from "./replay-analysis.ts";
import { mean, median, ratio, rollingMean, sum } from "./stats.ts";

/** Metrics that can be plotted as a per-match series. */
export const SERIES_METRICS = {
  touchShare: { label: "Touch share", unit: "%", scale: 100, get: (m: MatchMetrics) => m.touchShare },
  medianTouchSpeed: { label: "Median touch speed", unit: "km/h", scale: 1, get: (m: MatchMetrics) => m.medianTouchSpeed },
  hardTouches: { label: "Hard touches", unit: "", scale: 1, get: (m: MatchMetrics) => m.hardTouches },
  contestedTouches: { label: "Contested touches", unit: "", scale: 1, get: (m: MatchMetrics) => m.contestedTouches },
  possessionRuns: { label: "Possession runs", unit: "", scale: 1, get: (m: MatchMetrics) => m.possessionRuns },
  air: { label: "Time in the air", unit: "%", scale: 100, get: (m: MatchMetrics) => m.car?.air ?? null },
  goals: { label: "Goals", unit: "", scale: 1, get: (m: MatchMetrics) => m.me.goals },
  saves: { label: "Saves", unit: "", scale: 1, get: (m: MatchMetrics) => m.me.saves },
  shotConversion: { label: "Shot conversion", unit: "%", scale: 100, get: (m: MatchMetrics) => m.shotConversion },
} as const;
export type SeriesMetric = keyof typeof SERIES_METRICS;

export interface SeriesPoint {
  sessionId: string;
  startedAt: number;
  partied: boolean;
  outcome: MatchMetrics["outcome"];
  value: number | null;
  /** Trailing average over the last `window` matches with a value. */
  average: number | null;
}

/** A per-match series in chronological order, scaled for display (e.g. 0.55 → 55 for percentages). */
export function series(matches: readonly MatchMetrics[], metric: SeriesMetric, window = 5): SeriesPoint[] {
  const def = SERIES_METRICS[metric];
  const sorted = [...matches].sort((a, b) => a.startedAt - b.startedAt);
  const values = sorted.map((m) => {
    const v = def.get(m);
    return v === null ? null : v * def.scale;
  });
  const avg = rollingMean(values, window);
  return sorted.map((m, i) => ({
    sessionId: m.sessionId,
    startedAt: m.startedAt,
    partied: m.partied,
    outcome: m.outcome,
    value: values[i] ?? null,
    average: avg[i] ?? null,
  }));
}

export interface Split {
  /** Completed matches (abandoned ones are left out). */
  matches: number;
  wins: number;
  winRate: number | null;
  goalsPerMatch: number | null;
  /** Total goals over total shots, which weights matches by how much I shot. */
  shotConversion: number | null;
  touchShare: number | null;
  medianTouchSpeed: number | null;
  contestedPerMatch: number | null;
  air: number | null;
}

export function split(matches: readonly MatchMetrics[]): Split {
  const done = matches.filter((m) => m.outcome === "win" || m.outcome === "loss");
  const nonNull = <T>(xs: (T | null)[]) => xs.filter((x): x is T => x !== null);
  const wins = done.filter((m) => m.outcome === "win").length;
  return {
    matches: done.length,
    wins,
    winRate: ratio(wins, done.length),
    goalsPerMatch: mean(done.map((m) => m.me.goals)),
    shotConversion: ratio(sum(done.map((m) => m.me.goals)), sum(done.map((m) => m.me.shots))),
    touchShare: mean(nonNull(done.map((m) => m.touchShare))),
    medianTouchSpeed: median(nonNull(done.map((m) => m.medianTouchSpeed))),
    contestedPerMatch: mean(done.map((m) => m.contestedTouches)),
    air: mean(nonNull(done.map((m) => m.car?.air ?? null))),
  };
}

/** Standard splits: solo vs partied, then by team size. */
export function standardSplits(matches: readonly MatchMetrics[]): { name: string; split: Split }[] {
  const by = (name: string, f: (m: MatchMetrics) => boolean) => ({ name, split: split(matches.filter(f)) });
  return [
    by("Solo", (m) => !m.partied),
    by("With a known teammate", (m) => m.partied),
    by("1v1", (m) => m.teamSize === 1),
    by("2v2", (m) => m.teamSize === 2),
    by("3v3", (m) => m.teamSize === 3),
  ].filter((s) => s.split.matches > 0);
}

/**
 * Splits by a match's place in its play session (1 = the first match of the
 * night), to see whether long sessions wear me down.
 */
export function playSessionSplits(matches: readonly MatchMetrics[], position: ReadonlyMap<string, number>): { name: string; split: Split }[] {
  const at = (m: MatchMetrics) => position.get(m.sessionId) ?? 0;
  const by = (name: string, f: (n: number) => boolean) => ({ name, split: split(matches.filter((m) => at(m) > 0 && f(at(m)))) });
  return [
    by("Matches 1–3 of a play session", (n) => n <= 3),
    by("Matches 4–6 of a play session", (n) => n >= 4 && n <= 6),
    by("Matches 7 and later of a play session", (n) => n >= 7),
  ].filter((s) => s.split.matches > 0);
}

/** Mean and median of one per-match number. */
export interface Center {
  mean: number | null;
  median: number | null;
}

/**
 * What the Sessions cards say about a set of matches beyond the record. Only
 * decided matches (won or lost) count: a match left early has partial stats
 * and no final margin.
 */
export interface MatchSetStats {
  decided: number;
  perMatch: Record<"goals" | "assists" | "saves" | "shots" | "score" | "touchShare", Center>;
  overtime: { matches: number; wins: number; losses: number };
  margins: { oneGoal: number; wonByOne: number; lostByOne: number; meanDiff: number | null };
}

export function matchSetStats(all: readonly MatchMetrics[]): MatchSetStats {
  const ms = all.filter((m) => m.outcome === "win" || m.outcome === "loss");
  const center = (xs: (number | null)[]): Center => {
    const v = xs.filter((x): x is number => x !== null);
    return { mean: mean(v), median: median(v) };
  };
  const ot = ms.filter((m) => m.overtime);
  const diff = (m: MatchMetrics) => m.goalsFor - m.goalsAgainst;
  const byOne = ms.filter((m) => Math.abs(diff(m)) === 1);
  return {
    decided: ms.length,
    perMatch: {
      goals: center(ms.map((m) => m.me.goals)),
      assists: center(ms.map((m) => m.me.assists)),
      saves: center(ms.map((m) => m.me.saves)),
      shots: center(ms.map((m) => m.me.shots)),
      score: center(ms.map((m) => m.me.score)),
      touchShare: center(ms.map((m) => m.touchShare)),
    },
    overtime: { matches: ot.length, wins: ot.filter((m) => m.outcome === "win").length, losses: ot.filter((m) => m.outcome === "loss").length },
    margins: {
      oneGoal: byOne.length,
      wonByOne: byOne.filter((m) => m.outcome === "win").length,
      lostByOne: byOne.filter((m) => m.outcome === "loss").length,
      meanDiff: mean(ms.map(diff)),
    },
  };
}

/** My replay-analysis numbers over a set of matches (those with an analyzed replay). */
export interface ReplaySetStats {
  /** Matches with an analysis, out of `of` (the won or lost matches the other cards count). */
  matches: number;
  of: number;
  perMatch: {
    /** Average boost, 0..100. */
    boost: Center;
    /** Share of live play with no boost. */
    boostEmpty: Center;
    /** Share of live play as my team's last one back. */
    lastBack: Center;
  };
  /** 50/50s outside kickoffs, all matches together. */
  fifties: { won: number; lost: number; even: number };
  /** Races to the ball against an opponent, all matches together. */
  races: { won: number; lost: number };
}

/** `mine`: my numbers from each analyzed match; `of`: how many matches they're from in all. */
export function replaySetStats(mine: readonly PlayerReplayMetrics[], of: number): ReplaySetStats {
  const center = (xs: number[]): Center => ({ mean: mean(xs), median: median(xs) });
  return {
    matches: mine.length,
    of,
    perMatch: {
      boost: center(mine.map((p) => p.boost.average)),
      boostEmpty: center(mine.map((p) => p.boost.empty)),
      lastBack: center(mine.map((p) => p.positioning.lastBack)),
    },
    fifties: {
      won: sum(mine.map((p) => p.challenges.fifties.won)),
      lost: sum(mine.map((p) => p.challenges.fifties.lost)),
      even: sum(mine.map((p) => p.challenges.fifties.even)),
    },
    races: { won: sum(mine.map((p) => p.challenges.wonRace)), lost: sum(mine.map((p) => p.challenges.beatenToBall)) },
  };
}
