import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { CONFIG_FILE, defaultDataDir } from "./config.ts";

/** Before the rename to Whiff (0.1.56). */
export const OLD_CONFIG_FILE = "rl-stats-lab.config.json";
export const OLD_SETTINGS_FOLDER = "RL Stats Lab";
export const oldDefaultDataDir = (home = homedir()) => join(home, "rl-stats-lab-data");

export interface MoveFromRlStatsLab {
  /** The old settings folder (%APPDATA%\RL Stats Lab). */
  oldSettingsDir: string;
  /** The new one (%APPDATA%\Whiff). */
  settingsDir: string;
  /** Where data goes now (%LOCALAPPDATA%\Whiff). */
  dataDir?: string;
  home?: string;
}

/**
 * First start after the rename: bring RL Stats Lab's settings and data to
 * Whiff's folders. Moves, never copies or deletes, and only what isn't
 * there yet, so it's safe to run on every start.
 * - Settings: the config file (renamed to whiff.config.json), window.json and
 *   logs, from %APPDATA%\RL Stats Lab to %APPDATA%\Whiff. The browser caches
 *   left behind are the old folder's to delete.
 * - Data: only when the config still points at the old default folder
 *   (~/rl-stats-lab-data); a folder picked by hand stays where it is. A rename,
 *   so instant on the same drive; if it fails (another drive, a file in use)
 *   the config keeps the old folder and the app runs from there.
 * Returns what it did, a line each, for the log.
 */
export function moveFromRlStatsLab(o: MoveFromRlStatsLab): string[] {
  const done: string[] = [];
  const config = join(o.settingsDir, CONFIG_FILE);
  if (!existsSync(config) && existsSync(o.oldSettingsDir)) {
    mkdirSync(o.settingsDir, { recursive: true });
    const moves: [string, string][] = [
      [OLD_CONFIG_FILE, CONFIG_FILE],
      ["window.json", "window.json"],
      ["logs", "logs"],
    ];
    for (const [from, to] of moves) {
      const src = join(o.oldSettingsDir, from);
      const dest = join(o.settingsDir, to);
      if (!existsSync(src) || existsSync(dest)) continue;
      try {
        renameSync(src, dest);
        done.push(`moved ${src} to ${dest}`);
      } catch (e) {
        done.push(`couldn't move ${src}: ${String(e)}`);
      }
    }
  }
  if (!existsSync(config)) return done;

  // The data folder, if it's still the old default.
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
  } catch {
    return done;
  }
  const old = oldDefaultDataDir(o.home);
  const current = typeof file.dataDir === "string" ? file.dataDir : old;
  if (!samePath(current, old)) return done;
  const target = o.dataDir ?? defaultDataDir(process.env, o.home);
  if (existsSync(old)) {
    try {
      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        renameSync(old, target);
      }
      else {
        // The folder is there already (empty, or a fresh start's): move what isn't in it.
        for (const name of readdirSync(old)) if (!existsSync(join(target, name))) renameSync(join(old, name), join(target, name));
      }
      done.push(`moved ${old} to ${target}`);
    } catch (e) {
      done.push(`couldn't move ${old} (it stays the data folder): ${String(e)}`);
      return done;
    }
  }
  writeFileSync(config, JSON.stringify({ ...file, dataDir: target }, null, 2) + "\n");
  return done;
}

const samePath = (a: string, b: string) => normalize(a).replace(/[\\/]+$/, "").toLowerCase() === normalize(b).replace(/[\\/]+$/, "").toLowerCase();
