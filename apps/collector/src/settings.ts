import { MATCH_HISTORY_WARN_LAST } from "./replay-files.ts";
import { hostname, networkInterfaces } from "node:os";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  ConfigPatch,
  DEFAULT_UI,
  NOTIFICATION_KINDS,
  NotificationSettings,
  RESTART_KEYS,
  SHORTCUT_ACTIONS,
  UiSettings,
  type ConfigResponse,
  type ShortcutAction,
} from "@rl/api-contract";
import { loadConfig } from "./config.ts";

/**
 * The settings file as the settings screen sees it. Changes merge into the
 * file (keys it doesn't know about stay), written whole and renamed into
 * place so a crash never leaves half a file.
 */

/** What only the desktop app can do. Absent when running from the command line. */
export interface DesktopHooks {
  /** Shortcuts in effect, from the file with defaults filled in, and the ones that couldn't be registered. */
  shortcuts(): { configured: Record<ShortcutAction, string | null>; unavailable: string[] };
  startAtLogin(): boolean;
  setStartAtLogin(on: boolean): void;
  pickFolder(title: string, defaultPath?: string): Promise<string | null>;
  restart(): void;
  /** Files and addresses the Advanced settings show. */
  paths(): { settingsFile: string; logFile: string; dashboardUrl: string };
  /** Open one in its usual app (Explorer, Notepad, the browser). */
  open(what: "settingsFile" | "logFile" | "dataDir" | "browser"): void;
  /** After the file changed: re-register shortcuts, refresh the tray. */
  configChanged(keys: string[]): void;
}

export function readSettingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Merge a validated patch into the file. Nested objects (shortcuts, notifications, ui) merge too. */
export function writeSettingsPatch(path: string, patch: ConfigPatch): Record<string, unknown> {
  const file = readSettingsFile(path);
  const { startAtLogin: _handledByDesktop, ...rest } = patch;
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    if (value === null && (key === "ballchasingToken" || key === "replayDirs" || key === "practiceGameSpeed")) {
      delete file[key];
    } else if (key === "ballchasingUploads") {
      // Two levels: each kind's settings merge into what's there.
      const prev = file[key] && typeof file[key] === "object" ? (file[key] as Record<string, Record<string, unknown>>) : {};
      const next = { ...prev };
      for (const [kind, rule] of Object.entries(value as Record<string, Record<string, unknown>>)) next[kind] = { ...prev[kind], ...rule };
      file[key] = next;
    } else if (key === "shortcuts" || key === "notifications" || key === "ui") {
      const prev = file[key] && typeof file[key] === "object" ? (file[key] as Record<string, unknown>) : {};
      file[key] = { ...prev, ...(value as Record<string, unknown>) };
    } else {
      file[key] = value;
    }
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, path);
  return file;
}

export function uiSettings(file: Record<string, unknown>): ConfigResponse["ui"] {
  const r = UiSettings.safeParse(file.ui ?? {});
  return r.success ? r.data : DEFAULT_UI;
}

export function notificationSettings(file: Record<string, unknown>): ConfigResponse["notifications"] & object {
  const r = NotificationSettings.safeParse(file.notifications ?? {});
  return r.success ? r.data : (Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, true])) as ConfigResponse["notifications"] & object);
}

/** The settings screen's view: the file's values (the token only as set or not), plus what the desktop app knows. */
export function configView(
  path: string,
  ctx: {
    editable: boolean;
    desktop?: DesktopHooks;
    replayDirs: string[];
    /** dataDir, port and allowLan as the app started with them. */
    running: { dataDir: string; port: number; allowLan: boolean };
    /** The dashboard's addresses (the port it really listens on). */
    addresses: ConfigResponse["addresses"];
  },
): ConfigResponse {
  const file = readSettingsFile(path);
  const cfg = loadConfig(path);
  const shortcuts = ctx.desktop?.shortcuts();
  const values = { dataDir: cfg.dataDir, port: cfg.port, allowLan: cfg.allowLan };
  return {
    editable: ctx.editable,
    desktop: !!ctx.desktop,
    myPrimaryIds: cfg.myPrimaryIds,
    me: cfg.myPrimaryIds.map((primaryId) => ({ primaryId, name: null })),
    meConfirmed: cfg.meConfirmed,
    knownTeammates: cfg.knownTeammates.map((t) => ({ primaryId: t.primaryId, name: t.name ?? null })),
    dataDir: cfg.dataDir,
    replayDirs: ctx.replayDirs,
    replayDirsCustom: Array.isArray(file.replayDirs),
    practiceGameSpeed: cfg.practiceGameSpeed ?? null,
    matchHistoryWarn: cfg.matchHistoryWarn ?? MATCH_HISTORY_WARN_LAST,
    replayLeadSeconds: cfg.replayLeadSeconds,
    recordCasual: cfg.recordCasual,
    ballchasingUpload: cfg.ballchasingUpload,
    ballchasingUploads: cfg.ballchasingUploads,
    ballchasingTokenSet: typeof file.ballchasingToken === "string" && file.ballchasingToken.trim() !== "",
    shortcuts: shortcuts
      ? (Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a, shortcuts.configured[a] ?? null])) as Record<ShortcutAction, string | null>)
      : null,
    shortcutsUnavailable: shortcuts?.unavailable ?? [],
    notifications: ctx.desktop ? notificationSettings(file) : null,
    startAtLogin: ctx.desktop ? ctx.desktop.startAtLogin() : null,
    port: cfg.port,
    allowLan: cfg.allowLan,
    ui: uiSettings(file),
    restartPending: RESTART_KEYS.filter((k) => values[k] !== ctx.running[k]),
    addresses: ctx.addresses,
    paths: ctx.desktop ? { ...ctx.desktop.paths(), dataDir: cfg.dataDir } : null,
  };
}

export { ConfigPatch };

/** Adapters that aren't the PC's own network: VPNs, WSL, Hyper-V, virtual machines. */
const VIRTUAL = /vethernet|wsl|hyper-v|virtualbox|vmware|loopback|tailscale|zerotier|docker|vpn/i;

/**
 * The dashboard's addresses. On the network: this PC's name with .local
 * (answered by Windows, macOS and most phones over mDNS), then its IPv4
 * addresses on real adapters, private ranges first.
 */
export function dashboardAddresses(port: number, lan: boolean, net = networkInterfaces(), name = hostname()): ConfigResponse["addresses"] {
  const thisPc = `http://localhost:${port}`;
  if (!lan) return { thisPc, network: [] };
  const priv = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  const ips = Object.entries(net)
    .filter(([adapter]) => !VIRTUAL.test(adapter))
    .flatMap(([, list]) => list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
    .map((i) => i.address)
    .sort((a, b) => Number(priv(b)) - Number(priv(a)));
  const host = name && /^[A-Za-z0-9-]+$/.test(name) ? [`http://${name.toLowerCase()}.local:${port}`] : [];
  return { thisPc, network: [...host, ...[...new Set(ips)].map((a) => `http://${a}:${port}`)] };
}
