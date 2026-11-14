import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { epicLaunchUri, findGameLaunch, launchStep, tasklistHasGame } from "../src/game-launch.ts";
import { MeDetector } from "../src/me-detector.ts";
import { readRecording } from "../src/recording.ts";
import { enableStatsApi, findRocketLeagueInstalls, readStatsApi, statsApiIniPath, steamLibraries } from "../src/stats-api-setup.ts";
import { fixture, ME } from "./fixtures.ts";

describe("Stats API setup", () => {
  // The shape of the shipped DefaultStatsAPI.ini (2026-11-03), comments included.
  const shipped =
    "[TAGame.MatchStatsExporter_TA]\r\n\r\n; Port the client will listen for tcp connections on\r\nPort=49123\r\n\r\n" +
    "; Port the client will listen for web connections on\r\nWebPort=49124\r\n\r\n" +
    "; How many times per second the game sends the update state\r\nPacketSendRate=0\r\n";

  it("reads the settings, with the game's defaults for anything missing", () => {
    expect(readStatsApi(shipped)).toEqual({ packetSendRate: 0, port: 49123, webPort: 49124 });
    expect(readStatsApi("[TAGame.MatchStatsExporter_TA]\nwebport = 49200\n")).toEqual({ packetSendRate: 0, port: 49123, webPort: 49200 });
    expect(readStatsApi("[Other]\nPacketSendRate=60\n")).toEqual({ packetSendRate: 0, port: 49123, webPort: 49124 });
  });

  it("turns it on, keeping everything else and the line endings", () => {
    const on = enableStatsApi(shipped);
    expect(on).toBe(shipped.replace("PacketSendRate=0", "PacketSendRate=30"));
    expect(readStatsApi(on).packetSendRate).toBe(30);
  });

  it("adds the key or the section when missing", () => {
    expect(enableStatsApi("[TAGame.MatchStatsExporter_TA]\nPort=49124\n\n[Other]\nX=1\n")).toBe(
      "[TAGame.MatchStatsExporter_TA]\nPort=49124\nPacketSendRate=30\n\n[Other]\nX=1\n",
    );
    expect(enableStatsApi("[Other]\nX=1\n")).toBe("[Other]\nX=1\n\n[TAGame.MatchStatsExporter_TA]\nPacketSendRate=30\n");
    expect(enableStatsApi("")).toBe("[TAGame.MatchStatsExporter_TA]\nPacketSendRate=30\n");
  });

  it("finds installs from Epic manifests and Steam libraries, preferring TAStatsAPI.ini", () => {
    const root = mkdtempSync(join(tmpdir(), "rl-installs-"));
    const epicGame = join(root, "Epic", "rocketleague");
    mkdirSync(join(epicGame, "TAGame", "Config"), { recursive: true });
    writeFileSync(join(epicGame, "TAGame", "Config", "DefaultStatsAPI.ini"), shipped);
    writeFileSync(join(epicGame, "TAGame", "Config", "TAStatsAPI.ini"), shipped);
    const manifests = join(root, "ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests");
    mkdirSync(manifests, { recursive: true });
    writeFileSync(join(manifests, "A.item"), JSON.stringify({ DisplayName: "Rocket League®", InstallLocation: epicGame }));
    writeFileSync(join(manifests, "B.item"), JSON.stringify({ DisplayName: "Some Other Game", InstallLocation: root }));
    const steam = join(root, "Steam");
    const lib = join(root, "SteamLibrary");
    mkdirSync(join(steam, "steamapps"), { recursive: true });
    mkdirSync(join(lib, "steamapps", "common", "rocketleague", "TAGame", "Config"), { recursive: true });
    writeFileSync(join(lib, "steamapps", "common", "rocketleague", "TAGame", "Config", "DefaultStatsAPI.ini"), shipped);
    writeFileSync(join(steam, "steamapps", "libraryfolders.vdf"), `"libraryfolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"${lib.replace(/\\/g, "\\\\")}"\n\t}\n}\n`);
    expect(steamLibraries(join(steam, "steamapps", "libraryfolders.vdf"))).toEqual([lib]);

    const found = findRocketLeagueInstalls({ ProgramData: join(root, "ProgramData"), "ProgramFiles(x86)": root });
    expect(found).toEqual([epicGame, join(lib, "steamapps", "common", "rocketleague")]);
    expect(statsApiIniPath(epicGame)).toBe(join(epicGame, "TAGame", "Config", "TAStatsAPI.ini"));
  });
});

describe("recognizing me", () => {
  it("finds my PrimaryId from the camera in matches, freeplay and training, ignoring replays", async () => {
    for (const name of ["ranked-1s", "casual-3s", "freeplay-long", "training-marked", "tournament-live"]) {
      const d = new MeDetector();
      let found: string | null = null;
      for await (const e of readRecording(fixture(name))) if (e.kind === "message") found ??= d.feed(e.msg);
      expect(found, name).toBe(ME);
    }
    // A replay alone never decides: the camera follows whoever the viewer picks.
    const d = new MeDetector();
    let found: string | null = null;
    for await (const e of readRecording(fixture("replay-seeks"))) if (e.kind === "message") found ??= d.feed(e.msg);
    expect(found).toBeNull();
  });
});

describe("Stats API setup: comments", () => {
  it("ignores a commented-out PacketSendRate", () => {
    const ini = "[TAGame.MatchStatsExporter_TA]\n; PacketSendRate=0\nPacketSendRate=30\n";
    expect(readStatsApi(ini).packetSendRate).toBe(30);
    expect(readStatsApi("[TAGame.MatchStatsExporter_TA]\n; PacketSendRate=30\n").packetSendRate).toBe(0);
    expect(enableStatsApi("[TAGame.MatchStatsExporter_TA]\n; PacketSendRate=0\nPort=49123\n")).toBe(
      "[TAGame.MatchStatsExporter_TA]\n; PacketSendRate=0\nPort=49123\nPacketSendRate=30\n",
    );
  });
});

describe("launching the game", () => {
  it("builds the Epic launch URI, with and without catalog IDs", () => {
    expect(epicLaunchUri({ DisplayName: "Rocket League®", AppName: "Sugar", CatalogNamespace: "9773aa1aa54f4f7b80e44bef04986cea", CatalogItemId: "530145df28a24424923f5828cc9031a1" })).toBe(
      "com.epicgames.launcher://apps/9773aa1aa54f4f7b80e44bef04986cea%3A530145df28a24424923f5828cc9031a1%3ASugar?action=launch&silent=true",
    );
    expect(epicLaunchUri({ AppName: "Sugar" })).toBe("com.epicgames.launcher://apps/Sugar?action=launch&silent=true");
    expect(epicLaunchUri({})).toBe("com.epicgames.launcher://apps/Sugar?action=launch&silent=true");
  });

  it("prefers Epic, falls back to Steam (any library), and returns null when neither has the game", () => {
    const root = mkdtempSync(join(tmpdir(), "rl-launch-"));
    const env = { ProgramData: join(root, "ProgramData"), "ProgramFiles(x86)": root };
    expect(findGameLaunch(env)).toBeNull();

    // Steam, with the game in a second library.
    const steam = join(root, "Steam");
    const lib = join(root, "SteamLibrary");
    mkdirSync(join(steam, "steamapps"), { recursive: true });
    mkdirSync(join(lib, "steamapps", "common", "rocketleague"), { recursive: true });
    writeFileSync(join(steam, "steamapps", "libraryfolders.vdf"), `"libraryfolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"${lib.replace(/\\/g, "\\\\")}"\n\t}\n}\n`);
    expect(findGameLaunch(env)).toEqual({ store: "steam", uri: "steam://rungameid/252950" });

    // Epic too: Epic wins. Other games' manifests are ignored.
    const manifests = join(root, "ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests");
    mkdirSync(manifests, { recursive: true });
    writeFileSync(join(manifests, "A.item"), JSON.stringify({ DisplayName: "Some Other Game", AppName: "Other" }));
    writeFileSync(join(manifests, "B.item"), JSON.stringify({ DisplayName: "Rocket League®", AppName: "Sugar" }));
    expect(findGameLaunch(env)).toEqual({ store: "epic", uri: "com.epicgames.launcher://apps/Sugar?action=launch&silent=true" });
  });

  it("reads tasklist output", () => {
    expect(tasklistHasGame('"RocketLeague.exe","12345","Console","1","1,234,567 K"\r\n')).toBe(true);
    expect(tasklistHasGame("INFO: No tasks are running which match the specified criteria.\r\n")).toBe(false);
    expect(tasklistHasGame("")).toBe(false);
  });

  it("decides what a click does", () => {
    expect(launchStep({ running: true, statsApi: "off" })).toBe("focus");
    expect(launchStep({ running: false, statsApi: "off" })).toBe("turn-on-stats-api");
    expect(launchStep({ running: false, statsApi: "on" })).toBe("launch");
    expect(launchStep({ running: false, statsApi: "not-found" })).toBe("launch");
  });
});
