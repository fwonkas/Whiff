import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient, type ConfigResponse } from "@rl/api-contract";
import { startCollector, type RunningCollector } from "../src/collector.ts";
import { ingestRecording } from "../src/ingest.ts";
import { StatsDb } from "../src/db.ts";
import { fixture, ME, TEAMMATE } from "./fixtures.ts";

let running: RunningCollector | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

async function start(file: Record<string, unknown>, me = ME) {
  const dir = mkdtempSync(join(tmpdir(), "rl-settings-"));
  const settingsFile = join(dir, "whiff.config.json");
  writeFileSync(settingsFile, JSON.stringify({ ...file, dataDir: dir, port: 0 }));
  // A database with ranked 2s played with the teammate, before they're known.
  const dbPath = join(dir, "stats.db");
  const db = new StatsDb(dbPath);
  for (const s of (await ingestRecording(fixture("ranked-2s-party"), { myPrimaryIds: [me], knownTeammates: [] })).sessions) db.saveSession(s);
  db.db.close();
  running = await startCollector({
    myPrimaryIds: [me],
    knownTeammates: [],
    gameUrl: "ws://127.0.0.1:9", // nothing there; the collector keeps retrying quietly
    dbPath,
    rawDir: join(dir, "raw"),
    port: 0,
    log: () => {},
    settingsFile,
  });
  const api = createApiClient(`http://127.0.0.1:${running.port}`);
  return { api, settingsFile, dbPath };
}

describe("settings", () => {
  it("shows the settings file without the ballchasing key", async () => {
    const { api } = await start({ ballchasingToken: "secret", replayLeadSeconds: 7, custom: "kept" });
    const view: ConfigResponse = await api.config();
    expect(view).toMatchObject({ editable: true, desktop: false, replayLeadSeconds: 7, ballchasingTokenSet: true, shortcuts: null, restartPending: [] });
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  it("writes changes into the file, keeping what it doesn't know, and applies them", async () => {
    const { api, settingsFile } = await start({ custom: "kept" });
    const r = await api.patchConfig({ replayLeadSeconds: 4, ui: { theme: "light" }, ballchasingToken: "k" });
    expect(r.ok && r.config.replayLeadSeconds).toBe(4);
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toMatchObject({ custom: "kept", replayLeadSeconds: 4, ui: { theme: "light" }, ballchasingToken: "k" });
    expect((await api.settings()).replayLeadSeconds).toBe(4);
    await api.patchConfig({ ballchasingToken: null });
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).not.toHaveProperty("ballchasingToken");
  });

  it("keeps ballchasing upload settings per kind of match, merging changes and reading group links", async () => {
    const { api, settingsFile } = await start({});
    const view = await api.config();
    expect(view.ballchasingUpload).toBe(true);
    expect(view.ballchasingUploads).toEqual({
      online: { enabled: true, visibility: "public", group: null },
      tournament: { enabled: true, visibility: "public", group: null },
      private: { enabled: true, visibility: "private", group: null },
    });
    await api.patchConfig({ ballchasingUploads: { online: { enabled: false } } });
    const r = await api.patchConfig({ ballchasingUploads: { online: { group: "https://ballchasing.com/group/joe-online-x1y2" } } });
    expect(r.ok && r.config.ballchasingUploads.online).toEqual({ enabled: false, visibility: "public", group: "joe-online-x1y2" });
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).ballchasingUploads).toEqual({ online: { enabled: false, group: "joe-online-x1y2" } });
    await expect(api.patchConfig({ ballchasingUploads: { online: { group: "not a group" } } })).rejects.toThrow();
  });

  it("moves past matches into With teammates when a teammate is added", async () => {
    const { api } = await start({});
    expect((await api.summary({})).partied.wins + (await api.summary({})).partied.losses).toBe(0);
    const suggestions = await api.teammateSuggestions();
    expect(suggestions[0]).toMatchObject({ primaryId: TEAMMATE, known: false });
    await api.patchConfig({ knownTeammates: [{ primaryId: TEAMMATE, name: "Teammate" }] });
    const after = await api.summary({});
    expect(after.partied.wins + after.partied.losses).toBeGreaterThan(0);
    expect((await api.teammateSuggestions())[0]).toMatchObject({ primaryId: TEAMMATE, known: true });
  });

  it("asks to confirm a guessed player, and moves its sessions to the one picked instead", async () => {
    // The app guessed the teammate (say, a friend playing on this PC).
    const { api, settingsFile, dbPath } = await start({ myPrimaryIds: [TEAMMATE], meConfirmed: false }, TEAMMATE);
    const view = await api.config();
    expect(view.meConfirmed).toBe(false);
    expect(view.me).toEqual([{ primaryId: TEAMMATE, name: expect.any(String) }]);
    const candidates = await api.meCandidates();
    expect(candidates.map((c) => c.primaryId)).toContain(ME);
    expect(candidates.map((c) => c.primaryId)).not.toContain(TEAMMATE);

    const r = await api.patchConfig({ myPrimaryIds: [ME], meConfirmed: true });
    expect(r.ok && r.config.meConfirmed).toBe(true);
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toMatchObject({ myPrimaryIds: [ME], meConfirmed: true });
    const db = new StatsDb(dbPath);
    const mine = db.db.prepare("SELECT primary_id AS id, COUNT(*) AS n FROM session_players WHERE is_me = 1 GROUP BY primary_id").all();
    db.close();
    expect(mine).toEqual([{ id: ME, n: expect.any(Number) }]);
  });

  it("sets how early the Match History warning comes (5 matches by default)", async () => {
    const { api, settingsFile } = await start({ myPrimaryIds: [ME] });
    expect((await api.config()).matchHistoryWarn).toBe(5);
    const r = await api.patchConfig({ matchHistoryWarn: 8 });
    expect(r.ok && r.config.matchHistoryWarn).toBe(8);
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).matchHistoryWarn).toBe(8);
    await expect(api.patchConfig({ matchHistoryWarn: 0 })).rejects.toThrow(/matchHistoryWarn/);
  });

  it("leaves past sessions alone when a confirmed player ID is changed", async () => {
    const { api, dbPath } = await start({ myPrimaryIds: [ME] });
    expect((await api.config()).meConfirmed).toBe(true);
    await api.patchConfig({ myPrimaryIds: [TEAMMATE] });
    const db = new StatsDb(dbPath);
    const mine = db.db.prepare("SELECT DISTINCT primary_id AS id FROM session_players WHERE is_me = 1").all();
    db.close();
    expect(mine).toEqual([{ id: ME }]);
  });

  it("says which changes need a restart and rejects bad values", async () => {
    const { api } = await start({});
    const r = await api.patchConfig({ port: 49555 });
    expect(r.ok && r.config.restartPending).toEqual(["port"]);
    await expect(api.patchConfig({ shortcuts: { pause: "P" } })).rejects.toThrow(/modifier/);
    await expect(api.patchConfig({ nonsense: 1 } as never)).rejects.toThrow();
  });
});

describe("dashboard addresses", () => {
  it("lists this PC's name and its real network addresses, private ones first, only with network access", async () => {
    const { dashboardAddresses } = await import("../src/settings.ts");
    const ip = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null });
    const net = {
      Ethernet: [ip("203.0.113.5"), ip("192.168.1.20")],
      "vEthernet (WSL)": [ip("172.27.16.1")],
      "Loopback Pseudo-Interface 1": [ip("127.0.0.1", true)],
      "Wi-Fi": [ip("169.254.3.4")],
    };
    expect(dashboardAddresses(49200, true, net, "RocketLeague")).toEqual({
      thisPc: "http://localhost:49200",
      network: ["http://rocketleague.local:49200", "http://192.168.1.20:49200", "http://203.0.113.5:49200"],
    });
    expect(dashboardAddresses(49200, false, net, "RocketLeague")).toEqual({ thisPc: "http://localhost:49200", network: [] });
  });
});
