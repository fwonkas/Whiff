import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, LaunchGameResponse } from "@rl/api-contract";
import { ApiProvider } from "../lib/api.tsx";
import { makeRouter } from "../router.tsx";

// The live feed is a WebSocket; tests set its state directly.
const live = vi.hoisted(() => ({ state: { connected: true, gameConnected: false } }));
vi.mock("../lib/live.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/live.ts")>()), useLiveStatus: () => live.state }));

function renderShell({ canLaunchGame = true, result = { ok: true, status: "launching" } as LaunchGameResponse } = {}) {
  const api = {
    settings: vi.fn(async () => ({ replayLeadSeconds: 10, canLaunchGame, replayAgainShortcut: null })),
    sessions: vi.fn(async () => ({ items: [], nextCursor: null })),
    summary: vi.fn(async () => ({ matches: 0, record: { wins: 0, losses: 0, abandoned: 0 }, solo: { wins: 0, losses: 0, abandoned: 0 }, partied: { wins: 0, losses: 0, abandoned: 0 }, byTeamSize: {}, practiceSeconds: 0, firstStartedAt: null, lastStartedAt: null })),
    launchGame: vi.fn(async () => result),
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = makeRouter(queryClient, createMemoryHistory({ initialEntries: ["/sessions"] }));
  render(
    <ApiProvider client={api}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { api };
}

beforeEach(() => {
  live.state = { connected: true, gameConnected: false };
});

describe("game status in the header", () => {
  it("launches the game from the desktop app when it isn't running", async () => {
    const { api } = renderShell();
    await userEvent.click(await screen.findByRole("button", { name: /Game not running.*Launch/ }));
    expect(api.launchGame).toHaveBeenCalledOnce();
    expect(await screen.findByText("Launching Rocket League…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Launch/ })).not.toBeInTheDocument();
  });

  it("is plain text outside the desktop app", async () => {
    const { api } = renderShell({ canLaunchGame: false });
    expect(await screen.findByText("Game not running")).toBeInTheDocument();
    await vi.waitFor(() => expect(api.settings).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Launch/ })).not.toBeInTheDocument();
  });

  it("says why a launch failed and offers it again", async () => {
    renderShell({ result: { ok: false, reason: "Rocket League wasn't found in the Epic launcher or Steam" } });
    await userEvent.click(await screen.findByRole("button", { name: /Launch/ }));
    expect(await screen.findByText("Couldn’t launch: Rocket League wasn't found in the Epic launcher or Steam.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Launch/ })).toBeInTheDocument();
  });

});
