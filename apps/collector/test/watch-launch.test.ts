import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type LaunchGameResponse } from "@rl/api-contract";
import { startCollector, type RunningCollector } from "../src/collector.ts";
import { ME } from "./fixtures.ts";

let running: RunningCollector | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

async function start(launch: LaunchGameResponse) {
  const dir = mkdtempSync(join(tmpdir(), "rl-launch-"));
  const launchGame = vi.fn(async () => launch);
  running = await startCollector({
    myPrimaryIds: [ME],
    knownTeammates: [],
    gameUrl: "ws://127.0.0.1:9", // no game: it isn't running
    dbPath: join(dir, "stats.db"),
    rawDir: join(dir, "raw"),
    port: 0,
    log: () => {},
    launchGame,
    replayAnalysis: false,
  });
  return { api: createApiClient(`http://127.0.0.1:${running.port}`), launchGame };
}

const REPLAY = "28A9446211F1D80CBB62098D327FF865";

describe("Watch with the game closed", () => {
  it("starts the game when asked, and says the replay opens once it's up", async () => {
    const { api, launchGame } = await start({ ok: true, status: "launching" });
    expect(await api.replayWatch(REPLAY, true)).toEqual({ ok: true, status: "launching" });
    expect(await api.replayGoto({ replayId: REPLAY, frame: 1223, launch: true })).toEqual({ ok: true, status: "launching" });
    expect(launchGame).toHaveBeenCalledTimes(2);
  });

  it("without being asked to start it, says the game isn't running", async () => {
    const { api, launchGame } = await start({ ok: true, status: "launching" });
    await expect(api.replayWatch(REPLAY, false)).rejects.toThrow(/isn't running/);
    expect(launchGame).not.toHaveBeenCalled();
  });

  it("passes on a start that was cancelled", async () => {
    const { api } = await start({ ok: true, status: "cancelled" });
    await expect(api.replayWatch(REPLAY, true)).rejects.toThrow(/cancelled/);
  });
});
