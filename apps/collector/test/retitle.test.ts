import { describe, expect, it } from "vitest";
import { pacedFetch, planRetitle, type RetitleLookup } from "../src/retitle.ts";

const G = "A1B2C3D4E5F60718293A4B5C6D7E8F90";
const R = "11F1D0153A9E8C40B2D1E7A1AAAAAAAA";
const start = new Date(2026, 10, 14, 20, 13, 20).getTime(); // this PC's time zone
const known: RetitleLookup = { guidOf: (id) => (id === R ? G : null), playlist: (g) => (g === G ? 11 : null), start: (g) => (g === G ? start : null) };
const none: RetitleLookup = { guidOf: () => null, playlist: () => null, start: () => null };

describe("retitling uploads already on ballchasing", () => {
  it("uses Whiff's own record of the match: its playlist and start", () => {
    expect(planRetitle({ id: "bc-1", rocket_league_id: R.toLowerCase(), replay_title: "game", playlist_name: "Something Else" }, known)).toEqual({
      id: "bc-1",
      from: "game",
      to: "Ranked Doubles 2026-11-14 20:13",
    });
  });

  it("falls back to what ballchasing parsed: its playlist name, and its date less the match's length", () => {
    const end = new Date(2026, 10, 14, 20, 19, 30);
    const item = { id: "bc-2", replay_title: "game", playlist_name: "Ranked Standard", date: end.toISOString(), duration: 360 };
    expect(planRetitle(item, none)).toEqual({ id: "bc-2", from: "game", to: "Ranked Standard 2026-11-14 20:13" });
    expect(planRetitle({ id: "bc-3", match_type: "Private", date: end.toISOString(), duration: 360 }, none)?.to).toBe("Private Match 2026-11-14 20:13");
  });

  it("skips ones that already have the title, or with too little to go on", () => {
    expect(planRetitle({ id: "bc-4", rocket_league_id: R, replay_title: "Ranked Doubles 2026-11-14 20:13" }, known)).toBeNull();
    expect(planRetitle({ id: "bc-5", replay_title: "game" }, none)).toBeNull();
  });

  it("paces requests to the rate limit", async () => {
    const waits: number[] = [];
    let calls = 0;
    const f = pacedFetch(720, (async () => (calls++, new Response())) as typeof fetch, async (ms) => void waits.push(ms), () => 1_000);
    await Promise.all([f("a"), f("b"), f("c")]);
    expect(calls).toBe(3);
    // The first goes now; the next ones wait their turn, 720 ms apart.
    expect(waits).toEqual([720, 1440]);
  });
});
