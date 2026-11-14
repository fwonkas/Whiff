import { describe, expect, it } from "vitest";
import { arenaName, formatClock } from "./format.ts";

describe("arenaName", () => {
  it("maps asset names regardless of case", () => {
    expect(arenaName("FF_Dusk_P")).toBe("Estadio Vida");
    expect(arenaName("eurostadium_snownight_p")).toBe("Mannfield (Snowy)");
    expect(arenaName("Underwater_GRS_P")).toBe("AquaDome (Salty Shallows)");
    expect(arenaName("Wasteland_GRS_P")).toBe("Wasteland (Pitched)");
  });
  it("cleans up unknown assets", () => {
    expect(arenaName("Labs_Octagon_P")).toBe("Labs Octagon");
  });
});

describe("formatClock", () => {
  it("shows regulation counting down and overtime counting up", () => {
    expect(formatClock(3)).toBe("4:57");
    expect(formatClock(343)).toBe("+0:43");
  });
});
