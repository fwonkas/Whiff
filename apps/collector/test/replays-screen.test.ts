import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "@rl/api-contract";
import { startCollector, type RunningCollector } from "../src/collector.ts";
import { StatsDb } from "../src/db.ts";
import { ingestRecording } from "../src/ingest.ts";
import { fixture, ME } from "./fixtures.ts";
import { minimalHeader } from "./replay-header-writer.ts";

let running: RunningCollector | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

describe("GET /api/replays", () => {
  it("says which matches have a saved replay, which are still in Match History and which are gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-replays-"));
    const dbPath = join(dir, "stats.db");
    const db = new StatsDb(dbPath);
    const sessions = (await ingestRecording(fixture("ranked-2s-party"), { myPrimaryIds: [ME], knownTeammates: [] })).sessions.filter((s) => s.kind === "match");
    for (const s of sessions) db.saveSession(s);
    db.db.close();
    const newest = [...sessions].sort((a, b) => b.endedAt - a.endedAt)[0]!;
    const replays = join(dir, "DemosEpic");
    mkdirSync(replays);
    const replayId = "88A6539011F1D67D7C4FE98443CC66A5";
    writeFileSync(join(replays, `${replayId}.replay`), minimalHeader({ replayId, matchGuid: newest.matchGuid!, date: "2026-10-22 01-49-28", goals: [] }));

    running = await startCollector({ myPrimaryIds: [ME], knownTeammates: [], gameUrl: "ws://127.0.0.1:9", dbPath, rawDir: join(dir, "raw"), port: 0, log: () => {}, replayDirs: [replays] });
    const api = createApiClient(`http://127.0.0.1:${running.port}`);
    const r = await api.replays();

    expect(r.counts.matches).toBe(sessions.length);
    expect(r.matches.find((m) => m.sessionId === newest.id)).toMatchObject({ state: "saved", replayId, played: false, history: null });
    // The recording is from 2026-10-21, older than Match History's 30 days by now, so the rest are gone.
    const ageDays = (Date.now() - newest.endedAt) / 86_400_000;
    const others = r.matches.filter((m) => m.sessionId !== newest.id);
    if (ageDays > 30) expect(others.every((m) => m.state === "missing")).toBe(true);
    else expect(others.every((m) => m.state === "in-history" && m.history!.position >= 2 && m.history!.position <= 20)).toBe(true);
    expect(r.toPlay).toMatchObject({ unrecorded: 0, recorded: 1 });
    expect(r.gameConnected).toBe(false);

    // Sessions filters the same way: saved, or needs attention (not saved yet), with counts for each.
    const saved = await api.sessions({ replay: "saved" });
    expect(saved.items.map((i) => i.id)).toEqual([newest.id]);
    const attention = await api.sessions({ replay: "attention" });
    expect(attention.items).toHaveLength(sessions.length - 1);
    expect(attention.items.every((i) => i.kind === "match")).toBe(true);
    const summary = await api.summary({ replay: "saved" });
    expect(summary.matches).toBe(1);
    expect(summary.replayCounts).toEqual({ total: sessions.length, attention: sessions.length - 1, saved: 1 });
    // Result counts follow the replay filter.
    expect(summary.resultCounts.total).toBe(1);

    // Delete the match whose replay is saved: its replay is no longer offered for playing,
    // since a playback of a deleted match isn't kept (2026-11-04: three replays stayed "to play").
    await api.deleteSession(newest.id);
    const after = await api.replays();
    expect(after.counts.matches).toBe(sessions.length - 1);
    expect(after.toPlay).toMatchObject({ unrecorded: 0, recorded: 0 });

    // Playing needs the game.
    await expect(api.startBackfill()).rejects.toThrow(/Rocket League isn't running/);
    await expect(api.fetchMissingFromBallchasing()).rejects.toThrow(/no ballchasing API key/);
  });
});
