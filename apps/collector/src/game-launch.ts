import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { steamLibraries } from "./stats-api-setup.ts";

/**
 * Launching Rocket League from the tray app. The game starts through its
 * store's URL rather than its exe, so Epic sign-in and updates happen as
 * usual. The Electron side runs these; the decisions live here so they can be
 * tested.
 */

export const STEAM_APP_ID = 252950;

export interface EpicManifest {
  DisplayName?: string;
  AppName?: string;
  CatalogNamespace?: string;
  CatalogItemId?: string;
}

/**
 * The Epic launcher's URL for launching from a manifest:
 * com.epicgames.launcher://apps/<namespace:itemId:appName>?action=launch&silent=true,
 * or apps/<appName> when the catalog IDs are missing ("Sugar" is Rocket
 * League's AppName).
 */
export function epicLaunchUri(manifest: EpicManifest): string {
  const appName = manifest.AppName || "Sugar";
  const id =
    manifest.CatalogNamespace && manifest.CatalogItemId ? `${manifest.CatalogNamespace}:${manifest.CatalogItemId}:${appName}` : appName;
  return `com.epicgames.launcher://apps/${encodeURIComponent(id)}?action=launch&silent=true`;
}

export interface GameLaunch {
  store: "epic" | "steam";
  uri: string;
}

/**
 * How to launch the game on this PC: Epic first (its manifest), then Steam
 * (the game folder in the Steam root or any library). Null when neither has it.
 */
export function findGameLaunch(env: NodeJS.ProcessEnv = process.env): GameLaunch | null {
  const programData = env.ProgramData ?? "C:\\ProgramData";
  const manifests = join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
  let files: string[] = [];
  try {
    files = readdirSync(manifests).filter((f) => f.endsWith(".item"));
  } catch {
    // No Epic launcher.
  }
  for (const file of files) {
    try {
      const m = JSON.parse(readFileSync(join(manifests, file), "utf8")) as EpicManifest;
      if (/rocket league/i.test(m.DisplayName ?? "")) return { store: "epic", uri: epicLaunchUri(m) };
    } catch {
      // Not a manifest we can read.
    }
  }
  const steamRoot = join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Steam");
  const libraries = [steamRoot, ...steamLibraries(join(steamRoot, "steamapps", "libraryfolders.vdf"))];
  if (libraries.some((lib) => existsSync(join(lib, "steamapps", "common", "rocketleague")))) {
    return { store: "steam", uri: `steam://rungameid/${STEAM_APP_ID}` };
  }
  return null;
}

/**
 * Whether `tasklist /FI "IMAGENAME eq RocketLeague.exe" /NH /FO CSV` found the
 * game. With no match it prints an INFO line instead of a CSV row.
 */
export function tasklistHasGame(stdout: string): boolean {
  return stdout.split(/\r?\n/).some((line) => /^"RocketLeague\.exe",/i.test(line.trim()));
}

/**
 * What a click on "Launch Rocket League" does: bring a running game forward,
 * offer to turn the Stats API on first (the one moment an ini change works
 * without restarting the game), or launch.
 */
export function launchStep(state: { running: boolean; statsApi: "on" | "off" | "not-found" }): "focus" | "turn-on-stats-api" | "launch" {
  if (state.running) return "focus";
  if (state.statsApi === "off") return "turn-on-stats-api";
  return "launch";
}
