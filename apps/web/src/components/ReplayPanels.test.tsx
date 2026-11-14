import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@rl/api-contract";
import { day, replaysData } from "./replays.fixture.ts";
import { ApiProvider } from "../lib/api.tsx";
import { makeRouter } from "../router.tsx";

vi.mock("../lib/live.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/live.ts")>()), useLiveStatus: () => ({ connected: true, gameConnected: true }) }));

const summary = {
  matches: 3, record: { wins: 2, losses: 1, abandoned: 0 }, mvps: 0, mvpWins: 2, solo: { wins: 2, losses: 1, abandoned: 0 }, partied: { wins: 0, losses: 0, abandoned: 0 },
  byTeamSize: {}, practiceSeconds: 0, firstStartedAt: day, lastStartedAt: day + 2000, modes: [],
  filterCounts: Object.fromEntries(["all", "1", "2", "3"].map((k) => [k, { total: 3, solo: 3, party: 0 }])),
  resultCounts: { total: 3, win: 2, loss: 1, mvp: 0 },
  replayCounts: { total: 3, attention: 2, saved: 1 },
};

function renderAt(url: string) {
  const api = {
    sessions: vi.fn(async () => ({ items: [], nextCursor: null })),
    summary: vi.fn(async () => summary),
    replays: vi.fn(async () => replaysData),
    config: vi.fn(async () => { throw new Error("no config"); }),
    startBackfill: vi.fn(async () => ({ ok: true, queued: 2 })),
    fetchMissingFromBallchasing: vi.fn(async () => ({ ok: true })),
    settings: vi.fn(async () => ({ replayLeadSeconds: 10, canLaunchGame: false, replayAgainShortcut: null, ballchasing: true })),
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

describe("replays on Sessions", () => {
  it("only says something when a match is about to leave Match History, and points to Settings", async () => {
    const { router } = renderAt("/sessions?teamSize=2");
    const line = await screen.findByText(/A match is about to leave Match History without a saved replay/);
    await userEvent.click(within(line).getByRole("link", { name: "See which" }));
    expect(router.state.location.hash).toBe("settings/game");
    expect(router.state.location.search).toEqual({ teamSize: 2 });
  });
});

describe("the old Replays page", () => {
  it("sends its links to Sessions with the same filters", async () => {
    const { router } = renderAt("/replays?status=attention&result=loss");
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/sessions"));
    expect(router.state.location.search).toEqual({ replay: "attention", result: "loss" });
  });
});
