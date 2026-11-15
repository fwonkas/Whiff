import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { UploadKind, UploadRules, UploadVisibility } from "@rl/api-contract";
import { isCasual } from "@rl/schema";
import { join } from "node:path";
import { readReplayHeader, replaySummary } from "./replay-header.ts";

/**
 * Replays from ballchasing.com, for recorded matches with no saved replay on
 * this PC (the game's Match History keeps only the last 20). A downloaded
 * replay goes into the game's replays folder under its replay ID, the name the
 * game loads it by, so it works like one saved in the game: replay review can
 * jump into it and backfill can play it.
 *
 * API (ballchasing.com/doc/api): `Authorization: <token>`. GET /replays lists
 * with `uploader=me`, `replay-date-after/-before`, `sort-by`, `count` (≤ 200)
 * and a `next` URL; items carry `rocket_league_id` (the replay ID), `map_code`,
 * `date` and each team's `goals`, but not the match GUID. GET /replays/{id}
 * adds `match_guid`; GET /replays/{id}/file is the replay. The lowest tier
 * allows 2 lists a second and one download a second (200 an hour).
 */

export const BALLCHASING_API = "https://ballchasing.com/api";
/** Between downloads, under the lowest tier's limit of one a second. */
export const DOWNLOAD_GAP_MS = 1_100;

export interface BallchasingListItem {
  id: string;
  rocket_league_id?: string;
  map_code?: string;
  date?: string;
  date_has_tz?: boolean;
  playlist_id?: string;
  blue?: { goals?: number };
  orange?: { goals?: number };
}

interface ListResponse {
  list?: BallchasingListItem[];
  next?: string;
}

export class BallchasingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class BallchasingClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly base = BALLCHASING_API,
  ) {}

  private async request(url: string): Promise<Response> {
    const res = await this.fetchImpl(url.startsWith("http") ? url : `${this.base}${url}`, { headers: { Authorization: this.token } });
    if (res.status === 401) throw new BallchasingError(401, "ballchasing didn't accept the API key");
    if (res.status === 429) throw new BallchasingError(429, "ballchasing's rate limit was reached; try again in a while");
    if (!res.ok) throw new BallchasingError(res.status, `ballchasing answered ${res.status}`);
    return res;
  }

  /** The account the key belongs to, and the upload quota (uploads in the last 24 hours, and the most allowed). */
  async ping(): Promise<{ name?: string; type?: string; quota?: { uploads_in_24h?: { used?: number; max?: number } } }> {
    return (await (await this.request("/")).json()) as { name?: string; type?: string };
  }

  /**
   * Upload a replay file (POST /v2/upload, multipart field "file"). 201 is a
   * new upload, 409 one ballchasing already has; both give its ballchasing ID.
   */
  async upload(bytes: Uint8Array, fileName: string, visibility: UploadVisibility, group: string | null = null): Promise<{ id: string; duplicate: boolean }> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), fileName);
    const res = await this.fetchImpl(`${this.base.replace(/\/api$/, "/api/v2")}/upload?visibility=${visibility}${group ? `&group=${encodeURIComponent(group)}` : ""}`, {
      method: "POST",
      headers: { Authorization: this.token },
      body: form,
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if ((res.status === 201 || res.status === 409) && body.id) return { id: body.id, duplicate: res.status === 409 };
    if (res.status === 401) throw new BallchasingError(401, "ballchasing didn't accept the API key");
    if (res.status === 429) throw new BallchasingError(429, "ballchasing's rate limit was reached; try again in a while");
    throw new BallchasingError(res.status, body.error ? `ballchasing: ${body.error}` : `ballchasing answered ${res.status}`);
  }

  /** My uploads played between two times, every page. */
  async myReplays(after: number, before: number): Promise<BallchasingListItem[]> {
    const q = new URLSearchParams({
      uploader: "me",
      "replay-date-after": new Date(after).toISOString(),
      "replay-date-before": new Date(before).toISOString(),
      "sort-by": "replay-date",
      count: "200",
    });
    const out: BallchasingListItem[] = [];
    let url: string | undefined = `/replays?${q}`;
    for (let page = 0; url && page < 50; page++) {
      const body = (await (await this.request(url)).json()) as ListResponse;
      out.push(...(body.list ?? []));
      url = body.next;
    }
    return out;
  }

  async matchGuid(id: string): Promise<string | null> {
    const body = (await (await this.request(`/replays/${encodeURIComponent(id)}`)).json()) as { match_guid?: string };
    return typeof body.match_guid === "string" && body.match_guid ? body.match_guid.toUpperCase() : null;
  }

  async download(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.request(`/replays/${encodeURIComponent(id)}/file`)).arrayBuffer());
  }
}

/** A recorded match with no saved replay. */
export interface MissingReplay {
  sessionId: string;
  matchGuid: string;
  endedAt: number;
  arena: string | null;
  scoreBlue: number | null;
  scoreOrange: number | null;
}

/** How far a ballchasing date may be from the match's end (it's the replay's own Date; generous for time zone mix-ups). */
const DATE_SLACK_MS = 14 * 3_600_000;

/** ballchasing's date: with a zone when it has one, otherwise the replay header's UTC. */
export function ballchasingDate(item: BallchasingListItem): number | null {
  if (!item.date) return null;
  const hasZone = /(?:Z|[+-]\d\d:?\d\d)$/.test(item.date);
  const t = Date.parse(hasZone ? item.date : `${item.date.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * Uploads that could be this match: same arena and score, closest in time
 * first. The match GUID (from the replay's details) settles it.
 */
export function candidatesFor(m: MissingReplay, list: readonly BallchasingListItem[]): BallchasingListItem[] {
  return list
    .flatMap((item) => {
      const at = ballchasingDate(item);
      if (at === null || Math.abs(at - m.endedAt) > DATE_SLACK_MS) return [];
      if (m.arena && item.map_code && item.map_code.toLowerCase() !== m.arena.toLowerCase()) return [];
      // ballchasing leaves goals out when a team scored none.
      if (m.scoreBlue !== null && (item.blue?.goals ?? 0) !== m.scoreBlue) return [];
      if (m.scoreOrange !== null && (item.orange?.goals ?? 0) !== m.scoreOrange) return [];
      return [{ item, distance: Math.abs(at - m.endedAt) }];
    })
    .sort((a, b) => a.distance - b.distance)
    .map((c) => c.item);
}

export type FetchOutcome =
  | { sessionId: string; ok: true; replayId: string }
  | { sessionId: string; ok: false; reason: string };

export interface FetchProgress {
  done: number;
  total: number;
  found: number;
}

/**
 * Find each match's upload, download it into `replayDir` and check its header
 * names the same match before keeping it.
 */
export async function fetchMissingReplays(
  client: BallchasingClient,
  missing: readonly MissingReplay[],
  replayDir: string,
  opts: { onProgress?: (p: FetchProgress) => void; sleep?: (ms: number) => Promise<void>; shouldStop?: () => boolean } = {},
): Promise<FetchOutcome[]> {
  if (!missing.length) return [];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ends = missing.map((m) => m.endedAt);
  const day = 86_400_000;
  const list = await client.myReplays(Math.min(...ends) - day, Math.max(...ends) + day);
  mkdirSync(replayDir, { recursive: true });

  const out: FetchOutcome[] = [];
  let downloads = 0;
  for (const m of missing) {
    if (opts.shouldStop?.()) break;
    out.push(await fetchOne(m));
    opts.onProgress?.({ done: out.length, total: missing.length, found: out.filter((o) => o.ok).length });
  }
  return out;

  async function fetchOne(m: MissingReplay): Promise<FetchOutcome> {
    const candidates = candidatesFor(m, list);
    if (!candidates.length) return { sessionId: m.sessionId, ok: false, reason: "not found on ballchasing" };
    for (const c of candidates.slice(0, 3)) {
      const guid = await client.matchGuid(c.id);
      if (guid && guid !== m.matchGuid) continue;
      const replayId = (c.rocket_league_id ?? "").toUpperCase();
      if (!/^[0-9A-F]{32}$/.test(replayId)) continue;
      const path = join(replayDir, `${replayId}.replay`);
      if (existsSync(path)) return { sessionId: m.sessionId, ok: true, replayId };
      if (downloads++) await sleep(DOWNLOAD_GAP_MS);
      const part = `${path}.part`;
      writeFileSync(part, await client.download(c.id));
      let header: string | null = null;
      try {
        header = replaySummary(readReplayHeader(part)).matchGuid;
      } catch {
        // Not a replay we can read.
      }
      if (header !== m.matchGuid) {
        rmSync(part, { force: true });
        continue;
      }
      renameSync(part, path);
      return { sessionId: m.sessionId, ok: true, replayId };
    }
    return { sessionId: m.sessionId, ok: false, reason: "no upload on ballchasing matched this match" };
  }
}

// --- uploading saved replays ---------------------------------------------------

/**
 * Which kind of match a saved replay is, for the upload settings, from the
 * header's MatchType: Online, Tournament or Private. Online is ranked or
 * casual matchmaking, which only the playlist tells apart: from the live
 * recording, a playthrough or the note left when a casual match wasn't kept.
 * An Online match with no known playlist (Whiff wasn't running and it hasn't
 * been played through) counts as ranked. null: never uploaded (offline, LAN,
 * bots, an unreadable header).
 */
export function uploadKind(matchType: string | null, playlistId: number | null = null): UploadKind | null {
  if (matchType === "Online") return isCasual(playlistId) ? "casual" : "ranked";
  if (matchType === "Tournament") return "tournament";
  if (matchType === "Private") return "private";
  return null;
}

export interface UploadableReplay {
  replayId: string;
  path: string;
  mtimeMs: number;
  matchEndedAt: number | null;
  kind: UploadKind | null;
}

export interface UploadStatus {
  enabled: boolean;
  /** Saved replays waiting to go up. */
  pending: number;
  /** Uploaded by the app (not counting ones ballchasing already had). */
  uploaded: number;
  /** Why uploading is paused, if it is (quota reached, key refused, a failure). */
  waiting: string | null;
}

export interface UploaderDeps {
  /** A client when uploads are on and there's a key; null otherwise. */
  client: () => BallchasingClient | null;
  /** What uploads, by kind of match: on or off, visibility and group. */
  rules: () => UploadRules;
  /** Saved replays worth uploading (not of deleted matches). */
  replays: () => UploadableReplay[];
  /** Replay IDs ballchasing has, by any route (uploaded, downloaded from there, already there). */
  known: () => Set<string>;
  record: (replayId: string, ballchasingId: string | null, how: "uploaded" | "duplicate" | "already") => void;
  read: (path: string) => Uint8Array;
  log?: (line: string) => void;
  now?: () => number;
}

/** A replay file this new may still be being written. */
const SETTLE_MS = 30_000;
const DAY_MS = 86_400_000;

/**
 * Uploads saved replays to ballchasing, one at a time: each tick uploads the
 * next one that isn't there yet. Before uploading, it lists my uploads around
 * those replays' dates so ones I uploaded by hand aren't sent again (uploads
 * count against a daily quota), and it waits when the quota is used up.
 */
export class ReplayUploader {
  private waitingUntil = 0;
  private waiting: string | null = null;
  private listedAt = 0;
  private busy = false;
  private uploaded = 0;

  constructor(private readonly deps: UploaderDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** Settled replays ballchasing doesn't have yet. */
  private unsent(): UploadableReplay[] {
    const known = this.deps.known();
    const now = this.now();
    return this.deps.replays().filter((r) => !known.has(r.replayId) && now - r.mtimeMs > SETTLE_MS);
  }

  /** The ones to upload: of a kind that's on. */
  pending(): (UploadableReplay & { kind: UploadKind })[] {
    const rules = this.deps.rules();
    return this.unsent().filter((r): r is UploadableReplay & { kind: UploadKind } => r.kind !== null && rules[r.kind].enabled);
  }

  status(): UploadStatus {
    const on = this.deps.client() !== null;
    return {
      enabled: on,
      pending: on ? this.pending().length : 0,
      uploaded: this.uploaded,
      waiting: on ? this.waiting : null,
    };
  }

  /** Upload the next replay, if one is due. Resolves with what happened, for logs and tests. */
  async tick(): Promise<"idle" | "waiting" | "uploaded" | "skipped" | "failed"> {
    const client = this.deps.client();
    if (!client || this.busy) return "idle";
    if (this.now() < this.waitingUntil) return "waiting";
    let pending = this.pending();
    if (!pending.length) {
      this.waiting = null;
      return "idle";
    }
    this.busy = true;
    try {
      // Ones already on ballchasing (uploaded by hand) are marked, not sent.
      if (this.now() - this.listedAt > 6 * 3_600_000) {
        const dates = pending.map((r) => r.matchEndedAt ?? r.mtimeMs);
        const mine = await client.myReplays(Math.min(...dates) - DAY_MS, Math.max(...dates) + DAY_MS);
        this.listedAt = this.now();
        const there = new Map(mine.flatMap((m) => (m.rocket_league_id ? [[m.rocket_league_id.toUpperCase(), m.id] as const] : [])));
        for (const r of pending) {
          const id = there.get(r.replayId);
          if (id) this.deps.record(r.replayId, id, "already");
        }
        pending = this.pending();
        if (!pending.length) return "skipped";
      }
      const quota = (await client.ping()).quota?.uploads_in_24h;
      if (quota?.max !== undefined && (quota.used ?? 0) >= quota.max) {
        this.pause(`ballchasing's upload limit (${quota.max} a day) is reached`, 3_600_000);
        return "waiting";
      }
      const next = pending[0]!;
      const rule = this.deps.rules()[next.kind];
      const r = await client.upload(this.deps.read(next.path), `${next.replayId}.replay`, rule.visibility, rule.group);
      this.deps.record(next.replayId, r.id, r.duplicate ? "duplicate" : "uploaded");
      if (!r.duplicate) this.uploaded++;
      this.deps.log?.(`ballchasing: ${r.duplicate ? "already had" : "uploaded"} ${next.replayId}`);
      this.waiting = null;
      return "uploaded";
    } catch (e) {
      const status = e instanceof BallchasingError ? e.status : 0;
      const why = e instanceof BallchasingError ? e.message : `couldn't reach ballchasing (${String(e)})`;
      this.deps.log?.(`ballchasing upload: ${why}`);
      // A refused key waits for a new one (the client changes); limits and outages wait a while.
      this.pause(why, status === 401 ? 3_600_000 : status === 429 ? 1_800_000 : 600_000);
      return "failed";
    } finally {
      this.busy = false;
    }
  }

  /** Settings changed (a new key, uploads turned on): try again now. */
  reset(): void {
    this.waitingUntil = 0;
    this.waiting = null;
    this.listedAt = 0;
  }

  private pause(why: string, ms: number) {
    this.waiting = why;
    this.waitingUntil = this.now() + ms;
  }
}
