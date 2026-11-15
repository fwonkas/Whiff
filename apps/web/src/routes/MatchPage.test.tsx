import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { ApiClient, DetailPlayer, ReplayAnalysisResponse, SessionDetailResponse } from "@rl/api-contract";
import { analyzeReplay, type SubtrExtract } from "@rl/metrics";
import { ApiProvider } from "../lib/api.tsx";
import { makeRouter } from "../router.tsx";

vi.mock("../lib/live.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/live.ts")>()), useLiveStatus: () => ({ connected: true, gameConnected: false }) }));

const player = (over: Partial<DetailPlayer>): DetailPlayer => ({
  key: "k",
  name: "n",
  team: 0,
  isMe: false,
  isBot: false,
  isKnownTeammate: false,
  joinedAt: null,
  leftAt: null,
  score: 0,
  goals: 0,
  shots: 0,
  assists: 0,
  saves: 0,
  touches: 0,
  demos: 0,
  ...over,
});
const touch = (matchTime: number, owner: "me" | "teammate" | "opponent", x: number, y: number) => ({ at: matchTime * 1000, matchTime, owner, playerKey: owner, x, y, z: 93, postSpeed: 60 });

const detail: SessionDetailResponse = {
  session: {
    id: "m1", kind: "match", startedAt: Date.UTC(2026, 9, 21, 1, 19), durationSeconds: 481, playlistId: 11, playlistName: "Ranked Doubles",
    arena: "NeoTokyo_Arcade_P", outcome: "win", goalsFor: 2, goalsAgainst: 1, overtime: true, forfeit: false, leftSettled: false, teammatesLeft: false, source: "live", partied: true,
    queueWarmup: false, gameSpeed: null, gameSpeedSource: null, me: { score: 700, goals: 2, shots: 4, assists: 0, saves: 1, touches: 40, demos: 0, team: 1 },
    touchShare: 0.55, mvp: true, replay: null, teammates: ["Pat"], pack: null, playSessionId: null, note: null, endedAt: 0, pausedSeconds: 0,
  },
  players: [
    player({ key: "me", name: "Me", team: 1, isMe: true, score: 700, goals: 2 }),
    player({ key: "mate", name: "Pat", team: 1, isKnownTeammate: true, score: 300 }),
    player({ key: "o1", name: "Rival", team: 0, score: 500, goals: 1 }),
    player({ key: "o2", name: "Dropin", team: 0, score: 100, joinedAt: 5 }),
  ],
  goals: [
    { matchTime: 40, forUs: false, scorerName: "Rival", assisterName: null, speedKmh: 90.4, x: 0, y: -5200, z: 100, locationReliable: true },
    { matchTime: 200, forUs: true, scorerName: "Me", assisterName: "Pat", speedKmh: 70, x: 0, y: 5200, z: 100, locationReliable: true },
    { matchTime: 320, forUs: true, scorerName: "Me", assisterName: null, speedKmh: 110, x: 0, y: 5200, z: 100, locationReliable: true },
  ],
  touches: [touch(30, "opponent", 0, 0), touch(38, "opponent", 100, -4000), touch(195, "teammate", 0, 3000), touch(199, "me", 0, 4500), touch(250, "me", 0, 0)],
  statEvents: [{ matchTime: 320, eventName: "MVP", label: "MVP", playerName: "Me" }],
  cars: [],
  boostPickups: [],
  metrics: { teamSize: 2 } as SessionDetailResponse["metrics"],
  practice: null,
  replay: null,
  neighbors: {
    previous: { id: "m0", startedAt: Date.UTC(2026, 9, 21, 1, 10), playlistId: 11, playlistName: "Ranked Doubles", outcome: "loss", goalsFor: 1, goalsAgainst: 3 },
    next: null,
  },
};

function renderMatch(analysis: ReplayAnalysisResponse = { state: "no-replay" }, d: SessionDetailResponse = detail) {
  const api = {
    session: vi.fn(async () => d),
    review: vi.fn(async () => ({ replay: null, moments: [] })),
    analysis: vi.fn(async () => analysis),
    replayGoto: vi.fn(async () => ({ ok: true, status: "seeking" })),
    settings: vi.fn(async () => ({ replayLeadSeconds: 10, canLaunchGame: false, replayAgainShortcut: null, ballchasing: false })),
  } as unknown as ApiClient;
  liveApi = api;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = makeRouter(queryClient, createMemoryHistory({ initialEntries: ["/sessions/m1"] }));
  liveRouter = router;
  render(
    <ApiProvider client={api}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiProvider>,
  );
}

let liveApi: ApiClient;
let liveRouter: ReturnType<typeof makeRouter>;

/** The analysis of a real ranked 2s replay (anonymized), as the collector stores it. */
const realAnalysis = () =>
  analyzeReplay(JSON.parse(gunzipSync(readFileSync(`${process.cwd()}/fixtures/ranked-2s-replay.subtr.json.gz`)).toString()) as SubtrExtract);

describe("a match I left early", () => {
  const left = { ...detail, session: { ...detail.session, outcome: "abandoned" as const, goalsFor: 0, goalsAgainst: 3, mvp: false } };

  it("can be counted as the result its score shows", async () => {
    renderMatch(undefined, left);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Left early 0–3");
    const patchSession = vi.fn(async () => ({ ...left.session, outcome: "loss", leftSettled: true }));
    Object.assign(liveApi, { patchSession });
    await userEvent.click(screen.getByRole("button", { name: "Count it as a loss" }));
    expect(patchSession).toHaveBeenCalledWith("m1", { leftSettled: true });
    expect(screen.getByRole("button", { name: "About leaving early" })).toBeInTheDocument();
  });

  it("once counted, says so and can go back", async () => {
    renderMatch(undefined, { ...left, session: { ...left.session, outcome: "loss", leftSettled: true } });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Loss 0–3");
    expect(screen.getByText(/after the result was settled, so it counts as a loss/)).toBeInTheDocument();
    const patchSession = vi.fn(async () => left.session);
    Object.assign(liveApi, { patchSession });
    await userEvent.click(screen.getByRole("button", { name: "Count as left early" }));
    expect(patchSession).toHaveBeenCalledWith("m1", { leftSettled: false });
  });

  it("after all my teammates had left, it counts by itself and says why", async () => {
    renderMatch(undefined, { ...left, session: { ...left.session, outcome: "loss", teammatesLeft: true } });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Loss 0–3");
    expect(screen.getByText(/after all your teammates had, so it counts as a loss/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Count/ })).toBeNull();
  });

  it("isn't offered for a tied score or a match played to the end", async () => {
    renderMatch(undefined, { ...left, session: { ...left.session, goalsAgainst: 0 } });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: /Count it as/ })).toBeNull();
  });
});

describe("deleting a match", () => {
  it("is at the bottom of the match page, asks first, says what it removes, then goes back to Sessions", async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    renderMatch();
    (liveApi as unknown as { deleteSession: unknown }).deleteSession = vi.fn(async () => null);
    const button = await screen.findByRole("button", { name: "Delete match…" });
    await userEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Delete this match?" });
    expect(dialog).toHaveTextContent("This can’t be undone.");
    expect(dialog).toHaveTextContent("The raw recording and the replay file stay where they are.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(liveApi.deleteSession).not.toHaveBeenCalled();
    await userEvent.click(button);
    await userEvent.click(within(screen.getByRole("dialog", { name: "Delete this match?" })).getByRole("button", { name: "Delete match" }));
    expect(liveApi.deleteSession).toHaveBeenCalledWith("m1");
    await vi.waitFor(() => expect(liveRouter.state.location.pathname).toBe("/sessions"));
  });
});

describe("Match screen", () => {
  it("shows positioning, boost and challenges from the replay, and my moments to review", async () => {
    const a = realAnalysis();
    const named = new Map([["Epic|me|0", "Me"]]);
    const replayPlayers = a.players.map((p) =>
      player({ key: p.primaryId, name: named.get(p.primaryId) ?? p.name, team: p.team, isMe: p.primaryId === "Epic|me|0" }),
    );
    renderMatch({ state: "ready", replayId: "A5117F9A11F1D8C27ABA478AE3DA7507", analysis: a }, { ...detail, players: replayPlayers });
    const section = await screen.findByRole("region", { name: "Positioning, boost and challenges" });
    const table = within(section).getByRole("table");
    const meRow = within(table).getByRole("row", { name: /^Me ?\(you\)/ });
    // Back, 1st man, avg boost, empty, big pads, wasted, 50/50, races, whiffs.
    expect(within(meRow).getAllByRole("cell").map((c) => c.textContent)).toEqual(["54%", "37%", "54", "8%", "13", "444", "4–1", "2–7", "11"]);
    expect(within(table).getAllByRole("rowheader")[0]).toHaveTextContent("Your team");

    const moments = within(section).getByRole("list");
    const items = within(moments).getAllByRole("listitem");
    expect(items).toHaveLength(7 + 1 + 1 + 11 + 2); // beaten, lost 50/50, demoed, whiffs, conceded as last back
    expect(items[0]).toHaveTextContent("5:00Whiffed");
    await userEvent.click(within(section).getByRole("button", { name: /^All/ }));
    expect(within(moments).getAllByRole("listitem").length).toBeGreaterThan(items.length);
  });

  it("says when the replay waits to be analyzed, and leaves the card out without a replay", async () => {
    renderMatch({ state: "pending", replayId: "A5117F9A11F1D8C27ABA478AE3DA7507" });
    expect(await screen.findByText(/waiting to be analyzed/)).toBeInTheDocument();
  });

  it("shows the scoreboard my team first, with MVP and tags", async () => {
    renderMatch();
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    const names = rows.map((r) => within(r).queryAllByRole("rowheader")[0]?.textContent ?? "");
    expect(names.filter(Boolean)).toEqual([expect.stringMatching(/^Your team/), expect.stringMatching(/^Me \(you\)MVP/), "PatTeammate", expect.stringMatching(/^Opponents/), "Rival", "DropinJoined late"]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Win 2–1 in overtimeMVP");
  });

  it("marks no MVP in 1s, where the winner always is", async () => {
    const me = detail.players.find((p) => p.isMe)!;
    const rival = detail.players.find((p) => p.name === "Rival")!;
    renderMatch(undefined, {
      ...detail,
      session: { ...detail.session, mvp: false },
      players: [me, rival],
      metrics: { ...detail.metrics, teamSize: 1 } as SessionDetailResponse["metrics"],
    });
    const table = await screen.findByRole("table");
    expect(within(table).queryByText("MVP")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveTextContent("MVP");
  });

  it("lists goals with the running score, and shows a goal's build-up on the touch map", async () => {
    renderMatch();
    const goals = await screen.findByRole("region", { name: "Goals" });
    const buttons = within(goals).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      expect.stringContaining("4:20Conceded · Rival"),
      expect.stringContaining("1:40Scored · Me, assist Pat"),
      expect.stringContaining("+0:20Scored · Me"),
    ]);
    expect(buttons[2]).toHaveTextContent("110 km/h · 2–1");

    const map = screen.getByRole("img", { name: /5 touches on the field/ });
    expect(map).toBeInTheDocument();
    await userEvent.click(buttons[1]!);
    expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Build-up to the goal at 1:40" })).toBeInTheDocument();
    // Only the 12 seconds before it: the teammate's touch and mine.
    expect(screen.getByRole("img", { name: /2 touches before the goal/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all touches" }));
    expect(screen.getByRole("img", { name: /5 touches on the field/ })).toBeInTheDocument();
  });

  it("filters the map by whose touches", async () => {
    renderMatch();
    await userEvent.click(await screen.findByRole("button", { name: /Opponents 2/ }));
    expect(screen.getByRole("img", { name: /3 touches on the field/ })).toBeInTheDocument();
  });

  it("links to the match before, and says there's none after", async () => {
    renderMatch();
    const nav = await screen.findByRole("navigation", { name: "Matches" });
    expect(within(nav).getByRole("link", { name: /^Previous: .*L 1–3$/ })).toHaveAttribute("href", "/sessions/m0");
    expect(within(nav).getByText("Next ›")).toHaveAttribute("aria-disabled", "true");
  });
});
