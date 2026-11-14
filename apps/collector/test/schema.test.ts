import { describe, expect, it } from "vitest";
import { commands, encodeLikeGame, GameCommand, parseMessage } from "@rl/schema";
import { readRecording } from "../src/recording.ts";
import { allFixtures, fixture } from "./fixtures.ts";

describe("schemas against every recorded message", () => {
  for (const name of allFixtures()) {
    it(`${name}: every message parses`, async () => {
      const failures: string[] = [];
      let messages = 0;
      for await (const entry of readRecording(fixture(name))) {
        if (entry.kind === "message") messages++;
        if (entry.kind === "invalid") failures.push(`${entry.result.reason} ${entry.result.event ?? ""} ${entry.result.error ?? ""}`);
      }
      expect(failures.slice(0, 5)).toEqual([]);
      expect(messages).toBeGreaterThan(100);
    });
  }
});

describe("parseMessage", () => {
  it("decodes the game's double-encoded Data", () => {
    const text = encodeLikeGame("MatchEnded", { MatchGuid: "", WinnerTeamNum: 1 });
    const r = parseMessage(text);
    expect(r.ok && r.msg.Event === "MatchEnded" && r.msg.Data.WinnerTeamNum).toBe(1);
  });

  it("keeps unknown fields instead of failing", () => {
    const r = parseMessage(encodeLikeGame("RoundStarted", { MatchGuid: "x", NewField: 42 }));
    expect(r.ok && (r.msg.Data as Record<string, unknown>).NewField).toBe(42);
  });

  it("reports unknown events instead of throwing", () => {
    expect(parseMessage(encodeLikeGame("SomethingNew", {}))).toMatchObject({ ok: false, reason: "unknown-event" });
  });

  it("reports broken JSON", () => {
    expect(parseMessage("not json")).toMatchObject({ ok: false, reason: "invalid-json" });
  });
});

describe("commands", () => {
  it("seeks by frame using the measured 30 frames per seek-second", () => {
    expect(commands.seekToFrame(8700)).toEqual({ Command: "SeekReplay", Data: { TimeSeconds: 290 } });
  });
  it("validates POV focus", () => {
    expect(GameCommand.safeParse(commands.pov(3, "PlayerView")).success).toBe(true);
    expect(GameCommand.safeParse({ Command: "ChangePOV", Data: { Focus: "abc" } }).success).toBe(false);
  });
});
