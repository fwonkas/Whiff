import { beforeAll, describe, expect, it } from "vitest";
import { ingestRecording } from "@rl/collector";
import type { Session } from "@rl/domain";
import { groupPlaySessions, matchMetrics, wasMvp, practiceSummary, rollingMean, series, split, standardSplits, third, attackUp, type MatchMetrics } from "../src/index.ts";
import { fixture, ME, TEAMMATE } from "../../../apps/collector/test/fixtures.ts";

const config = { myPrimaryIds: [ME], knownTeammates: [{ primaryId: TEAMMATE }], recordCasual: true };
let party: Session[];
let all: MatchMetrics[];
let sessionsById: Map<string, Session>;

beforeAll(async () => {
  party = (await ingestRecording(fixture("ranked-2s-party"), config)).sessions;
  const names = ["ranked-3s-2s", "ranked-2s-party", "ranked-1s", "casual-3s", "ranked-mixed", "snowday"];
  const sessions = (await Promise.all(names.map((n) => ingestRecording(fixture(n), config)))).flatMap((r) => r.sessions);
  sessionsById = new Map(sessions.map((s) => [s.id, s]));
  all = sessions.map(matchMetrics).filter((m): m is MatchMetrics => m !== null);
});

describe("matchMetrics", () => {
  it("reproduces the overtime loss numbers shown in the mockup", () => {
    const ot = matchMetrics(party.filter((s) => s.kind === "match")[4]!)!;
    expect(ot.outcome).toBe("loss");
    expect([ot.goalsFor, ot.goalsAgainst]).toEqual([3, 4]);
    expect(ot.me).toMatchObject({ goals: 0, assists: 1, saves: 1, shots: 0, touches: 38 });
    expect(ot.touchShare).toBeCloseTo(38 / 68);
    expect(ot.contacts).toBe(33);
    expect(ot.medianTouchSpeed).toBeCloseTo(87.3, 0);
    expect(ot.hardTouches).toBe(15);
    expect(ot.contestedTouches).toBe(14);
    expect([ot.possessionRuns, ot.longestRun]).toEqual([5, 3]);
    expect(ot.thirds).toEqual({ attacking: 8, middle: 14, defending: 11 });
    expect(ot.conceded).toHaveLength(4);
    expect(ot.conceded.every((c) => c.lastTouch === "opponent")).toBe(true);
  });

  it("measured lobby size matches every fixed-size playlist, despite drop-ins replacing bots", () => {
    for (const m of all) {
      const s = sessionsById.get(m.sessionId)!;
      expect(s.teamSize, `${s.id} playlist ${s.playlistId}`).toBe(m.teamSize);
    }
  });

  it("covers every match I played, and leaves touch share out of 1v1", () => {
    expect(all).toHaveLength(22);
    for (const m of all.filter((m) => m.teamSize === 1)) expect(m.touchShare).toBeNull();
    for (const m of all.filter((m) => m.teamSize !== 1)) expect(m.touchShare).toBeGreaterThan(0);
  });

  it("puts my own goal at the bottom for either team", () => {
    expect(third({ x: 0, y: -5000, z: 93 }, 0)).toBe("defending");
    expect(third({ x: 0, y: -5000, z: 93 }, 1)).toBe("attacking");
    expect(attackUp({ x: 100, y: 200, z: 5 }, 1)).toEqual({ x: -100, y: -200, z: 5 });
  });
});

describe("aggregates", () => {
  it("rolling mean skips missing values instead of counting them as zero", () => {
    expect(rollingMean([1, null, 3, 5], 2)).toEqual([1, null, 2, 4]);
  });

  it("splits: overall record and the with-teammate split", () => {
    expect(split(all)).toMatchObject({ matches: 21, wins: 11 });
    const withTeammate = standardSplits(all).find((s) => s.name === "With a known teammate")!.split;
    expect(withTeammate).toMatchObject({ matches: 9, wins: 5 });
  });

  it("series scale percentages and keep chronological order", () => {
    const s = series(all.filter((m) => m.teamSize === 2), "touchShare");
    expect(s.length).toBe(13);
    for (let i = 1; i < s.length; i++) expect(s[i]!.startedAt).toBeGreaterThan(s[i - 1]!.startedAt);
    expect(s[0]!.value).toBeGreaterThan(1); // percent, not fraction
  });
});

describe("practiceSummary", () => {
  it("training: success depends on the pack type", async () => {
    const [defense] = (await ingestRecording(fixture("training-defense-and-shots"), config)).sessions;
    expect(practiceSummary(defense!)).toMatchObject({ attempts: 11, conceded: 2, noGoal: 9, successRate: null });
    expect(practiceSummary(defense!, { packType: "defense" })).toMatchObject({ successRate: 9 / 11 });
  });

  it("freeplay: touches per minute of game time at 85%", async () => {
    const [fp] = (await ingestRecording(fixture("freeplay"), config)).sessions;
    const s = practiceSummary(fp!);
    expect(s?.kind).toBe("freeplay");
    if (s?.kind !== "freeplay") return;
    expect(s.gameSpeed).toBe(0.85);
    expect(s.activeSeconds).toBeLessThan(s.durationSeconds);
    expect(s.touchesPerGameMinute).toBeCloseTo(s.touches / ((s.activeSeconds * 0.85) / 60));
    expect(s.gameSpeedSource).toBe("measured");
  });

  it("falls back to my practice speed setting when the speed couldn't be measured", async () => {
    const [fp] = (await ingestRecording(fixture("freeplay"), config)).sessions;
    const unmeasured = { ...fp!, gameSpeed: null };
    expect(practiceSummary(unmeasured)).toMatchObject({ gameSpeed: null, gameSpeedSource: null, touchesPerGameMinute: null });
    expect(practiceSummary(unmeasured, { defaultGameSpeed: 0.85 })).toMatchObject({ gameSpeed: 0.85, gameSpeedSource: "setting" });
    // A measured speed always wins over the setting.
    expect(practiceSummary(fp!, { defaultGameSpeed: 1 })).toMatchObject({ gameSpeed: 0.85, gameSpeedSource: "measured" });
  });
});

describe("groupPlaySessions", () => {
  const min = 60_000;
  const s = (id: string, start: number, lengthMin = 6) => ({ id, startedAt: start * min, endedAt: (start + lengthMin) * min });

  it("keeps queues and tournament waits together and splits on a long break", () => {
    // Matches 2 to 35 minutes apart, then a 41-minute break.
    const groups = groupPlaySessions([s("a", 0), s("b", 8), s("c", 49), s("d", 96)], []);
    expect(groups.map((g) => g.sessionIds)).toEqual([["a", "b", "c"], ["d"]]);
    expect(groups[0]).toMatchObject({ id: `play-0`, startedAt: 0, endedAt: 55 * min });
  });

  it("quitting splits after 10 minutes away, but not on a quick relaunch", () => {
    const quits = [6 * min, 17 * min];
    const groups = groupPlaySessions([s("a", 0), s("b", 9), s("c", 30)], quits);
    // Quit at 6, back at 9 (3 min): same sitting. Quit at 17 after b ends at 15, back at 30 (15 min): new sitting.
    expect(groups.map((g) => g.sessionIds)).toEqual([["a", "b"], ["c"]]);
  });

  it("orders input and handles sessions that overlap", () => {
    expect(groupPlaySessions([s("b", 3), s("a", 0, 10)], []).map((g) => g.sessionIds)).toEqual([["a", "b"]]);
  });
});

describe("wasMvp", () => {
  it("follows the game's MVP event, and the top score on the winning team without one", () => {
    const matches = party.filter((s) => s.kind === "match");
    const mvps = matches.map(wasMvp);
    // In ranked-2s-party I was MVP twice; the teammate or an opponent the rest.
    expect(mvps.filter(Boolean)).toHaveLength(2);
    for (const s of matches) {
      const event = s.statEvents.find((e) => e.eventName === "MVP")!;
      expect(event).toBeDefined();
      const winner = s.players.find((p) => p.key === event.mainKey)!;
      // The event always names the top score on the winning team: the fallback agrees.
      expect(winner.team).toBe(s.winnerTeam);
      expect(wasMvp({ ...s, statEvents: [] })).toBe(wasMvp(s));
    }
    expect(wasMvp({ ...matches[0]!, kind: "freeplay" })).toBeNull();
  });

  it("is never true in 1s, where the winner is always MVP", async () => {
    // 2026-11-08: a ranked 1s win. The game sends no MVP event in 1s, so only
    // the fallback (top score on the winning team) ever called it MVP.
    const [win] = (await ingestRecording(fixture("ranked-1s-win"), config)).sessions.filter((s) => s.kind === "match");
    expect([win!.playlistId, win!.outcome]).toEqual([10, "win"]);
    expect(win!.statEvents.some((e) => e.eventName === "MVP")).toBe(false);
    expect(wasMvp(win!)).toBe(false);
    expect(wasMvp({ ...win!, playlistId: 11, teamSize: 2 })).toBe(true);
    // A private 1v1 has no fixed team size: the lobby's counts.
    const priv = (await ingestRecording(fixture("private-1v1"), config)).sessions.filter((s) => s.kind === "match");
    expect(priv.length).toBeGreaterThan(0);
    expect(priv.map(wasMvp)).toEqual(priv.map(() => false));
  });
});

describe("match set stats (Sessions cards)", () => {
  it("counts decided matches only, with means, medians, overtime and margins", async () => {
    const { matchSetStats, matchMetrics } = await import("../src/index.ts");
    const { ingestRecording } = await import("../../../apps/collector/src/ingest.ts");
    const { fixture, ME } = await import("../../../apps/collector/test/fixtures.ts");
    // Ranked 2s with a known teammate, including an overtime loss.
    const ms = (await ingestRecording(fixture("ranked-2s-party"), { myPrimaryIds: [ME], knownTeammates: [] })).sessions
      .map(matchMetrics)
      .filter((m) => m !== null);
    const s = matchSetStats(ms);
    const decided = ms.filter((m) => m.outcome === "win" || m.outcome === "loss");
    expect(s.decided).toBe(decided.length);
    expect(s.overtime.matches).toBeGreaterThan(0);
    expect(s.overtime.losses).toBeGreaterThan(0);
    expect(s.overtime.wins + s.overtime.losses).toBe(s.overtime.matches);
    expect(s.margins.wonByOne + s.margins.lostByOne).toBe(s.margins.oneGoal);
    const goals = decided.map((m) => m.me.goals);
    expect(s.perMatch.goals.mean).toBeCloseTo(goals.reduce((a, b) => a + b, 0) / goals.length, 10);
    expect(s.perMatch.goals.median).toBe([...goals].sort((a, b) => a - b)[Math.floor(goals.length / 2)] ?? null);
  });

  it("says nothing for no matches", async () => {
    const { matchSetStats } = await import("../src/index.ts");
    expect(matchSetStats([])).toMatchObject({ decided: 0, perMatch: { goals: { mean: null, median: null } }, margins: { meanDiff: null } });
  });
});
