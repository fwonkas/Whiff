import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_UI, type ApiClient, type SessionListItem, type SummaryResponse, type UiSettings } from "@rl/api-contract";
import { ApiProvider } from "../lib/api.tsx";
import { makeRouter } from "../router.tsx";
import { groupByDay } from "./SessionsPage.tsx";

/**
 * The pattern for screen tests: a fake API client (just the methods the
 * screen calls), a memory history at the screen's URL, and assertions on what
 * a person sees and can do.
 */

// The game's status as the app shell shares it; null until known.
let liveStatus: { gameConnected: boolean } | null = null;
vi.mock("../lib/live.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/live.ts")>()), useSharedLiveStatus: () => liveStatus }));

const day = new Date(2026, 9, 21, 20, 0).getTime();
const match = (over: Partial<SessionListItem>): SessionListItem => ({
  id: "m1",
  kind: "match",
  startedAt: day,
  durationSeconds: 420,
  playlistId: 11,
  playlistName: "Ranked Doubles",
  arena: "NeoTokyo_Arcade_P",
  outcome: "loss",
  goalsFor: 3,
  goalsAgainst: 4,
  overtime: true,
  forfeit: false,
  leftSettled: false,
  teammatesLeft: false,
  source: "live",
  partied: true,
  queueWarmup: false,
  gameSpeed: null,
  gameSpeedSource: null,
  me: { score: 276, goals: 0, assists: 1, saves: 1, shots: 0, touches: 38, demos: 2, team: 1 },
  touchShare: 0.56,
  mvp: false,
  replay: { state: "saved", replayId: "A".repeat(32), played: false, history: null, notOnBallchasing: false },
  teammates: ["Pat"],
  pack: null,
  playSessionId: null,
  ...over,
});

const items: SessionListItem[] = [
  match({
    id: "m2",
    startedAt: day + 600_000,
    outcome: "win",
    goalsFor: 5,
    goalsAgainst: 3,
    overtime: false,
    teammates: ["Pat"],
    // Not recorded live, and its replay played through only at 2x.
    replay: { state: "saved", replayId: "B".repeat(32), played: true, playedFast: true, history: null, notOnBallchasing: false },
  }),
  match({ id: "m1" }),
  match({ id: "p1", kind: "freeplay", startedAt: day - 900_000, durationSeconds: 840, playlistId: 9, outcome: null, me: null, touchShare: null, teammates: [] }),
];

const summary: SummaryResponse = {
  matches: 2,
  record: { wins: 1, losses: 1, abandoned: 0 },
  mvps: 1,
  mvpWins: 1,
  stats: {
    decided: 2,
    perMatch: {
      goals: { mean: 1.5, median: 1.5 },
      assists: { mean: 0.5, median: 0.5 },
      saves: { mean: 1, median: 1 },
      shots: { mean: 2.5, median: 2.5 },
      score: { mean: 376, median: 376 },
      touchShare: { mean: 0.42, median: 0.42 },
    },
    overtime: { matches: 1, wins: 0, losses: 1 },
    margins: { oneGoal: 1, wonByOne: 0, lostByOne: 1, meanDiff: 0.5 },
  },
  replayStats: {
    matches: 1,
    of: 2,
    perMatch: { boost: { mean: 43.4, median: 43.4 }, boostEmpty: { mean: 0.137, median: 0.137 }, lastBack: { mean: 0.532, median: 0.532 } },
    fifties: { won: 6, lost: 4, even: 2 },
    races: { won: 3, lost: 5 },
  },
  solo: { wins: 0, losses: 0, abandoned: 0 },
  partied: { wins: 1, losses: 1, abandoned: 0 },
  byTeamSize: { "2": { wins: 1, losses: 1, abandoned: 0 } },
  practiceSeconds: 840,
  firstStartedAt: day,
  lastStartedAt: day + 600_000,
  filterCounts: { all: { total: 3, solo: 1, party: 2 }, "1": { total: 0, solo: 0, party: 0 }, "2": { total: 2, solo: 0, party: 2 }, "3": { total: 1, solo: 1, party: 0 } },
  modes: [{ playlistId: 34, name: "Tournament", matches: 1 }, { playlistId: 30, name: "Ranked Snow Day", matches: 2 }],
  resultCounts: { total: 2, win: 1, loss: 1, mvp: 0 },
  replayCounts: { total: 2, attention: 1, saved: 1 },
};

function renderAt(url: string, ui?: Partial<UiSettings>, sum: SummaryResponse = summary) {
  const api = {
    sessions: vi.fn(async () => ({ items, nextCursor: null })),
    summary: vi.fn(async () => sum),
    ...(ui ? { config: vi.fn(async () => ({ ui: { ...DEFAULT_UI, ...ui } })) } : {}),
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = makeRouter(queryClient, createMemoryHistory({ initialEntries: [url] }));
  render(
    <ApiProvider client={api}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { api, router };
}

describe("Sessions screen", () => {
  it("shows only the cards that say something about the listed matches", async () => {
    renderAt("/sessions");
    const cards = await screen.findByRole("region", { name: "Summary" });
    // No solo matches here, so the solo-against-teammates card would say nothing: left out.
    const record = within(cards).getByText("Record").closest(".card") as HTMLElement;
    expect(record).toHaveTextContent("1–1");
    // Win rate as the list's W pill, MVP share of the wins as its MVP badge.
    expect(within(record).getByText("50% won")).toHaveAttribute("data-outcome", "win");
    expect(within(record).getByText("100% MVP")).toHaveClass("mvp");
    expect(within(cards).queryByText(/Solo/)).toBeNull();
    expect(within(cards).getByText("Practice")).toBeInTheDocument();
  });

  it("leaves the MVP share out when the wins are all 1s (no MVP there)", async () => {
    renderAt("/sessions", undefined, { ...summary, mvps: 0, mvpWins: 0 });
    const cards = await screen.findByRole("region", { name: "Summary" });
    const record = within(cards).getByText("Record").closest(".card") as HTMLElement;
    expect(within(record).getByText("50% won")).toBeInTheDocument();
    expect(within(record).queryByText(/MVP/)).toBeNull();
  });

  it("adds close games and a per-match table, and adapts the record to the result picked", async () => {
    renderAt("/sessions");
    const cards = await screen.findByRole("region", { name: "Summary" });
    const close = within(cards).getByText("Close games").closest(".card") as HTMLElement;
    expect(close).toHaveTextContent("50%");
    // One fact per line with short hover text; the label's longer explanation is behind "?" (never both on one text).
    expect(within(close).getByText("Close games")).not.toHaveAttribute("title");
    expect(within(close).getByText("Goal margin +0.5")).toHaveAttribute("title", "Your team’s goals minus the other team’s, averaged over the 2 matches");
    expect(within(close).getByText("OT: 50% (0–1)")).toHaveAttribute("title", "1 of 2 matches went to overtime: you won 0 and lost 1");
    expect(within(close).getByRole("button", { name: "About Close games" })).toBeInTheDocument();
    const table = within(within(cards).getByText("Per match").closest(".card") as HTMLElement).getByRole("table");
    // Mean and median columns, and the one "mean/median" column phones show instead (CSS picks).
    const cells = (name: RegExp) => within(within(table).getByRole("row", { name })).getAllByRole("cell").map((c) => c.textContent);
    expect(cells(/Goals/)).toEqual(["1.5", "1.5", "1.5/1.5"]);
    expect(cells(/Score/)).toEqual(["376", "376", "376/376"]);
    expect(cells(/Touch share/)).toEqual(["42%", "42%", "42%/42%"]);
  });

  it("adds what the analyzed replays say, and how many matches that is", async () => {
    renderAt("/sessions");
    const cards = await screen.findByRole("region", { name: "Summary" });
    const card = within(cards).getByText("From replays").closest(".card") as HTMLElement;
    const cells = (name: RegExp) => within(within(card).getByRole("row", { name })).getAllByRole("cell").map((c) => c.textContent);
    expect(cells(/Average boost/)).toEqual(["43", "43", "43/43"]);
    expect(cells(/No boost/)).toEqual(["14%", "14%", "14%/14%"]);
    expect(cells(/Last back/)).toEqual(["53%", "53%", "53%/53%"]);
    expect(card).toHaveTextContent("50/50s won 60% (6–4)");
    expect(card).toHaveTextContent("Races won 38% (3–5)");
    expect(card).toHaveTextContent("From 1 of 2 matches");
    expect(within(card).getByRole("button", { name: "About From replays" })).toBeInTheDocument();
    cleanup();
    // None analyzed: no card.
    renderAt("/sessions", undefined, { ...summary, replayStats: { ...summary.replayStats, matches: 0 } });
    expect(within(await screen.findByRole("region", { name: "Summary" })).queryByText("From replays")).toBeNull();
  });

  it("under Wins, the record card counts wins and keeps the MVP share; under Losses, the close ones", async () => {
    renderAt("/sessions?result=win");
    let cards = await screen.findByRole("region", { name: "Summary" });
    const wins = within(cards).getByText("Wins").closest(".card") as HTMLElement;
    expect(wins).not.toHaveTextContent("won");
    expect(within(wins).getByText("100% MVP")).toHaveClass("mvp");
    cleanup();
    renderAt("/sessions?result=loss");
    cards = await screen.findByRole("region", { name: "Summary" });
    expect(within(cards).getByText("Losses").closest(".card")).toHaveTextContent("1 by one goal");
    expect(within(cards).getByText("Close games").closest(".card")).toHaveTextContent("ended in a loss by one goal: 1 of them");
  });

  it("compares solo and teammate win rates in one card", async () => {
    summary.solo = { wins: 1, losses: 3, abandoned: 0 };
    try {
      renderAt("/sessions");
      const card = (await screen.findByText("Solo · With teammates")).closest(".card") as HTMLElement;
      // One rate per line, each named, then the records.
      expect(card).toHaveTextContent("Solo25%Teammates50%");
      expect(card).toHaveTextContent("won 1–3 solo1–1 with teammates");
    } finally {
      summary.solo = { wins: 0, losses: 0, abandoned: 0 };
    }
  });

  it("drops the Practice card under a filter that lists only matches, and asks for every filter", async () => {
    const { api } = renderAt("/sessions?teamSize=2&result=win");
    const cards = await screen.findByRole("region", { name: "Summary" });
    expect(within(cards).queryByText("Practice")).toBeNull();
    expect(api.summary).toHaveBeenLastCalledWith(expect.objectContaining({ teamSize: 2, result: "win" }));
  });

  it("filters by dates, both ends included, and keeps them in the URL", async () => {
    const { api, router } = renderAt("/sessions");
    await screen.findByRole("region", { name: "Summary" });
    // jsdom has no popover support, so the form counts as hidden there.
    fireEvent.change(screen.getByLabelText("From", { selector: "input" }), { target: { value: "2026-10-20" } });
    await vi.waitFor(() => expect(router.state.location.search).toEqual({ from: "2026-10-20" }));
    fireEvent.change(screen.getByLabelText("To", { selector: "input" }), { target: { value: "2026-10-21" } });
    await vi.waitFor(() => expect(router.state.location.search).toEqual({ from: "2026-10-20", to: "2026-10-21" }));
    expect(router.state.location.search).toEqual({ from: "2026-10-20", to: "2026-10-21" });
    const chip = within(screen.getByRole("group", { name: "Dates" })).getAllByRole("button", { hidden: true })[0]!;
    await vi.waitFor(() => expect(chip).toHaveTextContent("Oct 20 – Oct 21"));
    expect(chip).toHaveAttribute("aria-current", "page");
    expect(api.sessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ since: new Date(2026, 9, 20).getTime(), until: new Date(2026, 9, 22).getTime() }),
    );
  });

  it("can hide the Replay column and Watch buttons while the game isn't running", async () => {
    liveStatus = { gameConnected: false };
    try {
      renderAt("/sessions", { hideReplayControlsWithoutGame: true });
      await screen.findByRole("heading", { level: 2 });
      await vi.waitFor(() => expect(screen.queryAllByRole("button", { name: /^Watch the replay/ })).toHaveLength(0));
      expect(screen.getByRole("region", { name: "Matches" })).toHaveAttribute("data-no-replay");
    } finally {
      liveStatus = null;
    }
  });

  it("marks Watch for a replay played through only too fast, when Settings → Advanced asks", async () => {
    renderAt("/sessions", { markFastPlaybacks: true });
    const fast = await screen.findByRole("button", { name: /a few touches are missing/ });
    expect(fast).toHaveAttribute("data-fast");
    expect(screen.getAllByRole("button", { name: /^Watch the replay/ }).filter((b) => b.hasAttribute("data-fast"))).toHaveLength(1);
  });

  it("groups matches by day with the day's record and practice time", async () => {
    renderAt("/sessions");
    const dayHeading = await screen.findByRole("heading", { level: 2 });
    expect(dayHeading).toHaveTextContent("2 matches · 1–1 · 14 min practice");

    const rows = within(screen.getByRole("region", { name: "Matches" })).getAllByRole("link");
    expect(rows).toHaveLength(2); // practice isn't listed as a row
    expect(rows[0]).toHaveTextContent("W");
    expect(rows[1]).toHaveTextContent("L");
    expect(rows[1]).toHaveTextContent("OT: overtime");
    // Each match with a saved replay can open it in the game.
    expect(screen.getAllByRole("button", { name: /^Watch the replay of the .* match/ })).toHaveLength(2);
    expect(rows[1]).toHaveAttribute("href", "/sessions/m1");
  });

  it("filter chips update the URL and the query", async () => {
    const { api, router } = renderAt("/sessions");
    await screen.findByRole("heading", { level: 2 });

    expect(screen.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");
    // Teammates and result are dropdown chips named after the current choice.
    const teammates = screen.getByRole("button", { name: /^Teammates:\s*Anyone$/ });
    expect(teammates).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /^Anyone/, hidden: true })).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("link", { name: "2s" }));

    expect(router.state.location.search).toEqual({ teamSize: 2 });
    expect(screen.getByRole("link", { name: "2s" })).toHaveAttribute("aria-current", "page");
    // Only one chip per group is current: "All" isn't any more, "Anyone" still is.
    expect(screen.getByRole("link", { name: "All" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /^Anyone/, hidden: true })).toHaveAttribute("aria-current", "page");
    expect(api.sessions).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "match", teamSize: 2 }));

    // Tournaments have a chip; the rarer modes are under Other, which then names the one picked.
    expect(screen.getByRole("link", { name: "Tournaments" })).not.toHaveAttribute("aria-current");
    const other = screen.getByRole("button", { name: "Other" });
    await userEvent.click(other);
    // jsdom has no popover support, so the list counts as hidden there.
    await userEvent.click(screen.getByRole("link", { name: /^Snow Day/, hidden: true }));
    expect(router.state.location.search).toEqual({ playlist: 30 });
    expect(api.sessions).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "match", playlist: 30, teamSize: undefined }));
    expect(other).toHaveTextContent("Snow Day");
    expect(other).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("link", { name: /^Wins/, hidden: true }));
    expect(router.state.location.search).toEqual({ playlist: 30, result: "win" });
    expect(api.sessions).toHaveBeenLastCalledWith(expect.objectContaining({ result: "win" }));
    expect(screen.getByRole("button", { name: /^Result:\s*Wins$/ })).toHaveAttribute("aria-current", "page");
    // No MVPs among these matches: off, with the reason.
    expect(screen.queryByRole("link", { name: /^MVP/, hidden: true })).toBeNull();
    expect(screen.getByText("MVP", { selector: "[aria-disabled] *, [aria-disabled]" }).closest("[aria-disabled]")).toHaveAttribute("title", "None here");

    // Another mode chip turns Other back into "Other".
    await userEvent.click(screen.getByRole("link", { name: "Tournaments" }));
    expect(router.state.location.search).toEqual({ playlist: 34, result: "win" });
    expect(screen.getByRole("button", { name: "Other" })).not.toHaveAttribute("aria-current");
  });

  it("explains an empty filtered list", async () => {
    const { api } = renderAt("/sessions?with=solo");
    vi.mocked(api.sessions).mockResolvedValue({ items: [], nextCursor: null });
    expect(await screen.findByText(/No matches for these filters/)).toBeInTheDocument();
  });
});

describe("filter chips that would change nothing", () => {
  it("turn off where they'd show nothing or everything, and a team size drops a teammate filter that no longer applies", async () => {
    // Counts: 2s are all with a teammate, the one 3s is solo, no 1s.
    const { router } = renderAt("/sessions?with=party");
    await screen.findByRole("heading", { level: 2 });
    // No 1s at all: off.
    const one = screen.getByText("1s", { selector: ".chip" });
    expect(one).toHaveAttribute("aria-disabled", "true");
    expect(one).toHaveAttribute("title", "No 1s matches");
    // 3s has no matches with a teammate, so choosing it drops "With teammates".
    await userEvent.click(screen.getByRole("link", { name: "3s" }));
    expect(router.state.location.search).toEqual({ teamSize: 3 });
    expect(screen.getByRole("button", { name: /^Teammates:\s*Anyone$/ })).toBeInTheDocument();
    // In 3s, Solo is everything and With teammates is nothing: both off in the menu.
    const off = (label: string) => screen.getByText(label, { selector: "[aria-disabled]" });
    expect(off("Solo")).toHaveAttribute("title", "Same as Anyone here");
    expect(off("With teammates")).toHaveAttribute("title", "No matches with a known teammate here");
    expect(screen.queryByRole("link", { name: /Solo|With teammates/, hidden: true })).toBeNull();
  });
});

describe("Sessions columns", () => {
  it("leave out time and arena by default and show my score, while the row still names the match", async () => {
    renderAt("/sessions");
    await screen.findByRole("heading", { level: 2 });
    const row = within(screen.getByRole("region", { name: "Matches" })).getAllByRole("link")[1]!;
    expect(row).not.toHaveTextContent("PM");
    expect(row).not.toHaveTextContent("Neo Tokyo");
    expect(row).toHaveTextContent("276");
    expect(row).toHaveAccessibleName(/^8:00 PM, Ranked 2s, L 3–4 in overtime$/);
  });

  it("follow the settings file's choice", async () => {
    renderAt("/sessions", { sessionsColumns: ["time", "arena", "result"] });
    await vi.waitFor(() => expect(within(screen.getByRole("region", { name: "Matches" })).getAllByRole("link")[1]).toHaveTextContent("Neo Tokyo"));
    const row = within(screen.getByRole("region", { name: "Matches" })).getAllByRole("link")[1]!;
    expect(row).toHaveTextContent("8:00 PM");
    expect(row).not.toHaveTextContent("276");
  });
});

describe("groupByDay", () => {
  it("drops days with only practice", () => {
    expect(groupByDay([items[2]!])).toEqual([]);
  });
});
