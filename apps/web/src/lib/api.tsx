import { createContext, useContext, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createApiClient, type ApiClient, type ConfigPatch, type ConfigResponse, type OpenTarget, type PatchSessionBody, type SessionsQuery, type SummaryQuery, type TrendsQuery } from "@rl/api-contract";
import { cacheUi } from "./ui-prefs.ts";

/**
 * The API client lives in context so tests can swap in a fake. Every screen
 * reads data through the hooks below, never by calling fetch itself.
 */
const ApiContext = createContext<ApiClient>(createApiClient());

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export const useApi = () => useContext(ApiContext);

/** Query keys in one place, so invalidation (e.g. when a session is saved) stays in sync. */
export const keys = {
  all: ["rl"] as const,
  sessions: (q: Partial<SessionsQuery>) => ["rl", "sessions", q] as const,
  summary: (q: Partial<SummaryQuery>) => ["rl", "summary", q] as const,
  session: (id: string) => ["rl", "session", id] as const,
  trends: (q: Partial<TrendsQuery>) => ["rl", "trends", q] as const,
  splits: () => ["rl", "splits"] as const,
  practice: () => ["rl", "practice"] as const,
  playSessions: () => ["rl", "play-sessions"] as const,
  review: (id: string) => ["rl", "review", id] as const,
  analysis: (id: string) => ["rl", "analysis", id] as const,
  settings: () => ["rl", "settings"] as const,
  config: () => ["rl", "config"] as const,
  replays: () => ["rl", "replays"] as const,
  teammateSuggestions: () => ["rl", "config", "teammates"] as const,
  meCandidates: () => ["rl", "config", "me-candidates"] as const,
  appUpdate: () => ["rl", "app-update"] as const,
  tags: () => ["rl", "tags"] as const,
};

/** Sessions, newest first, a page at a time (cursor = the oldest start time so far). */
export function useSessions(q: Omit<Partial<SessionsQuery>, "before">) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.sessions(q),
    queryFn: ({ pageParam }) => api.sessions({ ...q, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useSummary(q: Partial<SummaryQuery>) {
  const api = useApi();
  return useQuery({ queryKey: keys.summary(q), queryFn: () => api.summary(q), placeholderData: keepPreviousData });
}

export function useSession(id: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.session(id), queryFn: () => api.session(id) });
}

export function useTrends(q: Partial<TrendsQuery>) {
  const api = useApi();
  return useQuery({ queryKey: keys.trends(q), queryFn: () => api.trends(q), placeholderData: keepPreviousData });
}

export function useSplits() {
  const api = useApi();
  return useQuery({ queryKey: keys.splits(), queryFn: () => api.splits() });
}

export function usePractice() {
  const api = useApi();
  return useQuery({ queryKey: keys.practice(), queryFn: () => api.practice() });
}

/** Play sessions (sittings), newest first, a page at a time. */
export function usePlaySessions() {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.playSessions(),
    queryFn: ({ pageParam }) => api.playSessions({ before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Moments to review in a match's replay (goals for and against, with replay frames). */
export function useReview(id: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.review(id), queryFn: () => api.review(id) });
}

/**
 * Positioning, boost and challenges from a match's saved replay. While the
 * replay waits its turn it checks again every 15 seconds.
 */
export function useReplayAnalysis(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.analysis(id),
    queryFn: () => api.analysis(id),
    refetchInterval: (q) => (q.state.data?.state === "pending" ? 15_000 : false),
  });
}

/**
 * Jump the game to a frame of a saved replay (it loads the replay first when
 * needed). Resolves with { ok: false, reason } when the game can't do it now,
 * e.g. it isn't running or a match is in progress.
 */
export function useReplayGoto() {
  const api = useApi();
  return useMutation({
    mutationFn: (body: { replayId: string; frame: number; leadSeconds?: number; camera?: "mine" | "director" | "keep"; launch?: boolean }) =>
      api.replayGoto(body).catch(refusal),
  });
}

/**
 * Start Rocket League through the desktop app (it may ask about the Stats API
 * first). Resolves with { ok: false, reason } when it can't, e.g. outside the
 * desktop app or when neither store has the game.
 */
export function useLaunchGame() {
  const api = useApi();
  return useMutation({ mutationFn: () => api.launchGame().catch(refusal) });
}

/**
 * Download a match's replay from my ballchasing uploads into the game's
 * replays folder, then refresh its review so the Watch buttons appear.
 */
export function useFetchReplayFromBallchasing(sessionId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.fetchReplayFromBallchasing(sessionId).catch(refusal),
    onSuccess: (r) => {
      if (!r.ok) return;
      void queryClient.invalidateQueries({ queryKey: keys.review(sessionId) });
      void queryClient.invalidateQueries({ queryKey: keys.replays() });
    },
  });
}

/** 409 and 503 carry { ok: false, reason } bodies; surface them as results, not errors. */
function refusal(e: unknown): { ok: false; reason: string } {
  const message = e instanceof Error ? e.message : String(e);
  let body: unknown;
  try {
    body = JSON.parse(message);
  } catch {
    throw e;
  }
  return body as { ok: false; reason: string };
}

/** Settings from the settings file that the web app uses (e.g. replay lead time). */
export function useSettings() {
  const api = useApi();
  return useQuery({ queryKey: keys.settings(), queryFn: () => api.settings(), staleTime: 60_000 });
}

/** The settings screen's view of the settings file. Fails (503) when the collector has no settings file. */
export function useConfig() {
  const api = useApi();
  return useQuery({ queryKey: keys.config(), queryFn: () => api.config(), staleTime: 30_000, retry: false });
}

/**
 * Change settings. The answer is the new view, so the cache is set from it.
 * Teammates, player IDs and the practice speed change what past sessions
 * show, so those refresh everything.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The settings as they'll be once a patch is saved: nested settings (ui, notifications…) merged, lists and values replaced. */
export function mergePatch<T>(current: T, patch: object): T {
  if (!isPlainObject(current)) return current;
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergePatch(out[k], v) : v;
  }
  return out as T;
}

export function usePatchConfig() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: ConfigPatch) => api.patchConfig(patch).catch(refusal),
    // Show the change at once: a controlled checkbox would otherwise flip back
    // to the old value until the server answers, then forward again.
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: keys.config() });
      const before = queryClient.getQueryData<ConfigResponse>(keys.config());
      if (before) queryClient.setQueryData(keys.config(), mergePatch(before, patch));
      return { before };
    },
    onError: (_e, _patch, ctx) => {
      if (ctx?.before) queryClient.setQueryData(keys.config(), ctx.before);
    },
    onSuccess: (r, patch, ctx) => {
      if (!r.ok) {
        if (ctx?.before) queryClient.setQueryData(keys.config(), ctx.before);
        return;
      }
      queryClient.setQueryData(keys.config(), r.config);
      cacheUi(r.config.ui);
      if (patch.knownTeammates || patch.myPrimaryIds || patch.practiceGameSpeed !== undefined || patch.replayDirs !== undefined) {
        void queryClient.invalidateQueries({ queryKey: keys.all, predicate: (q) => q.queryKey[1] !== "config" });
        if (patch.myPrimaryIds) void queryClient.invalidateQueries({ queryKey: keys.meCandidates() });
      } else {
        void queryClient.invalidateQueries({ queryKey: keys.settings() });
      }
    },
  });
}

export function useTeammateSuggestions(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: keys.teammateSuggestions(), queryFn: () => api.teammateSuggestions(), enabled });
}

/** The others in the session my player was recognized in (for "Not you?"). */
export function useMeCandidates(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: keys.meCandidates(), queryFn: () => api.meCandidates(), enabled });
}

export function useTestBallchasing() {
  const api = useApi();
  return useMutation({ mutationFn: (token?: string) => api.testBallchasing(token).catch(refusal) });
}

/** The desktop app's folder picker. Resolves with the folder, or null when cancelled. */
export function usePickFolder() {
  const api = useApi();
  return useMutation({ mutationFn: ({ title, defaultPath }: { title: string; defaultPath?: string }) => api.pickFolder(title, defaultPath).then((r) => r.path) });
}

/** The desktop app's update, if its check found one. Polls quickly while it's being installed. */
export function useAppUpdate() {
  const api = useApi();
  return useQuery({
    queryKey: keys.appUpdate(),
    queryFn: () => api.appUpdate(),
    refetchInterval: (q) => (q.state.data?.update?.installing ? 2_000 : 60_000),
  });
}

/** Download the update if needed, install it and restart the app. */
export function useInstallUpdate() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api.installUpdate(), onSettled: () => qc.invalidateQueries({ queryKey: keys.appUpdate() }) });
}

export function useRestartApp() {
  const api = useApi();
  return useMutation({ mutationFn: () => api.restartApp() });
}

/** Every match's replay status. Polls while replays are playing or downloading. */
export function useReplays() {
  const api = useApi();
  return useQuery({
    queryKey: keys.replays(),
    queryFn: () => api.replays(),
    staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.backfill.running || q.state.data?.ballchasing.running ? 2_000 : false),
  });
}

/** Start or stop playing saved replays, or start downloading missing ones; each refreshes the Replays screen. */
export function useReplayActions() {
  const api = useApi();
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.replays() });
  return {
    play: useMutation({
      mutationFn: ({ all, quitWhenDone }: { all: boolean; quitWhenDone: boolean }) => api.startBackfill(all, quitWhenDone).catch(refusal),
      onSettled: refresh,
    }),
    stop: useMutation({ mutationFn: () => api.stopBackfill(), onSettled: refresh }),
    /** While replays play: whether the game is closed when they finish. */
    quitWhenDone: useMutation({ mutationFn: (on: boolean) => api.setBackfillQuit(on), onSettled: refresh }),
    ballchasing: useMutation({ mutationFn: () => api.fetchMissingFromBallchasing().catch(refusal), onSettled: refresh }),
  };
}

/** Open a saved replay in the game from its start (no jump). */
export function useReplayWatch() {
  const api = useApi();
  return useMutation({ mutationFn: ({ replayId, launch }: { replayId: string; launch?: boolean }) => api.replayWatch(replayId, launch).catch(refusal) });
}

/** Change what I edit on a session (notes, a training pack, a left-early match counted as settled). */
export function usePatchSession() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchSessionBody }) => api.patchSession(id, body),
    // The outcome feeds the list, the cards and the neighbors' labels, not just this page.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.all, predicate: (q) => q.queryKey[1] !== "config" }),
  });
}

/** Delete a match. Everything that lists matches refreshes. */
/** Tags in use (for suggestions) and the known teammates' automatic ones. */
export function useTags(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: keys.tags(), queryFn: () => api.tags(), enabled, staleTime: 30_000 });
}

export function useDeleteSession() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.all, predicate: (q) => q.queryKey[1] !== "config" }),
  });
}

/** Open the settings file, the log, the data folder or the dashboard in a browser (desktop app). */
export function useOpenInApp() {
  const api = useApi();
  return useMutation({ mutationFn: (what: OpenTarget) => api.openInApp(what) });
}
