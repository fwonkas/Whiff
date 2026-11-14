import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_UI, type ApiClient, type ConfigPatch, type ConfigResponse } from "@rl/api-contract";
import { ApiProvider } from "../lib/api.tsx";
import { makeRouter } from "../router.tsx";

const GUESS = "Epic|guess|0";
const ME = "Epic|me|0";

function renderWith(meConfirmed: boolean) {
  let config = {
    editable: true,
    myPrimaryIds: [GUESS],
    me: [{ primaryId: GUESS, name: "Couch Friend" }],
    meConfirmed,
    knownTeammates: [],
    ui: DEFAULT_UI,
  } as unknown as ConfigResponse;
  const api = {
    sessions: vi.fn(async () => ({ items: [], nextCursor: null })),
    summary: vi.fn(async () => null),
    config: vi.fn(async () => config),
    meCandidates: vi.fn(async () => [
      { primaryId: ME, name: "Origami Box" },
      { primaryId: "Epic|other|0", name: "Opponent" },
    ]),
    patchConfig: vi.fn(async (p: ConfigPatch) => {
      config = { ...config, ...p } as ConfigResponse;
      return { ok: true, config };
    }),
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
  return api;
}

describe("confirming my player", () => {
  it("asks once after the app picked the player, and goes away on Yes", async () => {
    const api = renderWith(false);
    const banner = await screen.findByRole("region", { name: /Recording you as Couch Friend/ });
    expect(banner).toHaveTextContent("Recording you as Couch Friend (Epic). Is that you?");
    await userEvent.click(screen.getByRole("button", { name: "Yes, that’s me" }));
    expect(api.patchConfig).toHaveBeenCalledWith({ meConfirmed: true });
    expect(banner).not.toBeInTheDocument();
  });

  it("offers the other players from that session when it's not me", async () => {
    const api = renderWith(false);
    await userEvent.click(await screen.findByRole("button", { name: "Not me" }));
    expect(screen.getByRole("button", { name: "Not me" })).toHaveAttribute("aria-expanded", "true");
    const pick = await screen.findByRole("button", { name: /^Origami Box/ });
    expect(pick).toHaveTextContent("Origami Box (Epic)");
    await userEvent.click(pick);
    expect(api.patchConfig).toHaveBeenCalledWith({ myPrimaryIds: [ME], meConfirmed: true });
  });

  it("stays out of the way once confirmed", async () => {
    const api = renderWith(true);
    await vi.waitFor(() => expect(api.config).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: /Recording you as/ })).not.toBeInTheDocument();
  });
});
