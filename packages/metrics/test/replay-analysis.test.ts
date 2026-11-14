import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FIXTURE_DIR, ME } from "../../../apps/collector/test/fixtures.ts";
import { replaySetStats } from "../src/aggregate.ts";
import { analyzeReplay, primaryIdOf, type SubtrExtract } from "../src/replay-analysis.ts";

/** subtr-actor's extract of a real ranked 2s replay (3–4 loss), anonymized. */
const extract = (name: string): SubtrExtract => JSON.parse(gunzipSync(readFileSync(`${FIXTURE_DIR}${name}.subtr.json.gz`)).toString());

describe("replay analysis from subtr-actor", () => {
  const a = analyzeReplay(extract("ranked-2s-replay"));
  const me = a.players.find((p) => p.primaryId === ME)!;

  it("writes player IDs the way the Stats API does, so they match live recordings", () => {
    expect(primaryIdOf({ Epic: "abc" }, "x")).toBe("Epic|abc|0");
    expect(primaryIdOf({ PlayStation: { online_id: "123", name: "x" } }, "x")).toBe("PS4|123|0");
    expect(primaryIdOf({ Xbox: "9" }, "x")).toBe("XboxOne|9|0");
    expect(primaryIdOf({ SplitScreen: 0 }, "Bot")).toBe("bot:Bot");
    expect(a.players.map((p) => p.primaryId).sort()).toEqual(["Epic|anon0001|0", ME, "PS4|anon0002|0", "XboxOne|anon0003|0"].sort());
    expect(me).toMatchObject({ name: "Origami Box", team: 1 });
    expect(a).toMatchObject({ teamSize: 2, score: [3, 4], mapName: "TrainStation_P", analyzer: "subtr-actor 1.5.1 / rules 2" });
  });

  it("splits 2s positioning between the two teammates", () => {
    const mate = a.players.find((p) => p.team === 1 && p !== me)!;
    // In 2s one is last back while the other is forward (bar moments of no clear order).
    expect(me.positioning.lastBack).toBeCloseTo(mate.positioning.mostForward, 5);
    expect(me.positioning.lastBack + me.positioning.mostForward).toBeGreaterThan(0.9);
    expect(me.positioning.lastBack).toBeCloseTo(0.54, 2);
    expect(me.positioning.firstMan).toBeCloseTo(mate.positioning.secondMan, 5);
    expect(me.liveSeconds).toBeGreaterThan(290);
  });

  it("reads boost on the HUD's 0–100 scale", () => {
    // Kickoff boost is 33.
    expect(me.boost.average).toBeGreaterThan(30);
    expect(me.boost.average).toBeLessThan(80);
    expect(me.boost.empty + me.boost.full).toBeLessThan(1);
    expect(me.boost).toMatchObject({ bigPads: 13, smallPads: 76, steals: 18 });
    expect(me.boost.overfill).toBeLessThan(me.boost.collected);
  });

  it("counts challenges, demos and goals conceded as last back", () => {
    expect(me.challenges).toMatchObject({ fifties: { won: 4, lost: 1, even: 0 }, beatenToBall: 7, wonRace: 2, whiffs: 11, touches: 20 });
    expect(me.demos).toEqual({ inflicted: 1, taken: 1 });
    // Every goal had someone last back on the conceding side: 3 + 4 goals.
    expect(a.players.reduce((n, p) => n + p.concededAsLastBack, 0)).toBe(7);
  });

  it("lists moments in frame order, with goals matching the score", () => {
    const frames = a.moments.map((m) => m.frame);
    expect(frames).toEqual([...frames].sort((x, y) => x - y));
    expect(a.moments.filter((m) => m.kind === "goal")).toHaveLength(7);
    const demo = a.moments.find((m) => m.kind === "demo")!;
    expect(demo.other).not.toBeNull();
    expect(demo.matchTime).toBeGreaterThan(0);
    expect(demo.matchTime).toBeLessThanOrEqual(300);
  });

  it("uses the replay's own frame numbers, so moments seek like the header's goals do", () => {
    // The replay header's Goals list (frame of each goal) for this replay; the replay remote seeks to these.
    expect(a.moments.filter((m) => m.kind === "goal").map((m) => m.frame)).toEqual([2835, 3845, 4391, 5024, 5825, 6102, 6720]);
    expect(a.moments.find((m) => m.kind === "goal")!.matchTime).toBe(124); // 2:56 on the clock
  });
});

describe("replay numbers over a set of matches", () => {
  const me = analyzeReplay(extract("ranked-2s-replay")).players.find((p) => p.primaryId === ME)!;

  it("averages per match and adds up 50/50s and races; says how many matches it's from", () => {
    const one = replaySetStats([me], 3);
    expect(one).toMatchObject({ matches: 1, of: 3 });
    expect(one.perMatch.boost).toEqual({ mean: me.boost.average, median: me.boost.average });
    expect(one.perMatch.lastBack.mean).toBeCloseTo(0.54, 2);
    expect(one.fifties).toEqual(me.challenges.fifties);
    expect(one.races).toEqual({ won: me.challenges.wonRace, lost: me.challenges.beatenToBall });
    // A second, emptier match: the mean moves halfway, the median of two is the same; totals add.
    const low = { ...me, boost: { ...me.boost, average: 20 }, challenges: { ...me.challenges, wonRace: 1, beatenToBall: 2 } };
    const two = replaySetStats([me, low], 2);
    expect(two.perMatch.boost.mean).toBeCloseTo((me.boost.average + 20) / 2, 5);
    expect(two.races).toEqual({ won: me.challenges.wonRace + 1, lost: me.challenges.beatenToBall + 2 });
  });

  it("is empty without analyzed matches", () => {
    expect(replaySetStats([], 5)).toMatchObject({ matches: 0, of: 5, perMatch: { boost: { mean: null, median: null } }, races: { won: 0, lost: 0 } });
  });
});
