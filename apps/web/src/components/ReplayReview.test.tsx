import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_UI, type ApiClient, type ReplayGotoResponse, type ReviewResponse, type UiSettings } from "@rl/api-contract";
import { ApiProvider } from "../lib/api.tsx";
import { LiveStatusContext } from "../lib/live.ts";
import { ReplayReview } from "./ReplayReview.tsx";

const REPLAY = "88A6539011F1D67D7C4FE98443CC66A5";
const review = (over: Partial<ReviewResponse> = {}): ReviewResponse => ({
  replay: { replayId: REPLAY, saved: true, played: true },
  moments: [
    { id: "goal-1", kind: "goal-against", matchTime: 49, playerName: "Player-006", frame: 1223 },
    { id: "goal-2", kind: "goal-for", matchTime: 66, playerName: "Origami Box", frame: 1798 },
    { id: "goal-3", kind: "goal-against", matchTime: 89, playerName: "Player-007", frame: null },
  ],
  ...over,
});

function renderReview(
  data: ReviewResponse,
  gotoResult: ReplayGotoResponse = { ok: true, status: "loading" },
  ballchasing = false,
  live: { connected: boolean; gameConnected: boolean } | null = null,
  ui: Partial<UiSettings> | null = null,
) {
  const api = {
    ...(ui ? { config: vi.fn(async () => ({ ui: { ...DEFAULT_UI, ...ui } })) } : {}),
    settings: vi.fn(async () => ({ replayLeadSeconds: 8, canLaunchGame: false, replayAgainShortcut: "Ctrl+Alt+R", ballchasing })),
    review: vi.fn(async () => data),
    fetchReplayFromBallchasing: vi.fn(async () => ({ ok: true, replayId: REPLAY })),
    replayGoto: vi.fn(async () => gotoResult),
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ApiProvider client={api}>
      <QueryClientProvider client={queryClient}>
        <LiveStatusContext.Provider value={live}>
          <ReplayReview sessionId="m1" />
        </LiveStatusContext.Provider>
      </QueryClientProvider>
    </ApiProvider>,
  );
  return api;
}

describe("Replay review", () => {
  it("lists goals against first, and all goals on request", async () => {
    renderReview(review());
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("4:11")).toBeTruthy(); // 49 s in: 4:11 on the clock
    await userEvent.click(screen.getByRole("button", { name: /All goals/ }));
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /All goals/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("asks the game to jump to a goal with the chosen lead time, and says what happened", async () => {
    const api = renderReview(review());
    // The settings file's lead time is the default.
    await screen.findByRole("option", { name: "8 s" });
    expect((screen.getByLabelText(/Start/) as HTMLSelectElement).value).toBe("8");
    await userEvent.selectOptions(screen.getByLabelText(/Start/), "10");
    await userEvent.click(screen.getByRole("button", { name: "Watch the goal conceded at 4:11" }));
    expect(api.replayGoto).toHaveBeenCalledWith({ replayId: REPLAY, frame: 1223, leadSeconds: 10, camera: "mine", launch: false });
    await userEvent.selectOptions(screen.getByLabelText("Camera"), "director");
    await userEvent.click(screen.getByRole("button", { name: "Watch the goal conceded at 4:11" }));
    expect(api.replayGoto).toHaveBeenLastCalledWith({ replayId: REPLAY, frame: 1223, leadSeconds: 10, camera: "director", launch: false });
    expect(await screen.findByText(/Loading the replay in Rocket League/)).toHaveTextContent("It pauses after the goal; Ctrl+Alt+R goes back to the start.");
    // No frame known for this goal: nothing to jump to.
    expect((screen.getByRole("button", { name: "Watch the goal conceded at 3:31" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("with the setting to start the game, jumps from a closed game: the game starts, then the replay opens", async () => {
    const closed = { connected: true, gameConnected: false };
    const api = renderReview(review(), { ok: true, status: "launching" }, false, closed, { watchWithoutGame: "launch" });
    const watch = await screen.findByRole("button", { name: "Watch the goal conceded at 4:11" });
    await vi.waitFor(() => expect(watch).toBeEnabled());
    // No "Start Rocket League to watch" note: Watch does it.
    expect(screen.queryByText(/Start Rocket League to watch these goals/)).toBeNull();
    await userEvent.click(watch);
    expect(api.replayGoto).toHaveBeenLastCalledWith(expect.objectContaining({ frame: 1223, launch: true }));
    expect(await screen.findByText(/Starting Rocket League. The replay opens once it’s up./)).toBeTruthy();
  });

  it("keeps goal buttons disabled with the game closed by default", async () => {
    renderReview(review(), undefined, false, { connected: true, gameConnected: false });
    expect(await screen.findByRole("button", { name: "Watch the goal conceded at 4:11" })).toBeDisabled();
  });

  it("passes on why the game can't jump", async () => {
    renderReview(review(), { ok: false, reason: "you're in a match or practice" });
    await userEvent.click(await screen.findByRole("button", { name: "Watch the goal conceded at 4:11" }));
    expect(await screen.findByText("Can’t jump to it: you're in a match or practice.")).toBeTruthy();
  });

  it("explains a missing replay instead of offering buttons", async () => {
    renderReview(review({ replay: null }));
    expect(await screen.findByText(/No saved replay of this match/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Watch/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /ballchasing/ })).toBeNull();
  });

  it("gets a missing replay from ballchasing, then offers Watch", async () => {
    const api = renderReview(review({ replay: null }), undefined, true);
    const get = await screen.findByRole("button", { name: "Get it from ballchasing" });
    vi.mocked(api.review).mockResolvedValue(review());
    await userEvent.click(get);
    expect(api.fetchReplayFromBallchasing).toHaveBeenCalledWith("m1");
    // The review is fetched again and now has the replay.
    expect(await screen.findByRole("button", { name: "Watch the goal conceded at 4:11" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ballchasing/ })).toBeNull();
  });

  it("says why ballchasing didn't have it", async () => {
    const api = renderReview(review({ replay: null }), undefined, true);
    vi.mocked(api.fetchReplayFromBallchasing).mockResolvedValueOnce({ ok: false, reason: "not found on ballchasing" });
    await userEvent.click(await screen.findByRole("button", { name: "Get it from ballchasing" }));
    expect(await screen.findByText("Couldn’t get it: not found on ballchasing.")).toBeTruthy();
  });

  it("turns Watch off while Rocket League isn't running", async () => {
    renderReview(review(), undefined, false, { connected: true, gameConnected: false });
    const watch = await screen.findByRole("button", { name: "Watch the goal conceded at 4:11" });
    expect(watch).toBeDisabled();
    expect(screen.getByText(/Start Rocket League to watch these goals/)).toBeInTheDocument();
  });
});
