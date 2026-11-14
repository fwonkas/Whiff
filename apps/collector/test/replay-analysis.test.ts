import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { analyzeReplay, type SubtrExtract } from "@rl/metrics";
import { StatsDb } from "../src/db.ts";
import { ingestRecording } from "../src/ingest.ts";
import { StatsService } from "../src/service.ts";
import { ReplayAnalyzer } from "../src/replay-analyzer.ts";
import { anonymizeExtract } from "../src/subtr/fixture-cli.ts";
import { SubtrSetupError, SubtrWorker } from "../src/subtr/pool.ts";
import { fixture, FIXTURE_DIR, ME } from "./fixtures.ts";

const extract = (): SubtrExtract => JSON.parse(gunzipSync(readFileSync(`${FIXTURE_DIR}ranked-2s-replay.subtr.json.gz`)).toString());
const GUID = "9D3CC11811F1D8C1DE5E478A8C50DEBA";

function setup(extractImpl: (path: string) => Promise<SubtrExtract>, canRun = () => true) {
  const db = new StatsDb(":memory:");
  const now = Date.now();
  const replays = [
    { replayId: "A5117F9A11F1D8C27ABA478AE3DA7507", path: "a", mtimeMs: now - 60_000, matchGuid: GUID },
    { replayId: "B".repeat(32), path: "b", mtimeMs: now - 1_000, matchGuid: null }, // still being written
  ];
  const analyzer = new ReplayAnalyzer({
    replays: () => replays,
    analyzed: () => db.replayAnalyzers(),
    extract: extractImpl,
    save: (id, name, r) => db.saveReplayAnalysis(id, name, r),
    canRun,
  });
  return { db, analyzer };
}

describe("analyzing saved replays", () => {
  it("analyzes each settled replay once per analyzer and stores it by match GUID", async () => {
    const { db, analyzer } = setup(async () => extract());
    expect(analyzer.status()).toMatchObject({ pending: 1, running: false });
    expect(await analyzer.tick()).toBe("A5117F9A11F1D8C27ABA478AE3DA7507");
    expect(await analyzer.tick()).toBeNull();
    const row = db.replayAnalysis(GUID.toLowerCase())!;
    expect(row.analysis!.players.find((p) => p.primaryId === ME)!.challenges.whiffs).toBe(11);
    expect(db.replayAnalyzers().get("A5117F9A11F1D8C27ABA478AE3DA7507")).toBe(analyzer.analyzer);
  });

  it("records a failure so a broken file isn't retried until the analyzer changes", async () => {
    const { db, analyzer } = setup(async () => {
      throw new Error("unsupported replay version");
    });
    await analyzer.tick();
    expect(await analyzer.tick()).toBeNull();
    expect(analyzer.status()).toMatchObject({ pending: 0, failed: 1 });
    expect(db.replayAnalyzers().size).toBe(1);
  });

  it("records nothing when the parser itself can't start, and tries again later", async () => {
    const { db, analyzer } = setup(async () => {
      throw new SubtrSetupError("Cannot find module 'subtr-actor.wasm'");
    });
    expect(await analyzer.tick()).toBeNull();
    expect(db.replayAnalyzers().size).toBe(0);
    expect(analyzer.status()).toMatchObject({ pending: 1, failed: 0 });
  });

  it("waits while something is being played", async () => {
    const { analyzer } = setup(async () => extract(), () => false);
    expect(await analyzer.tick()).toBeNull();
    expect(analyzer.status().pending).toBe(1);
  });

  it("anonymizes fixtures: my ID becomes Epic|me|0, others anonNNNN with their names replaced", () => {
    const x = extract();
    const real = { ...x, players: { team0: [{ remote_id: { Steam: "76561190000000000" }, name: "Someone" }], team1: [{ remote_id: { Epic: "real" }, name: "Me" }] } };
    real.events = [{ stream: "demolition", payload: { attacker: { Steam: "76561190000000000" }, victim: { Epic: "real" }, note: "Someone" } }];
    const a = anonymizeExtract(real, ["Epic|real|0"]);
    expect(a.players).toEqual({ team0: [{ remote_id: { Steam: "anon0001" }, name: "Player-001" }], team1: [{ remote_id: { Epic: "me" }, name: "Me" }] });
    expect(a.events[0]!.payload).toEqual({ attacker: { Steam: "anon0001" }, victim: { Epic: "me" }, note: "Player-001" });
  });
});

// Real replays stay out of the repo; point RL_REPLAY at one to check the worker end to end.
describe.skipIf(!process.env.RL_REPLAY)("the subtr-actor worker", () => {
  it("parses a real replay off the main thread", async () => {
    const w = new SubtrWorker();
    try {
      const x = await w.extract(process.env.RL_REPLAY!);
      expect(x.version).toBe("1.5.1");
      expect(x.frames.length).toBeGreaterThan(1000);
      expect(x.events.length).toBeGreaterThan(100);
    } finally {
      await w.close();
    }
  }, 120_000);
});

describe("my replay numbers on Sessions", () => {
  it("come from the analysis of each listed match's replay, matched by my ID, with how many matches have one", async () => {
    const db = new StatsDb(":memory:");
    const [m, ...rest] = (await ingestRecording(fixture("ranked-2s-party"), { myPrimaryIds: [ME], knownTeammates: [] })).sessions.filter((s) => s.kind === "match");
    // The analyzed replay stands in for the first match's.
    db.saveSession({ ...m!, matchGuid: GUID });
    for (const s of rest) db.saveSession(s);
    const analysis = analyzeReplay(extract());
    db.saveReplayAnalysis("A5117F9A11F1D8C27ABA478AE3DA7507", "test", { analysis });
    const mine = analysis.players.find((p) => p.primaryId === ME)!;
    expect([...db.myReplayMetrics()]).toEqual([[m!.id, mine]]);
    const summary = new StatsService(db, {}).summary({});
    expect(summary.replayStats).toMatchObject({ matches: 1, of: summary.stats.decided, races: { won: mine.challenges.wonRace, lost: mine.challenges.beatenToBall } });
    expect(summary.replayStats.perMatch.boost.mean).toBe(mine.boost.average);
    db.close();
  });
});
