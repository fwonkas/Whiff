import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCasual } from "@rl/schema";
import { createApi } from "../src/api.ts";
import { StatsDb } from "../src/db.ts";
import { StatsService } from "../src/service.ts";
import { ingestRecording } from "../src/ingest.ts";
import { fixture, ME, TEAMMATE } from "./fixtures.ts";

const config = { myPrimaryIds: [ME], knownTeammates: [{ primaryId: TEAMMATE }] };

describe("StatsDb", () => {
  it("stores sessions and re-saving replaces rather than duplicates", async () => {
    const db = new StatsDb(":memory:");
    const { sessions } = await ingestRecording(fixture("ranked-2s-party"), config);
    for (const s of sessions) db.saveSession(s);
    for (const s of sessions) db.saveSession(s);

    const count = (sql: string) => (db.db.prepare(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) n FROM sessions WHERE kind = 'match'")).toBe(9);
    expect(count("SELECT COUNT(*) n FROM goals")).toBe(sessions.reduce((n, s) => n + s.goals.length, 0));
    expect(count("SELECT COUNT(*) n FROM session_players WHERE is_me = 1")).toBe(9);

    const record = db.db
      .prepare("SELECT outcome, COUNT(*) n FROM sessions WHERE kind = 'match' GROUP BY outcome ORDER BY outcome")
      .all();
    expect(record).toEqual([
      { outcome: "loss", n: 4 },
      { outcome: "win", n: 5 },
    ]);
    db.close();
  });

  it("re-ingesting removes sessions the recording no longer produces", async () => {
    const db = new StatsDb(":memory:");
    const { sessions, span } = await ingestRecording(fixture("replay-scrub"), config);
    for (const s of sessions) db.saveSession(s);
    // What an older sessionizer saved from the same recording: a seek taken for a match.
    const [replay] = sessions;
    db.saveSession({ ...replay!, id: `match-${replay!.startedAt + 1000}`, kind: "match", replayId: null, playback: null });
    const before = (db.db.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n;
    expect(db.removeStale(span!, sessions.map((s) => s.id))).toBe(1);
    expect((db.db.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n).toBe(before - 1);
    expect(db.db.prepare("SELECT kind FROM sessions WHERE id NOT LIKE 'match-replay-%'").all()).toEqual([{ kind: "replay" }]);
    db.close();
  });

  it("keeps user-entered fields (pack code, note) across re-ingest", async () => {
    const db = new StatsDb(":memory:");
    const { sessions } = await ingestRecording(fixture("training-defense-and-shots"), config);
    const pack = sessions[0]!;
    db.saveSession(pack);
    db.db.prepare("UPDATE sessions SET pack_code = ? WHERE id = ?").run("441D-89FB-0F29-60E1", pack.id);
    db.saveSession(pack);
    expect(db.db.prepare("SELECT pack_code FROM sessions WHERE id = ?").get(pack.id)).toEqual({
      pack_code: "441D-89FB-0F29-60E1",
    });
    db.close();
  });

  it("keeps a star across re-ingest", async () => {
    const db = new StatsDb(":memory:");
    const { sessions } = await ingestRecording(fixture("ranked-1s-win"), config);
    const m = sessions.find((s) => s.kind === "match")!;
    db.saveSession(m);
    expect(db.updateSession(m.id, { starred: true })).toBe(true);
    db.saveSession(m);
    expect(db.sessionRow(m.id)?.starred).toBe(1);
    expect(db.listSessionIds({ starred: true }).map((r) => r.id)).toEqual([m.id]);
    db.close();
  });

  it("looks up the replay frame for a match moment", async () => {
    const db = new StatsDb(":memory:");
    const { sessions } = await ingestRecording(fixture("replay-ot-seeks"), config);
    db.saveSession(sessions[0]!);
    expect(db.frameFor(sessions[0]!.id, 336)).toBe(8701);
    expect(db.frameFor(sessions[0]!.id, -5)).toBeNull();
    db.close();
  });
});

describe("a match I left after its result was settled", () => {
  // Ranked 3s, 2026-11-15: one teammate left at 4:42, the other at 2:33 down 0–3, and I left a second later.
  // That one counts as a loss by itself (the sessionizer test); as if a teammate had stayed, it's "left early"
  // until I say the result was settled.
  const leftEarly = async () => {
    const [m] = (await ingestRecording(fixture("left-after-teammates"), config)).sessions.filter((s) => s.kind === "match");
    return [{ ...m!, outcome: "abandoned" as const, teammatesLeft: false }];
  };

  it("counts as the result its score shows, survives re-ingest, and can go back", async () => {
    const db = new StatsDb(":memory:");
    const [m] = await leftEarly();
    expect([m!.scoreBlue, m!.scoreOrange, m!.myTeam]).toEqual([0, 3, 0]);
    db.saveSession(m!);
    expect(db.setLeftSettled(m!.id, true)).toBe("ok");
    expect([db.loadSession(m!.id)!.outcome, db.loadSession(m!.id)!.leftSettled]).toEqual(["loss", true]);
    db.saveSession(m!); // re-ingest: the recording still says I left
    expect([db.loadSession(m!.id)!.outcome, db.loadSession(m!.id)!.leftSettled]).toEqual(["loss", true]);
    expect(db.setLeftSettled(m!.id, false)).toBe("ok");
    expect([db.loadSession(m!.id)!.outcome, db.loadSession(m!.id)!.leftSettled]).toEqual(["abandoned", false]);
  });

  it("through the API: the page, the list and the record all follow it", async () => {
    const db = new StatsDb(":memory:");
    const [m] = await leftEarly();
    db.saveSession(m!);
    const api = createApi({ service: new StatsService(db), gameConnected: () => false });
    const get = async (path: string) => (await api.request(path)).json() as Promise<{ session?: { outcome: string }; items?: { outcome: string }[] }>;
    expect((await get(`/api/sessions/${m!.id}`)).session?.outcome).toBe("abandoned"); // cached now
    const patch = (body: unknown) => api.request(`/api/sessions/${m!.id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const r = await patch({ leftSettled: true });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { outcome: string; leftSettled: boolean })).toMatchObject({ outcome: "loss", leftSettled: true });
    expect((await get(`/api/sessions/${m!.id}`)).session?.outcome).toBe("loss");
    expect((await get("/api/sessions")).items?.[0]?.outcome).toBe("loss");
    expect((await patch({ leftSettled: true })).status).toBe(200); // already counted: nothing to do
  });

  it("is only for a match left early with a score that settles something", async () => {
    const db = new StatsDb(":memory:");
    const [m] = await leftEarly();
    db.saveSession({ ...m!, scoreOrange: 0 });
    expect(db.setLeftSettled(m!.id, true)).toBe("tied");
    db.saveSession({ ...m!, outcome: "loss" });
    expect(db.setLeftSettled(m!.id, true)).toBe("not left");
    expect(db.setLeftSettled("nope", true)).toBe("not found");
  });
});

describe("matches from saved replays", () => {
  const load = async (name: string) => (await ingestRecording(fixture(name), config)).sessions;

  it("a complete replay of a match never recorded live becomes that match", async () => {
    const db = new StatsDb(":memory:");
    for (const s of await load("replay-backfill")) db.saveSession(s);
    const rows = db.db.prepare("SELECT id, source, outcome, playlist_id, team_size, overtime, forfeit FROM sessions WHERE kind = 'match' ORDER BY started_at").all();
    expect(rows).toEqual([
      { id: "match-replay-746BA0CC11F1D67AD18BEFB69E830D44", source: "replay", outcome: "loss", playlist_id: 34, team_size: 3, overtime: 1, forfeit: 0 },
      { id: "match-replay-8FC9377E11F1D67C99C2E9845776FF5B", source: "replay", outcome: "loss", playlist_id: 34, team_size: 3, overtime: 0, forfeit: 1 },
    ]);
    // Dated by the replay (the match's end), not by when it was watched.
    const m = db.loadSession("match-replay-746BA0CC11F1D67AD18BEFB69E830D44")!;
    expect(new Date(m.endedAt).toISOString()).toBe("2026-11-02T05:12:13.000Z");
    expect(m.touches.every((t) => t.at >= m.startedAt && t.at <= m.endedAt)).toBe(true);
    db.close();
  });

  it("no match from a casual replay while casual matches are off; turning them on brings it", async () => {
    // 2026-11-12: a Casual Doubles replay played through (casual off) became a
    // match in Sessions. Here the tournament replays stand in, as playlist 2.
    const db = new StatsDb(":memory:");
    const casual = (await load("replay-backfill")).map((s) => (s.kind === "replay" ? { ...s, playlistId: 2 } : s));
    for (const s of casual) db.saveSession(s);
    const matches = () => (db.db.prepare("SELECT id FROM sessions WHERE kind = 'match'").all() as { id: string }[]).map((r) => r.id);
    expect(matches()).toEqual([]);
    expect(db.setRecordCasual(true)).toBe(0);
    expect(matches()).toHaveLength(2);
    expect(db.setRecordCasual(false)).toBe(2);
    expect(matches()).toEqual([]);
    db.close();
  });

  it("remembers casual matches left out, by GUID, while casual matches are off", async () => {
    const db = new StatsDb(":memory:");
    const { skipped } = await ingestRecording(fixture("casual-3s"), { ...config, recordCasual: false });
    for (const s of skipped) db.recordSkipped(s);
    expect([...db.skippedGuids()].sort()).toEqual(skipped.map((s) => s.matchGuid!.toUpperCase()).sort());
    db.setRecordCasual(true);
    expect(db.skippedGuids().size).toBe(0);
    db.close();
  });

  it("knows each match's playlist by GUID: kept matches, and casual ones left out", async () => {
    // For ballchasing uploads: a replay's header says only "Online" for ranked and casual alike.
    const db = new StatsDb(":memory:");
    const { skipped } = await ingestRecording(fixture("casual-3s"), { ...config, recordCasual: false });
    for (const s of skipped) db.recordSkipped(s);
    const ranked = (await load("ranked-1s-win")).filter((s) => s.kind === "match");
    for (const s of ranked) db.saveSession(s);
    const playlists = db.playlistsByGuid();
    for (const s of skipped) expect(playlists.get(s.matchGuid!.toUpperCase())).toBe(s.playlistId);
    expect(skipped.every((s) => isCasual(s.playlistId))).toBe(true);
    for (const s of ranked) expect(playlists.get(s.matchGuid!.toUpperCase())).toBe(10);
    // When each kept match started, for its ballchasing title; casual ones left out have no start.
    const starts = db.matchStartsByGuid();
    for (const s of ranked) expect(starts.get(s.matchGuid!.toUpperCase())).toBe(s.startedAt);
    for (const s of skipped) expect(starts.has(s.matchGuid!.toUpperCase())).toBe(false);
    // Turning casual on doesn't forget them (unlike skippedGuids).
    db.setRecordCasual(true);
    expect(db.playlistsByGuid().size).toBe(playlists.size);
    db.close();
  });

  it("takes a match's data from a 1x playback over a newer 2x one, and says which played only fast", async () => {
    const db = new StatsDb(":memory:");
    const all = await load("replay-backfill");
    for (const s of all) db.saveSession(s);
    // 746BA0CC… was never recorded live and played at 2x only.
    const guid = "746BA0CC11F1D67AD18BEFB69E830D44";
    expect([...db.fastPlaybackGuids()]).toContain(guid);
    const fast = all.find((s) => s.kind === "replay" && s.matchGuid?.toUpperCase() === guid)!;
    // The same playback again at 1x, then a newer 2x one: the 1x one wins.
    const slow = { ...fast, id: `${fast.id}-1x`, startedAt: fast.startedAt + 1, playback: { ...fast.playback!, speed: 1.05 }, touches: fast.touches.slice(1) };
    const newer = { ...fast, id: `${fast.id}-2x`, startedAt: fast.startedAt + 2 };
    db.saveSession(slow);
    db.saveSession(newer);
    expect(db.bestReplay(guid)?.id).toBe(slow.id);
    expect(db.loadSession("match-replay-" + guid)?.touches).toHaveLength(slow.touches.length);
    expect([...db.fastPlaybackGuids()]).not.toContain(guid);
    db.close();
  });

  it("gives way to the live recording, whichever is saved first", async () => {
    for (const order of [
      ["replay-backfill", "tournament-live"],
      ["tournament-live", "replay-backfill"],
    ]) {
      const db = new StatsDb(":memory:");
      for (const name of order) for (const s of await load(name)) db.saveSession(s);
      const ids = (db.db.prepare("SELECT id, source FROM sessions WHERE kind = 'match' ORDER BY id").all() as { id: string; source: string }[]).map((r) => `${r.source} ${r.id.slice(0, 14)}`);
      expect(ids, order.join(" then ")).toEqual(["live match-17935965", "replay match-replay-7"]);
      db.close();
    }
  });

  it("adds columns to a database from before replays counted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-db-"));
    const path = join(dir, "stats.db");
    const old = new StatsDb(path);
    for (const c of ["source", "forfeit", "playback"]) old.db.exec(`ALTER TABLE sessions DROP COLUMN ${c}`);
    old.close();
    const db = new StatsDb(path);
    for (const s of await load("tournament-live")) db.saveSession(s);
    expect(db.db.prepare("SELECT source, forfeit FROM sessions WHERE kind = 'match'").get()).toEqual({ source: "live", forfeit: 1 });
    db.close();
  });
});

describe("reassignMe", () => {
  it("moves me to the player picked, with my team and the outcome following", async () => {
    const db = new StatsDb(":memory:");
    for (const s of (await ingestRecording(fixture("ranked-1s"), { myPrimaryIds: [ME], knownTeammates: [] })).sessions) db.saveSession(s);
    const outcomes = () => db.db.prepare("SELECT outcome, COUNT(*) AS n FROM sessions WHERE kind = 'match' AND outcome != 'abandoned' GROUP BY outcome ORDER BY outcome").all();
    const before = outcomes() as { outcome: string; n: number }[];
    // In 1v1 the only other person is the opponent: as "me", every result flips.
    const opponent = (db.db.prepare("SELECT primary_id AS id FROM session_players WHERE is_me = 0 AND is_bot = 0 LIMIT 1").get() as { id: string }).id;
    db.reassignMe([ME], [opponent]);
    const flip = (o: string) => (o === "win" ? "loss" : "win");
    expect(outcomes()).toEqual(before.map((r) => ({ outcome: flip(r.outcome), n: r.n })).sort((a, b) => a.outcome.localeCompare(b.outcome)));
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM session_players WHERE is_me = 1 AND primary_id = ?").get(ME)).toEqual({ n: 0 });
    db.close();
  });
});

describe("deleteNeverStartedMatches", () => {
  it("removes 0–0 matches with no touches saved before the rule, and nothing else", async () => {
    const { StatsDb } = await import("../src/db.ts");
    const { ingestRecording } = await import("../src/ingest.ts");
    const { fixture, ME } = await import("./fixtures.ts");
    const db = new StatsDb(":memory:");
    const sessions = (await ingestRecording(fixture("ranked-1s"), { myPrimaryIds: [ME], knownTeammates: [] })).sessions;
    for (const s of sessions) db.saveSession(s);
    const match = sessions.find((s) => s.kind === "match")!;
    // The Rumble lobby as it was saved: no goals, no touches, nobody with a touch.
    db.saveSession({ ...match, id: "match-empty", matchGuid: "EMPTY", goals: [], touches: [], scoreBlue: 0, scoreOrange: 0, players: match.players.map((p) => ({ ...p, stats: { ...p.stats, touches: 0, score: 0 } })) } as typeof match);
    const before = db.countSessions();
    expect(db.deleteNeverStartedMatches()).toBe(1);
    expect(db.countSessions()).toBe(before - 1);
    expect(db.sessionRow("match-empty")).toBeNull();
  });
});

describe("deleteMatch", () => {
  it("removes the match and its replay playbacks, and keeps re-ingesting from bringing it back", async () => {
    const { StatsDb } = await import("../src/db.ts");
    const { ingestRecording } = await import("../src/ingest.ts");
    const { fixture, ME } = await import("./fixtures.ts");
    const db = new StatsDb(":memory:");
    const sessions = (await ingestRecording(fixture("ranked-1s"), { myPrimaryIds: [ME], knownTeammates: [] })).sessions;
    for (const s of sessions) db.saveSession(s);
    const match = sessions.find((s) => s.kind === "match")!;
    const before = db.countSessions();
    expect(db.deleteMatch(match.id)).toBe(true);
    expect(db.sessionRow(match.id)).toBeNull();
    expect(db.countSessions()).toBe(before - 1);
    // Re-ingesting the same recording skips it.
    for (const s of sessions) db.saveSession(s);
    expect(db.sessionRow(match.id)).toBeNull();
    expect(db.countSessions()).toBe(before - 1);
    // Practice isn't a match: nothing to delete.
    expect(db.deleteMatch(sessions.find((s) => s.kind !== "match")?.id ?? "none")).toBe(false);
  });
});
