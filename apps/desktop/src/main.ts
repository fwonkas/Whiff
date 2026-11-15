import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import {
  CONFIG_FILE,
  defaultDataDir,
  moveFromRlStatsLab,
  OLD_SETTINGS_FOLDER,
  loadConfig,
  findGameLaunch,
  launchStep,
  replayDirsIn,
  tasklistHasGame,
  startCollector,
  type BackfillProgress,
  type CollectorStatus,
  type LaunchGameResponse,
  type DesktopHooks,
  type NotificationKind,
  notificationSettings,
  MATCH_HISTORY_WARN_LAST,
  type RunningCollector,
} from "@rl/collector";
import { checkStatsApi, turnOnStatsApi, type StatsApiCheck } from "./stats-api.ts";

/**
 * Whiff (formerly RL Stats Lab) as a Windows tray app: runs the collector in the background,
 * shows its status in the tray and opens the dashboard in the browser. No
 * windows of its own.
 */

/** Kept from the RL Stats Lab days: the installer upgrades that install in place, and Windows keeps its notification settings. */
const APP_ID = "dev.rlstatslab.desktop";
const APP_NAME = "Whiff";
/** Before the rename (0.1.55), for the start-at-login entry. */
const OLD_NAME = "RL Stats Lab";
const UPDATE_CHECK_MS = 6 * 3_600_000;

if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId(APP_ID);

/** %APPDATA%\Whiff: the config, window size and logs (Electron's default for the product name). */
const userData = app.getPath("userData");
// From RL Stats Lab: its settings (and its data, if in the old default folder) move to Whiff's folders.
const moved = moveFromRlStatsLab({ oldSettingsDir: join(app.getPath("appData"), OLD_SETTINGS_FOLDER), settingsDir: userData });
const configPath = join(userData, CONFIG_FILE);
const logPath = join(userData, "logs", "collector.log");
const assets = app.isPackaged ? join(process.resourcesPath, "assets") : join(__dirname, "..", "assets");
const webRoot = app.isPackaged ? join(process.resourcesPath, "web") : join(__dirname, "..", "..", "web", "dist");
/** subtr-actor's worker and WASM (built by scripts/build.mjs), for replay analysis. */
const subtrDir = app.isPackaged ? join(process.resourcesPath, "subtr") : join(__dirname, "..", "subtr");

let tray: Tray | null = null;
let collector: RunningCollector | null = null;
let statsApi: StatsApiCheck = { kind: "not-found" };
let quitting = false;
/**
 * Global keyboard shortcuts, set in the settings file under "shortcuts"
 * (Electron accelerator strings such as "CommandOrControl+Alt+B"; null turns
 * one off). They work while the game has focus.
 */
type ShortcutAction = "backfill" | "pause" | "dashboard" | "replayAgain";
type Shortcuts = Record<ShortcutAction, string | null>;
const DEFAULT_SHORTCUTS: Shortcuts = {
  backfill: "CommandOrControl+Alt+B",
  pause: "CommandOrControl+Alt+P",
  dashboard: "CommandOrControl+Alt+D",
  replayAgain: "CommandOrControl+Alt+R",
};
let shortcuts: Shortcuts = { ...DEFAULT_SHORTCUTS };

function log(line: string) {
  try {
    mkdirSync(join(userData, "logs"), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never stop the collector.
  }
}

/** The config file as written, so saving one value keeps the rest. */
function readConfigFile(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfigFile(values: Record<string, unknown>) {
  mkdirSync(userData, { recursive: true });
  writeFileSync(configPath, JSON.stringify(values, null, 2) + "\n");
}

/** First run: a config with the defaults spelled out, so it's easy to edit. Later runs add new settings' defaults. */
function ensureConfigFile() {
  if (!existsSync(configPath)) {
    writeConfigFile({ myPrimaryIds: [], knownTeammates: [], dataDir: defaultDataDir(), shortcuts: DEFAULT_SHORTCUTS });
  }
  // Settings added in later versions, written out with their defaults so they're easy to find and change.
  const file = readConfigFile();
  const additions: Record<string, unknown> = {};
  if (typeof file.shortcuts !== "object" || file.shortcuts === null) additions.shortcuts = DEFAULT_SHORTCUTS;
  if (typeof file.replayLeadSeconds !== "number") additions.replayLeadSeconds = 10;
  if (Object.keys(additions).length) writeConfigFile({ ...file, ...additions });
}

function toggleBackfill() {
  if (!collector) return;
  if (collector.backfillProgress().running) {
    collector.stopBackfill();
    return;
  }
  // The shortcut plays everything left: new matches first, then the extra data for recorded ones.
  const result = collector.startBackfill({ includeRecorded: true });
  if (!result.started) notify("Can't play saved replays", `${result.reason ?? "Unknown reason"}.`);
}

function togglePause() {
  if (!collector) return;
  const paused = !collector.status().paused;
  collector.setPaused(paused);
  notify(paused ? "Recording paused" : "Recording resumed", paused ? "Nothing is recorded until you resume." : "", "recording");
}

const shortcutActions: Record<ShortcutAction, () => void> = {
  backfill: toggleBackfill,
  pause: togglePause,
  dashboard: () => openDashboard(),
  replayAgain: () => {
    const r = collector?.replayAgain();
    if (r && !r.ok) notify("Can't jump back", `${r.reason[0]!.toUpperCase()}${r.reason.slice(1)}.`);
  },
};

/** An accelerator as people write it: "CommandOrControl+Alt+R" → "Ctrl+Alt+R". */
const shortcutLabel = (accel: string | null) => accel?.replace(/CommandOrControl|CmdOrCtrl/g, process.platform === "darwin" ? "Cmd" : "Ctrl") ?? null;

let unavailableShortcuts: string[] = [];
/** The shortcuts the settings file asks for, with defaults where it says nothing. */
function configuredShortcuts(): Shortcuts {
  const configured = readConfigFile().shortcuts as Partial<Record<ShortcutAction, unknown>> | undefined;
  const out = { ...DEFAULT_SHORTCUTS };
  for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
    const value = configured && action in configured ? configured[action] : DEFAULT_SHORTCUTS[action];
    out[action] = typeof value === "string" && value.trim() ? value.trim() : null;
  }
  return out;
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const configured = readConfigFile().shortcuts as Partial<Record<ShortcutAction, unknown>> | undefined;
  const failed: string[] = [];
  for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
    const value = configured && action in configured ? configured[action] : DEFAULT_SHORTCUTS[action];
    const accel = typeof value === "string" && value.trim() ? value.trim() : null;
    shortcuts[action] = null;
    if (!accel) continue;
    try {
      if (globalShortcut.register(accel, shortcutActions[action])) shortcuts[action] = accel;
      else failed.push(accel);
    } catch {
      failed.push(accel); // not a valid accelerator
    }
  }
  unavailableShortcuts = failed;
  if (failed.length) {
    log(`shortcuts not registered: ${failed.join(", ")}`);
    notify("Some shortcuts aren't available", `${failed.join(", ")} ${failed.length === 1 ? "is" : "are"} taken or invalid. Change them in the settings file.`);
  }
}

/**
 * One notification at a time, replacing the last, so a run of replays
 * doesn't pile up in Windows' notification center. They dismiss themselves.
 */
let lastNotification: Notification | null = null;
/**
 * A desktop notification. With a kind, the settings can turn it off; without
 * one (something went wrong) it always shows.
 */
function notify(title: string, body: string, kind?: NotificationKind, open?: string, urgent = false) {
  if (kind && !notificationSettings(readConfigFile())[kind]) return;
  lastNotification?.close();
  // Urgent (a replay about to be lost): with a sound, and on screen until dismissed.
  lastNotification = new Notification({ title, body, silent: !urgent, timeoutType: urgent ? "never" : "default" });
  // Clicking it opens the page about it (the Replays screen for replay news).
  if (open) lastNotification.on("click", () => openDashboard(open));
  lastNotification.show();
}

const minutesText = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

let lastBackfillReplay: string | null = null;
let lastSessionKey: string | null = null;

/** Is RocketLeague.exe running? */
function isGameRunning(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) =>
    execFile("tasklist", ["/FI", "IMAGENAME eq RocketLeague.exe", "/NH", "/FO", "CSV"], { windowsHide: true }, (err, stdout) =>
      resolve(!err && tasklistHasGame(stdout)),
    ),
  );
}

/**
 * Close Rocket League after a replay run. taskkill without /F asks the game's
 * window to close (like Alt+F4), so it saves what it saves on a normal exit;
 * forced only if it's still there 15 s later. Resolves to whether it's gone.
 */
async function quitGame(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const taskkill = (args: string[]) => new Promise<void>((resolve) => execFile("taskkill", args, { windowsHide: true }, () => resolve()));
  const gone = async (ms: number) => {
    for (let waited = 0; waited < ms; waited += 500) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await isGameRunning())) return true;
    }
    return false;
  };
  await taskkill(["/IM", "RocketLeague.exe"]);
  let closed = await gone(15_000);
  if (!closed) {
    await taskkill(["/IM", "RocketLeague.exe", "/F"]);
    closed = await gone(5_000);
  }
  if (closed) notify("Rocket League closed", "The saved replays finished playing.", "replays");
  else notify("Couldn’t close Rocket League", "The saved replays finished playing, but the game is still running.", "replays");
  return closed;
}

/** How long after launching to check that the game is sending stats. */
const LAUNCH_CHECK_MS = 3 * 60_000;
let launching = false;

/** A dialog over the focused window (the dashboard, when the launch came from there). */
function showDialog(options: Electron.MessageBoxOptions) {
  const win = BrowserWindow.getFocusedWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

/**
 * Launch Rocket League through its store (Epic, else Steam, or launchUri in
 * the settings file), turning the Stats API on first if a game update reset
 * it: before a launch is the one moment that works without a restart.
 */
async function launchGame(): Promise<LaunchGameResponse> {
  if (launching) return { ok: true, status: "launching" };
  const running = await isGameRunning();
  statsApi = checkStatsApi();
  const step = launchStep({ running, statsApi: statsApi.kind });
  if (step === "focus") {
    await focusGame();
    return { ok: true, status: "focused" };
  }
  if (step === "turn-on-stats-api" && statsApi.kind === "off") {
    const { response } = await showDialog({
      type: "question",
      title: APP_NAME,
      message: "Rocket League's Stats API is off.",
      detail:
        "A game update may have reset it. Without it, nothing is recorded. Turning it on now, before the game starts, works without a restart.\n\n" +
        `Setting: PacketSendRate=30 in ${statsApi.iniPath}`,
      buttons: ["Turn on and launch", "Launch anyway", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return { ok: true, status: "cancelled" };
    if (response === 0) {
      try {
        await turnOnStatsApi(statsApi.iniPath);
        statsApi = checkStatsApi();
        log("turned on the Stats API before launching");
      } catch (e) {
        log(`couldn't turn on the Stats API: ${String(e)}`);
        const { response: next } = await showDialog({
          type: "warning",
          title: APP_NAME,
          message: "Couldn't turn on the Stats API.",
          detail: `${String(e)}\n\nYou can launch anyway, but games won't be recorded until it's on.`,
          buttons: ["Launch anyway", "Cancel"],
          defaultId: 1,
          cancelId: 1,
        });
        if (next !== 0) return { ok: true, status: "cancelled" };
      }
    }
  }

  const override = readConfigFile().launchUri;
  const launch = typeof override === "string" && override.trim() ? { store: "custom", uri: override.trim() } : findGameLaunch();
  if (!launch) {
    await showDialog({
      type: "error",
      title: APP_NAME,
      message: "Couldn't find Rocket League in the Epic launcher or Steam.",
      detail: 'If it\'s installed somewhere else, add a "launchUri" to the settings file with the link that starts it (for example steam://rungameid/252950).',
    });
    return { ok: false, reason: "Rocket League wasn't found in the Epic launcher or Steam" };
  }
  try {
    await shell.openExternal(launch.uri);
  } catch (e) {
    log(`launch failed (${launch.uri}): ${String(e)}`);
    await showDialog({ type: "error", title: APP_NAME, message: "Couldn't launch Rocket League.", detail: String(e) });
    return { ok: false, reason: "the launcher didn't start" };
  }
  log(`launching Rocket League via ${launch.store}: ${launch.uri}`);
  launching = true;
  refreshTray();
  notify("Launching Rocket League", launch.store === "steam" ? "Starting it through Steam." : launch.store === "epic" ? "Starting it through the Epic Games launcher." : "Starting it with the launchUri from your settings.", "launch");
  watchLaunch();
  return { ok: true, status: "launching" };
}

/** Clear the launching state once the game connects; after 3 minutes, say if it's running but silent. */
function watchLaunch() {
  const started = Date.now();
  const timer = setInterval(async () => {
    if (collector?.status().gameConnected) {
      clearInterval(timer);
      launching = false;
      refreshTray();
      return;
    }
    if (Date.now() - started < LAUNCH_CHECK_MS) return;
    clearInterval(timer);
    launching = false;
    refreshTray();
    if (await isGameRunning()) {
      notify(
        "Rocket League isn't sending stats",
        "The game is running but hasn't connected. Check the Stats API item in the tray menu, then restart the game.",
      );
    }
  }, 5_000);
  timer.unref();
}
function onBackfill(p: BackfillProgress) {
  refreshTray();
  if (p.running && p.current && p.current !== lastBackfillReplay) {
    lastBackfillReplay = p.current;
    const position = p.done + p.failed + 1;
    const total = position + p.remaining;
    const left = p.remainingMs !== null ? ` · about ${minutesText(p.remainingMs)} left` : "";
    notify("Playing saved replays", `Replay ${position} of ${total}${left}`, "replays");
  }
  if (!p.running) {
    lastBackfillReplay = null;
    if (p.done + p.failed > 0) {
      const skipped = p.failed ? `, ${p.failed} skipped` : "";
      notify("Saved replays played", `Played ${p.done}${skipped}.`, "replays", "/replays");
    }
  }
}

/** The ballchasing API key from the settings file, read each time so a new one works without a restart. */
function ballchasingToken(): string | null {
  const t = readConfigFile().ballchasingToken;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

let ballchasingRun: { running: boolean; done: number; total: number; found: number } | null = null;
function onBallchasing(p: { running: boolean; done: number; total: number; found: number }) {
  const started = p.running && !ballchasingRun?.running;
  ballchasingRun = p;
  refreshTray();
  if (started && p.total > 1) notify("Getting replays from ballchasing", `Looking for ${p.total} recorded matches with no saved replay.`, "replays");
}

/**
 * Download replays of recorded matches with none saved, from my ballchasing
 * uploads, into the game's replays folder. Without an API key, say how to add one.
 */
async function getMissingReplays() {
  if (!collector) return;
  if (!ballchasingToken()) {
    const { response } = await showDialog({
      type: "info",
      title: APP_NAME,
      message: "Connect ballchasing",
      detail:
        `${APP_NAME} can download replays you uploaded to ballchasing.com for recorded matches with no saved replay, so you can review them here.\n\n` +
        'Copy your API key from ballchasing.com/upload, then add it to the settings file as "ballchasingToken": "<your key>". Then choose this again.',
      buttons: ["Open ballchasing.com/upload", "Open settings file", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) void shell.openExternal("https://ballchasing.com/upload");
    if (response === 1) void shell.openPath(configPath);
    return;
  }
  const { outcomes, error } = await collector.fetchReplays();
  if (error) {
    notify("Couldn't get replays from ballchasing", `${error[0]!.toUpperCase()}${error.slice(1)}.`);
    return;
  }
  if (!outcomes.length) {
    notify("No replays missing", "Every recorded match has a saved replay.", "replays");
    return;
  }
  const found = outcomes.filter((o) => o.ok).length;
  const notFound = outcomes.length - found;
  notify(
    "Replays from ballchasing",
    `Downloaded ${found} of ${outcomes.length}.${notFound ? ` ${notFound} ${notFound === 1 ? "wasn't" : "weren't"} on ballchasing.` : ""}`,
    "replays",
    "/replays",
  );
}

/**
 * Warn before an unsaved match drops out of the game's Match History: once
 * when it gets within the warning range (Settings → Notifications), and again
 * when the next match would drop it. After each match, so it's there while
 * queuing for the next one.
 */
const warnedAbout = new Map<string, "early" | "last">();
function checkMatchHistory() {
  if (!collector) return;
  const risk = collector.matchHistoryRisk();
  const level = (guid: string) => (risk.dropsIn.get(guid.toUpperCase()) === 1 ? "last" : "early");
  const fresh = risk.atRisk.filter((m) => warnedAbout.get(m.matchGuid) !== level(m.matchGuid) && warnedAbout.get(m.matchGuid) !== "last");
  if (!fresh.length) return;
  for (const m of fresh) warnedAbout.set(m.matchGuid, level(m.matchGuid));
  const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const soonest = Math.min(...fresh.map((m) => risk.dropsIn.get(m.matchGuid.toUpperCase()) ?? 99));
  const list = fresh.slice(0, 3).map((m) => when(m.endedAt)).join(", ");
  const them = fresh.length === 1 ? "it" : "them";
  notify(
    soonest === 1
      ? `Your next match drops ${fresh.length === 1 ? "an unsaved replay" : `${fresh.length} unsaved replays`}`
      : `${fresh.length === 1 ? "A match is" : `${fresh.length} matches are`} leaving Match History ${
          // In the warning range by position, or only because it's nearly 30 days old.
          soonest <= ((readConfigFile().matchHistoryWarn as number | undefined) ?? MATCH_HISTORY_WARN_LAST) ? `in ${soonest} matches` : "within 3 days"
        }`,
    `No saved replay for ${list}${fresh.length > 3 ? " and more" : ""}. Save ${them} from Match History in the game to keep ${them}. Click to see which.`,
    "matchHistory",
    "/sessions?replay=attention",
    true,
  );
}

/** The app icon, grayed out while recording is paused, with a badge once an update is ready. */
const icon = (paused: boolean) => nativeImage.createFromPath(join(assets, `tray${paused ? "-paused" : ""}${updateReady ? "-update" : ""}.png`));

function statusLine(s: CollectorStatus): string {
  if (s.paused) return "Recording paused";
  if (!s.gameConnected) return "Waiting for Rocket League";
  return s.me.length ? "Recording" : "Recording (you'll be recognized in your first match)";
}

function lastSessionLine(s: CollectorStatus): string | null {
  const last = s.lastSession;
  if (!last) return null;
  const when = new Date(last.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const what = last.kind === "match" ? (last.outcome === "win" ? "Win" : last.outcome === "loss" ? "Loss" : "Match") : last.kind[0]!.toUpperCase() + last.kind.slice(1);
  return `Last saved: ${what} at ${when}`;
}

/**
 * The dashboard in its own window: the same web app the browser shows, so
 * it works from a phone too. Closing the window hides it; the app keeps
 * running in the tray.
 */
let dashboard: BrowserWindow | null = null;
const windowStatePath = join(userData, "window.json");

function savedBounds(): Electron.Rectangle | null {
  try {
    const b = JSON.parse(readFileSync(windowStatePath, "utf8")) as Electron.Rectangle;
    // Only if it still fits on a screen (monitors change).
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    return visible ? b : null;
  } catch {
    return null;
  }
}

/** The splash is 16:9 (assets/splash.jpg, 1280×720): shown this wide, or smaller on a small screen. */
const SPLASH_WIDTH = 640;
/** Shown at least this long, so a quick load doesn't flash it. */
const SPLASH_MIN_MS = 900;
/** The dashboard is shown anyway after this long, whatever the page is doing. */
const SPLASH_MAX_MS = 10_000;

/**
 * A picture while the dashboard window loads: without it, the first open
 * shows nothing and then a blank window for a moment. Centered where the
 * dashboard will appear. Returns how to take it down.
 */
function showSplash(over: Electron.Rectangle | null): () => void {
  const area = (over ? screen.getDisplayMatching(over) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
  const width = Math.min(SPLASH_WIDTH, area.width - 32);
  const height = Math.round((width * 9) / 16);
  const center = over ? { x: over.x + over.width / 2, y: over.y + over.height / 2 } : { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  const splash = new BrowserWindow({
    width,
    height,
    x: Math.round(Math.max(area.x, Math.min(center.x - width / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(center.y - height / 2, area.y + area.height - height))),
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#0e1116",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: false },
  });
  splash.once("ready-to-show", () => !splash.isDestroyed() && splash.showInactive());
  void splash.loadFile(join(assets, "splash.html")).catch(() => {});
  return () => {
    if (!splash.isDestroyed()) splash.destroy();
  };
}

/** Open the dashboard window, optionally at a page ("/replays") or a hash ("#settings"). */
function openDashboard(target?: string) {
  if (!collector) return;
  const url = `http://localhost:${collector.port}`;
  if (dashboard && !dashboard.isDestroyed()) {
    if (target?.startsWith("#")) void dashboard.webContents.executeJavaScript(`location.hash = ${JSON.stringify(target.slice(1))}`);
    else if (target) void dashboard.loadURL(`${url}${target}`);
    if (dashboard.isMinimized()) dashboard.restore();
    dashboard.show();
    dashboard.focus();
    return;
  }
  const bounds = savedBounds();
  const closeSplash = showSplash(bounds);
  const splashSince = Date.now();
  dashboard = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 900,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 360,
    title: APP_NAME,
    icon: join(assets, "icon.png"),
    backgroundColor: "#0e1116",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Shown once the page has drawn its header (not just loaded), and the splash has had its moment.
  const created = dashboard;
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    setTimeout(
      () => {
        if (!created.isDestroyed()) created.show();
        closeSplash();
      },
      Math.max(0, SPLASH_MIN_MS - (Date.now() - splashSince)),
    );
  };
  const drawn = `new Promise((done) => {
    const check = () => (document.querySelector("#root header") ? done(true) : setTimeout(check, 50));
    check();
  })`;
  created.webContents.once("did-finish-load", () => void created.webContents.executeJavaScript(drawn).then(reveal, reveal));
  created.webContents.once("did-fail-load", reveal);
  setTimeout(reveal, SPLASH_MAX_MS).unref();
  created.once("closed", closeSplash);
  // Links away from the dashboard open in the browser.
  dashboard.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  dashboard.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      void shell.openExternal(target);
    }
  });
  dashboard.on("close", (e) => {
    if (dashboard && !quitting) {
      try {
        writeFileSync(windowStatePath, JSON.stringify(dashboard.getNormalBounds()));
      } catch {
        // Not worth failing over.
      }
      e.preventDefault();
      dashboard.hide();
    }
  });
  void dashboard.loadURL(target ? (target.startsWith("#") ? `${url}/${target}` : `${url}${target}`) : url);
}

function openInBrowser() {
  if (collector) void shell.openExternal(`http://localhost:${collector.port}`);
}

/**
 * Bring Rocket League to the front. Windows only lets the app in front hand
 * focus to another, so this taps Alt (which lifts that restriction) before
 * SetForegroundWindow, then restores the window if it was minimized.
 * Resolves once the game's window is in front (checked for up to 3 s), so the
 * replay can start playing then.
 */
function focusGame(): Promise<void> | void {
  if (process.platform !== "win32") return;
  const script = [
    "$p = Get-Process RocketLeague -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    "if (-not $p) { exit 1 }",
    'Add-Type -Namespace RLStatsLab -Name Win -MemberDefinition @"',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);',
    '[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);',
    '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);',
    '"@',
    "$h = $p.MainWindowHandle",
    "if ([RLStatsLab.Win]::IsIconic($h)) { [void][RLStatsLab.Win]::ShowWindow($h, 9) }",
    "[RLStatsLab.Win]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)",
    "[void][RLStatsLab.Win]::SetForegroundWindow($h)",
    "[RLStatsLab.Win]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)",
    "for ($i = 0; $i -lt 60; $i++) { if ([RLStatsLab.Win]::GetForegroundWindow() -eq $h) { exit 0 }; Start-Sleep -Milliseconds 50 }",
    "exit 2",
  ].join("\n");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true }, (err) => {
      if (err) log(`couldn't bring Rocket League to the front (${err.code ?? err.message}); playing anyway`);
      resolve();
    });
  });
}

function refreshTray() {
  if (!tray || !collector) return;
  const s = collector.status();
  tray.setImage(icon(s.paused));
  const last = lastSessionLine(s);
  const update = updateReady ? `Update ready: ${updateReady}` : null;
  tray.setToolTip([APP_NAME, statusLine(s), last, update].filter(Boolean).join("\n"));

  const items: MenuItemConstructorOptions[] = [
    { label: statusLine(s), enabled: false },
    ...(last ? [{ label: last, enabled: false }] : []),
    { type: "separator" },
    ...(!s.gameConnected
      ? [launching ? { label: "Launching Rocket League…", enabled: false } : { label: "Launch Rocket League", click: () => void launchGame() }]
      : []),
    { label: "Open dashboard", accelerator: shortcuts.dashboard ?? undefined, registerAccelerator: false, click: () => openDashboard() },
    {
      label: "Pause recording",
      type: "checkbox",
      checked: s.paused,
      accelerator: shortcuts.pause ?? undefined,
      registerAccelerator: false,
      click: (item) => collector?.setPaused(item.checked),
    },
  ];

  // Replays: playing saved ones, ballchasing, and matches with nothing saved.
  const replays: MenuItemConstructorOptions[] = [];
  const bf = collector.backfillProgress();
  if (bf.running) {
    const total = bf.done + bf.failed + bf.remaining + (bf.current ? 1 : 0);
    const left = bf.remainingMs !== null ? `, about ${minutesText(bf.remainingMs)} left` : "";
    replays.push(
      { label: `Playing saved replays: ${bf.done + bf.failed + 1} of ${total}${left}`, enabled: false },
      { label: "Stop playing replays", accelerator: shortcuts.backfill ?? undefined, registerAccelerator: false, click: () => collector?.stopBackfill() },
    );
  } else {
    replays.push({ label: "Play saved replays…", accelerator: shortcuts.backfill ?? undefined, registerAccelerator: false, enabled: s.gameConnected && !s.paused, click: () => void offerBackfill() });
  }
  if (ballchasingRun?.running) {
    replays.push({ label: `Getting replays from ballchasing: ${ballchasingRun.done} of ${ballchasingRun.total}`, enabled: false });
  } else {
    replays.push({ label: ballchasingToken() ? "Get missing replays from ballchasing" : "Connect ballchasing…", click: () => void getMissingReplays() });
  }
  const history = collector.matchHistoryRisk();
  const unsaved = history.unsaved.length;
  replays.push(
    { type: "separator" },
    unsaved
      ? {
          label: `${unsaved} recent ${unsaved === 1 ? "match has" : "matches have"} no saved replay…`,
          click: () => openDashboard("/sessions?replay=attention"),
        }
      : { label: "Replay settings…", click: () => openDashboard("#settings/game") },
  );
  items.push({
    label: bf.running ? "Replays (playing)" : unsaved ? `Replays (${unsaved} not saved)` : "Replays",
    submenu: replays,
  });

  if (statsApi.kind === "off") {
    items.push({ label: "Turn on Rocket League's Stats API…", click: () => void offerStatsApi(true) });
  } else if (statsApi.kind === "not-found") {
    items.push({ label: "Rocket League not found", enabled: false });
  }
  items.push(
    { type: "separator" },
    { label: "Settings…", click: () => openDashboard("#settings") },
    ...(!app.isPackaged
      ? []
      : updateReady
        ? [{ label: `Install update and restart (${updateReady})`, click: () => void quit("restart") }]
        : [{ label: "Check for updates", click: () => void checkForUpdates(true) }]),
    { type: "separator" },
    { label: `Quit ${APP_NAME} ${app.getVersion()}`, click: () => void quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/** Ask to turn the Stats API on. `fromMenu` skips the "don't ask again" setting. */
async function offerStatsApi(fromMenu = false) {
  if (statsApi.kind !== "off") return;
  if (!fromMenu && readConfigFile().skipStatsApiPrompt === true) return;
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: "question",
    title: APP_NAME,
    message: "Turn on Rocket League's Stats API?",
    detail:
      `${APP_NAME} records your games through the Stats API, which is off by default. ` +
      `This sets PacketSendRate to 30 in:\n${statsApi.iniPath}\n\n` +
      "Windows may ask for permission, since the game is installed in a protected folder. " +
      "Restart Rocket League afterwards if it's running.",
    buttons: ["Turn on", "Not now"],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: fromMenu ? undefined : "Don't ask again",
  });
  if (response !== 0) {
    if (checkboxChecked) writeConfigFile({ ...readConfigFile(), skipStatsApiPrompt: true });
    return;
  }
  try {
    await turnOnStatsApi(statsApi.iniPath);
    statsApi = checkStatsApi();
    log(`turned on the Stats API in ${statsApi.kind === "on" ? statsApi.iniPath : "?"}`);
    new Notification({ title: "Stats API turned on", body: "Restart Rocket League if it's running, and your games will be recorded." }).show();
  } catch (e) {
    log(`couldn't turn on the Stats API: ${String(e)}`);
    await dialog.showMessageBox({
      type: "error",
      title: APP_NAME,
      message: "Couldn't change the Stats API setting.",
      detail: `${String(e)}\n\nYou can set PacketSendRate=30 by hand in:\n${statsApi.kind === "off" ? statsApi.iniPath : ""}`,
    });
  }
  refreshTray();
}

/** Ask which saved replays to play, then start. */
async function offerBackfill() {
  if (!collector) return;
  const plan = collector.backfillPlan();
  // About what Backfill estimates: play at normal speed plus 20 s per replay.
  const ms = (ids: string[]) => ids.reduce((n, id) => n + (plan.seconds[id] ?? 320) * 1000 + 20_000, 0);
  if (!plan.unrecorded.length && !plan.recorded.length) {
    await dialog.showMessageBox({ title: APP_NAME, message: "Every saved replay has already been played through." });
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: APP_NAME,
    message: "Play saved replays?",
    detail:
      `${plan.unrecorded.length} are matches you didn't record: playing them adds those matches${plan.unrecorded.length ? ` (about ${minutesText(ms(plan.unrecorded))})` : ""}.\n` +
      `${plan.recorded.length} are matches you did record: playing them adds the other players' car data and boost pickups${plan.recorded.length ? ` (about ${minutesText(ms(plan.recorded))} more)` : ""}.\n\n` +
      (shortcuts.backfill ? `Tip: ${shortcuts.backfill.replace("CommandOrControl", "Ctrl")} starts or stops this anytime (it plays all of them).\n` : "") +
      "Rocket League plays them one after another. Starting a match or freeplay stops it.",
    buttons: [`Unrecorded only (${plan.unrecorded.length})`, `All (${plan.unrecorded.length + plan.recorded.length})`, "Cancel"],
    defaultId: plan.unrecorded.length ? 0 : 1,
    cancelId: 2,
  });
  if (response === 2) return;
  const result = collector.startBackfill({ includeRecorded: response === 1 });
  if (!result.started) {
    await dialog.showMessageBox({ title: APP_NAME, message: `Couldn't start: ${result.reason ?? "unknown reason"}.` });
  }
  refreshTray();
}

// --- updates ------------------------------------------------------------------
// Background checks (at start and every few hours) download a new version
// quietly; the tray icon gets a badge and the menu "Install update and
// restart". Quitting installs it too. "Check for updates" from the menu goes
// all the way: download, install and restart.

/** The version downloaded and ready to install, if any. */
let updateReady: string | null = null;
/** A newer version the check found (downloading, or ready once updateReady is set). */
let updateFound: string | null = null;
let updateRun: Promise<void> | null = null;
/** The user asked to update: restart into it as soon as it's downloaded. */
let restartWhenReady = false;
let updaterSetUp = false;

async function getUpdater() {
  const { autoUpdater } = await import("electron-updater");
  if (!updaterSetUp) {
    updaterSetUp = true;
    autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} } as never;
    autoUpdater.autoDownload = true;
    // quit() decides: it installs a downloaded update itself.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("update-available", (info) => {
      updateFound = info.version;
    });
    autoUpdater.on("update-downloaded", (info) => {
      updateReady = info.version;
      log(`update ${info.version} downloaded`);
      refreshTray();
      if (restartWhenReady) void quit("restart");
    });
  }
  return autoUpdater;
}

async function checkForUpdates(fromMenu: boolean) {
  if (fromMenu) {
    if (updateReady) return void quit("restart");
    restartWhenReady = true;
    if (updateRun) {
      notify(APP_NAME, "Downloading the update. Whiff restarts when it's done.");
      return;
    }
  }
  if (updateRun) return;
  updateRun = (async () => {
    try {
      const updater = await getUpdater();
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        if (fromMenu) {
          restartWhenReady = false;
          await dialog.showMessageBox({ title: APP_NAME, message: `You have the latest version (${app.getVersion()}).` });
        }
        return;
      }
      if (restartWhenReady) notify(APP_NAME, `Downloading Whiff ${result.updateInfo.version}. Whiff restarts when it's done.`);
      // update-downloaded takes it from there.
      await result.downloadPromise;
    } catch (e) {
      log(`update check failed: ${String(e)}`);
      if (!updateReady) updateFound = null;
      if (restartWhenReady) {
        restartWhenReady = false;
        await dialog.showMessageBox({ type: "error", title: APP_NAME, message: "Couldn't update Whiff.", detail: String(e) });
      }
    } finally {
      updateRun = null;
    }
  })();
  await updateRun;
}

/**
 * Close everything and exit. With an update downloaded, its installer runs
 * as Whiff exits, silently: "restart" starts the new version afterwards,
 * a plain quit doesn't.
 */
async function quit(how: "quit" | "restart" = "quit") {
  if (quitting) return;
  quitting = true;
  try {
    globalShortcut.unregisterAll();
    if (dashboard && !dashboard.isDestroyed()) {
      try {
        writeFileSync(windowStatePath, JSON.stringify(dashboard.getNormalBounds()));
      } catch {
        // Not worth failing over.
      }
      dashboard.destroy();
    }
    await collector?.stop();
  } finally {
    tray?.destroy();
    if (updateReady) {
      log(`installing update ${updateReady}${how === "restart" ? " and restarting" : ""}`);
      // Starts the installer and quits (before-quit lets it through: quitting is set).
      (await getUpdater()).quitAndInstall(true, how === "restart");
      // If the installer didn't start, don't hang around.
      setTimeout(() => app.exit(0), 10_000).unref();
    } else {
      app.exit(0);
    }
  }
}

/** What the settings screen needs from the desktop app. */
const desktopHooks: DesktopHooks = {
  shortcuts: () => ({ configured: configuredShortcuts(), unavailable: unavailableShortcuts }),
  startAtLogin: () => app.getLoginItemSettings().openAtLogin,
  setStartAtLogin: (on) => app.setLoginItemSettings({ openAtLogin: on }),
  async pickFolder(title, defaultPath) {
    const win = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = { title, defaultPath, properties: ["openDirectory", "createDirectory"] };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  restart() {
    log("restarting for new settings");
    // With an update ready, the installer starts the new version instead.
    if (updateReady) return void quit("restart");
    app.relaunch();
    void quit();
  },
  paths: () => ({ settingsFile: configPath, logFile: logPath, dashboardUrl: `http://localhost:${collector?.port ?? loadConfig(configPath).port}` }),
  open(what) {
    if (what === "browser") return openInBrowser();
    if (what === "taskbarSettings") return void shell.openExternal("ms-settings:taskbar");
    void shell.openPath(what === "settingsFile" ? configPath : what === "logFile" ? logPath : loadConfig(configPath).dataDir);
  },
  configChanged(keys) {
    if (keys.includes("shortcuts")) registerShortcuts();
    refreshTray();
  },
  update() {
    const version = updateReady ?? updateFound;
    return version ? { version, state: updateReady ? "ready" : "downloading", installing: restartWhenReady } : null;
  },
  // The same as the tray's Check for updates: download if needed, install, restart.
  installUpdate: () => void checkForUpdates(true),
};

/**
 * The rename changed the program's file and folder (RL Stats Lab.exe → Whiff.exe),
 * and "start at sign-in" is a registry entry pointing at the old one, which the
 * installer removed. The entry is named after the app ID, which didn't change:
 * if it points at another program, point it at this one, as on or off as it was.
 */
function moveLoginItem() {
  const item = app.getLoginItemSettings().launchItems?.find((i) => i.name === APP_ID);
  if (!item || item.path.toLowerCase() === process.execPath.toLowerCase()) return;
  app.setLoginItemSettings({ openAtLogin: true });
  if (!item.enabled) app.setLoginItemSettings({ openAtLogin: false });
  log(`start at sign-in moved from ${item.path}`);
}

async function start() {
  for (const line of moved) log(`from RL Stats Lab: ${line}`);
  // No settings file yet (not even one moved from RL Stats Lab): the first start after installing.
  const firstRun = !existsSync(configPath);
  ensureConfigFile();
  if (app.isPackaged) moveLoginItem();
  if (app.isPackaged && readConfigFile().startAtLoginSet !== true) {
    // Start at sign-in by default, once; after that the menu decides.
    app.setLoginItemSettings({ openAtLogin: true });
    writeConfigFile({ ...readConfigFile(), startAtLoginSet: true });
  }

  const cfg = loadConfig(configPath);
  statsApi = checkStatsApi();
  // The game's WebSocket listens on the ini's WebPort; a gameUrl in the settings file wins.
  const explicitUrl = typeof readConfigFile().gameUrl === "string";
  const gameUrl = !explicitUrl && statsApi.kind !== "not-found" ? `ws://localhost:${statsApi.webPort}` : cfg.gameUrl;
  log(`starting: data ${cfg.dataDir}, game ${gameUrl}, Stats API ${statsApi.kind}`);

  try {
    collector = await startCollector({
      ...cfg,
      gameUrl,
      dbPath: join(cfg.dataDir, "stats.db"),
      rawDir: join(cfg.dataDir, "raw"),
      webRoot,
      log,
      replayAnalysis: { workerPath: join(subtrDir, "worker.cjs"), wasmPath: join(subtrDir, "subtr-actor.wasm") },
      onStatus: (s) => {
        refreshTray();
        // After each match, check whether an unsaved one is about to leave Match History.
        const key = s.lastSession ? `${s.lastSession.kind}:${s.lastSession.startedAt}` : null;
        if (key && key !== lastSessionKey) {
          lastSessionKey = key;
          if (s.lastSession!.kind === "match") checkMatchHistory();
        }
      },
      replayDirs: cfg.replayDirs ?? replayDirsIn(app.getPath("documents")),
      defaultReplayDirs: replayDirsIn(app.getPath("documents")),
      settingsFile: configPath,
      desktop: desktopHooks,
      onBackfill,
      focusGame,
      launchGame,
      quitGame: process.platform === "win32" ? quitGame : undefined,
      ballchasingToken,
      onBallchasing,
      replayAgainShortcut: () => shortcutLabel(shortcuts.replayAgain),
      onMeDetected: (id) => {
        const file = readConfigFile();
        const ids = Array.isArray(file.myPrimaryIds) ? (file.myPrimaryIds as string[]) : [];
        // The dashboard asks to confirm it (MeBanner).
        if (!ids.length) writeConfigFile({ ...file, myPrimaryIds: [id], meConfirmed: false });
        notify(APP_NAME, "Recognized your player. Your games are being recorded; confirm it's you in the dashboard.", "recording");
      },
    });
  } catch (e) {
    log(`couldn't start: ${String(e)}`);
    const inUse = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
    await dialog.showMessageBox({
      type: "error",
      title: APP_NAME,
      message: inUse ? `Port ${cfg.port} is already in use.` : `${APP_NAME} couldn't start.`,
      detail: inUse
        ? `Another collector is probably running (for example \`npm run collect\`). Stop it, then start ${APP_NAME} again.`
        : String(e),
    });
    app.exit(1);
    return;
  }

  registerShortcuts();
  tray = new Tray(icon(false));
  tray.on("click", () => openDashboard());
  refreshTray();
  // The first start opens the dashboard, so a new user sees more than a tray icon; after
  // that only with the setting. The Stats API question comes first, so the window can't hide it.
  const ui = readConfigFile().ui as { openDashboardOnLaunch?: unknown } | undefined;
  const showDashboard = firstRun || ui?.openDashboardOnLaunch === true;
  void offerStatsApi().finally(() => {
    if (showDashboard) openDashboard();
  });
  checkMatchHistory();

  if (app.isPackaged) {
    void checkForUpdates(false);
    setInterval(() => void checkForUpdates(false), UPDATE_CHECK_MS).unref();
  }
}

app.on("second-instance", () => openDashboard());
// A tray app: no windows, and closing none of them should quit.
app.on("window-all-closed", () => {});
app.on("before-quit", (e) => {
  if (!quitting) {
    e.preventDefault();
    void quit();
  }
});
app.whenReady().then(start, (e) => log(`failed: ${String(e)}`));
