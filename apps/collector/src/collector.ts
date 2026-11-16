import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket as WsClient } from "ws";
import { DEFAULT_UPLOAD_RULES, type UploadRules } from "@rl/api-contract";
import type { ConfigPatch, ConfigPatchResponse, ConfigResponse, LaunchGameResponse, LiveMessage, ReplayAnalysisResponse, ReplayGotoResponse, ReplayMatchItem, ReplaysResponse } from "@rl/api-contract";
import type { CollectorConfig, Session } from "@rl/domain";
import { GameCommand, parseMessage } from "@rl/schema";
import { createApi } from "./api.ts";
import { StatsDb } from "./db.ts";
import { compressRawLogs, RawLogWriter } from "./recording.ts";
import { StatsService } from "./service.ts";
import { Backfill, BACKFILL_RECORDED_SPEED, BACKFILL_SPEED, type BackfillProgress } from "./backfill.ts";
import { BallchasingClient, BallchasingError, fetchMissingReplays, ReplayUploader, replayTitle, uploadKind, type FetchOutcome, type FetchProgress } from "./ballchasing.ts";
import { MeDetector } from "./me-detector.ts";
import { DEFAULT_REPLAY_LEAD_SECONDS, ReplayRemote } from "./replay-remote.ts";
import { listSavedReplays, matchHistoryRisk, planBackfill, type BackfillPlan, type MatchHistoryRisk } from "./replay-files.ts";
import { Sessionizer } from "./sessionizer.ts";
import { completeAtReplayEnd } from "./replays.ts";
import { ReplayAnalyzer } from "./replay-analyzer.ts";
import { SubtrWorker, type SubtrWorkerOptions } from "./subtr/pool.ts";
import { configView, dashboardAddresses, writeSettingsPatch, type DesktopHooks } from "./settings.ts";
import { loadConfig } from "./config.ts";

/**
 * Why not to close the game at the end of a replay run, or null to close it.
 * Only live play keeps it open: a replay session still open (the last replay
 * on its final frame, one skipped as stuck) doesn't, as it did on 2026-11-15.
 */
export function keepGameOpen(s: { stopped: boolean; gameConnected: boolean; active: { kind: string } | null }): string | null {
  if (s.stopped) return "Whiff is shutting down";
  if (!s.gameConnected) return "the game isn't connected";
  if (s.active && s.active.kind !== "replay") return `${s.active.kind} in progress`;
  return null;
}

export interface CollectorOptions extends CollectorConfig {
  gameUrl: string;
  dbPath: string;
  rawDir: string;
  /** HTTP API, web app and live feed (/live) all share this port. 0 picks a free one. */
  port: number;
  /** "127.0.0.1" (this PC only, the default) or "0.0.0.0" (other devices on the network). */
  host?: string;
  /** Built web app to serve at /, if present. */
  webRoot?: string;
  log?: (line: string) => void;
  /** Called whenever connection, pause or recognition state changes. */
  onStatus?: (status: CollectorStatus) => void;
  /**
   * With no myPrimaryIds, the collector works out which player is me from the
   * camera and calls this once, so the caller can save it.
   */
  onMeDetected?: (primaryId: string) => void;
  /** Folders with saved replays (`DemosEpic`, `Demos`), for backfill. See replayDirsIn(). */
  replayDirs?: string[];
  /** Backfill progress changed. */
  onBackfill?: (p: BackfillProgress) => void;
  /** Bring Rocket League's window to the front (after a jump to a replay moment). */
  focusGame?: () => void;
  /** The ballchasing API key (read when needed, so a new one works without a restart). */
  ballchasingToken?: () => string | null;
  /** Where subtr-actor's worker and WASM are (the desktop app's bundled copies); false turns replay analysis off. */
  replayAnalysis?: SubtrWorkerOptions | false;
  /** Upload saved replays to ballchasing when there's a key (default on), and who can see them. */
  ballchasingUpload?: boolean;
  ballchasingUploads?: UploadRules;
  /** Progress while downloading missing replays from ballchasing. */
  onBallchasing?: (p: FetchProgress & { running: boolean }) => void;
  /** The keyboard shortcut that calls replayAgain(), to mention in the web app. */
  replayAgainShortcut?: () => string | null;
  /** Start Rocket League from the dashboard (the desktop app's launch routine). */
  launchGame?: () => Promise<LaunchGameResponse>;
  /**
   * Close Rocket League (the desktop app, on Windows): offered when playing
   * saved replays, for when the run finishes. Resolves to whether it closed.
   */
  quitGame?: () => Promise<boolean>;
  /** The settings file, for the settings screen. Without it, settings can't be changed in the app. */
  settingsFile?: string;
  /** The game's own replay folders, used when the settings file names none. */
  defaultReplayDirs?: string[];
  /** What only the desktop app can do (shortcuts, start at login, folder picker, restart). */
  desktop?: DesktopHooks;
}

export interface CollectorStatus {
  gameConnected: boolean;
  /** Recording paused: messages from the game are ignored. */
  paused: boolean;
  /** My PrimaryIds, configured or detected. Empty until known. */
  me: string[];
  /** The last session saved, for a tooltip. */
  lastSession: { kind: string; startedAt: number; outcome: string | null } | null;
}

export interface RunningCollector {
  port: number;
  db: StatsDb;
  service: StatsService;
  status(): CollectorStatus;
  /** Saved replays worth playing, without starting anything. */
  backfillPlan(): BackfillPlan;
  /**
   * Play saved replays at 2x, one after another: matches never recorded
   * first, then (with includeRecorded) the rest, which add opponents' car data.
   * Refused while a live session is open or the game isn't connected.
   */
  startBackfill(options?: { includeRecorded?: boolean; quitWhenDone?: boolean }): { started: boolean; queued: number; reason?: string };
  stopBackfill(): void;
  /** While replays play: whether the game is closed when they finish. */
  setBackfillQuit(on: boolean): void;
  /** Recent matches in the game's Match History with no saved replay, and those about to drop out. */
  matchHistoryRisk(): MatchHistoryRisk<{ id: string; matchGuid: string; endedAt: number; playlistId: number | null; outcome: string | null }>;
  backfillProgress(): BackfillProgress;
  /** Pausing ends the session in progress; nothing is recorded until resumed. */
  setPaused(paused: boolean): void;
  /**
   * Download replays of recorded matches that have none saved from my
   * ballchasing uploads (all of them, or the given sessions).
   */
  fetchReplays(sessionIds?: string[]): Promise<{ outcomes: FetchOutcome[]; error?: string }>;
  /** Back to where the last replay jump started (a keyboard shortcut in the desktop app). */
  replayAgain(): ReplayGotoResponse;
  /** Every match's replay status, and what can be done about the gaps (the Replays screen). */
  replays(): ReplaysResponse;
  stop(): Promise<void>;
}

/** @deprecated Use LiveMessage from @rl/api-contract. */
export type RelayMessage = LiveMessage;

/**
 * The only client of the game's socket. Writes the raw log, keeps the
 * database current, serves the API and web app, and relays the live feed
 * (and replay commands) over /live.
 */
export async function startCollector(opts: CollectorOptions): Promise<RunningCollector> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = new StatsDb(opts.dbPath);
  const dropped = db.deleteNeverStartedMatches();
  if (dropped) log(`removed ${dropped} match(es) that never started`);
  let recordCasual = opts.recordCasual ?? false;
  const casualDropped = db.setRecordCasual(recordCasual);
  if (casualDropped) log(`removed ${casualDropped} casual match(es) rebuilt from replays (casual matches are off)`);
  let replayDirs = opts.replayDirs ?? [];
  let matchHistoryWarn = opts.matchHistoryWarn;
  const service = new StatsService(db, { practiceGameSpeed: opts.practiceGameSpeed, replayDirs, matchHistoryWarn });
  // One raw log per game launch (each connection to the game), named for when it connected.
  const rawFor = (at: number) => new RawLogWriter(join(opts.rawDir, `${new Date(at).toISOString().replace(/[:.]/g, "-").slice(0, 19)}.ndjson`));
  let raw = rawFor(Date.now());
  // Finished logs are gzipped: those left from before at start, each one as a new one takes over.
  let compressing: Promise<unknown> = Promise.resolve();
  const compressFinished = () => {
    compressing = compressing.then(() => compressRawLogs(opts.rawDir, raw.path, log));
  };
  compressFinished();

  let game: WebSocket | null = null;
  let stopped = false;
  let gameConnected = false;
  let connectedAt: number | null = null;
  let paused = false;
  let me = [...opts.myPrimaryIds];
  let lastSession: CollectorStatus["lastSession"] = null;
  const detector = me.length ? null : new MeDetector();
  const status = (): CollectorStatus => ({ gameConnected, paused, me: [...me], lastSession });
  const notify = () => opts.onStatus?.(status());
  let retryMs = 1000;
  let retryTimer: NodeJS.Timeout | null = null;
  // SetHUDVisibility persists into later matches, so the collector restores it.
  let hudHidden = false;

  // --- ballchasing: replays of recorded matches with none saved -------------
  type FetchResult = { outcomes: FetchOutcome[]; error?: string };
  let ballchasingProgress = { running: false, done: 0, total: 0, found: 0 };
  const onBallchasing = (p: FetchProgress & { running: boolean }) => {
    ballchasingProgress = p;
    opts.onBallchasing?.(p);
  };
  let fetching: Promise<FetchResult> | null = null;
  const fetchReplays = (sessionIds?: string[]): Promise<FetchResult> => {
    if (fetching) return fetching.then(() => fetchReplays(sessionIds));
    const run = async (): Promise<{ outcomes: FetchOutcome[]; error?: string }> => {
      const token = opts.ballchasingToken?.();
      if (!token) return { outcomes: [], error: "no ballchasing API key is set" };
      const dirs = replayDirs;
      const dir = dirs.find((d) => existsSync(d)) ?? dirs[0];
      if (!dir) return { outcomes: [], error: "no replays folder" };
      const saved = new Set(listSavedReplays(dirs).flatMap((r) => (r.matchGuid ? [r.matchGuid] : [])));
      const wanted = sessionIds ? new Set(sessionIds) : null;
      const missing = db.liveMatchesForReplays().filter((m) => !saved.has(m.matchGuid) && (!wanted || wanted.has(m.sessionId)));
      if (!missing.length) return { outcomes: [] };
      log(`ballchasing: looking for ${missing.length} replay(s)`);
      onBallchasing({ done: 0, total: missing.length, found: 0, running: true });
      try {
        const outcomes = await fetchMissingReplays(new BallchasingClient(token), missing, dir, {
          onProgress: (p) => onBallchasing({ ...p, running: true }),
        });
        const found = outcomes.filter((o) => o.ok).length;
        log(`ballchasing: downloaded ${found} of ${missing.length}`);
        onBallchasing({ done: outcomes.length, total: missing.length, found, running: false });
        const guidOf = new Map(missing.map((m) => [m.sessionId, m.matchGuid]));
        for (const o of outcomes) {
          const guid = guidOf.get(o.sessionId);
          if (guid) db.recordBallchasingCheck(guid, o.ok);
          if (o.ok) {
            // It came from there, so it's not one to upload.
            db.recordBallchasingUpload(o.replayId, null, "downloaded");
            service.invalidate(o.sessionId, null);
          }
        }
        service.invalidateReplayStatus();
        return { outcomes };
      } catch (e) {
        const error = e instanceof BallchasingError ? e.message : `couldn't reach ballchasing (${String(e)})`;
        log(`ballchasing: ${error}`);
        onBallchasing({ done: 0, total: missing.length, found: 0, running: false });
        return { outcomes: [], error };
      }
    };
    fetching = run().finally(() => (fetching = null));
    return fetching;
  };

  // --- ballchasing: uploading saved replays ---------------------------------
  let uploadOn = opts.ballchasingUpload ?? true;
  let uploadRules: UploadRules = opts.ballchasingUploads ?? DEFAULT_UPLOAD_RULES;
  let uploadClient: { token: string; client: BallchasingClient } | null = null;
  const uploader = new ReplayUploader({
    client: () => {
      const token = uploadOn ? opts.ballchasingToken?.() : null;
      if (!token) return null;
      if (uploadClient?.token !== token) uploadClient = { token, client: new BallchasingClient(token) };
      return uploadClient.client;
    },
    rules: () => uploadRules,
    replays: () => {
      const deleted = db.deletedGuids();
      const playlists = db.playlistsByGuid();
      const starts = db.matchStartsByGuid();
      return listSavedReplays(replayDirs)
        .filter((r) => !r.matchGuid || !deleted.has(r.matchGuid))
        .map((r) => {
          const guid = r.matchGuid?.toUpperCase() ?? null;
          const playlistId = guid ? (playlists.get(guid) ?? null) : null;
          const kind = uploadKind(r.matchType, playlistId);
          // The recorded start, else the header's end less the time played (a guess that includes any pauses).
          const startedAt = (guid && starts.get(guid)) || (r.matchEndedAt !== null && r.seconds !== null ? r.matchEndedAt - r.seconds * 1000 : null);
          return { ...r, kind, title: replayTitle({ playlistId, kind, startedAt }) };
        });
    },
    known: () => db.onBallchasing(),
    record: (replayId, id, how) => {
      db.recordBallchasingUpload(replayId, id, how);
      service.invalidateReplayStatus();
    },
    read: (path) => readFileSync(path),
    log,
  });

  // --- replay analysis: subtr-actor over saved replays ------------------------
  const subtrWorker = opts.replayAnalysis === false ? null : new SubtrWorker(opts.replayAnalysis ?? {});
  const analyzer = subtrWorker
    ? new ReplayAnalyzer({
        replays: () => listSavedReplays(replayDirs),
        analyzed: () => db.replayAnalyzers(),
        extract: (path) => subtrWorker.extract(path),
        save: (replayId, name, result) => {
          db.saveReplayAnalysis(replayId, name, result);
          service.invalidateReplayStatus();
        },
        // Not while a match, practice or replay plays: the game needs the CPU.
        canRun: () => !stopped && !paused && !sessionizer.active,
        log,
      })
    : null;
  const analysisFor = (sessionId: string): ReplayAnalysisResponse | null => {
    const s = service.session(sessionId);
    if (!s) return null;
    const guid = s.matchGuid?.toUpperCase();
    if (s.kind !== "match" || !guid) return { state: "no-replay" };
    const row = db.replayAnalysis(guid);
    if (row?.analysis) return { state: "ready", replayId: row.replayId, analysis: row.analysis };
    const saved = listSavedReplays(replayDirs).find((r) => r.matchGuid === guid);
    if (row?.error && (!saved || saved.replayId === row.replayId) && db.replayAnalyzers().get(row.replayId) === analyzer?.analyzer)
      return { state: "failed", replayId: row.replayId, error: row.error };
    return saved && analyzer ? { state: "pending", replayId: saved.replayId } : { state: "no-replay" };
  };

  // The collector's own interface, for API routes that need it (set before the server takes requests that use it).
  // eslint-disable-next-line prefer-const
  let handle: RunningCollector;

  // --- settings screen ------------------------------------------------------
  const running = { dataDir: resolve(dirname(opts.dbPath)), port: opts.port, allowLan: opts.host === "0.0.0.0" };
  const settingsView = (editable: boolean): ConfigResponse | null => {
    if (!opts.settingsFile) return null;
    const port = handle?.port ?? running.port;
    const v = configView(opts.settingsFile, { editable, desktop: opts.desktop, replayDirs, running, addresses: dashboardAddresses(port, running.allowLan) });
    v.me = v.me.map((m) => ({ ...m, name: db.latestName(m.primaryId) }));
    // Compare folders as paths, not strings.
    v.restartPending = v.restartPending.filter((k) => k !== "dataDir" || resolve(v.dataDir) !== running.dataDir);
    return v;
  };
  const patchSettings = async (p: ConfigPatch): Promise<ConfigPatchResponse> => {
    const file = opts.settingsFile;
    if (!file) return { ok: false, reason: "there's no settings file" };
    if (p.startAtLogin !== undefined) {
      if (!opts.desktop) return { ok: false, reason: "start at sign-in is set in the desktop app" };
      opts.desktop.setStartAtLogin(p.startAtLogin);
    }
    // Correcting the app's own guess: what it credited to the wrong player moves to the right one.
    const wasGuess = p.myPrimaryIds !== undefined && !loadConfig(file).meConfirmed;
    const guessed = [...me];
    try {
      writeSettingsPatch(file, p);
    } catch (e) {
      return { ok: false, reason: `couldn't write the settings file (${String(e)})` };
    }
    let cfg: ReturnType<typeof loadConfig>;
    try {
      cfg = loadConfig(file);
    } catch (e) {
      return { ok: false, reason: `the settings file has a value the app can't read (${String(e)})` };
    }
    const keys = Object.keys(p);
    log(`settings changed: ${keys.join(", ")}`);
    if (p.replayLeadSeconds !== undefined) replayLeadSeconds = cfg.replayLeadSeconds;
    if (p.replayDirs !== undefined) replayDirs = cfg.replayDirs ?? opts.defaultReplayDirs ?? [];
    if (p.matchHistoryWarn !== undefined) matchHistoryWarn = cfg.matchHistoryWarn;
    if (p.practiceGameSpeed !== undefined || p.replayDirs !== undefined || p.matchHistoryWarn !== undefined)
      service.configure({ practiceGameSpeed: cfg.practiceGameSpeed ?? null, replayDirs, matchHistoryWarn });
    if (p.knownTeammates) {
      const ids = cfg.knownTeammates.map((t) => t.primaryId);
      sessionizer.setTeammates(ids);
      db.setKnownTeammates(ids);
      service.invalidateAll();
    }
    if (p.recordCasual !== undefined) {
      recordCasual = cfg.recordCasual ?? false;
      sessionizer.setRecordCasual(recordCasual);
      db.setRecordCasual(recordCasual);
      service.invalidateAll();
    }
    if (p.ballchasingUpload !== undefined) uploadOn = cfg.ballchasingUpload;
    if (p.ballchasingUploads !== undefined) uploadRules = cfg.ballchasingUploads;
    if (p.ballchasingToken !== undefined || p.ballchasingUpload !== undefined || p.ballchasingUploads !== undefined || p.replayDirs !== undefined) {
      uploader.reset();
      setTimeout(() => !stopped && void uploader.tick(), 2_000).unref();
    }
    if (p.myPrimaryIds) {
      me = [...cfg.myPrimaryIds];
      sessionizer.setMe(me);
      if (wasGuess && guessed.length && guessed.join() !== me.join()) {
        db.reassignMe(guessed, me);
        service.invalidateAll();
        log(`my player corrected: sessions moved from ${guessed.join(", ")} to ${me.join(", ")}`);
      }
      notify();
    }
    opts.desktop?.configChanged(keys);
    return { ok: true, config: settingsView(true)! };
  };

  // --- HTTP server: API, web app, and the /live WebSocket --------------------
  /** Why the game can't be driven to a replay moment right now, if it can't. */
  const replayControl = (): ReplayGotoResponse | null => {
    if (!gameConnected) return { ok: false, reason: "Rocket League isn't running" };
    const active = sessionizer.active;
    if (active && active.kind !== "replay") return { ok: false, reason: "you're in a match or practice" };
    return null;
  };
  /**
   * Watch with the game closed (setting "launch"): start Rocket League, and
   * once it connects and has had a moment to reach the menus, open the
   * replay. The game ignores commands while it's still starting, so if the
   * replay hasn't opened a little later the request is sent once more.
   * Given up after a few minutes (the game didn't start, or was closed).
   */
  let afterLaunch: { run: () => void; replayId: string; until: number } | null = null;
  const LAUNCH_WAIT_MS = 4 * 60_000;
  const CONNECT_SETTLE_MS = 8_000;
  const RETRY_MS = 15_000;
  const runAfterLaunch = () => {
    const job = afterLaunch;
    if (!job || Date.now() > job.until) return void (afterLaunch = null);
    afterLaunch = null;
    job.run();
    setTimeout(() => {
      if (gameConnected && remote.openReplay !== job.replayId.toUpperCase()) job.run();
    }, RETRY_MS).unref();
  };
  const withLaunch = async (replayId: string, launch: boolean, run: () => ReplayGotoResponse): Promise<ReplayGotoResponse> => {
    if (gameConnected || !launch) return replayControl() ?? run();
    if (!opts.launchGame) return { ok: false, reason: "Rocket League isn't running" };
    const started = await opts.launchGame();
    if (!started.ok) return { ok: false, reason: started.reason };
    if (started.status === "cancelled") return { ok: false, reason: "starting Rocket League was cancelled" };
    afterLaunch = { run, replayId, until: Date.now() + LAUNCH_WAIT_MS };
    log(`replay remote: starting Rocket League to open ${replayId}`);
    return { ok: true, status: "launching" };
  };
  let replayLeadSeconds = opts.replayLeadSeconds ?? DEFAULT_REPLAY_LEAD_SECONDS;
  const app = createApi({
    service,
    settings: () => ({
      replayLeadSeconds,
      canLaunchGame: !!opts.launchGame,
      canQuitGame: !!opts.quitGame,
      replayAgainShortcut: opts.replayAgainShortcut?.() ?? null,
      ballchasing: !!opts.ballchasingToken?.(),
    }),
    fetchReplay: opts.ballchasingToken
      ? async (id) => {
          const r = await fetchReplays([id]);
          if (r.error) return { ok: false, reason: r.error };
          const o = r.outcomes[0];
          if (!o) return { ok: false, reason: "this match already has a replay, or has no match ID" };
          return o.ok ? { ok: true, replayId: o.replayId } : { ok: false, reason: o.reason };
        }
      : undefined,
    launchGame: opts.launchGame,
    analysis: analysisFor,
    replays: {
      overview: () => handle.replays(),
      startBackfill: (includeRecorded, quitWhenDone) => {
        const r = handle.startBackfill({ includeRecorded, quitWhenDone });
        return r.started ? { ok: true, queued: r.queued } : { ok: false, reason: r.reason ?? "couldn't start" };
      },
      stopBackfill: () => handle.stopBackfill(),
      setBackfillQuit: (on) => handle.setBackfillQuit(on),
      fetchFromBallchasing: () => {
        if (!opts.ballchasingToken?.()) return { ok: false, reason: "no ballchasing API key is set" };
        void fetchReplays();
        return { ok: true };
      },
    },
    config: opts.settingsFile
      ? {
          view: (editable) => settingsView(editable)!,
          patch: patchSettings,
          teammates: () => {
            const known = new Set(me);
            return db.teammateSuggestions().filter((t) => !known.has(t.primaryId));
          },
          meCandidates: () => db.playersWithMe(me),
          testBallchasing: async (token) => {
            const key = token ?? opts.ballchasingToken?.() ?? loadConfig(opts.settingsFile!).ballchasingToken ?? null;
            if (!key) return { ok: false, reason: "no API key" };
            try {
              const me = await new BallchasingClient(key).ping();
              return { ok: true, name: me.name ?? null, tier: me.type ?? null };
            } catch (e) {
              return { ok: false, reason: e instanceof BallchasingError ? e.message : `couldn't reach ballchasing (${String(e)})` };
            }
          },
          pickFolder: opts.desktop ? (title, defaultPath) => opts.desktop!.pickFolder(title, defaultPath) : undefined,
          restart: opts.desktop ? () => opts.desktop!.restart() : undefined,
          open: opts.desktop ? (what) => opts.desktop!.open(what) : undefined,
          update: opts.desktop ? () => opts.desktop!.update() : undefined,
          installUpdate: opts.desktop ? () => opts.desktop!.installUpdate() : undefined,
        }
      : undefined,
    gameConnected: () => gameConnected,
    webRoot: opts.webRoot,
    replayGoto: (b) =>
      withLaunch(b.replayId, b.launch ?? false, () => replayControl() ?? remote.goto(b.replayId, b.frame, b.leadSeconds ?? replayLeadSeconds, Date.now(), b.camera)),
    replayWatch: (replayId, launch) => withLaunch(replayId, launch, () => replayControl() ?? remote.watch(replayId, Date.now())),
    deleteMatch: (id) => {
      const ok = db.deleteMatch(id);
      if (ok) {
        log(`deleted match ${id}`);
        service.invalidateAll();
      }
      return ok;
    },
  });
  // Plain HTTP here, so the http.Server type is the right one.
  const server = serve({
    fetch: app.fetch,
    port: opts.port,
    hostname: opts.host ?? "127.0.0.1",
    // Keep Node's own Request/Response; the game connection uses Node's WebSocket.
    overrideGlobalObjects: false,
  }) as Server;
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;

  const live = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/live") return socket.destroy();
    live.handleUpgrade(req, socket, head, (ws) => live.emit("connection", ws, req));
  });
  const broadcast = (m: LiveMessage) => {
    const text = JSON.stringify(m);
    for (const c of live.clients) if (c.readyState === c.OPEN) c.send(text);
  };

  // --- sessions ------------------------------------------------------------
  /**
   * Playbacks that reached the replay file's end count as complete even when
   * the feed's clock or a late forfeit hid it (completeAtReplayEnd). Run on
   * each new playback and once at start, which fixes ones saved before.
   */
  const finishPlaybacks = (only?: Session): Session | null => {
    const frames = new Map(listSavedReplays(replayDirs).map((r) => [r.replayId, r.numFrames]));
    const candidates = only ? [only] : db.unfinishedPlaybacks().flatMap((r) => db.loadSession(r.id) ?? []);
    let fixed = 0;
    let last: Session | null = null;
    for (const s of candidates) {
      const done = completeAtReplayEnd(s, s.replayId ? (frames.get(s.replayId.toUpperCase()) ?? null) : null, s.matchGuid ? db.liveWinner(s.matchGuid) : null);
      if (!done) continue;
      if (!only) db.saveSession(done);
      service.invalidate(done.id, done.matchGuid);
      last = done;
      fixed++;
    }
    if (fixed && !only) {
      service.invalidateReplayStatus();
      log(`marked ${fixed} replay playbacks complete: they reached the end of the replay file`);
    }
    return last;
  };
  const sessionizer = new Sessionizer(
    opts,
    (played) => {
      const s = played.kind === "replay" ? (finishPlaybacks(played) ?? played) : played;
      if (!db.saveSession(s)) {
        log(`not saved: ${s.kind} session ${s.id} belongs to a match deleted in the app`);
        return;
      }
      service.invalidate(s.id, s.matchGuid);
      log(`saved ${s.kind} session ${s.id}${s.outcome ? ` (${s.outcome})` : ""}`);
      lastSession = { kind: s.kind, startedAt: s.startedAt, outcome: s.outcome };
      notify();
      broadcast({ type: "session", session: { id: s.id, kind: s.kind, startedAt: s.startedAt, outcome: s.outcome } });
    },
    (left) => {
      db.recordSkipped(left);
      log(`not saved: casual match ${left.id} (casual matches are off); its replay won't be played through`);
    },
  );

  // --- the game ------------------------------------------------------------
  const sendToGame = (cmd: GameCommand) => {
    if (!game || game.readyState !== WebSocket.OPEN) return false;
    game.send(JSON.stringify(cmd));
    raw.write({ receivedAt: Date.now(), sent: cmd });
    if (cmd.Command === "SetHUDVisibility") hudHidden = !cmd.Data.bVisible;
    return true;
  };

  finishPlaybacks();

  const backfill = new Backfill({
    send: sendToGame,
    log,
    onProgress: (p) => opts.onBackfill?.(p),
    // A run that was to end with the game closed finished on its own (see Backfill.quitWhenDone).
    quit: () => {
      if (!opts.quitGame) return;
      const reason = keepGameOpen({ stopped, gameConnected, active: sessionizer.active });
      if (reason) return log(`replays finished, but not closing Rocket League: ${reason}`);
      log("replays finished: closing Rocket League");
      void opts.quitGame().then(
        (closed) => log(closed ? "Rocket League closed" : "Rocket League didn't close"),
        (e) => log(`couldn't close Rocket League: ${String(e)}`),
      );
    },
    onReplayDone: (_id, at) => {
      raw.write({ receivedAt: at, note: "replay-ended" });
      sessionizer.endReplay(at);
    },
  });
  const remote = new ReplayRemote({
    send: sendToGame,
    log,
    beforeControl: () => backfill.stop("replay remote took over"),
    me: () => me,
    focusGame: opts.focusGame,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  });
  const backfillTimer = setInterval(() => backfill.tick(Date.now()), 1000);
  // One upload a minute at most; quick enough for new replays, gentle on ballchasing.
  const uploadTimer = setInterval(() => !stopped && void uploader.tick(), 60_000);
  // Analyze the backlog one replay after another, then check for new ones now and then.
  let analyzing = false;
  const analyzeBacklog = async () => {
    if (!analyzer || analyzing) return;
    analyzing = true;
    try {
      while (!stopped && (await analyzer.tick())) {
        /* next */
      }
    } finally {
      analyzing = false;
    }
  };
  const analyzeTimer = setInterval(() => void analyzeBacklog(), 20_000);
  backfillTimer.unref();
  const backfillPlan = () => {
    // Replays of matches deleted in the app, or casual ones while casual matches are
    // off, would play for nothing: what they record isn't kept.
    const deleted = db.deletedGuids();
    const skipped = db.skippedGuids();
    const replays = listSavedReplays(replayDirs).filter((r) => !r.matchGuid || (!deleted.has(r.matchGuid) && !skipped.has(r.matchGuid.toUpperCase())));
    return planBackfill(replays, db.playedReplayIds(), { guids: db.liveMatchGuids(), ends: db.liveMatchEnds() });
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(opts.gameUrl);
    game = ws;
    ws.addEventListener("open", () => {
      gameConnected = true;
      retryMs = 1000;
      const at = Date.now();
      const finished = raw;
      raw = rawFor(at);
      void finished.close().then(compressFinished);
      raw.write({ receivedAt: at, note: "connected" });
      connectedAt = at;
      db.saveConnection({ connectedAt: at, disconnectedAt: null });
      broadcast({ type: "status", gameConnected });
      log(`connected to ${opts.gameUrl}`);
      notify();
      if (afterLaunch) setTimeout(runAfterLaunch, CONNECT_SETTLE_MS).unref();
    });
    ws.addEventListener("message", (e) => {
      if (paused) return;
      const at = Date.now();
      const text = typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer).toString("utf8");
      const r = parseMessage(text);
      if (r.ok && detector && !me.length) {
        const found = detector.feed(r.msg);
        if (found) {
          me = [found];
          sessionizer.setMe(me);
          log(`recognized my player: ${found}`);
          opts.onMeDetected?.(found);
          notify();
        }
      }
      if (r.ok) {
        backfill.ingest(at, r.msg);
        remote.ingest(at, r.msg);
      }
      if (r.ok) {
        raw.write({ receivedAt: at, msg: r.msg });
        sessionizer.ingest(at, r.msg);
        broadcast({ type: "game", receivedAt: at, event: r.msg.Event, data: r.msg.Data });
      } else {
        // Keep anything unrecognized in the raw log, decoded where possible.
        let msg: unknown = text;
        try {
          const env = JSON.parse(text) as { Event?: unknown; Data?: unknown };
          msg = typeof env.Data === "string" ? { ...env, Data: JSON.parse(env.Data) } : env;
        } catch {
          raw.write({ receivedAt: at, unparsed: text });
          return;
        }
        raw.write({ receivedAt: at, msg });
        if (r.reason !== "unknown-event") log(`unreadable ${r.event ?? "message"}: ${r.error ?? r.reason}`);
      }
    });
    ws.addEventListener("close", () => {
      if (gameConnected) {
        const at = Date.now();
        raw.write({ receivedAt: at, note: "disconnected" });
        sessionizer.disconnect();
        backfill.stop("game disconnected");
        remote.reset();
        // Stopping the collector closes the socket too, but the game is still running then.
        if (connectedAt !== null && !stopped) db.saveConnection({ connectedAt, disconnectedAt: at });
        connectedAt = null;
        log("game disconnected");
      }
      gameConnected = false;
      broadcast({ type: "status", gameConnected });
      notify();
      if (!stopped) {
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      }
    });
    ws.addEventListener("error", () => {});
  };

  live.on("connection", (client: WsClient) => {
    client.send(JSON.stringify({ type: "status", gameConnected } satisfies LiveMessage));
    client.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      const cmd = GameCommand.safeParse((parsed as { command?: unknown })?.command ?? parsed);
      if (cmd.success) sendToGame(cmd.data);
      else client.send(JSON.stringify({ type: "error", error: "invalid command" } satisfies LiveMessage));
    });
    client.on("close", () => {
      if (live.clients.size === 0 && hudHidden) sendToGame({ Command: "SetHUDVisibility", Data: { bVisible: true } });
    });
  });

  connect();

  handle = {
    port,
    db,
    service,
    status,
    backfillPlan,
    startBackfill(options = {}) {
      if (!gameConnected) return { started: false, queued: 0, reason: "Rocket League isn't running" };
      if (paused) return { started: false, queued: 0, reason: "recording is paused" };
      const active = sessionizer.active;
      if (active && active.kind !== "replay") return { started: false, queued: 0, reason: "you're in a match or practice" };
      const plan = backfillPlan();
      const items = [
        ...plan.unrecorded.map((replayId) => ({ replayId, seconds: plan.seconds[replayId] ?? null, speed: BACKFILL_SPEED })),
        ...(options.includeRecorded ? plan.recorded.map((replayId) => ({ replayId, seconds: plan.seconds[replayId] ?? null, speed: BACKFILL_RECORDED_SPEED })) : []),
      ];
      const ids = items.map((i) => i.replayId);
      if (!ids.length) return { started: false, queued: 0, reason: "no saved replays left to play" };
      backfill.start(items, Date.now(), { quitWhenDone: !!options.quitWhenDone && !!opts.quitGame });
      const started = backfill.progress().running;
      // Started from the dashboard (or the tray), the game is usually behind it: bring it forward to watch.
      if (started) void Promise.resolve(opts.focusGame?.()).catch(() => {});
      return { started, queued: ids.length };
    },
    stopBackfill: () => backfill.stop("stopped"),
    setBackfillQuit: (on) => backfill.setQuitWhenDone(on && !!opts.quitGame),
    matchHistoryRisk() {
      const saved = new Set(listSavedReplays(replayDirs).flatMap((r) => (r.matchGuid ? [r.matchGuid] : [])));
      return matchHistoryRisk(db.liveOnlineMatches(), saved, Date.now(), matchHistoryWarn);
    },
    backfillProgress: () => backfill.progress(),
    replayAgain: () => replayControl() ?? remote.again(Date.now()),
    fetchReplays,
    replays(): ReplaysResponse {
      const status = service.replayStatus();
      const items = service.sessions({ kind: "match", limit: 500 }).items;
      const matches = items.map(
        (m): ReplayMatchItem => ({
          sessionId: m.id,
          startedAt: m.startedAt,
          playlistId: m.playlistId,
          playlistName: m.playlistName,
          arena: m.arena,
          outcome: m.outcome,
          goalsFor: m.goalsFor,
          goalsAgainst: m.goalsAgainst,
          mvp: m.mvp === true,
          source: m.source === "replay" ? "replay" : "live",
          ...(status.get(m.id) ?? { state: "missing", replayId: null, played: false, history: null, notOnBallchasing: false }),
        }),
      );
      const plan = backfillPlan();
      const p = backfill.progress();
      return {
        matches,
        counts: {
          matches: matches.length,
          saved: matches.filter((m) => m.state === "saved").length,
          played: matches.filter((m) => m.played).length,
          inHistory: matches.filter((m) => m.state === "in-history").length,
          atRisk: matches.filter((m) => m.history?.atRisk).length,
          missing: matches.filter((m) => m.state === "missing").length,
        },
        toPlay: {
          unrecorded: plan.unrecorded.length,
          recorded: plan.recorded.length,
          seconds:
            plan.unrecorded.reduce((n, id) => n + (plan.seconds[id] ?? 0) / BACKFILL_SPEED, 0) +
            plan.recorded.reduce((n, id) => n + (plan.seconds[id] ?? 0) / BACKFILL_RECORDED_SPEED, 0),
        },
        backfill: { running: p.running, current: p.current, done: p.done, failed: p.failed, remaining: p.remaining, remainingMs: p.remainingMs, quitWhenDone: p.quitWhenDone },
        ballchasing: { configured: !!opts.ballchasingToken?.(), ...ballchasingProgress, upload: uploader.status() },
        gameConnected,
        replayDirs,
      };
    },
    setPaused(next: boolean) {
      if (next === paused) return;
      paused = next;
      if (gameConnected) raw.write({ receivedAt: Date.now(), note: paused ? "paused" : "resumed" });
      if (paused) {
        sessionizer.disconnect();
        backfill.stop("recording paused");
      }
      log(paused ? "recording paused" : "recording resumed");
      notify();
    },
    async stop() {
      stopped = true;
      clearInterval(backfillTimer);
      clearInterval(uploadTimer);
      clearInterval(analyzeTimer);
      await subtrWorker?.close();
      backfill.stop("collector stopping");
      if (retryTimer) clearTimeout(retryTimer);
      if (hudHidden) sendToGame({ Command: "SetHUDVisibility", Data: { bVisible: true } });
      sessionizer.flush();
      game?.close();
      for (const c of live.clients) c.terminate();
      live.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await raw.close();
      db.close();
    },
  };
  return handle;
}
