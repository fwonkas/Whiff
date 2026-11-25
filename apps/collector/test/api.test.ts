import { beforeAll, describe, expect, it } from "vitest";
import { ApiError, createApiClient, type ApiClient } from "@rl/api-contract";
import { createApi } from "../src/api.ts";
import { StatsDb } from "../src/db.ts";
import { ingestRecording } from "../src/ingest.ts";
import { StatsService } from "../src/service.ts";
import { fixture, ME, spliceRecording, TEAMMATE } from "./fixtures.ts";

const config = { myPrimaryIds: [ME], knownTeammates: [{ primaryId: TEAMMATE, name: "Teammate" }], recordCasual: true };
let app: ReturnType<typeof createApi>;
let api: ApiClient;
let service: StatsService;

beforeAll(async () => {
  const db = new StatsDb(":memory:");
  for (const name of ["ranked-3s-2s", "ranked-2s-party", "ranked-1s", "casual-3s", "snowday", "training-defense-and-shots", "freeplay", "replay-ot-seeks", "private-1v1", "ranked-1s-win"]) {
    for (const s of (await ingestRecording(fixture(name), config)).sessions) db.saveSession(s);
  }
  service = new StatsService(db);
  app = createApi({ service, gameConnected: () => false });
  // The typed client, talking to the app in-process instead of over HTTP.
  api = createApiClient("http://test", (input, init) => Promise.resolve(app.request(String(input), init)));
});

describe("GET /api/sessions", () => {
  it("lists newest first, never replays, and pages with a cursor", async () => {
    const first = await api.sessions({ limit: 5 });
    expect(first.items).toHaveLength(5);
    expect(first.items.every((s) => (s.kind as string) !== "replay")).toBe(true);
    for (let i = 1; i < 5; i++) expect(first.items[i]!.startedAt).toBeLessThan(first.items[i - 1]!.startedAt);
    const next = await api.sessions({ limit: 5, before: first.nextCursor! });
    expect(next.items[0]!.startedAt).toBeLessThan(first.items[4]!.startedAt);
  });

  it("filters: 2v2 with a known teammate", async () => {
    const { items } = await api.sessions({ teamSize: 2, with: "party" });
    expect(items).toHaveLength(9);
    expect(items.every((s) => s.partied && s.teammates.includes("Teammate"))).toBe(true);
  });

  it("filters by result, and extra modes have their own filter while team sizes are standard play", async () => {
    for (const size of [1, 2, 3]) expect((await api.sessions({ teamSize: size, limit: 500 })).items.some((s) => s.playlistId === 30 || s.playlistId === 6)).toBe(false);
    expect((await api.sessions({ playlist: 30 })).items.every((s) => s.playlistId === 30)).toBe(true);
    const wins = await api.sessions({ result: "win", limit: 500 });
    expect(wins.items.length).toBeGreaterThan(0);
    expect(wins.items.every((s) => s.outcome === "win")).toBe(true);
    const mvps = await api.sessions({ result: "mvp", limit: 500 });
    expect(mvps.items.every((s) => s.mvp)).toBe(true);
    const summary = await api.summary({});
    expect(summary.modes.map((m) => m.playlistId)).toEqual(expect.arrayContaining([30, 6]));
    expect(summary.resultCounts).toMatchObject({ win: wins.items.length, mvp: mvps.items.length });
    expect(summary.mvps).toBe(mvps.items.length);
  });

  it("no MVP in 1s: the filter, the counts and the share's wins leave them out", async () => {
    const ones = await api.summary({ teamSize: 1 });
    expect(ones.record.wins).toBeGreaterThan(0);
    expect(ones.resultCounts.mvp).toBe(0);
    expect(ones.mvps).toBe(0);
    expect(ones.mvpWins).toBe(0);
    expect((await api.sessions({ teamSize: 1, limit: 500 })).items.some((s) => s.mvp)).toBe(false);
    // Across all sizes, the MVP share is out of the wins outside 1s.
    const all = await api.summary({});
    expect(all.mvpWins).toBe(all.record.wins - ones.record.wins);
  });

  it("summarizes the listed matches with every filter applied, dates included", async () => {
    const all = await api.sessions({ kind: "match", limit: 500 });
    const wins = await api.summary({ result: "win" });
    expect(wins.record.losses).toBe(0);
    expect(wins.matches).toBe(all.items.filter((s) => s.outcome === "win").length);
    // The summary counts what the list shows, extra modes included.
    expect((await api.summary({})).matches).toBe(all.items.length);
    // A date range narrows both, the start included and the end not.
    const mid = all.items[Math.floor(all.items.length / 2)]!.startedAt;
    const since = await api.sessions({ kind: "match", since: mid, limit: 500 });
    expect(since.items.every((s) => s.startedAt >= mid)).toBe(true);
    expect(since.items.some((s) => s.startedAt === mid)).toBe(true);
    const until = await api.sessions({ kind: "match", until: mid, limit: 500 });
    expect(until.items.length + since.items.length).toBe(all.items.length);
    expect((await api.summary({ until: mid })).matches).toBe(until.items.length);
    expect((await api.summary({ since: mid })).filterCounts.all.total).toBe(since.items.length);
  });

  it("list items carry what the Sessions screen needs", async () => {
    const { items } = await api.sessions({ kind: "match", teamSize: 1 });
    expect(items.map((s) => [s.goalsFor, s.goalsAgainst, s.outcome])).toEqual([
      [5, 3, "win"],
      [3, 6, "loss"],
      [1, 5, "loss"],
    ]);
    expect(items[1]!.touchShare).toBeNull();
    expect(items[1]!.me).toMatchObject({ goals: 3, shots: 5 });
  });

  it("a change made through the API tells the collector, so other open dashboards fetch again", async () => {
    const id = (await api.sessions({ kind: "match", limit: 1 })).items[0]!.id;
    let changes = 0;
    const off = service.onChange(() => changes++);
    await api.patchSession(id, { note: "from my phone" });
    expect(changes).toBeGreaterThan(0);
    await api.patchSession(id, { note: null });
    off();
  });

  it("stars and unstars a match, and lists starred matches only on request", async () => {
    const all = (await api.sessions({ kind: "match", limit: 500 })).items;
    expect(all.every((s) => !s.starred)).toBe(true);
    const [a, b] = all;
    expect((await api.patchSession(a!.id, { starred: true })).starred).toBe(true);
    await api.patchSession(b!.id, { starred: true });
    const starred = await api.sessions({ starred: true, limit: 500 });
    expect(starred.items.map((s) => s.id)).toEqual([a!.id, b!.id]);
    // The star chip's count: of the matches listed with every other filter.
    expect((await api.summary({})).starredCounts).toEqual({ total: all.length, starred: 2 });
    expect((await api.summary({ starred: true })).matches).toBe(2);
    expect((await api.summary({ result: a!.outcome === "win" ? "loss" : "win" })).starredCounts.starred).toBe(
      [a, b].filter((s) => s!.outcome === (a!.outcome === "win" ? "loss" : "win")).length,
    );
    await api.patchSession(a!.id, { starred: false });
    await api.patchSession(b!.id, { starred: false });
    expect((await api.sessions({ starred: true })).items).toEqual([]);
  });

  it("tags a match, filters by my tags and known teammates' names, and counts both", async () => {
    const party = (await api.sessions({ with: "party", limit: 500 })).items;
    const solo = (await api.sessions({ with: "solo", limit: 500 })).items;
    const [a] = solo;
    expect((await api.patchSession(a!.id, { tags: ["Kickoffs", "kickoffs", "Tilted"] })).tags).toEqual(["Kickoffs", "Tilted"]);
    expect((await api.sessions({ tag: "KICKOFFS" })).items.map((s) => s.id)).toEqual([a!.id]);
    // A known teammate's name is a tag on every match with them, without saving it.
    expect((await api.sessions({ tag: "teammate", limit: 500 })).items.map((s) => s.id)).toEqual(party.map((s) => s.id));
    expect((await api.summary({ tag: "Tilted" })).matches).toBe(1);
    const counts = (await api.summary({})).tagCounts;
    expect(counts[0]).toEqual({ tag: "Teammate", count: party.length, teammate: true });
    expect(counts.slice(1)).toEqual([
      { tag: "Kickoffs", count: 1, teammate: false },
      { tag: "Tilted", count: 1, teammate: false },
    ]);
    // Within the other filters (not the tag's own).
    expect((await api.summary({ with: "party", tag: "Tilted" })).tagCounts.map((t) => t.tag)).toEqual(["Teammate"]);
    expect(await api.tags()).toEqual({ tags: [{ tag: "Kickoffs", count: 1 }, { tag: "Tilted", count: 1 }], teammates: ["Teammate"] });
    await api.patchSession(a!.id, { tags: [] });
    expect((await api.sessions({ tag: "Tilted" })).items).toEqual([]);
  });

  it("rejects bad queries with 400", async () => {
    const res = await app.request("/api/sessions?teamSize=7");
    expect(res.status).toBe(400);
  });
});

describe("private matches", () => {
  it("are listed but left out of records unless asked for by playlist", async () => {
    const { items } = await api.sessions({ playlist: 6 });
    expect(items.map((s) => [s.playlistName, s.outcome])).toEqual([
      ["Private Match", "loss"],
      ["Private Match", "abandoned"],
    ]);
    expect((await api.summary({ playlist: 6 })).record).toEqual({ wins: 0, losses: 1, abandoned: 1 });
  });
});

describe("GET /api/summary", () => {
  it("counts the record, splitting abandoned matches out", async () => {
    const s = await api.summary();
    // Every listed match counts, extra modes included (the Snow Day fixture's 2-1 and private matches);
    // a team size means standard play.
    expect(s.record).toEqual({ wins: 11, losses: 9, abandoned: 2 });
    expect((await api.summary({ playlist: 30 })).record).toEqual({ wins: 2, losses: 1, abandoned: 0 });
    const standard = (await Promise.all(([1, 2, 3] as const).map((teamSize) => api.summary({ teamSize })))).map((x) => x.record);
    expect(standard.reduce((n, r) => n + r.wins, 0)).toBe(9);
    expect(s.partied).toEqual({ wins: 5, losses: 4, abandoned: 0 });
    // 1v1 includes the private 1v1 fixture (listed matches, extra modes included).
    expect(s.byTeamSize["1"]).toEqual({ wins: 1, losses: 3, abandoned: 1 });
    expect(s.practiceSeconds).toBeGreaterThan(0);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns match detail with touches rotated so my team attacks up", async () => {
    const { items } = await api.sessions({ teamSize: 2, with: "party" });
    const ot = items.find((s) => s.overtime)!;
    const d = await api.session(ot.id);
    expect(d.metrics?.contestedTouches).toBe(14);
    expect(d.players).toHaveLength(4);
    // Goals for us cross the line at +y, goals against at -y.
    for (const g of d.goals.filter((g) => g.locationReliable)) expect(Math.sign(g.y)).toBe(g.forUs ? 1 : -1);
    expect(d.touches.filter((t) => t.owner === "me")).toHaveLength(33);
    // This match's saved replay was recorded too.
    expect(d.replay?.replayId).toBe("C5024DCC11F1CDB73F942EB6513C40BD");
  });

  it("404s for unknown ids", async () => {
    await expect(api.session("nope")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("trends, splits and practice", () => {
  it("returns requested series for one team size", async () => {
    const t = await api.trends({ metrics: "touchShare,air", teamSize: 2 } as never);
    expect(t.matches).toBe(11); // 2 solo + 9 with the teammate in the loaded recordings
    expect(Object.keys(t.series)).toEqual(["touchShare", "air"]);
    expect(t.series.touchShare!.points).toHaveLength(11);
  });

  it("splits include solo and teammate rows", async () => {
    const { splits } = await api.splits();
    expect(splits.map((s) => s.name)).toContain("With a known teammate");
  });

  it("tagging a pack turns on its success rate", async () => {
    const before = await api.practice();
    const defense = before.items.find((i) => i.kind === "training" && i.arena === "Park_P")!;
    expect(defense.kind === "training" && defense.successRate).toBeNull();

    await api.putPack("441D-89FB-0F29-60E1", { name: "Weird Saves & Clears", type: "defense" });
    await api.patchSession(defense.sessionId, { packCode: "441D-89FB-0F29-60E1" });

    const after = (await api.practice()).items.find((i) => i.sessionId === defense.sessionId)!;
    expect(after.pack?.name).toBe("Weird Saves & Clears");
    expect(after.kind === "training" && after.successRate).toBeCloseTo(9 / 11);
  });
});

describe("playlists without a fixed team size", () => {
  it("filter by measured size: tournaments and private matches have filters of their own", async () => {
    const db = new StatsDb(":memory:");
    const [standard] = (await ingestRecording(fixture("ranked-3s-2s"), config)).sessions.filter((s) => s.playlistId === 13);
    const tournament = { ...standard!, id: "match-tournament", startedAt: standard!.startedAt + 1, playlistId: 34 };
    expect(tournament.teamSize).toBe(3);
    db.saveSession(tournament);
    for (const s of (await ingestRecording(fixture("private-1v1"), config)).sessions) db.saveSession(s);
    const local = createApiClient("http://test", (input, init) =>
      Promise.resolve(createApi({ service: new StatsService(db), gameConnected: () => false }).request(String(input), init)),
    );

    expect((await local.sessions({ teamSize: 3 })).items).toEqual([]);
    expect((await local.sessions({ playlist: 34 })).items.map((s) => s.playlistName)).toEqual(["Tournament"]);
    expect((await local.summary({ playlist: 34 })).record.wins + (await local.summary({ playlist: 34 })).record.losses).toBe(1);
    expect((await local.summary({})).modes).toEqual([
      { playlistId: 34, name: "Tournament", matches: 1 },
      { playlistId: 6, name: "Private Match", matches: 2 },
    ]);
    expect((await local.sessions({ teamSize: 1 })).items).toEqual([]);
    expect((await local.sessions({ playlist: 6 })).items).toHaveLength(2);
  });
});

describe("matches with saved replays", () => {
  it("a live match gains the replay's opponent cars and boost pickups; a replay-only match is listed", async () => {
    const db = new StatsDb(":memory:");
    for (const name of ["tournament-live", "replay-backfill"]) {
      for (const s of (await ingestRecording(fixture(name), config)).sessions) db.saveSession(s);
    }
    const local = createApiClient("http://test", (input, init) =>
      Promise.resolve(createApi({ service: new StatsService(db), gameConnected: () => false }).request(String(input), init)),
    );
    const { items } = await local.sessions({ kind: "match" });
    expect(items.map((s) => [s.source, s.outcome, s.forfeit, s.overtime])).toEqual([
      ["live", "loss", true, false],
      ["replay", "loss", false, true],
    ]);
    const live = await local.session(items[0]!.id);
    expect(db.loadSession(items[0]!.id)!.carSummaries.length).toBeLessThan(6);
    expect(live.cars).toHaveLength(6);
    expect(live.boostPickups.length).toBeGreaterThan(150);
    // Moved onto the live match's clock: the same match time as in the replay.
    expect(live.boostPickups.every((p) => p.matchTime !== null && p.matchTime >= 0 && p.matchTime <= 300)).toBe(true);
    expect(live.goals.every((g) => g.locationReliable)).toBe(true);
    const replayOnly = await local.session(items[1]!.id);
    expect(replayOnly.goals.map((g) => g.locationReliable)).toEqual([true, true, true]);
    expect(replayOnly.players).toHaveLength(6);
  });
});

describe("play sessions", () => {
  it("group a night's matches, split after quitting, and number matches within a sitting", async () => {
    // A night of 2s, quit, back 15 minutes later for 1s; then a week later, the casual night.
    // ranked-2s-party starts with the collector's "connected" note.
    const path = await spliceRecording([
      { fixture: "ranked-2s-party" },
      { note: "disconnected", afterMs: 1000 },
      { fixture: "ranked-1s", gapMs: 15 * 60_000 },
      { fixture: "casual-3s", gapMs: 7 * 24 * 3_600_000 },
    ]);
    const db = new StatsDb(":memory:");
    const r = await ingestRecording(path, config);
    for (const s of r.sessions) db.saveSession(s);
    for (const c of r.connections) db.saveConnection(c);
    expect(db.quitTimes().length).toBeGreaterThan(0);
    const local = createApiClient("http://test", (input, init) =>
      Promise.resolve(createApi({ service: new StatsService(db), gameConnected: () => false }).request(String(input), init)),
    );

    const { items } = await local.playSessions();
    expect(items.map((p) => [p.matches, p.playlists.map((x) => x.name)])).toEqual([
      [2, ["Casual Standard"]],
      [2, ["Ranked Duel"]],
      [9, ["Ranked Doubles"]],
    ]);
    expect(items[2]!.record).toEqual({ wins: 5, losses: 4, abandoned: 0 });

    const sessions = (await local.sessions({ kind: "match" })).items;
    expect(new Set(sessions.map((s) => s.playSessionId)).size).toBe(3);

    const splits = (await local.splits()).splits.filter((s) => s.name.includes("play session"));
    // Finished matches only: 3 of 2s, 2 of 1s and 1 casual (the other was left early).
    expect(splits.map((s) => [s.name, s.split.matches])).toEqual([
      ["Matches 1–3 of a play session", 6],
      ["Matches 4–6 of a play session", 3],
      ["Matches 7 and later of a play session", 3],
    ]);
  });
});

describe("POST /api/game/launch", () => {
  const json = { "content-type": "application/json" };
  it("is unavailable outside the desktop app", async () => {
    const res = await app.request("/api/game/launch", { method: "POST" });
    expect(res.status).toBe(503);
    expect(await (await app.request("/api/settings")).json()).toMatchObject({ canLaunchGame: false });
  });

  it("runs the desktop app's launch routine", async () => {
    let calls = 0;
    const desktop = createApi({
      service: new StatsService(new StatsDb(":memory:")),
      gameConnected: () => false,
      launchGame: async () => (calls++, { ok: true, status: "launching" }),
    });
    expect(await (await desktop.request("/api/settings")).json()).toMatchObject({ canLaunchGame: true });
    const res = await desktop.request("/api/game/launch", { method: "POST", headers: { host: "127.0.0.1:49200", origin: "http://127.0.0.1:49200" } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, status: "launching" });
    expect(calls).toBe(1);
  });

  it("refuses writes from other websites", async () => {
    let calls = 0;
    const desktop = createApi({
      service: new StatsService(new StatsDb(":memory:")),
      gameConnected: () => false,
      launchGame: async () => (calls++, { ok: true, status: "launching" }),
    });
    const res = await desktop.request("/api/game/launch", { method: "POST", headers: { host: "127.0.0.1:49200", origin: "https://example.com" } });
    expect(res.status).toBe(403);
    const note = await desktop.request("/api/sessions/x", { method: "PATCH", body: "{}", headers: { ...json, host: "127.0.0.1:49200", origin: "https://example.com" } });
    expect(note.status).toBe(403);
    expect(calls).toBe(0);
  });
});

describe("summary filter counts", () => {
  it("count every filter combination like the Sessions list does", async () => {
    const s = await api.summary({ teamSize: 2 });
    const listed = async (q: { teamSize?: 1 | 2 | 3; with?: "solo" | "party" }) => (await api.sessions({ kind: "match", limit: 500, ...q })).items.length;
    for (const size of [undefined, 1, 2, 3] as const) {
      const c = s.filterCounts[size === undefined ? "all" : (String(size) as "1" | "2" | "3")];
      expect(c.total).toBe(await listed({ teamSize: size }));
      expect(c.solo).toBe(await listed({ teamSize: size, with: "solo" }));
      expect(c.party).toBe(await listed({ teamSize: size, with: "party" }));
    }
    // Nobody has a teammate in 1s.
    expect(s.filterCounts["1"].party).toBe(0);
  });
});
