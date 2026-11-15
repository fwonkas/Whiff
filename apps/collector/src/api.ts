import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { OpenTarget, type AppUpdate, type AppUpdateResponse, type ReplayActionResponse, type ReplaysResponse, type BallchasingFetchResponse, type BallchasingTestResponse, ConfigPatch, type ConfigPatchResponse, type ConfigResponse, type TeammateSuggestion, type MeCandidate, PatchSessionBody, PlaySessionsQuery, PutPackBody, ReplayGotoBody, type LaunchGameResponse, type ReplayAnalysisResponse, type ReplayGotoResponse, type SettingsResponse, SessionsQuery, SummaryQuery, TrendsQuery, type HealthResponse } from "@rl/api-contract";
import type { StatsService } from "./service.ts";

export interface ApiOptions {
  service: StatsService;
  gameConnected: () => boolean;
  /** Folder with the built web app (apps/web/dist). Served at / when it exists. */
  webRoot?: string;
  /** Jump to a frame in a saved replay in the game. Absent when there's no game connection to drive. */
  replayGoto?: (body: ReplayGotoBody) => ReplayGotoResponse | Promise<ReplayGotoResponse>;
  /** Open a saved replay in the game, from the start. */
  replayWatch?: (replayId: string, launch: boolean) => ReplayGotoResponse | Promise<ReplayGotoResponse>;
  /** Delete a match (and its replay playbacks) from the database; the raw log stays. */
  deleteMatch?: (id: string) => boolean;
  /** Settings the web app needs. */
  settings?: () => SettingsResponse;
  /** Start Rocket League. Only the desktop app can (it owns the dialogs and the store links). */
  launchGame?: () => Promise<LaunchGameResponse>;
  /** Download a match's replay from ballchasing. Absent without an API key. */
  fetchReplay?: (sessionId: string) => Promise<BallchasingFetchResponse>;
  /** A match's analysis from its saved replay. Null: no such match. */
  analysis?: (sessionId: string) => ReplayAnalysisResponse | null;
  /** The Replays screen: status, and playing or downloading the missing ones. */
  replays?: {
    overview(): ReplaysResponse;
    startBackfill(includeRecorded: boolean, quitWhenDone: boolean): ReplayActionResponse;
    stopBackfill(): void;
    setBackfillQuit(on: boolean): void;
    fetchFromBallchasing(): ReplayActionResponse;
  };
  /** The settings screen. Absent without a settings file. */
  config?: {
    view(editable: boolean): ConfigResponse;
    patch(p: ConfigPatch): Promise<ConfigPatchResponse>;
    teammates(): TeammateSuggestion[];
    /** Others in the session my player was recognized in, to pick from when the guess is wrong. */
    meCandidates(): MeCandidate[];
    testBallchasing(token?: string): Promise<BallchasingTestResponse>;
    pickFolder?: (title: string, defaultPath?: string) => Promise<string | null>;
    restart?: () => void;
    open?: (what: OpenTarget) => void;
    update?: () => AppUpdate | null;
    installUpdate?: () => void;
  };
}

/**
 * Settings can be changed only from this PC. With allowLan on, a phone on the
 * network can read them (without the ballchasing key) but not change them.
 * In-process requests (tests) have no socket and count as local.
 */
function fromThisPc(c: Context): boolean {
  const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return addr === undefined || addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * Writes must come from this app's own pages. Browsers send Origin on
 * cross-site requests, so without this any website could make the game launch
 * or a note change through the local server. Requests without an Origin
 * (curl, the tests) and the same host (Electron, Vite's proxy, a phone on the
 * LAN) pass.
 */
function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === c.req.header("host");
  } catch {
    return false;
  }
}

const invalid = (c: Context, error: z.ZodError) => c.json({ error: "invalid request", details: z.flattenError(error) }, 400);

/** The read API, plus the two small writes (pack tags and notes). */
export function createApi({ service, gameConnected, webRoot, replayGoto, replayWatch, deleteMatch, settings, launchGame, fetchReplay, config, replays, analysis }: ApiOptions) {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(c)) return c.json({ error: "cross-origin request" }, 403);
    await next();
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, gameConnected: gameConnected(), sessions: service.db.countSessions() } satisfies HealthResponse),
  );

  app.get("/api/sessions", (c) => {
    const q = SessionsQuery.safeParse(c.req.query());
    return q.success ? c.json(service.sessions(q.data)) : invalid(c, q.error);
  });

  app.get("/api/summary", (c) => {
    const q = SummaryQuery.safeParse(c.req.query());
    return q.success ? c.json(service.summary(q.data)) : invalid(c, q.error);
  });

  app.get("/api/settings", (c) => c.json(settings?.() ?? ({ replayLeadSeconds: 10, canLaunchGame: !!launchGame, canQuitGame: false, replayAgainShortcut: null, ballchasing: !!fetchReplay } satisfies SettingsResponse)));

  app.get("/api/sessions/:id/review", (c) => {
    const r = service.review(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/sessions/:id/analysis", (c) => {
    const r = analysis ? analysis(c.req.param("id")) : ({ state: "no-replay" } as const);
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/replay/goto", async (c) => {
    const body = ReplayGotoBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error);
    if (!replayGoto) return c.json({ ok: false, reason: "replay control isn't available" } satisfies ReplayGotoResponse, 503);
    const r = await replayGoto(body.data);
    return c.json(r, r.ok ? 202 : 409);
  });

  app.post("/api/sessions/:id/replay/ballchasing", async (c) => {
    if (!fetchReplay) return c.json({ ok: false, reason: "no ballchasing API key is set" } satisfies BallchasingFetchResponse, 503);
    const r = await fetchReplay(c.req.param("id"));
    return c.json(r, r.ok ? 200 : 409);
  });

  const noConfig = (c: Context) => c.json({ ok: false, reason: "settings can't be changed here: there's no settings file" }, 503);
  const notHere = (c: Context) => c.json({ ok: false, reason: "settings can be changed only on the PC running Whiff" }, 403);
  app.get("/api/config", (c) => (config ? c.json(config.view(fromThisPc(c))) : noConfig(c)));
  app.patch("/api/config", async (c) => {
    if (!config) return noConfig(c);
    if (!fromThisPc(c)) return notHere(c);
    const body = ConfigPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error);
    const r = await config.patch(body.data);
    return c.json(r, r.ok ? 200 : 409);
  });
  app.get("/api/config/teammates", (c) => (config ? c.json(config.teammates()) : noConfig(c)));
  app.get("/api/config/me-candidates", (c) => (config ? c.json(config.meCandidates()) : noConfig(c)));
  app.post("/api/config/ballchasing-test", async (c) => {
    if (!config) return noConfig(c);
    if (!fromThisPc(c)) return notHere(c);
    const body = z.object({ token: z.string().trim().min(1).optional() }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!body.success) return invalid(c, body.error);
    return c.json(await config.testBallchasing(body.data.token));
  });
  app.post("/api/config/pick-folder", async (c) => {
    if (!config?.pickFolder) return c.json({ ok: false, reason: "only the desktop app can show a folder picker" }, 503);
    if (!fromThisPc(c)) return notHere(c);
    const body = z.object({ title: z.string().max(120), defaultPath: z.string().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error);
    return c.json({ ok: true, path: await config.pickFolder(body.data.title, body.data.defaultPath) });
  });
  app.post("/api/app/open", async (c) => {
    if (!config?.open) return c.json({ ok: false, reason: "only the desktop app can open files" }, 503);
    if (!fromThisPc(c)) return notHere(c);
    const body = z.object({ what: OpenTarget }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error);
    config.open(body.data.what);
    return c.json({ ok: true });
  });
  app.get("/api/app/update", (c) =>
    c.json({ update: config?.update?.() ?? null, canInstall: !!config?.installUpdate && fromThisPc(c) } satisfies AppUpdateResponse),
  );
  app.post("/api/app/update", (c) => {
    if (!config?.installUpdate) return c.json({ ok: false, reason: "only the desktop app updates itself" }, 503);
    if (!fromThisPc(c)) return notHere(c);
    if (!config.update?.()) return c.json({ ok: false, reason: "no update found" }, 409);
    config.installUpdate();
    return c.json({ ok: true }, 202);
  });
  app.post("/api/app/restart", (c) => {
    if (!config?.restart) return c.json({ ok: false, reason: "only the desktop app can restart itself" }, 503);
    if (!fromThisPc(c)) return notHere(c);
    setTimeout(() => config.restart!(), 300);
    return c.json({ ok: true }, 202);
  });

  const noReplays = (c: Context) => c.json({ ok: false, reason: "replay management needs the collector" }, 503);
  app.get("/api/replays", (c) => (replays ? c.json(replays.overview()) : noReplays(c)));
  app.post("/api/replays/backfill", async (c) => {
    if (!replays) return noReplays(c);
    const body = z
      .object({ includeRecorded: z.boolean().default(false), quitWhenDone: z.boolean().default(false) })
      .safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!body.success) return invalid(c, body.error);
    const r = replays.startBackfill(body.data.includeRecorded, body.data.quitWhenDone);
    return c.json(r, r.ok ? 202 : 409);
  });
  app.post("/api/replays/backfill/quit-when-done", async (c) => {
    if (!replays) return noReplays(c);
    const body = z.object({ on: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error);
    replays.setBackfillQuit(body.data.on);
    return c.json({ ok: true } satisfies ReplayActionResponse);
  });
  app.post("/api/replays/backfill/stop", (c) => {
    if (!replays) return noReplays(c);
    replays.stopBackfill();
    return c.json({ ok: true } satisfies ReplayActionResponse);
  });
  app.post("/api/replays/ballchasing", (c) => {
    if (!replays) return noReplays(c);
    const r = replays.fetchFromBallchasing();
    return c.json(r, r.ok ? 202 : 409);
  });

  app.post("/api/game/launch", async (c) => {
    if (!launchGame) return c.json({ ok: false, reason: "only the desktop app can launch the game" } satisfies LaunchGameResponse, 503);
    const r = await launchGame();
    return c.json(r, r.ok ? 202 : 409);
  });

  app.post("/api/replay/watch", async (c) => {
    const body = z.object({ replayId: z.string().regex(/^[0-9A-Fa-f]{32}$/), launch: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error);
    if (!replayWatch) return c.json({ ok: false, reason: "replay control isn't available" } satisfies ReplayGotoResponse, 503);
    const r = await replayWatch(body.data.replayId, body.data.launch ?? false);
    return c.json(r, r.ok ? 202 : 409);
  });

  app.delete("/api/sessions/:id", (c) => {
    if (!fromThisPc(c)) return c.json({ error: "matches can be deleted only on the PC running Whiff" }, 403);
    if (!deleteMatch) return c.json({ error: "deleting isn't available" }, 503);
    return deleteMatch(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/sessions/:id", (c) => {
    const d = service.detail(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  });

  app.patch("/api/sessions/:id", async (c) => {
    const body = PatchSessionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error);
    const id = c.req.param("id");
    if (!service.db.updateSession(id, body.data)) return c.json({ error: "not found" }, 404);
    return c.json(service.detail(id)!.session);
  });

  app.get("/api/trends", (c) => {
    const q = TrendsQuery.safeParse(c.req.query());
    return q.success ? c.json(service.trends(q.data)) : invalid(c, q.error);
  });

  app.get("/api/splits", (c) => c.json(service.splits()));

  app.get("/api/play-sessions", (c) => {
    const q = PlaySessionsQuery.safeParse(c.req.query());
    return q.success ? c.json(service.playSessions(q.data)) : invalid(c, q.error);
  });
  app.get("/api/practice", (c) => c.json(service.practice()));
  app.get("/api/packs", (c) => c.json(service.db.packs()));

  app.put("/api/packs/:code", async (c) => {
    const body = PutPackBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error);
    const code = c.req.param("code");
    service.db.putPack(code, body.data.name, body.data.type);
    return c.json({ code, ...body.data });
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // The built web app, with client-side routes falling back to index.html.
  if (webRoot && existsSync(join(webRoot, "index.html"))) {
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("/*", serveStatic({ root: webRoot, path: "index.html" }));
  }

  return app;
}
