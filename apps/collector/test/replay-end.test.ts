import { describe, expect, it } from "vitest";
import { ingestRecording } from "../src/ingest.ts";
import { completeAtReplayEnd } from "../src/replays.ts";
import { fixture, ME } from "./fixtures.ts";

/**
 * "Play all" playing a ranked 3s replay at 2x (2026-11-06): the feed's last
 * tick has the clock at 1, not 0, at frame 7129. The replay file's header
 * says NumFrames 7129, so the playback reached the file's end.
 */
const NUM_FRAMES = 7129;

async function playback() {
  const { sessions } = await ingestRecording(fixture("replay-ends-at-clock-1"), { myPrimaryIds: [ME], knownTeammates: [] });
  return sessions.find((s) => s.kind === "replay")!;
}

describe("a replay playback that ends with the clock at 0:01", () => {
  it("counts as watched to the end of regulation", async () => {
    const s = await playback();
    expect(s.playback).toMatchObject({ complete: true, endReason: "regulation", gaps: 0, firstFrame: 9, lastFrame: NUM_FRAMES });
    expect([s.scoreBlue, s.scoreOrange]).toEqual([1, 2]);
    expect(s.outcome).toBe(s.myTeam === 1 ? "win" : "loss");
  });

  it("reaching the replay file's last frame completes a playback the clock rule missed", async () => {
    const s = await playback();
    const missed = { ...s, playback: { ...s.playback!, complete: false, endReason: null }, winnerTeam: null, outcome: null };
    const done = completeAtReplayEnd(missed, NUM_FRAMES)!;
    expect(done.playback).toMatchObject({ complete: true, endReason: "end" });
    expect(done.winnerTeam).toBe(1);
    expect(done.outcome).toBe(s.outcome);
    // Not at the file's end, skipped ahead, started late, or already complete: unchanged.
    expect(completeAtReplayEnd(missed, NUM_FRAMES + 200)).toBeNull();
    expect(completeAtReplayEnd({ ...missed, playback: { ...missed.playback, gaps: 1 } }, NUM_FRAMES)).toBeNull();
    expect(completeAtReplayEnd({ ...missed, playback: { ...missed.playback, firstFrame: 900 } }, NUM_FRAMES)).toBeNull();
    expect(completeAtReplayEnd(s, NUM_FRAMES)).toBeNull();
    expect(completeAtReplayEnd(missed, null)).toBeNull();
  });

  it("a forfeit can end tied: complete, with the live match's winner when known", async () => {
    const s = await playback();
    // Seen on 2026-11-06: a 3–3 forfeit's playback reached the file's end and was replayed five times.
    const tied = { ...s, scoreBlue: 3, scoreOrange: 3, playback: { ...s.playback!, complete: false, endReason: null } };
    expect(completeAtReplayEnd(tied, NUM_FRAMES)).toMatchObject({ playback: { complete: true }, winnerTeam: null });
    expect(completeAtReplayEnd(tied, NUM_FRAMES, s.myTeam)).toMatchObject({ winnerTeam: s.myTeam, outcome: "win" });
  });
});
