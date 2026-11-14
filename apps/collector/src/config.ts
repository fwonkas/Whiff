import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { CollectorConfig } from "@rl/domain";
import { UploadRules } from "@rl/api-contract";

/**
 * Settings live in whiff.config.json: at the repo root when run from source
 * (git-ignored), in %APPDATA%\Whiff for the desktop app. The data folder
 * defaults to defaultDataDir(), outside OneDrive, so the live database never
 * fights with file sync.
 */
const ConfigFile = z.object({
  myPrimaryIds: z.array(z.string()).default([]),
  /** False after the app picked my player by itself, until I confirm it (or pick another). */
  meConfirmed: z.boolean().default(true),
  knownTeammates: z.array(z.object({ primaryId: z.string(), name: z.string().optional() })).default([]),
  dataDir: z.string().default(() => defaultDataDir()),
  gameUrl: z.string().default("ws://localhost:49124"),
  /**
   * My usual practice game speed (0.85 for 85%). Used for freeplay and
   * training whose speed can't be measured (no goals, or Disable Goal Reset on).
   */
  practiceGameSpeed: z.number().gt(0).max(1).optional(),
  /** Warn about an unsaved match this many matches before it drops out of Match History. */
  matchHistoryWarn: z.number().int().min(1).max(15).optional(),
  /** Seconds before a moment that a replay jump starts (replay review). */
  replayLeadSeconds: z.number().min(0).max(60).default(10),
  /** Port for the API, the web app and the live feed (/live). */
  port: z.number().int().optional(),
  /** Older name for `port`. */
  relayPort: z.number().int().optional(),
  /**
   * Accept connections from other devices on the network (e.g. your phone).
   * Off by default: anyone on the network could then read your stats and send
   * replay commands to the game.
   */
  allowLan: z.boolean().default(false),
  /** API key from ballchasing.com/upload, for downloading replays of recorded matches that have none saved. */
  ballchasingToken: z.string().optional(),
  /** Upload saved replays to ballchasing (only with an API key). */
  ballchasingUpload: z.boolean().default(true),
  /** Which kinds of match upload, who can see them and the group they join. */
  ballchasingUploads: UploadRules.default(UploadRules.parse({})),
  /** Keep casual matches. Off by default; the raw log still has them. */
  recordCasual: z.boolean().default(false),
  /** Folders with saved replays, instead of the game's own under Documents. */
  replayDirs: z.array(z.string()).optional(),
});
export type AppConfig = z.infer<typeof ConfigFile> & CollectorConfig & { port: number; host: string };

export const CONFIG_FILE = "whiff.config.json";

/**
 * Where the database and raw recordings go unless the config says otherwise:
 * %LOCALAPPDATA%\Whiff on Windows (per-user, not roaming, not synced),
 * ~/.local/share/whiff elsewhere.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "Whiff");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "whiff");
}

export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** The repo's config when run from source; rl-stats-lab.config.json from before the rename still works. */
export function repoConfigPath(root = findRepoRoot()): string {
  const path = join(root, CONFIG_FILE);
  const old = join(root, "rl-stats-lab.config.json");
  return !existsSync(path) && existsSync(old) ? old : path;
}

export function loadConfig(path = repoConfigPath()): AppConfig {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const cfg = ConfigFile.parse(raw);
  return { ...cfg, port: cfg.port ?? cfg.relayPort ?? 49200, host: cfg.allowLan ? "0.0.0.0" : "127.0.0.1" };
}

export const paths = (cfg: AppConfig) => ({
  db: join(cfg.dataDir, "stats.db"),
  rawDir: join(cfg.dataDir, "raw"),
  webRoot: join(findRepoRoot(), "apps", "web", "dist"),
});
