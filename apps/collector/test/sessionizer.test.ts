import { PLAYLISTS } from "@rl/schema";
import { matchMetrics, practiceSummary } from "@rl/metrics";
import { beforeAll, describe, expect, it } from "vitest";
import { ingestRecording } from "../src/ingest.ts";
import type { Session } from "@rl/domain";
import { allFixtures, fixture, fixtureLines, ME, spliceRecording, TEAMMATE, writeRecording } from "./fixtures.ts";

/**
 * Known truths from the spike sessions (2026-10-21..23): scorelines noted at
 * the time, marked training shots and confirmed pack types.
 */

const config = { myPrimaryIds: [ME], knownTeammates: [{ primaryId: TEAMMATE }], recordCasual: true };
const cache = new Map<string, Session[]>();
const sessions = async (name: string) => {
  if (!cache.has(name)) cache.set(name, (await ingestRecording(fixture(name), config)).sessions);
  return cache.get(name)!;
};
const matches = async (name: string) => (await sessions(name)).filter((s) => s.kind === "match");
const summary = (s: Session) => ({
  playlist: s.playlistId,
  score: `${s.scoreBlue}-${s.scoreOrange}`,
  myTeam: s.myTeam,
  outcome: s.outcome,
});

beforeAll(async () => {
  await Promise.all(allFixtures().map(sessions));
});

describe("match results", () => {
  it("ranked 3s and 2s, solo (2026-10-21)", async () => {
    expect((await matches("ranked-3s-2s")).map(summary)).toEqual([
      { playlist: 13, score: "3-0", myTeam: 0, outcome: "win" },
      { playlist: 11, score: "3-2", myTeam: 1, outcome: "loss" },
      { playlist: 11, score: "2-3", myTeam: 1, outcome: "win" },
    ]);
  });

  it("ranked 2s with a known teammate, including an overtime loss", async () => {
    const ms = await matches("ranked-2s-party");
    expect(ms.map((s) => `${s.scoreBlue}-${s.scoreOrange} ${s.outcome}`)).toEqual([
      "3-3 win", // opponents forfeited at 3-3
      "4-1 win",
      "2-3 win",
      "3-4 loss",
      "4-3 loss",
      "5-3 win",
      "6-1 loss",
      "0-1 loss",
      "6-1 win",
    ]);
    expect(ms.every((s) => s.partied)).toBe(true);
    expect(ms.map((s) => s.overtime)).toEqual([false, false, false, false, true, false, false, false, false]);
  });

  it("ranked 1s", async () => {
    expect((await matches("ranked-1s")).map(summary)).toEqual([
      { playlist: 10, score: "5-1", myTeam: 1, outcome: "loss" },
      { playlist: 10, score: "6-3", myTeam: 1, outcome: "loss" },
    ]);
  });

  it("ranked 2s and 3s, solo (2026-10-23)", async () => {
    expect((await matches("ranked-mixed")).map(summary)).toEqual([
      { playlist: 11, score: "3-2", myTeam: 1, outcome: "loss" },
      { playlist: 13, score: "0-5", myTeam: 0, outcome: "loss" },
      { playlist: 11, score: "1-3", myTeam: 1, outcome: "win" },
    ]);
    expect((await matches("ranked-mixed")).some((s) => s.partied)).toBe(false);
  });

  it("Snow Day, including a match whose post-game ticks reset to 0-0", async () => {
    expect((await matches("snowday")).map(summary)).toEqual([
      { playlist: 30, score: "2-4", myTeam: 1, outcome: "win" },
      { playlist: 30, score: "3-2", myTeam: 1, outcome: "loss" },
      { playlist: 30, score: "1-2", myTeam: 1, outcome: "win" },
    ]);
  });

  it("casual: a win, then a match I left early with bots and drop-ins", async () => {
    const [win, left] = await matches("casual-3s");
    expect(summary(win!)).toEqual({ playlist: 3, score: "3-2", myTeam: 0, outcome: "win" });
    expect(summary(left!)).toEqual({ playlist: 3, score: "2-5", myTeam: 0, outcome: "abandoned" });
    expect(left!.players.filter((p) => p.isBot).map((p) => p.key)).toEqual(["bot:Tex"]);
    expect(left!.players.filter((p) => p.joinedAt !== null).length).toBeGreaterThan(0);
  });
});

describe("goals", () => {
  it("every goal's location ends up on the scoring team's goal line", async () => {
    let checked = 0;
    for (const name of allFixtures()) {
      for (const s of await matches(name)) {
        for (const g of s.goals) {
          if (g.locationSource !== "replay-end") continue;
          // Blue (0) scores at +Y, orange (1) at -Y.
          expect(Math.sign(g.location.y)).toBe(g.team === 0 ? 1 : -1);
          expect(Math.abs(g.location.y)).toBeGreaterThan(5000);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(110);
  });

  it("drops the blank-scorer twin: one goal per goal", async () => {
    for (const name of allFixtures()) {
      for (const s of await matches(name)) {
        if (s.outcome === "abandoned") continue;
        expect(s.goals.length, `${name} ${s.id}`).toBe((s.scoreBlue ?? 0) + (s.scoreOrange ?? 0));
      }
    }
  });

  it("goal match time counts up through overtime", async () => {
    const ot = (await matches("ranked-2s-party"))[4]!;
    const last = ot.goals.at(-1)!;
    expect(last.matchTime).toBeGreaterThan(300);
  });
});

describe("private matches", () => {
  it("a 1v1 against a known teammate: own GUID, not partied, team size from the lobby", async () => {
    const ms = await matches("private-1v1");
    const [restarted, played] = ms;
    expect(ms.map(summary)).toEqual([
      { playlist: 6, score: "1-0", myTeam: 0, outcome: "abandoned" },
      { playlist: 6, score: "2-5", myTeam: 0, outcome: "loss" },
    ]);
    expect(played!.matchGuid).not.toBe(restarted!.matchGuid);
    expect(played!.partied).toBe(false);
    expect(played!.players.find((p) => p.isKnownTeammate)?.team).toBe(1);
    const m = matchMetrics(played!)!;
    expect(m.teamSize).toBe(1);
    expect(m.touchShare).toBeNull();
  });
});

describe("practice", () => {
  it("marked training pack: 5 made, 3 missed, at 85% speed", async () => {
    const [t] = (await sessions("training-marked")).filter((s) => s.kind === "training");
    const count = (o: string) => t!.trainingAttempts.filter((a) => a.outcome === o).length;
    expect([count("scored"), count("none")]).toEqual([5, 3]);
    expect(t!.gameSpeed).toBe(0.85);
  });

  it("short shot clocks still measure 85% speed (the countdown isn't a clock step)", async () => {
    const packs = (await sessions("training-five-packs")).filter((s) => s.kind === "training");
    expect(packs.map((s) => s.arena)).toEqual(["Stadium_P", "Park_P", "Stadium_Foggy_P", "Stadium_Foggy_P", "EuroStadium_Night_P"]);
    for (const s of packs) if (s.gameSpeed !== null) expect(s.gameSpeed, s.arena!).toBe(0.85);
    expect(packs.at(-1)!.gameSpeed).toBe(0.85);
  });

  it("restarts after a touch count as misses; restarts before one don't count", async () => {
    const packs = (await sessions("training-five-packs")).filter((s) => s.kind === "training");
    const backboard = practiceSummary(packs.at(-1)!, { packType: "offense" });
    expect(backboard).toMatchObject({ kind: "training", restarted: 16, restartedAfterTouch: 12, attempts: 14, scored: 0, successRate: 0 });
    const dribble = practiceSummary(packs[3]!, { packType: "offense" });
    expect(dribble).toMatchObject({ attempts: 1, scored: 1, successRate: 1 });
  });

  it("defense pack: failed saves show up as conceded", async () => {
    const [defense, shooting] = (await sessions("training-defense-and-shots")).filter((s) => s.kind === "training");
    const count = (s: Session, o: string) => s.trainingAttempts.filter((a) => a.outcome === o).length;
    expect(defense!.arena).toBe("Park_P");
    expect([count(defense!, "conceded"), count(defense!, "none")]).toEqual([2, 9]);
    expect(count(shooting!, "scored")).toBe(4);
  });

  it("freeplay: goals, pauses and 85% speed from GoalTime", async () => {
    const [f] = await sessions("freeplay");
    expect(f!.kind).toBe("freeplay");
    expect(f!.goals).toHaveLength(2);
    expect(f!.gameSpeed).toBe(0.85);
    expect(f!.pausedSeconds).toBeGreaterThan(60);
  });

  it("freeplay speed works whether GoalTime counts per round or from the session start", async () => {
    // 2026-10-23: GoalTime ran 14, 67, 101, 441... from the session start (once read as 280%).
    const long = (await sessions("freeplay-long")).find((s) => s.kind === "freeplay" && s.goals.length > 3)!;
    expect(long.gameSpeed).toBe(0.85);
    // 2026-10-22: GoalTime reset each round.
    const warmup = (await sessions("ranked-1s")).find((s) => s.kind === "freeplay" && s.goals.length)!;
    expect(warmup.gameSpeed).toBe(0.85);
    // Every measurable practice session in the recordings was at 85%.
    for (const name of allFixtures()) {
      for (const s of await sessions(name)) if (s.gameSpeed !== null) expect(s.gameSpeed, `${name} ${s.id}`).toBe(0.85);
    }
  });

  it("Online Freeplay (playlist 73) with a party is freeplay, not a match", async () => {
    // 2026-11-10: started from the menu between tournament matches; two party members joined and scored.
    const ss = await sessions("online-freeplay");
    expect(ss.map((s) => [s.kind, s.playlistId])).toEqual([["freeplay", 73]]);
    const [f] = ss;
    expect(f!.players).toHaveLength(3);
    expect(f!.goals.map((g) => g.scorerKey)).toEqual([ME, "Epic|other1|0", ME]);
    // Practice counts only my touches and goals.
    const p = practiceSummary(f!);
    expect(p?.kind === "freeplay" && p.goals).toBe(2);
    expect(p?.kind === "freeplay" && p.touches).toBe(f!.touches.filter((t) => t.playerKey === ME).length);
  });

  it("freeplay right before a match is tagged as a queue warm-up", async () => {
    const ss = await sessions("ranked-1s");
    const warmups = ss.filter((s) => s.kind === "freeplay" && s.queueWarmup);
    expect(warmups).toHaveLength(2);
  });

  it("bOnWall is classified before bOnGround", async () => {
    const [f] = await sessions("freeplay");
    const me = f!.carSummaries.find((c) => c.playerKey === ME)!;
    expect(me.wall).toBeGreaterThan(0);
    expect(me.ground + me.wall + me.air).toBeCloseTo(1);
  });
});

describe("replays", () => {
  it("seeks stay inside one replay session, linked to the live match", async () => {
    const r = await sessions("replay-seeks");
    expect(r).toHaveLength(1);
    expect(r[0]!.replayId).toBe("2CA4EF0011F1CDAB1F3CFCAA7B43BB89");
    expect(r[0]!.matchGuid).toBe("C2A0CBB011F1CDAA5A53FCAAFFA26E0E");
    const live = (await matches("ranked-3s-2s"))[0]!;
    expect(live.matchGuid).toBe(r[0]!.matchGuid);
  });

  it("each LoadReplay is its own session", async () => {
    expect((await sessions("replay-load")).map((s) => s.replayId?.slice(0, 8))).toEqual([
      "C5024DCC",
      "2CA4EF00",
      "C5024DCC",
      "C5024DCC",
    ]);
  });

  it("indexes frames by match time, including overtime", async () => {
    const [r] = await sessions("replay-ot-seeks");
    const frames = r!.replayFrames;
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.frame).toBeGreaterThanOrEqual(frames[i - 1]!.frame);
    // `seek 290` landed on frame 8701 at +0:36 of overtime (match time 336).
    expect(frames.find((f) => f.matchTime === 336)?.frame).toBe(8701);
  });
});

/**
 * 2026-11-01: two tournament replays played start to finish at 2x. The first
 * (a forfeit, with seeks to the start before playing) also has a live
 * recording; the second was never recorded live.
 */
describe("replay playback as match data", () => {
  const replays = async () => (await sessions("replay-backfill")).filter((s) => s.kind === "replay");

  it("a full playback is complete, with the score, outcome and how it ended", async () => {
    const [forfeit, overtime] = await replays();
    expect(forfeit!.playback).toMatchObject({ complete: true, endReason: "forfeit", gaps: 0 });
    expect([forfeit!.scoreBlue, forfeit!.scoreOrange, forfeit!.outcome, forfeit!.forfeit]).toEqual([1, 4, "loss", true]);
    expect(overtime!.playback).toMatchObject({ complete: true, endReason: "overtime", gaps: 0 });
    expect([overtime!.scoreBlue, overtime!.scoreOrange, overtime!.outcome, overtime!.overtime]).toEqual([2, 1, "loss", true]);
  });

  it("matches the live recording of the same match", async () => {
    const [replay] = await replays();
    const [live] = await matches("tournament-live");
    expect(replay!.matchGuid).toBe(live!.matchGuid);
    const stats = (s: Session) => Object.fromEntries(s.players.map((p) => [p.key, p.stats]));
    expect(stats(replay!)).toEqual(stats(live!));
    expect(replay!.goals.map((g) => [g.scorerKey, Math.round(g.matchTime!)])).toEqual(live!.goals.map((g) => [g.scorerKey, Math.round(g.matchTime!)]));
    // 2x playback drops a few quick repeat touches.
    expect(replay!.touches.length / live!.touches.length).toBeGreaterThan(0.9);
    // Only replays carry boost pickups and every player's car.
    expect(replay!.boostPickups.length).toBeGreaterThan(150);
    expect(replay!.carSummaries).toHaveLength(6);
    expect(live!.carSummaries.length).toBeLessThan(6);
  });

  it("measures the playback speed: replay game time over real time, pauses left out", async () => {
    // replay-backfill played at 2x; replay-load's first replay at 1x. Game time runs a little ahead of the clock.
    // The forfeit seeks to the start first, which reads a little faster.
    for (const r of await replays()) expect(r.playback!.speed).toBeGreaterThanOrEqual(2), expect(r.playback!.speed).toBeLessThan(2.5);
    expect((await sessions("replay-load"))[0]!.playback?.speed).toBe(1.05);
  });

  it("seeks and partial playbacks are not complete", async () => {
    for (const name of ["replay-seeks", "replay-ot-seeks", "replay-load"]) {
      for (const r of await sessions(name)) expect(r.playback?.complete, name).toBe(false);
    }
  });

  it("detects forfeits in live play: the clock jumps to 0:00 just before MatchEnded", async () => {
    const forfeits: string[] = [];
    for (const name of allFixtures()) for (const m of await matches(name)) if (m.forfeit) forfeits.push(`${name} ${m.scoreBlue}-${m.scoreOrange}`);
    // All with time left on the clock, e.g. the tournament match at 1-4 with 2:26 left. One
    // ended 3-3: a forfeit can come while tied, and the team that forfeits loses.
    expect(forfeits.sort()).toEqual([
      "ranked-1s 5-1",
      "ranked-2s-party 3-3",
      "ranked-2s-party 4-1",
      "ranked-2s-party 6-1",
      "ranked-3s-2s 3-0",
      "ranked-mixed 1-3",
      "tournament-live 1-4",
    ]);
  });
});

describe("game closing", () => {
  const spliceSessions = async (parts: Parameters<typeof spliceRecording>[0]) =>
    (await ingestRecording(await spliceRecording(parts), config)).sessions;

  it("quitting mid-freeplay ends the session there, not at the next launch", async () => {
    const [whole] = (await sessions("freeplay")).filter((s) => s.kind === "freeplay");
    const out = await spliceSessions([{ fixture: "freeplay", fraction: 0.5 }, { note: "disconnected" }, { fixture: "ranked-1s", gapMs: 3_600_000 }]);
    const [cut] = out.filter((s) => s.kind === "freeplay");
    expect(cut!.startedAt).toBe(whole!.startedAt);
    expect(cut!.endedAt).toBeLessThan(whole!.endedAt);
    expect(out.filter((s) => s.kind === "match")).toHaveLength((await matches("ranked-1s")).length);
  });

  it("a match cut off by the game closing counts as left early", async () => {
    // ranked-1s holds two matches; stop a quarter of the way in, inside the first.
    const out = await spliceSessions([{ fixture: "ranked-1s", fraction: 0.25 }, { note: "disconnected" }]);
    const [m] = out.filter((s) => s.kind === "match");
    expect(m!.outcome).toBe("abandoned");
  });
});

describe("matches that never started", () => {
  it("drops a match nobody touched the ball in (a 0–0 Rumble forfeit at kickoff, 2026-11-02)", async () => {
    const { sessions } = await ingestRecording(fixture("rumble-never-started"), config);
    expect(sessions.map((s) => s.kind)).toEqual(["freeplay"]);
  });
});

describe("casual matches", () => {
  it("are left out unless the settings ask for them", async () => {
    const off = (await ingestRecording(fixture("casual-3s"), { ...config, recordCasual: false })).sessions;
    const on = (await ingestRecording(fixture("casual-3s"), config)).sessions;
    expect(on.filter((s) => s.kind === "match").length).toBeGreaterThan(0);
    expect(off.filter((s) => s.kind === "match")).toEqual([]);
    // Everything else in the recording stays.
    expect(off.length).toBe(on.length - on.filter((s) => s.kind === "match").length);
  });

  it("casual Snow Day (playlist 15) is casual too: left out with casual off (2026-11-13)", async () => {
    const off = await ingestRecording(fixture("casual-snow-day"), { ...config, recordCasual: false });
    expect(off.sessions.filter((s) => s.kind === "match")).toEqual([]);
    expect(off.skipped.map((s) => [s.playlistId, s.matchGuid])).toEqual([[15, "BD284B3811F1DFE1D7D91B8BE6D1B582"]]);
    const [m] = (await ingestRecording(fixture("casual-snow-day"), config)).sessions.filter((s) => s.kind === "match");
    expect([m!.playlistId, m!.teamSize, m!.arena]).toEqual([15, 3, "eurostadium_snownight_p"]);
    expect(PLAYLISTS[15]?.name).toBe("Casual Snow Day");
  });

  it("leaving after all my teammates had counts as the score shows, not as left early (2026-11-15)", async () => {
    // Ranked 3s: one teammate left at 4:42, the other at 2:33 down 0–3, and I left a second later; no MatchEnded.
    const [m] = (await ingestRecording(fixture("left-after-teammates"), config)).sessions.filter((s) => s.kind === "match");
    expect([m!.outcome, m!.teammatesLeft, m!.scoreBlue, m!.scoreOrange, m!.myTeam]).toEqual(["loss", true, 0, 3, 0]);
    expect(m!.players.filter((p) => p.team === 0 && !p.isMe).every((p) => p.leftAt !== null)).toBe(true);
  });

  it("leaving with a teammate still there stays left early", async () => {
    // The same match, cut before the second teammate left at 2:33 (as if I'd left first).
    const all = fixtureLines("left-after-teammates");
    const second = all.findIndex((l, i) => l.includes('"PlayerLeft"') && all.slice(0, i).some((x) => x.includes('"PlayerLeft"')));
    const at = (JSON.parse(all[second - 1]!) as { receivedAt: number }).receivedAt;
    const destroyed = all.find((l) => l.includes('"MatchDestroyed"'))!.replace(/"receivedAt":\d+/, `"receivedAt":${at + 1000}`);
    const file = writeRecording([...all.slice(0, second), destroyed]);
    const [m] = (await ingestRecording(file, config)).sessions.filter((s) => s.kind === "match");
    expect([m!.outcome, m!.teammatesLeft]).toEqual(["abandoned", false]);
  });

  it("Honor Duel (playlist 53, a limited-time 1v1) is kept with casual off, as an extra mode (2026-11-15)", async () => {
    const { sessions, skipped } = await ingestRecording(fixture("honor-duel"), { ...config, recordCasual: false });
    expect(skipped).toEqual([]);
    const [m] = sessions.filter((s) => s.kind === "match");
    expect([m!.playlistId, m!.teamSize, m!.myTeam, m!.scoreBlue, m!.scoreOrange, m!.outcome]).toEqual([53, 1, 1, 4, 2, "loss"]);
    expect(PLAYLISTS[53]).toMatchObject({ name: "Honor Duel", nonStandard: true });
  });

  it("left out, they're reported, so their replays aren't played through", async () => {
    const { skipped } = await ingestRecording(fixture("casual-3s"), { ...config, recordCasual: false });
    const on = (await ingestRecording(fixture("casual-3s"), config)).sessions.filter((s) => s.kind === "match");
    expect(skipped.map((s) => s.matchGuid)).toEqual(on.map((s) => s.matchGuid));
    expect(skipped.every((s) => s.matchGuid && s.playlistId === 3)).toBe(true);
    expect((await ingestRecording(fixture("casual-3s"), config)).skipped).toEqual([]);
  });
});
