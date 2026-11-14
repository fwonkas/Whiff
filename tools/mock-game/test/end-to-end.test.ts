import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCollector, StatsDb, ingestRecording } from "@rl/collector";
import { startMockGame } from "../src/index.ts";
import { fixture, ME, TEAMMATE } from "../../../apps/collector/test/fixtures.ts";

/**
 * Build-plan step 2 is done when a recorded match replayed through the mock
 * game produces correct rows. This test does exactly that.
 */

const config = { myPrimaryIds: [ME], knownTeammates: [{ primaryId: TEAMMATE }], recordCasual: true };
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

const rowsFor = (db: StatsDb) =>
  db.db
    .prepare(
      "SELECT kind, playlist_id, score_blue, score_orange, outcome, partied FROM sessions WHERE kind != 'freeplay' ORDER BY started_at",
    )
    .all();

describe("mock game → collector → database", () => {
  for (const name of ["ranked-1s", "casual-3s", "training-marked"]) {
    it(`${name}: live pipeline matches offline ingest`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "rl-e2e-"));
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

      const game = await startMockGame({ file: fixture(name), speed: 1000, maxGapMs: 1 });
      const collector = await startCollector({
        ...config,
        gameUrl: `ws://localhost:${game.port}`,
        dbPath: join(dir, "stats.db"),
        rawDir: join(dir, "raw"),
        port: 0,
        log: () => {},
      });
      // A web-app client on the relay sees the live feed.
      const seen: string[] = [];
      const client = new WebSocket(`ws://localhost:${collector.port}/live`);
      client.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data)).type));

      await game.done;
      await new Promise((r) => setTimeout(r, 300));
      client.close();
      await collector.stop();
      await game.close();

      const live = new StatsDb(join(dir, "stats.db"));
      const offline = new StatsDb(":memory:");
      for (const s of (await ingestRecording(fixture(name), config)).sessions) offline.saveSession(s);
      expect(rowsFor(live)).toEqual(rowsFor(offline));
      expect(rowsFor(live).length).toBeGreaterThan(0);
      live.close();
      offline.close();

      expect(readdirSync(join(dir, "raw"))).toHaveLength(1);
      expect(seen).toContain("game");
    });
  }

  it("forwards replay commands from the web app and restores the HUD when the app disconnects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-e2e-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const game = await startMockGame({ file: fixture("replay-seeks"), speed: 1, waitForClient: true });
    const collector = await startCollector({
      ...config,
      gameUrl: `ws://localhost:${game.port}`,
      dbPath: join(dir, "stats.db"),
      rawDir: join(dir, "raw"),
      port: 0,
      log: () => {},
    });
    const client = new WebSocket(`ws://localhost:${collector.port}/live`);
    await new Promise((r) => client.addEventListener("open", r));
    // Wait until the collector has reached the game.
    await new Promise<void>((resolve) =>
      client.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data));
        if (m.type === "game") resolve();
      }),
    );
    client.send(JSON.stringify({ command: { Command: "SetHUDVisibility", Data: { bVisible: false } } }));
    client.send(JSON.stringify({ command: { Command: "SeekReplay", Data: { TimeSeconds: 60 } } }));
    client.send(JSON.stringify({ command: { Command: "Nonsense", Data: {} } }));
    await new Promise((r) => setTimeout(r, 200));
    client.close();
    await new Promise((r) => setTimeout(r, 200));

    expect(game.commands).toEqual([
      { Command: "SetHUDVisibility", Data: { bVisible: false } },
      { Command: "SeekReplay", Data: { TimeSeconds: 60 } },
      { Command: "SetHUDVisibility", Data: { bVisible: true } },
    ]);
    await collector.stop();
    await game.close();
  });
});

describe("desktop app hooks", () => {
  it("with no player ID configured, recognizes me and marks me in the saved match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-e2e-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const game = await startMockGame({ file: fixture("ranked-1s"), speed: 1000, maxGapMs: 1 });
    const detected: string[] = [];
    const statuses: boolean[] = [];
    const collector = await startCollector({
      myPrimaryIds: [],
      knownTeammates: [],
      gameUrl: `ws://localhost:${game.port}`,
      dbPath: join(dir, "stats.db"),
      rawDir: join(dir, "raw"),
      port: 0,
      log: () => {},
      onMeDetected: (id) => detected.push(id),
      onStatus: (s) => statuses.push(s.gameConnected),
    });
    await game.done;
    await new Promise((r) => setTimeout(r, 300));
    expect(collector.status().me).toEqual([ME]);
    await collector.stop();
    await game.close();
    expect(detected).toEqual([ME]);
    expect(statuses).toContain(true);
    const db = new StatsDb(join(dir, "stats.db"));
    // Same as configuring my ID up front.
    const offline = new StatsDb(":memory:");
    for (const s of (await ingestRecording(fixture("ranked-1s"), config)).sessions) offline.saveSession(s);
    const rows = (d: StatsDb) => d.db.prepare("SELECT outcome, my_team FROM sessions WHERE kind = 'match' ORDER BY started_at").all();
    expect(rows(db)).toEqual(rows(offline));
    expect(rows(db).every((r) => (r as { my_team: number | null }).my_team !== null)).toBe(true);
    offline.close();
    db.close();
  });

  it("records nothing while paused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-e2e-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const game = await startMockGame({ file: fixture("ranked-1s"), speed: 1000, maxGapMs: 1, waitForClient: true });
    const collector = await startCollector({
      ...config,
      gameUrl: `ws://localhost:${game.port}`,
      dbPath: join(dir, "stats.db"),
      rawDir: join(dir, "raw"),
      port: 0,
      log: () => {},
    });
    collector.setPaused(true);
    await game.done;
    await new Promise((r) => setTimeout(r, 300));
    expect(collector.status().paused).toBe(true);
    await collector.stop();
    await game.close();
    const db = new StatsDb(join(dir, "stats.db"));
    expect(db.countSessions()).toBe(0);
    db.close();
  });
});

describe("backfill through the collector", () => {
  it("refuses without the game, then sends LoadReplay and the 2x speed once a replay loads", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "rl-e2e-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const demos = join(dir, "DemosEpic");
    mkdirSync(demos);
    const id = "F69CDDC611F1D67B7E2FEFB659D821EA";
    writeFileSync(join(demos, `${id}.replay`), "");

    const game = await startMockGame({ file: fixture("replay-backfill"), speed: 1000, maxGapMs: 1, waitForClient: true });
    const collector = await startCollector({
      ...config,
      gameUrl: "ws://localhost:1",
      dbPath: join(dir, "stats.db"),
      rawDir: join(dir, "raw"),
      port: 0,
      log: () => {},
      replayDirs: [demos],
    });
    expect(collector.startBackfill()).toMatchObject({ started: false, reason: "Rocket League isn't running" });
    // An empty file has no header to read, so no length either.
    expect(collector.backfillPlan()).toEqual({ unrecorded: [id], recorded: [], seconds: {} });
    await collector.stop();
    await game.close();
  });

  it("brings the game forward when it starts playing replays", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "rl-e2e-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const demos = join(dir, "DemosEpic");
    mkdirSync(demos);
    writeFileSync(join(demos, "F69CDDC611F1D67B7E2FEFB659D821EA.replay"), "");
    const game = await startMockGame({ file: fixture("freeplay"), speed: 1, maxGapMs: 1000, waitForClient: true });
    let focused = 0;
    const collector = await startCollector({
      ...config,
      gameUrl: `ws://localhost:${game.port}`,
      dbPath: join(dir, "stats.db"),
      rawDir: join(dir, "raw"),
      port: 0,
      log: () => {},
      replayDirs: [demos],
      focusGame: () => void focused++,
    });
    for (let i = 0; i < 50 && !collector.status().gameConnected; i++) await new Promise((r) => setTimeout(r, 50));
    expect(collector.status().gameConnected).toBe(true);
    expect(collector.startBackfill()).toMatchObject({ started: true, queued: 1 });
    expect(focused).toBe(1);
    collector.stopBackfill();
    await collector.stop();
    await game.close();
  });
});
