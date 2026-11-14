import { describe, expect, it } from "vitest";
import { parseReplayHeader, replaySummary } from "../src/replay-header.ts";
import { HeaderWriter } from "./replay-header-writer.ts";

// The shape of a 2026-11-02 replay's header (version 868.34), with invented values.
const header = new HeaderWriter()
  .u32(0)
  .u32(0)
  .u32(868)
  .u32(34)
  .u32(12)
  .str("TAGame.Replay_Soccar_TA")
  .prop("TeamSize", "IntProperty", (w) => w.u32(3))
  .prop("NumFrames", "IntProperty", (w) => w.u32(5210))
  .prop("bForfeit", "BoolProperty", (w) => w.byte(1))
  .prop("TotalSecondsPlayed", "FloatProperty", (w) => w.u32(0x436b0000)) // 235.0
  .prop("MatchStartEpoch", "QWordProperty", (w) => w.u64(1793601254n))
  .prop("PlayerStats", "ArrayProperty", (w) =>
    w
      .u32(1)
      .prop("PlayerID", "StructProperty", (s) =>
        s
          .str("UniqueNetId")
          .prop("Uid", "QWordProperty", (x) => x.u64(123n))
          .prop("NpId", "StructProperty", (x) =>
            x
              .str("SceNpId")
              .prop("Term", "ByteProperty", (y) => y.str("None").byte(0))
              .str("None"),
          )
          .prop("EpicAccountId", "StrProperty", (x) => x.u32(0))
          .prop("Platform", "ByteProperty", (x) => x.str("OnlinePlatform").str("OnlinePlatform_Dingo"))
          .str("None"),
      )
      .prop("Name", "StrProperty", (x) => x.str("Player-001"))
      .str("None"),
  )
  .prop("Id", "StrProperty", (w) => w.str("1dc15e5211f1d688fde9d79abbc6370d"))
  .prop("MatchGUID", "StrProperty", (w) => w.str("6BB2003611F1D687F049D79A9A30F5C2"))
  .prop("Date", "StrProperty", (w) => w.str("2026-11-02 06-39-12"))
  .prop("MatchType", "NameProperty", (w) => w.str("Online"))
  .str("None")
  .bytes();

describe("replay headers", () => {
  it("reads the properties, nested structs and enum bytes included", () => {
    const h = parseReplayHeader(header);
    expect(h.gameType).toBe("TAGame.Replay_Soccar_TA");
    expect(h.properties.TotalSecondsPlayed).toBe(235);
    const player = (h.properties.PlayerStats as Record<string, unknown>[])[0]!;
    expect(player.Name).toBe("Player-001");
    expect(player.PlayerID).toMatchObject({ Uid: 123, Platform: "OnlinePlatform_Dingo", NpId: { Term: 0 } });
  });

  it("gives the match GUID, the replay ID and when the match started and ended", () => {
    expect(replaySummary(parseReplayHeader(header))).toEqual({
      replayId: "1DC15E5211F1D688FDE9D79ABBC6370D",
      matchGuid: "6BB2003611F1D687F049D79A9A30F5C2",
      endedAt: Date.UTC(2026, 10, 2, 6, 39, 12),
      startedAt: 1793601254000,
      forfeit: true,
      teamSize: 3,
      numFrames: 5210,
      matchType: "Online",
      seconds: 235,
    });
  });

  it("fails clearly on a truncated file", () => {
    expect(() => parseReplayHeader(header.subarray(0, 60))).toThrow(/ends early/);
  });
});
