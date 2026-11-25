import { describe, expect, it, vi } from "vitest";
import type { Session } from "@rl/domain";
import type { GameCommand, GameMessage } from "@rl/schema";
import { Backfill, BACKFILL_CUT_PAUSE_MS, BACKFILL_LOAD_TIMEOUT_MS, BACKFILL_QUIT_DELAY_MS, BACKFILL_RECORDED_SPEED, BACKFILL_SPEED, BACKFILL_STALL_MS } from "../src/backfill.ts";
import { keepGameOpen } from "../src/collector.ts";
import { readRecording } from "../src/recording.ts";
import { Sessionizer } from "../src/sessionizer.ts";
import { listSavedReplays, matchHistoryRisk, planBackfill, replayDirsIn, replayFolderSignature } from "../src/replay-files.ts";
import { fixture, ME } from "./fixtures.ts";

const FORFEIT = "88A6539011F1D67D7C4FE98443CC66A5";
const OVERTIME = "F69CDDC611F1D67B7E2FEFB659D821EA";

describe("Backfill", () => {
  it("plays each replay to its end at its own speed and moves on (the 2026-11-01 playbacks)", async () => {
    const sent: GameCommand[] = [];
    const b = new Backfill({ send: (c) => (sent.push(c), true) });
    let started = false;
    for await (const e of readRecording(fixture("replay-backfill"))) {
      if (e.kind !== "message") continue;
      if (!started) {
        b.start([{ replayId: FORFEIT, speed: BACKFILL_RECORDED_SPEED }, OVERTIME], e.receivedAt);
        started = true;
      }
      b.ingest(e.receivedAt, e.msg);
      b.tick(e.receivedAt);
    }
    // The recording stops right after the second replay's end pause.
    b.tick(Number.MAX_SAFE_INTEGER / 2);
    expect(sent).toEqual([
      { Command: "LoadReplay", Data: { FileName: FORFEIT } },
      { Command: "SetGameSpeed", Data: { Speed: 2 } },
      { Command: "LoadReplay", Data: { FileName: OVERTIME } },
      { Command: "SetGameSpeed", Data: { Speed: BACKFILL_SPEED } },
    ]);
    expect(b.progress()).toEqual({ running: false, current: null, done: 2, failed: 0, remaining: 0, remainingMs: null, quitWhenDone: false });
  });

  it("ends the last replay's playback itself: it stays open in the game, and unsaved it would count as unplayed", async () => {
    // 2026-11-13: after "Play all", the button still said "Play all 1": the last
    // replay sat paused on its final frame, and a playback is saved when it closes.
    const sessions: Session[] = [];
    const sz = new Sessionizer({ myPrimaryIds: [ME], knownTeammates: [] }, (s) => sessions.push(s));
    const ended: string[] = [];
    const b = new Backfill({
      send: () => true,
      onReplayDone: (id, at) => {
        ended.push(id);
        sz.endReplay(at);
      },
    });
    let started = false;
    let last = 0;
    for await (const e of readRecording(fixture("replay-backfill"))) {
      if (e.kind !== "message") continue;
      if (!started) {
        b.start([FORFEIT, OVERTIME], e.receivedAt);
        started = true;
      }
      sz.ingest(e.receivedAt, e.msg);
      b.ingest(e.receivedAt, e.msg);
      b.tick(e.receivedAt);
      last = e.receivedAt;
    }
    // The recording stops on the second replay's end pause; the game never closes it.
    b.tick(last + 60_000);
    expect(ended).toEqual([OVERTIME]);
    const replays = sessions.filter((s) => s.kind === "replay");
    expect(replays.map((s) => [s.replayId, s.playback?.complete])).toEqual([
      [FORFEIT, true],
      [OVERTIME, true],
    ]);
    // Leaving the replay afterwards changes nothing.
    sz.ingest(last + 61_000, { Event: "MatchDestroyed", Data: { MatchGuid: "" } } as GameMessage);
    sz.flush();
    expect(sessions.filter((s) => s.kind === "replay")).toHaveLength(2);
  });

  describe("closing the game when the run is done", () => {
    /** Plays the two recorded playbacks as a run. Resolves to when the run ended (finished or stopped). */
    async function run(b: Backfill, options: { quitWhenDone?: boolean }, during?: (done: number) => void) {
      let started = false;
      let last = 0;
      for await (const e of readRecording(fixture("replay-backfill"))) {
        if (e.kind !== "message") continue;
        if (!started) {
          b.start([FORFEIT, OVERTIME], e.receivedAt, options);
          started = true;
        }
        b.ingest(e.receivedAt, e.msg);
        b.tick(e.receivedAt);
        last = e.receivedAt;
        if (!b.progress().running) return last;
        during?.(b.progress().done);
      }
      // The recording stops in the last replay's end pause.
      b.tick(last + 4_000);
      return last + 4_000;
    }
    const liveTick = { Event: "UpdateState", Data: { Game: { bReplay: false } } } as unknown as GameMessage;

    it("quits a few seconds after the last replay ends, once, and only when asked", async () => {
      const quit = vi.fn();
      const b = new Backfill({ send: () => true, quit });
      const end = await run(b, { quitWhenDone: true }, () => expect(quit).not.toHaveBeenCalled());
      expect(b.progress()).toMatchObject({ running: false, done: 2, quitWhenDone: false });
      b.tick(end + BACKFILL_QUIT_DELAY_MS - 1);
      expect(quit).not.toHaveBeenCalled();
      b.tick(end + BACKFILL_QUIT_DELAY_MS);
      b.tick(end + 60_000);
      expect(quit).toHaveBeenCalledTimes(1);

      const plain = vi.fn();
      const c = new Backfill({ send: () => true, quit: plain });
      c.tick((await run(c, {})) + 60_000);
      expect(plain).not.toHaveBeenCalled();
    });

    it("can be switched on or off while the run plays", async () => {
      const quit = vi.fn();
      const b = new Backfill({ send: () => true, quit });
      b.tick((await run(b, { quitWhenDone: true }, (done) => done === 1 && b.setQuitWhenDone(false))) + 60_000);
      expect(quit).not.toHaveBeenCalled();

      const c = new Backfill({ send: () => true, quit });
      c.tick((await run(c, {}, (done) => done === 1 && c.setQuitWhenDone(true))) + 60_000);
      expect(quit).toHaveBeenCalledTimes(1);
    });

    it("never quits after a stop, or when live play or a Watch starts in the wait", async () => {
      const quit = vi.fn();
      // Stopped by hand during the second replay.
      const stopped = new Backfill({ send: () => true, quit });
      stopped.tick((await run(stopped, { quitWhenDone: true }, (done) => done === 1 && stopped.stop("stopped"))) + 60_000);
      // Finished, then a second of live play before the quit.
      const live = new Backfill({ send: () => true, quit });
      const l = await run(live, { quitWhenDone: true });
      for (let i = 0; i < 30; i++) live.ingest(l + 100 + i * 33, liveTick);
      live.tick(l + 60_000);
      // Finished, then a replay opened from the dashboard (Watch stops the run first).
      const watch = new Backfill({ send: () => true, quit });
      const w = await run(watch, { quitWhenDone: true });
      watch.stop("replay remote took over");
      watch.tick(w + 60_000);
      expect(quit).not.toHaveBeenCalled();
    });
  });

  it("ends a replay skipped for not advancing, and the run still closes the game (2026-11-15)", async () => {
    // A replay stopped advancing near the end of a run; its session stayed open for ten hours,
    // and the run, seeing a session in progress, left the game running.
    const sessions: Session[] = [];
    const sz = new Sessionizer({ myPrimaryIds: [ME], knownTeammates: [] }, (s) => sessions.push(s));
    const ended: string[] = [];
    const quit = vi.fn();
    const b = new Backfill({
      send: () => true,
      quit,
      onReplayDone: (id, at) => {
        ended.push(id);
        sz.endReplay(at);
      },
    });
    let started = false;
    let last = 0;
    let playingFrom: number | null = null;
    for await (const e of readRecording(fixture("replay-backfill"))) {
      if (e.kind !== "message") continue;
      if (!started) {
        b.start([FORFEIT, "MISSING"], e.receivedAt, { quitWhenDone: true });
        started = true;
      }
      sz.ingest(e.receivedAt, e.msg);
      b.ingest(e.receivedAt, e.msg);
      b.tick(e.receivedAt);
      last = e.receivedAt;
      // 20 s into the first replay's play (it starts paused through the seeks), the game goes quiet.
      if (e.msg.Event === "MatchUnpaused") playingFrom = e.receivedAt;
      if (e.msg.Event === "MatchPaused") playingFrom = null;
      if (playingFrom !== null && e.receivedAt - playingFrom > 20_000) break;
    }
    b.tick(last + BACKFILL_STALL_MS + 1);
    expect(ended).toEqual([FORFEIT]);
    expect(sz.active).toBeNull();
    expect(sessions.filter((s) => s.kind === "replay").map((s) => [s.replayId, s.playback?.complete])).toEqual([[FORFEIT, false]]);
    // The next one never loads; the run finishes and closes the game.
    const done = last + BACKFILL_STALL_MS + 1 + BACKFILL_LOAD_TIMEOUT_MS + 1;
    b.tick(done);
    expect(b.progress()).toMatchObject({ running: false, done: 0, failed: 2 });
    b.tick(done + BACKFILL_QUIT_DELAY_MS);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("closes the game unless live play is in progress", () => {
    const base = { stopped: false, gameConnected: true };
    expect(keepGameOpen({ ...base, active: null })).toBeNull();
    expect(keepGameOpen({ ...base, active: { kind: "replay" } })).toBeNull();
    expect(keepGameOpen({ ...base, active: { kind: "match" } })).toBe("match in progress");
    expect(keepGameOpen({ ...base, active: { kind: "freeplay" } })).toBe("freeplay in progress");
    expect(keepGameOpen({ ...base, gameConnected: false, active: null })).toBe("the game isn't connected");
  });

  it("skips a replay that never loads", () => {
    const sent: GameCommand[] = [];
    const b = new Backfill({ send: (c) => (sent.push(c), true) });
    b.start(["MISSING", "NEXT"], 0);
    b.tick(BACKFILL_LOAD_TIMEOUT_MS + 1);
    expect(sent.map((c) => (c.Command === "LoadReplay" ? c.Data.FileName : c.Command))).toEqual(["MISSING", "NEXT"]);
    expect(b.progress()).toMatchObject({ running: true, current: "NEXT", failed: 1, remaining: 0 });
  });

  it("keeps going through a replay paused at a goal, where ticks say bReplay false but keep their Frame (2026-11-22)", async () => {
    const sent: GameCommand[] = [];
    const logs: string[] = [];
    const b = new Backfill({ send: (c) => (sent.push(c), true), log: (l) => logs.push(l) });
    b.start(["A", "B"], 0);
    b.ingest(1000, { Event: "ReplayCreated", Data: { MatchGuid: "", FileName: "A" } } as GameMessage);
    const tick = (frame: number | undefined, bReplay: boolean) =>
      ({ Event: "UpdateState", Data: { MatchGuid: "G", Players: [], Game: { bReplay, ...(frame === undefined ? {} : { Frame: frame }), TimeSeconds: 156 } } }) as unknown as GameMessage;
    b.ingest(1900, { Event: "MatchPaused", Data: { MatchGuid: "G" } } as GameMessage);
    for (let t = 2000; t < 10_000; t += 33) {
      b.ingest(t, tick(3959, false));
      b.tick(t);
    }
    // Not stopped, and not taken for the replay's end (a pause there has bReplay true).
    expect(b.progress()).toMatchObject({ running: true, current: "A", done: 0 });
    expect(sent.at(-1)).not.toEqual({ Command: "SetMatchPaused", Data: { bPaused: false } });
    // Still paused there after 10 s: the run resumes it.
    for (let t = 10_000; t <= 1900 + BACKFILL_CUT_PAUSE_MS; t += 100) b.tick(t);
    expect(sent.at(-1)).toEqual({ Command: "SetMatchPaused", Data: { bPaused: false } });
    expect(logs.at(-1)).toBe("backfill: A paused at frame 3959 mid-replay, resumed");
    // Live play (no Frame) still stops it.
    for (let t = 10_000; t < 14_000; t += 33) b.ingest(t, tick(undefined, false));
    expect(b.progress().running).toBe(false);
    // Starting again isn't stopped by the live ticks that stopped the last run.
    b.start(["A"], 15_000);
    b.ingest(15_100, tick(undefined, false));
    expect(b.progress()).toMatchObject({ running: true, current: "A" });
  });

  it("stops when live play starts or the game isn't connected", async () => {
    const b = new Backfill({ send: () => true });
    b.start(["A", "B"], 0);
    for await (const e of readRecording(fixture("ranked-1s"))) {
      if (e.kind === "message") b.ingest(e.receivedAt, e.msg);
      if (!b.progress().running) break;
    }
    expect(b.progress()).toMatchObject({ running: false, remaining: 0 });

    const offline = new Backfill({ send: () => false });
    offline.start(["A"], 0);
    expect(offline.progress().running).toBe(false);
  });
});

describe("choosing replays to backfill", () => {
  it("lists .replay files by ID, newest first, from every folder given", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const docs = mkdtempSync(join(tmpdir(), "rl-docs-"));
    const [epic, steam] = replayDirsIn(docs);
    mkdirSync(epic!, { recursive: true });
    mkdirSync(steam!, { recursive: true });
    writeFileSync(join(epic!, `${FORFEIT}.replay`), "");
    writeFileSync(join(steam!, `${OVERTIME.toLowerCase()}.replay`), "");
    writeFileSync(join(epic!, "notes.txt"), "");
    utimesSync(join(epic!, `${FORFEIT}.replay`), 1000, 1000);
    utimesSync(join(steam!, `${OVERTIME.toLowerCase()}.replay`), 2000, 2000);
    expect(listSavedReplays(replayDirsIn(docs)).map((r) => r.replayId)).toEqual([OVERTIME, FORFEIT]);
    expect(listSavedReplays([join(docs, "missing")])).toEqual([]);

    // A replay saved or deleted changes the folders' signature (it tells open dashboards); other files don't.
    const before = replayFolderSignature(replayDirsIn(docs));
    writeFileSync(join(epic!, "more-notes.txt"), "");
    expect(replayFolderSignature(replayDirsIn(docs))).toBe(before);
    writeFileSync(join(epic!, `${"A".repeat(32)}.replay`), "");
    expect(replayFolderSignature(replayDirsIn(docs))).not.toBe(before);
  });

  it("skips replays played through, and puts matches never recorded live first", () => {
    const min = 60_000;
    const r = (replayId: string, mtimeMs: number, matchGuid: string | null = null) => ({ replayId, path: "", mtimeMs, matchGuid, matchEndedAt: null, seconds: 300, matchType: "Online", numFrames: null });
    const replays = [
      r("A", 100 * min), // unreadable header, saved a minute after a live match ended
      r("B", 200 * min), // unreadable header, no live match near it
      r("C", 300 * min, "G3"), // already played through
      r("D", 400 * min, "G1"), // its match was recorded live, though saved much later
      r("E", 500 * min, "G2"), // never recorded live
    ];
    expect(planBackfill(replays, new Set(["C"]), { guids: new Set(["G1"]), ends: [99 * min, 150 * min] })).toMatchObject({
      unrecorded: ["E", "B"],
      recorded: ["D", "A"],
    });
  });

  it("knows which replays the database has seen played through", async () => {
    const { StatsDb } = await import("../src/db.ts");
    const { ingestRecording } = await import("../src/ingest.ts");
    const db = new StatsDb(":memory:");
    for (const s of (await ingestRecording(fixture("replay-backfill"), { myPrimaryIds: ["Epic|me|0"], knownTeammates: [] })).sessions) db.saveSession(s);
    for (const s of (await ingestRecording(fixture("replay-seeks"), { myPrimaryIds: ["Epic|me|0"], knownTeammates: [] })).sessions) db.saveSession(s);
    // replay-seeks skipped ahead, so it doesn't count.
    expect([...db.playedReplayIds()].sort()).toEqual([FORFEIT, OVERTIME].sort());
    db.close();
  });
});

describe("backfill time estimates", () => {
  it("estimates from each replay's length at the playback speed, then corrects with what replays actually took", () => {
    const b = new Backfill({ send: () => true });
    b.start([{ replayId: "A", seconds: 300 }, { replayId: "B", seconds: 300 }], 0);
    // 300 s of play at 1x plus 20 s of loading and countdowns, twice.
    expect(b.progress(0).remainingMs).toBe(640_000);
    expect(b.progress(60_000).remainingMs).toBe(580_000);
    // A recorded match plays at 2x: half the play time.
    b.start([{ replayId: "A", seconds: 300, speed: 2 }], 0);
    expect(b.progress(0).remainingMs).toBe(170_000);
  });
});

describe("Match History check", () => {
  const day = 86_400_000;
  const now = 100 * day;
  const match = (n: number, ageDays = n * 0.1) => ({ matchGuid: `G${n}`, endedAt: now - ageDays * day });

  it("warns about unsaved matches in the last 5 places (16 to 20) by default, newest first, and says how soon each drops", () => {
    const matches = Array.from({ length: 25 }, (_, i) => match(i + 1)); // G1 newest
    const saved = new Set(["G18"]);
    const r = matchHistoryRisk(matches, saved, now);
    expect(r.unsaved).toHaveLength(19);
    expect(r.atRisk.map((m) => m.matchGuid)).toEqual(["G16", "G17", "G19", "G20"]);
    // G20 goes with the next match; G16 after 5 more.
    expect(r.dropsIn.get("G20")).toBe(1);
    expect(r.dropsIn.get("G16")).toBe(5);
    expect(r.dropsIn.has("G21")).toBe(false);
  });

  it("warns as early as the setting asks", () => {
    const matches = Array.from({ length: 25 }, (_, i) => match(i + 1));
    expect(matchHistoryRisk(matches, new Set(), now, 3).atRisk.map((m) => m.matchGuid)).toEqual(["G18", "G19", "G20"]);
    expect(matchHistoryRisk(matches, new Set(), now, 10).atRisk).toHaveLength(10);
  });

  it("warns near the 30-day limit, and not at all while the list is short", () => {
    expect(matchHistoryRisk([match(1, 1), match(2, 28)], new Set(), now).atRisk.map((m) => m.matchGuid)).toEqual(["G2"]);
    expect(matchHistoryRisk([match(1, 1), match(2, 2)], new Set(), now).atRisk).toEqual([]);
    expect(matchHistoryRisk([match(1, 31)], new Set(), now).unsaved).toEqual([]);
  });
});
