import type { PatchSessionBody, PlaySessionsQuery, PutPackBody, SessionsQuery, SummaryQuery, TrendsQuery } from "./queries.ts";
import type { AppUpdateResponse, BallchasingTestResponse, ConfigPatch, ConfigPatchResponse, ConfigResponse, MeCandidate, OpenTarget, TeammateSuggestion } from "./config.ts";
import type { ReplayActionResponse, ReplaysResponse, BallchasingFetchResponse, LaunchGameResponse, ReplayGotoResponse, ReplayAnalysisResponse, ReviewResponse, SettingsResponse } from "./responses.ts";
import type {
  HealthResponse,
  Pack,
  PlaySessionsResponse,
  PracticeResponse,
  SessionDetailResponse,
  SessionsResponse,
  SplitsResponse,
  SummaryResponse,
  TrendsResponse,
} from "./responses.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | string[] | undefined>;

const toQuery = (params: Params = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
};

/**
 * A small typed client for the collector's API. `baseUrl` is empty in the
 * browser (same origin, or Vite's dev proxy) and a full URL in tests.
 */
export function createApiClient(baseUrl = "", fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || res.statusText);
    }
    if (res.status === 204) return null as T;
    return (await res.json()) as T;
  };
  const get = <T>(path: string, params?: Params) => request<T>("GET", path + toQuery(params));

  return {
    health: () => get<HealthResponse>("/api/health"),
    settings: () => get<SettingsResponse>("/api/settings"),
    sessions: (q: Partial<SessionsQuery> = {}) => get<SessionsResponse>("/api/sessions", q),
    summary: (q: Partial<SummaryQuery> = {}) => get<SummaryResponse>("/api/summary", q),
    session: (id: string) => get<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}`),
    trends: (q: Partial<TrendsQuery> = {}) => get<TrendsResponse>("/api/trends", q as Params),
    splits: () => get<SplitsResponse>("/api/splits"),
    playSessions: (q: Partial<PlaySessionsQuery> = {}) => get<PlaySessionsResponse>("/api/play-sessions", q),
    practice: () => get<PracticeResponse>("/api/practice"),
    packs: () => get<Pack[]>("/api/packs"),
    patchSession: (id: string, body: PatchSessionBody) =>
      request<SessionDetailResponse["session"]>("PATCH", `/api/sessions/${encodeURIComponent(id)}`, body),
    putPack: (code: string, body: PutPackBody) => request<Pack>("PUT", `/api/packs/${encodeURIComponent(code)}`, body),
    review: (id: string) => get<ReviewResponse>(`/api/sessions/${encodeURIComponent(id)}/review`),
    /** Positioning, boost and challenges from the match's saved replay. */
    analysis: (id: string) => get<ReplayAnalysisResponse>(`/api/sessions/${encodeURIComponent(id)}/analysis`),
    replayGoto: (body: { replayId: string; frame: number; leadSeconds?: number; camera?: "mine" | "director" | "keep"; launch?: boolean }) => request<ReplayGotoResponse>("POST", "/api/replay/goto", body),
    /** Open a saved replay in the game from the start. */
    replayWatch: (replayId: string, launch?: boolean) => request<ReplayGotoResponse>("POST", "/api/replay/watch", { replayId, launch }),
    /** Delete a match from the database (the raw recording stays; re-ingesting skips it). */
    deleteSession: (id: string) => request<null>("DELETE", `/api/sessions/${encodeURIComponent(id)}`),
    /** Download a match's replay from ballchasing into the replays folder. */
    fetchReplayFromBallchasing: (id: string) => request<BallchasingFetchResponse>("POST", `/api/sessions/${encodeURIComponent(id)}/replay/ballchasing`),
    /** Start Rocket League (desktop app only). */
    launchGame: () => request<LaunchGameResponse>("POST", "/api/game/launch"),
    /** The Replays screen. */
    replays: () => get<ReplaysResponse>("/api/replays"),
    startBackfill: (includeRecorded = false, quitWhenDone = false) =>
      request<ReplayActionResponse>("POST", "/api/replays/backfill", { includeRecorded, quitWhenDone }),
    /** Change, while replays play, whether the game is closed when they finish. */
    setBackfillQuit: (on: boolean) => request<ReplayActionResponse>("POST", "/api/replays/backfill/quit-when-done", { on }),
    stopBackfill: () => request<ReplayActionResponse>("POST", "/api/replays/backfill/stop"),
    fetchMissingFromBallchasing: () => request<ReplayActionResponse>("POST", "/api/replays/ballchasing"),
    /** The settings screen. */
    config: () => get<ConfigResponse>("/api/config"),
    patchConfig: (body: ConfigPatch) => request<ConfigPatchResponse>("PATCH", "/api/config", body),
    teammateSuggestions: () => get<TeammateSuggestion[]>("/api/config/teammates"),
    meCandidates: () => get<MeCandidate[]>("/api/config/me-candidates"),
    testBallchasing: (token?: string) => request<BallchasingTestResponse>("POST", "/api/config/ballchasing-test", token ? { token } : {}),
    pickFolder: (title: string, defaultPath?: string) => request<{ ok: true; path: string | null }>("POST", "/api/config/pick-folder", { title, defaultPath }),
    restartApp: () => request<{ ok: true }>("POST", "/api/app/restart"),
    openInApp: (what: OpenTarget) => request<{ ok: true }>("POST", "/api/app/open", { what }),
    /** The desktop app's update, if one was found. */
    appUpdate: () => get<AppUpdateResponse>("/api/app/update"),
    /** Download it if needed, install it and restart. */
    installUpdate: () => request<{ ok: true }>("POST", "/api/app/update"),
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
