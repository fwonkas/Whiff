import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { BallchasingClient, ballchasingDate, candidatesFor, fetchMissingReplays, ReplayUploader, uploadKind, type BallchasingListItem, type UploadableReplay, type MissingReplay } from "../src/ballchasing.ts";
import { StatsDb } from "../src/db.ts";
import { DEFAULT_UPLOAD_RULES } from "@rl/api-contract";
import { listSavedReplays } from "../src/replay-files.ts";
import { StatsService } from "../src/service.ts";
import { minimalHeader } from "./replay-header-writer.ts";

const GUID = "776022F011F1D015396D9C8068244BC6";
const OTHER_GUID = "4C96D43811F1D3494DCB74B3B79AC2EF";
const REPLAY = "5F0C1A2B11F1D0153A9E8C40B2D1E7A1";
const ended = Date.parse("2026-10-25T01:49:30Z");
const match: MissingReplay = { sessionId: "match-1", matchGuid: GUID, endedAt: ended, arena: "Paname_Dusk_P", scoreBlue: 2, scoreOrange: 0 };
const item = (over: Partial<BallchasingListItem> = {}): BallchasingListItem => ({
  id: "bc-1",
  rocket_league_id: REPLAY,
  map_code: "paname_dusk_p",
  date: "2026-10-25T01:49:28Z",
  blue: { goals: 2 },
  orange: {}, // no goals: ballchasing leaves the field out
  ...over,
});

describe("matching ballchasing uploads to recorded matches", () => {
  it("reads dates with a zone as given and without one as the header's UTC", () => {
    expect(ballchasingDate({ id: "a", date: "2026-10-24T20:49:28-05:00" })).toBe(Date.parse("2026-10-25T01:49:28Z"));
    expect(ballchasingDate({ id: "a", date: "2026-10-25T01:49:28" })).toBe(Date.parse("2026-10-25T01:49:28Z"));
    expect(ballchasingDate({ id: "a" })).toBeNull();
  });

  it("keeps uploads with the same arena and score, closest first", () => {
    const later = item({ id: "bc-2", date: "2026-10-25T03:00:00Z" });
    const otherArena = item({ id: "bc-3", map_code: "stadium_p" });
    const otherScore = item({ id: "bc-4", orange: { goals: 1 } });
    const days = item({ id: "bc-5", date: "2026-10-27T01:49:28Z" });
    expect(candidatesFor(match, [later, otherArena, item(), otherScore, days]).map((c) => c.id)).toEqual(["bc-1", "bc-2"]);
  });
});

/** A fake ballchasing: the list, each replay's GUID, and its file. */
function fakeBallchasing(list: BallchasingListItem[], files: Record<string, { guid: string; replayId: string }>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    expect((init?.headers as Record<string, string>).Authorization).toBe("key");
    const m = url.pathname.match(/^\/api\/replays\/([^/]+)(\/file)?$/);
    if (url.pathname === "/api/replays") {
      expect(url.searchParams.get("uploader")).toBe("me");
      return Response.json({ list, count: list.length });
    }
    if (m && files[m[1]!]) {
      const f = files[m[1]!]!;
      if (!m[2]) return Response.json({ id: m[1], match_guid: f.guid });
      return new Response(minimalHeader({ replayId: f.replayId, matchGuid: f.guid, date: "2026-10-25 01-49-28", goals: [] }));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { client: new BallchasingClient("key", fetchImpl), calls };
}

describe("fetchMissingReplays", () => {
  it("downloads the upload whose match GUID matches into the replays folder, named by its replay ID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-bc-"));
    // A rematch on the same arena with the same score, closer in time, is a different match.
    const rematch = item({ id: "bc-rematch", rocket_league_id: "AAAA1A2B11F1D0153A9E8C40B2D1E7A1", date: "2026-10-25T01:49:29Z" });
    const { client, calls } = fakeBallchasing([rematch, item()], {
      "bc-rematch": { guid: OTHER_GUID, replayId: "AAAA1A2B11F1D0153A9E8C40B2D1E7A1" },
      "bc-1": { guid: GUID, replayId: REPLAY },
    });
    const out = await fetchMissingReplays(client, [match], dir, { sleep: async () => {} });
    expect(out).toEqual([{ sessionId: "match-1", ok: true, replayId: REPLAY }]);
    expect(calls).toEqual(["/api/replays", "/api/replays/bc-rematch", "/api/replays/bc-1", "/api/replays/bc-1/file"]);
    expect(readdirSync(dir)).toEqual([`${REPLAY}.replay`]);
    expect(listSavedReplays([dir])[0]).toMatchObject({ replayId: REPLAY, matchGuid: GUID });
  });

  it("throws away a download whose header names another match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-bc-"));
    const { client } = fakeBallchasing([item()], { "bc-1": { guid: GUID, replayId: REPLAY } });
    // The details say it's the match, but the file is another one.
    const lying = new BallchasingClient("key", (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/file"))
        return new Response(minimalHeader({ replayId: REPLAY, matchGuid: OTHER_GUID, date: "2026-10-25 01-49-28", goals: [] }));
      return (client as unknown as { fetchImpl: typeof fetch }).fetchImpl(input, init);
    }) as typeof fetch);
    const out = await fetchMissingReplays(lying, [match], dir, { sleep: async () => {} });
    expect(out[0]).toMatchObject({ ok: false });
    expect(existsSync(join(dir, `${REPLAY}.replay`))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("says when there's no upload of a match", async () => {
    const { client } = fakeBallchasing([item({ map_code: "stadium_p" })], {});
    const out = await fetchMissingReplays(client, [match], mkdtempSync(join(tmpdir(), "rl-bc-")));
    expect(out).toEqual([{ sessionId: "match-1", ok: false, reason: "not found on ballchasing" }]);
  });
});

describe("POST /api/sessions/:id/replay/ballchasing", () => {
  it("needs an API key", async () => {
    const api = createApi({ service: new StatsService(new StatsDb(":memory:")), gameConnected: () => false });
    expect((await api.request("/api/sessions/m1/replay/ballchasing", { method: "POST" })).status).toBe(503);
    expect(await (await api.request("/api/settings")).json()).toMatchObject({ ballchasing: false });
  });
});

describe("uploading saved replays", () => {
  const A = "AAAAAAAA11F1D0153A9E8C40B2D1E7A1";
  const B = "BBBBBBBB11F1D0153A9E8C40B2D1E7A1";
  const now = ended + 3_600_000;

  /** A fake ballchasing for uploads: my uploads list, the quota, and what was posted. */
  function setup(opts: { mine?: BallchasingListItem[]; used?: number; max?: number; status?: number } = {}) {
    const posted: { visibility: string | null; group: string | null; name: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/") return Response.json({ name: "me", quota: { uploads_in_24h: { used: opts.used ?? 0, max: opts.max ?? 100 } } });
      if (url.pathname === "/api/replays") return Response.json({ list: opts.mine ?? [], count: 0 });
      if (url.pathname === "/api/v2/upload" && init?.method === "POST") {
        const file = (init.body as FormData).get("file") as File;
        posted.push({ visibility: url.searchParams.get("visibility"), group: url.searchParams.get("group"), name: file.name });
        if (opts.status === 409) return Response.json({ error: "duplicate replay", id: "bc-dup" }, { status: 409 });
        if (opts.status) return Response.json({ error: "nope" }, { status: opts.status });
        return Response.json({ id: `bc-${posted.length}`, location: "x" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new BallchasingClient("key", fetchImpl);
    const records: { replayId: string; id: string | null; how: string }[] = [];
    let on = true;
    const replays: UploadableReplay[] = [
      { replayId: A, path: "a", mtimeMs: ended, matchEndedAt: ended, kind: "online" },
      { replayId: B, path: "b", mtimeMs: now - 5_000, matchEndedAt: now - 10_000, kind: "online" }, // still being written
      { replayId: "C".repeat(32), path: "c", mtimeMs: ended, matchEndedAt: ended, kind: "tournament" }, // tournaments are off here
      { replayId: "E".repeat(32), path: "e", mtimeMs: ended, matchEndedAt: ended, kind: null }, // offline
    ];
    const rules = {
      ...DEFAULT_UPLOAD_RULES,
      online: { enabled: true, visibility: "unlisted" as const, group: "my-group-1a2b" },
      tournament: { ...DEFAULT_UPLOAD_RULES.tournament, enabled: false },
    };
    const uploader = new ReplayUploader({
      client: () => (on ? client : null),
      rules: () => rules,
      replays: () => replays,
      known: () => new Set(records.map((r) => r.replayId)),
      record: (replayId, id, how) => records.push({ replayId, id, how }),
      read: () => new Uint8Array([1, 2, 3]),
      now: () => now,
    });
    return { uploader, posted, records, off: () => (on = false) };
  }

  it("uploads settled replays of the kinds that are on, with their visibility and group", async () => {
    const { uploader, posted, records } = setup();
    expect(uploader.status()).toEqual({ enabled: true, pending: 1, uploaded: 0, waiting: null });
    expect(await uploader.tick()).toBe("uploaded");
    expect(posted).toEqual([{ visibility: "unlisted", group: "my-group-1a2b", name: `${A}.replay` }]);
    expect(records).toEqual([{ replayId: A, id: "bc-1", how: "uploaded" }]);
    expect(await uploader.tick()).toBe("idle"); // B is too new; C and E don't upload
    expect(uploader.status()).toEqual({ enabled: true, pending: 0, uploaded: 1, waiting: null });
  });

  it("marks replays I already uploaded instead of sending them again", async () => {
    const { uploader, posted, records } = setup({ mine: [item({ id: "bc-mine", rocket_league_id: A.toLowerCase() })] });
    expect(await uploader.tick()).toBe("skipped");
    expect(posted).toEqual([]);
    expect(records).toEqual([{ replayId: A, id: "bc-mine", how: "already" }]);
  });

  it("records a duplicate ballchasing already had", async () => {
    const { uploader, records } = setup({ status: 409 });
    expect(await uploader.tick()).toBe("uploaded");
    expect(records).toEqual([{ replayId: A, id: "bc-dup", how: "duplicate" }]);
    expect(uploader.status().uploaded).toBe(0);
  });

  it("waits when the daily quota is used up or ballchasing refuses", async () => {
    const full = setup({ used: 10, max: 10 });
    expect(await full.uploader.tick()).toBe("waiting");
    expect(full.posted).toEqual([]);
    expect(full.uploader.status().waiting).toMatch(/upload limit/);
    expect(await full.uploader.tick()).toBe("waiting");

    const refused = setup({ status: 401 });
    expect(await refused.uploader.tick()).toBe("failed");
    expect(refused.uploader.status().waiting).toMatch(/API key/);
    refused.uploader.reset();
    expect(refused.uploader.status().waiting).toBeNull();
  });

  it("does nothing when uploads are off or there's no key", async () => {
    const { uploader, posted, off } = setup();
    off();
    expect(await uploader.tick()).toBe("idle");
    expect(uploader.status()).toEqual({ enabled: false, pending: 0, uploaded: 0, waiting: null });
    expect(posted).toEqual([]);
  });
});

describe("sorting saved replays into upload kinds", () => {
  it("goes by the header's MatchType", () => {
    expect(uploadKind("Online")).toBe("online");
    expect(uploadKind("Tournament")).toBe("tournament");
    expect(uploadKind("Private")).toBe("private");
    expect(uploadKind("Offline")).toBeNull();
    expect(uploadKind(null)).toBeNull();
  });
});
