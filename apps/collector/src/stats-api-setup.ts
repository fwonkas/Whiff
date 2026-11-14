import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Turning on the game's Stats API, so nobody has to edit an ini file by hand.
 * From rocketleague.com/developer/stats-api: edit
 * `<install>\TAGame\Config\TAStatsAPI.ini` (or DefaultStatsAPI.ini when that
 * doesn't exist), section [TAGame.MatchStatsExporter_TA]: PacketSendRate
 * (default 0, which disables it; capped at 120) and Port (default 49123).
 * The shipped DefaultStatsAPI.ini (2026-11-03) also has WebPort=49124: Port is
 * a raw TCP socket and WebPort the WebSocket, which is the one the collector
 * uses. The website doesn't mention WebPort. Changes apply when the game next
 * starts.
 */

export const STATS_API_SECTION = "TAGame.MatchStatsExporter_TA";
export const DEFAULT_STATS_API_PORT = 49123;
export const DEFAULT_STATS_API_WEB_PORT = 49124;
export const RECOMMENDED_PACKET_SEND_RATE = 30;

export interface StatsApiSettings {
  packetSendRate: number;
  /** Raw TCP. */
  port: number;
  /** WebSocket: what the collector connects to. */
  webPort: number;
}

/** Read PacketSendRate and Port from the ini text; missing values get the game's defaults. */
export function readStatsApi(ini: string): StatsApiSettings {
  const values = sectionValues(ini);
  const num = (key: string, fallback: number) => {
    const v = Number(values.get(key.toLowerCase()));
    return Number.isFinite(v) && values.has(key.toLowerCase()) ? v : fallback;
  };
  return {
    packetSendRate: num("PacketSendRate", 0),
    port: num("Port", DEFAULT_STATS_API_PORT),
    webPort: num("WebPort", DEFAULT_STATS_API_WEB_PORT),
  };
}

/**
 * The ini text with PacketSendRate set, adding the key or the section when
 * missing. Everything else, including line endings, stays as it was.
 */
export function enableStatsApi(ini: string, rate = RECOMMENDED_PACKET_SEND_RATE): string {
  const eol = ini.includes("\r\n") ? "\r\n" : "\n";
  const lines = ini.length ? ini.split(/\r?\n/) : [];
  const start = lines.findIndex((l) => isSection(l) && sectionName(l) === STATS_API_SECTION.toLowerCase());
  const line = `PacketSendRate=${rate}`;
  if (start === -1) {
    while (lines.length && lines.at(-1) === "") lines.pop();
    const block = [`[${STATS_API_SECTION}]`, line, ""];
    return [...lines, ...(lines.length ? [""] : []), ...block].join(eol);
  }
  let end = lines.findIndex((l, i) => i > start && isSection(l));
  if (end === -1) end = lines.length;
  const keyAt = lines.findIndex((l, i) => i > start && i < end && keyOf(l) === "packetsendrate");
  if (keyAt !== -1) lines[keyAt] = line;
  else {
    // After the section's last non-blank line.
    let at = end;
    while (at - 1 > start && lines[at - 1]!.trim() === "") at--;
    lines.splice(at, 0, line);
  }
  return lines.join(eol);
}

const isSection = (l: string) => /^\s*\[.+\]\s*$/.test(l);
const sectionName = (l: string) => l.trim().slice(1, -1).trim().toLowerCase();
const keyOf = (l: string) => {
  const m = l.match(/^\s*([^;=#\s][^=]*?)\s*=/);
  return m ? m[1]!.toLowerCase() : null;
};

function sectionValues(ini: string): Map<string, string> {
  const out = new Map<string, string>();
  let inSection = false;
  for (const l of ini.split(/\r?\n/)) {
    if (isSection(l)) inSection = sectionName(l) === STATS_API_SECTION.toLowerCase();
    else if (inSection) {
      const key = keyOf(l);
      if (key) out.set(key, l.slice(l.indexOf("=") + 1).trim());
    }
  }
  return out;
}

/** The ini to edit in an install folder: TAStatsAPI.ini, else DefaultStatsAPI.ini. Null when neither exists. */
export function statsApiIniPath(installDir: string): string | null {
  const dir = join(installDir, "TAGame", "Config");
  for (const name of ["TAStatsAPI.ini", "DefaultStatsAPI.ini"]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Rocket League install folders on this PC (Windows): from the Epic launcher's
 * install manifests, then Steam's library folders. Only folders that have a
 * Stats API ini are returned.
 */
export function findRocketLeagueInstalls(env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = [];
  const programData = env.ProgramData ?? "C:\\ProgramData";
  const manifests = join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
  for (const file of safeList(manifests).filter((f) => f.endsWith(".item"))) {
    try {
      const m = JSON.parse(readFileSync(join(manifests, file), "utf8")) as { DisplayName?: string; InstallLocation?: string };
      if (m.InstallLocation && /rocket league/i.test(m.DisplayName ?? "")) found.push(m.InstallLocation);
    } catch {
      // Not a manifest we can read.
    }
  }
  const steamRoots = [join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Steam")];
  for (const root of steamRoots) {
    const libraries = [root, ...steamLibraries(join(root, "steamapps", "libraryfolders.vdf"))];
    for (const lib of libraries) found.push(join(lib, "steamapps", "common", "rocketleague"));
  }
  return [...new Set(found)].filter((dir) => statsApiIniPath(dir) !== null);
}

/** Library paths from Steam's libraryfolders.vdf ("path" entries). */
export function steamLibraries(vdfPath: string): string[] {
  if (!existsSync(vdfPath)) return [];
  const text = readFileSync(vdfPath, "utf8");
  return [...text.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1]!.replace(/\\\\/g, "\\"));
}

const safeList = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
