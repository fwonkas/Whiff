import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE, defaultDataDir } from "../src/config.ts";
import { moveFromRlStatsLab, OLD_CONFIG_FILE } from "../src/migrate.ts";

/** A home with RL Stats Lab's settings (%APPDATA%\RL Stats Lab) and data (~/rl-stats-lab-data). */
function oldInstall(dataDir?: string) {
  const home = mkdtempSync(join(tmpdir(), "whiff-move-"));
  const roaming = join(home, "AppData", "Roaming");
  const oldSettingsDir = join(roaming, "RL Stats Lab");
  mkdirSync(join(oldSettingsDir, "logs"), { recursive: true });
  mkdirSync(join(oldSettingsDir, "Local Storage"));
  const oldData = join(home, "rl-stats-lab-data");
  mkdirSync(join(oldData, "raw"), { recursive: true });
  writeFileSync(join(oldData, "stats.db"), "db");
  writeFileSync(join(oldData, "raw", "2026-11-14T01-00-00.ndjson.gz"), "raw");
  writeFileSync(join(oldSettingsDir, OLD_CONFIG_FILE), JSON.stringify({ myPrimaryIds: ["Epic|me|0"], dataDir: dataDir ?? oldData, port: 49200 }));
  writeFileSync(join(oldSettingsDir, "window.json"), "{}");
  writeFileSync(join(oldSettingsDir, "logs", "collector.log"), "log");
  return {
    home,
    oldSettingsDir,
    oldData,
    settingsDir: join(roaming, "Whiff"),
    dataDir: join(home, "AppData", "Local", "Whiff"),
  };
}

describe("moving RL Stats Lab's settings and data to Whiff's folders", () => {
  it("moves the config (renamed), window size, logs and the data folder, and points the config at the new one", () => {
    const o = oldInstall();
    const done = moveFromRlStatsLab(o);
    expect(done.filter((l) => l.startsWith("moved"))).toHaveLength(4);
    const config = JSON.parse(readFileSync(join(o.settingsDir, CONFIG_FILE), "utf8"));
    expect(config).toEqual({ myPrimaryIds: ["Epic|me|0"], dataDir: o.dataDir, port: 49200 });
    expect(readFileSync(join(o.settingsDir, "window.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(o.settingsDir, "logs", "collector.log"), "utf8")).toBe("log");
    expect(readFileSync(join(o.dataDir, "stats.db"), "utf8")).toBe("db");
    expect(readFileSync(join(o.dataDir, "raw", "2026-11-14T01-00-00.ndjson.gz"), "utf8")).toBe("raw");
    // Moved, not copied; the browser's caches stay behind, and nothing is deleted.
    expect(existsSync(o.oldData)).toBe(false);
    expect(existsSync(join(o.oldSettingsDir, OLD_CONFIG_FILE))).toBe(false);
    expect(existsSync(join(o.oldSettingsDir, "Local Storage"))).toBe(true);
    // Running again (every start) changes nothing.
    expect(moveFromRlStatsLab(o)).toEqual([]);
    expect(JSON.parse(readFileSync(join(o.settingsDir, CONFIG_FILE), "utf8")).dataDir).toBe(o.dataDir);
  });

  it("leaves a data folder picked by hand where it is", () => {
    const picked = join(tmpdir(), "somewhere-else");
    const o = oldInstall(picked);
    moveFromRlStatsLab(o);
    expect(JSON.parse(readFileSync(join(o.settingsDir, CONFIG_FILE), "utf8")).dataDir).toBe(picked);
    expect(existsSync(join(o.oldData, "stats.db"))).toBe(true);
    expect(existsSync(o.dataDir)).toBe(false);
  });

  it("moves the data into a Whiff folder that already exists, without replacing what's there", () => {
    const o = oldInstall();
    mkdirSync(o.dataDir, { recursive: true });
    writeFileSync(join(o.dataDir, "stats.db"), "newer");
    moveFromRlStatsLab(o);
    expect(readFileSync(join(o.dataDir, "stats.db"), "utf8")).toBe("newer");
    expect(readFileSync(join(o.dataDir, "raw", "2026-11-14T01-00-00.ndjson.gz"), "utf8")).toBe("raw");
    expect(existsSync(join(o.oldData, "stats.db"))).toBe(true);
  });

  it("does nothing on a fresh install", () => {
    const home = mkdtempSync(join(tmpdir(), "whiff-fresh-"));
    expect(moveFromRlStatsLab({ oldSettingsDir: join(home, "RL Stats Lab"), settingsDir: join(home, "Whiff"), dataDir: join(home, "data"), home })).toEqual([]);
    expect(existsSync(join(home, "Whiff"))).toBe(false);
  });
});

describe("the default data folder", () => {
  it("is %LOCALAPPDATA%\\Whiff on Windows, ~/.local/share/whiff elsewhere", () => {
    expect(defaultDataDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "C:\\Users\\me")).toBe(join("C:\\Users\\me\\AppData\\Local", "Whiff"));
    expect(defaultDataDir({}, "/home/me")).toBe(join("/home/me", ".local", "share", "whiff"));
  });
});
