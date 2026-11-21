import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApiClient } from "@rl/api-contract";
import type { GameCommand, GameMessage } from "@rl/schema";
import { createApi } from "../src/api.ts";
import { StatsDb } from "../src/db.ts";
import { ingestRecording } from "../src/ingest.ts";
import { readRecording } from "../src/recording.ts";
import { ReplayRemote } from "../src/replay-remote.ts";
import { StatsService } from "../src/service.ts";
import { fixture, ME } from "./fixtures.ts";
import { minimalHeader } from "./replay-header-writer.ts";

const REPLAY = "88A6539011F1D67D7C4FE98443CC66A5";
const GUID = "8FC9377E11F1D67C99C2E9845776FF5B";
const created = (fileName: string): GameMessage => ({ Event: "ReplayCreated", Data: { MatchGuid: "", FileName: fileName, Date: "" } }) as GameMessage;

describe("ReplayRemote", () => {
  it("loads the replay, then seeks a few seconds before the frame at normal speed", async () => {
    const sent: GameCommand[] = [];
    const timers: (() => void)[] = [];
    const r = new ReplayRemote({ send: (c) => (sent.push(c), true), setTimer: (fn) => timers.push(fn) });
    expect(r.goto(REPLAY.toLowerCase(), 1000, 6, 0)).toEqual({ ok: true, status: "loading" });
    expect(sent).toEqual([{ Command: "LoadReplay", Data: { FileName: REPLAY } }]);
    r.ingest(10, created(REPLAY));
    timers.shift()!();
    // 6 s at about 22 frames a second: frame 868, and SeekReplay takes frame / 30.
    await new Promise((x) => setTimeout(x, 0));
    // Lands paused; with nothing to bring forward, play starts at once.
    expect(sent.slice(1)).toEqual([
      { Command: "SetGameSpeed", Data: { Speed: 1 } },
      { Command: "SeekReplay", Data: { TimeSeconds: 868 / 30 } },
      { Command: "SetMatchPaused", Data: { bPaused: true } },
      { Command: "SetMatchPaused", Data: { bPaused: false } },
    ]);
    // Already open: seek straight away.
    expect(r.goto(REPLAY, 2000, 0, 20)).toEqual({ ok: true, status: "seeking" });
    expect(sent.at(-2)).toEqual({ Command: "SeekReplay", Data: { TimeSeconds: 2000 / 30 } });
  });

  it("waits to play until the game is in front", async () => {
    const sent: GameCommand[] = [];
    let bringForward: () => void = () => {};
    const r = new ReplayRemote({
      send: (c) => (sent.push(c), true),
      focusGame: () => new Promise<void>((resolve) => (bringForward = resolve)),
      setTimer: (fn, ms) => (ms === 300 ? fn() : undefined), // the short beat runs at once; the 4 s timeout never fires
    });
    r.ingest(0, created(REPLAY));
    r.goto(REPLAY, 1000, 0, 10);
    await new Promise((x) => setTimeout(x, 0));
    expect(sent.at(-1)).toEqual({ Command: "SetMatchPaused", Data: { bPaused: true } });
    bringForward();
    await new Promise((x) => setTimeout(x, 0));
    expect(sent.at(-1)).toEqual({ Command: "SetMatchPaused", Data: { bPaused: false } });
  });

  it("points the camera at my car once the replay shows the new frame, and brings the game forward", () => {
    const sent: GameCommand[] = [];
    let focused = 0;
    const r = new ReplayRemote({ send: (c) => (sent.push(c), true), me: () => ["Epic|me|0"], focusGame: () => void focused++ });
    r.ingest(0, created(REPLAY));
    const tick = (frame: number): GameMessage =>
      ({
        Event: "UpdateState",
        Data: {
          MatchGuid: "",
          Players: [
            { Name: "Someone", PrimaryId: "Steam|1|0", Shortcut: 1, TeamNum: 1 },
            { Name: "Origami Box", PrimaryId: "Epic|me|0", Shortcut: 4, TeamNum: 0 },
          ],
          Game: { Teams: [], PlaylistId: 13, TimeSeconds: 200, bOvertime: false, Ball: { Speed: 0, TeamNum: 255 }, bReplay: true, bHasWinner: false, Winner: "", Arena: "x", bHasTarget: false, Frame: frame },
        },
      }) as unknown as GameMessage;
    r.ingest(5, tick(3000)); // playing later in the replay
    expect(r.goto(REPLAY, 1000, 0, 10)).toEqual({ ok: true, status: "seeking" });
    expect(focused).toBe(1);
    const before = sent.length;
    r.ingest(20, tick(3001)); // a tick from before the seek took: not yet
    expect(sent.length).toBe(before);
    const destroyed = { Event: "MatchDestroyed", Data: { MatchGuid: "" } } as GameMessage;
    r.ingest(30, destroyed); // the seek took
    r.ingest(40, tick(1002));
    expect(sent.at(-1)).toEqual({ Command: "ChangePOV", Data: { Focus: "4", Perspective: "PlayerView" } });
    // Director camera on request.
    r.goto(REPLAY, 2000, 0, 50, "director");
    // Seeking back from just after the target: the stale frame is in range, but the seek hasn't taken.
    r.ingest(55, tick(2010));
    expect(sent.at(-1)).toEqual({ Command: "SetMatchPaused", Data: { bPaused: true } });
    r.ingest(58, destroyed);
    r.ingest(60, tick(2000));
    expect(sent.at(-1)).toEqual({ Command: "ChangePOV", Data: { Perspective: "Camera_Director" } });
  });

  it("after a player left, aims at my car again until the camera stays on it (2026-11-15/16)", () => {
    // 2s: my teammate (shortcut 1) left at 2:41; after a seek past that, ticks say I'm 1 (I'd been 2).
    // Pointing at 1 attached and dropped a few frames later (2026-11-16); pointing at 2 found nothing (Fly).
    const sent: GameCommand[] = [];
    const logs: string[] = [];
    const r = new ReplayRemote({ send: (c) => (sent.push(c), true), me: () => ["Epic|me|0"], log: (l) => logs.push(l) });
    const G = "51C17E4C11F1E0BC52889AAFC25E20E3";
    const player = (Name: string, Shortcut: number, TeamNum: number, PrimaryId = `Steam|${Shortcut}|0`) => ({ Name, PrimaryId, Shortcut, TeamNum });
    const tick = (frame: number, players: ReturnType<typeof player>[], target?: string): GameMessage =>
      ({
        Event: "UpdateState",
        Data: {
          MatchGuid: G,
          Players: players,
          Game: {
            Teams: [], PlaylistId: 11, TimeSeconds: 200, bOvertime: false, Ball: { Speed: 0, TeamNum: 255 }, bReplay: true, bHasWinner: false, Winner: "", Arena: "x",
            bHasTarget: !!target, ...(target ? { Target: { Name: target, Shortcut: 0, TeamNum: 0 } } : {}), Frame: frame,
          },
        },
      }) as unknown as GameMessage;
    const me = (s: number) => player("Origami Box", s, 0, "Epic|me|0");
    const all = [player("Opp A", 5, 1), player("Teammate", 1, 0), me(2), player("Opp B", 6, 1)];
    const after = [player("Opp A", 5, 1), me(1), player("Opp B", 6, 1)];
    const destroyed = { Event: "MatchDestroyed", Data: { MatchGuid: G } } as GameMessage;
    const pov = (s: number) => ({ Command: "ChangePOV", Data: { Focus: String(s), Perspective: "PlayerView" } });

    r.ingest(0, created(REPLAY));
    r.ingest(100, tick(28, all, "Origami Box"));
    r.goto(REPLAY, 5148, 5, 200); // lands at 5038
    r.ingest(300, destroyed);
    r.ingest(400, tick(5040, after));
    expect(sent.at(-1)).toEqual(pov(1)); // the shortcut ticks show now
    r.ingest(450, tick(5047, after, "Origami Box")); // attached...
    r.ingest(500, tick(5050, after)); // ...and dropped
    r.ingest(1400, tick(5070, after));
    expect(sent.filter((c) => c.Command === "ChangePOV")).toHaveLength(2); // aimed again after 1 s without it
    r.ingest(1500, tick(5072, after, "Origami Box"));
    r.ingest(3100, tick(5110, after, "Origami Box")); // held for 1.5 s: done
    r.ingest(6000, tick(5200, after));
    expect(sent.filter((c) => c.Command === "ChangePOV")).toHaveLength(2);
    expect(logs.at(-1)).toBe("replay remote: the camera held on my car after 2 tries (targets: none → Origami Box → none → Origami Box)");

    // It gives up after 5 tries with a log line.
    sent.length = 0;
    r.goto(REPLAY, 5148, 5, 7000);
    r.ingest(7100, destroyed);
    for (let t = 7200; t <= 13_000; t += 500) r.ingest(t, tick(5040 + (t - 7200) / 50, after));
    expect(sent.filter((c) => c.Command === "ChangePOV")).toEqual(Array(5).fill(pov(1)));
    expect(logs.at(-1)).toBe("replay remote: the camera didn't stay on my car after 5 tries (targets: none)");
  });

  it("opens a replay to watch from the start at normal speed, without seeking", () => {
    const sent: GameCommand[] = [];
    const r = new ReplayRemote({ send: (c) => (sent.push(c), true) });
    expect(r.watch(REPLAY.toLowerCase())).toEqual({ ok: true, status: "loading" });
    expect(sent).toEqual([{ Command: "LoadReplay", Data: { FileName: REPLAY } }]);
    r.ingest(10, created(REPLAY));
    // Loaded: 1x ("Play all" may have left the game at 2x), no seek or pause; opening it again just brings the game forward.
    expect(sent.slice(1)).toEqual([{ Command: "SetGameSpeed", Data: { Speed: 1 } }]);
    expect(r.watch(REPLAY)).toEqual({ ok: true, status: "open" });
    expect(sent).toHaveLength(2);
  });

  it("loads the replay again after it was left for the menu (MatchDestroyed, then nothing)", () => {
    const sent: GameCommand[] = [];
    const r = new ReplayRemote({ send: (c) => (sent.push(c), true) });
    r.ingest(0, created(REPLAY));
    const destroyed = { Event: "MatchDestroyed", Data: {} } as GameMessage;
    const matchCreated = { Event: "MatchCreated", Data: {} } as GameMessage;
    // A seek: destroyed and recreated at once, still open.
    r.ingest(1000, destroyed);
    r.ingest(1500, matchCreated);
    expect(r.watch(REPLAY, 9000)).toEqual({ ok: true, status: "open" });
    // Left: destroyed, nothing after.
    r.ingest(10_000, destroyed);
    expect(r.watch(REPLAY, 20_000)).toEqual({ ok: true, status: "loading" });
    expect(sent.at(-1)).toEqual({ Command: "LoadReplay", Data: { FileName: REPLAY } });
  });

  it("says so when the game isn't connected", () => {
    const r = new ReplayRemote({ send: () => false });
    expect(r.goto(REPLAY, 10, 0, 0)).toEqual({ ok: false, reason: "Rocket League isn't connected" });
  });
});

describe("GET /api/sessions/:id/review", () => {
  const config = { myPrimaryIds: [ME], knownTeammates: [] };
  const setup = async (withFile: boolean) => {
    const db = new StatsDb(":memory:");
    for (const name of ["tournament-live", "replay-backfill"]) {
      for (const s of (await ingestRecording(fixture(name), config)).sessions) db.saveSession(s);
    }
    const dir = mkdtempSync(join(tmpdir(), "rl-demos-"));
    if (withFile) {
      const goals = [100, 200, 300, 400, 500].map((frame, i) => ({ frame, team: i === 1 ? 0 : 1 }));
      writeFileSync(join(dir, `${REPLAY}.replay`), minimalHeader({ replayId: REPLAY, matchGuid: GUID, date: "2026-11-02 05-23-27", goals }));
    }
    const api = createApi({ service: new StatsService(db, { replayDirs: [dir] }), gameConnected: () => false });
    return { db, client: createApiClient("http://test", (input, init) => Promise.resolve(api.request(String(input), init))) };
  };
  const liveId = (db: StatsDb) => (db.db.prepare("SELECT id FROM sessions WHERE kind = 'match' AND match_guid = ?").get(GUID) as { id: string }).id;

  it("takes goal frames from the saved replay's header", async () => {
    const { db, client } = await setup(true);
    const r = await client.review(liveId(db));
    expect(r.replay).toEqual({ replayId: REPLAY, saved: true, played: true, playedFast: false });
    // 1-4 loss: the second goal was ours.
    expect(r.moments.map((m) => [m.kind, m.frame])).toEqual([
      ["goal-against", 100],
      ["goal-for", 200],
      ["goal-against", 300],
      ["goal-against", 400],
      ["goal-against", 500],
    ]);
  });

  it("falls back to a playback's frame index when the file is gone", async () => {
    const { db, client } = await setup(false);
    const r = await client.review(liveId(db));
    expect(r.replay).toEqual({ replayId: REPLAY, saved: false, played: true, playedFast: false });
    expect(r.moments).toHaveLength(5);
    expect(r.moments.every((m) => m.frame !== null && m.frame > 0)).toBe(true);
    const frames = r.moments.map((m) => m.frame!);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
  });
});

describe("ReplayRemote after the goal", () => {
  // replay-backfill plays 88A65390… through: goals at frames 1223 and 1797, each
  // followed by GoalReplayStart (the cut to the next kickoff) about 66 frames later.
  async function jumpToSecondGoal() {
    const sent: { cmd: GameCommand; frame: number | undefined }[] = [];
    let frame: number | undefined;
    const r = new ReplayRemote({ send: (cmd) => (sent.push({ cmd, frame }), true) });
    let jumped = false;
    for await (const e of readRecording(fixture("replay-backfill"))) {
      if (e.kind !== "message") continue;
      if (e.msg.Event === "UpdateState") frame = e.msg.Data.Game.Frame;
      r.ingest(e.receivedAt, e.msg);
      if (!jumped && r.openReplay === REPLAY) {
        expect(r.goto(REPLAY, 1797, 10, e.receivedAt, "keep")).toEqual({ ok: true, status: "seeking" });
        jumped = true;
        await new Promise((x) => setTimeout(x, 0)); // play starts
      }
    }
    return { r, sent };
  }
  const pausedAt = (sent: { cmd: GameCommand; frame: number | undefined }[]) =>
    sent.filter((s) => s.cmd.Command === "SetMatchPaused" && s.cmd.Data.bPaused).map((s) => s.frame);

  it("pauses just before the replay cuts to the next kickoff, only after the goal jumped to", async () => {
    const { sent } = await jumpToSecondGoal();
    // The seek lands paused, then the stop: 58 frames after goal 1797, just
    // before the cut at 1864, and not after the earlier goal or the later ones.
    const paused = pausedAt(sent);
    expect(paused).toHaveLength(2);
    expect(paused[1]).toBe(1855);
  });

  it("pauses after the goal when the game sends no GoalReplayStart, ignoring the events and stale frames seeks bring", async () => {
    // A playback from 2026-11-04: goals at 7159 and 1010, each followed by
    // CountdownBegin alone (at 7245 and 1095). The recording's own seeks
    // (a jump to 7159, the shortcut back, a jump to 1010 from 7038) send
    // CountdownBegin too, while ticks still show the frame from before.
    const REPLAY2 = "D6920A0B43704CE946A40CAE499B0243";
    const sent: { cmd: GameCommand; frame: number | undefined }[] = [];
    let frame: number | undefined;
    const r = new ReplayRemote({ send: (cmd) => (sent.push({ cmd, frame }), true) });
    for await (const e of readRecording(fixture("replay-pause-after-goal"))) {
      if (e.kind === "sent") {
        // Replay the jumps the collector made, by the seek it sent.
        const c = e.command as GameCommand;
        if (c.Command === "SeekReplay") r.goto(REPLAY2, (c.Data.TimeSeconds ?? 0) * 30 + 10 * 22, 10, e.receivedAt, "keep");
        continue;
      }
      if (e.kind !== "message") continue;
      if (e.msg.Event === "UpdateState") frame = e.msg.Data.Game.Frame;
      r.ingest(e.receivedAt, e.msg);
    }
    const stops = sent.filter((s, i) => s.cmd.Command === "SetMatchPaused" && s.cmd.Data.bPaused && sent[i - 1]?.cmd.Command !== "SeekReplay");
    // Goals at 7159 and 1010 (the cuts at 7245 and 1095).
    expect(stops.map((s) => s.frame)).toEqual([7217, 1067]);
  });

  it("jumps back without reloading while paused at the cut, and sets the camera only once each seek has taken", async () => {
    // 2026-11-04: a jump to the goal at 5945, then Ctrl+Alt+R pressed again
    // and again. Paused at the cut, the game sends bReplay false ticks (with
    // the frame), which looked like leaving the replay; and the camera was
    // set from frames from before each seek, so the seek left it on Fly.
    const REPLAY3 = "307FB42411F1D80BD49C15941045EB00";
    const sent: { cmd: GameCommand; frame: number | undefined; destroyedSinceSeek: boolean }[] = [];
    let frame: number | undefined;
    let destroyedSinceSeek = true;
    const r = new ReplayRemote({
      send: (cmd) => {
        if (cmd.Command === "SeekReplay") destroyedSinceSeek = false;
        sent.push({ cmd, frame, destroyedSinceSeek });
        return true;
      },
      me: () => ["Epic|me|0"],
    });
    const results: unknown[] = [];
    let loadedAt = -Infinity;
    for await (const e of readRecording(fixture("replay-jump-again"))) {
      if (e.kind === "sent") {
        // Replay the jumps the app made then: the first from the page, then the shortcut,
        // which sent a LoadReplay (the bug) or a seek. A seek within seconds of a load belongs to that load.
        const c = e.command as GameCommand;
        if (c.Command === "LoadReplay") {
          results.push(results.length ? r.again(e.receivedAt) : r.goto(REPLAY3, 5945, 10, e.receivedAt, "mine"));
          loadedAt = e.receivedAt;
        } else if (c.Command === "SeekReplay" && e.receivedAt - loadedAt > 6_000) {
          results.push(r.again(e.receivedAt));
        }
        continue;
      }
      if (e.kind !== "message") continue;
      if (e.msg.Event === "UpdateState") frame = e.msg.Data.Game.Frame;
      if (e.msg.Event === "MatchDestroyed") destroyedSinceSeek = true;
      r.ingest(e.receivedAt, e.msg);
      await new Promise((x) => setImmediate(x));
    }
    expect(results[0]).toEqual({ ok: true, status: "loading" });
    // Every later jump seeks in the open replay.
    expect(results.slice(1).length).toBeGreaterThan(3);
    expect(results.slice(1).every((x) => (x as { status?: string }).status === "seeking")).toBe(true);
    // The camera is set only after the game rebuilt the match for the seek.
    const povs = sent.filter((s) => s.cmd.Command === "ChangePOV");
    expect(povs.length).toBeGreaterThan(0);
    expect(povs.every((s) => s.destroyedSinceSeek)).toBe(true);
  });

  it("goes back to where the last jump started", async () => {
    expect(new ReplayRemote({ send: () => true }).again(0)).toEqual({ ok: false, reason: "there's no jump to go back to" });
    const { r, sent } = await jumpToSecondGoal();
    // The recording ends in another replay, so going back loads this one again.
    expect(r.openReplay).not.toBe(REPLAY);
    const before = sent.length;
    expect(r.again(0)).toEqual({ ok: true, status: "loading" });
    expect(sent.slice(before).map((s) => s.cmd)).toEqual([{ Command: "LoadReplay", Data: { FileName: REPLAY } }]);
    // Once it's open, the same start: 10 s before frame 1797 at 22 frames a second.
    r.ingest(1, created(REPLAY));
    await new Promise((x) => setTimeout(x, 0));
    expect(sent.slice(before + 1, before + 3).map((s) => s.cmd)).toEqual([
      { Command: "SetGameSpeed", Data: { Speed: 1 } },
      { Command: "SeekReplay", Data: { TimeSeconds: 1577 / 30 } },
    ]);
  });
});

describe("POST /api/replay/goto", () => {
  it("validates the body and passes it on", async () => {
    const calls: unknown[] = [];
    const api = createApi({
      service: new StatsService(new StatsDb(":memory:")),
      gameConnected: () => true,
      replayGoto: (b) => (calls.push(b), { ok: true, status: "loading" }),
    });
    const bad = await api.request("/api/replay/goto", { method: "POST", body: JSON.stringify({ replayId: "x", frame: 1 }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    const ok = await api.request("/api/replay/goto", { method: "POST", body: JSON.stringify({ replayId: REPLAY, frame: 10 }), headers: { "content-type": "application/json" } });
    expect(ok.status).toBe(202);
    // No lead time given: the collector applies the setting.
    expect(calls).toEqual([{ replayId: REPLAY, frame: 10, camera: "mine" }]);
  });
});
