import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_UI, DEFAULT_UPLOAD_RULES, type ApiClient, type AppUpdateResponse, type ConfigPatch, type ConfigResponse, type ReplaysResponse } from "@rl/api-contract";
import { ApiProvider } from "../lib/api.tsx";
import { makeRouter } from "../router.tsx";
import { replaysData } from "./replays.fixture.ts";
import { acceleratorFor } from "./SettingsDialog.tsx";

vi.mock("../lib/live.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/live.ts")>()), useLiveStatus: () => ({ connected: true, gameConnected: false }) }));

// jsdom has <dialog> without showModal.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

const config: ConfigResponse = {
  editable: true,
  desktop: true,
  myPrimaryIds: ["Epic|me|0"],
  me: [{ primaryId: "Epic|me|0", name: "Me" }],
  meConfirmed: true,
  knownTeammates: [],
  dataDir: "C:\\data",
  replayDirs: ["C:\\replays"],
  replayDirsCustom: false,
  practiceGameSpeed: 0.85,
  matchHistoryWarn: 5,
  replayLeadSeconds: 10,
  recordCasual: false,
  addresses: { thisPc: "http://localhost:49200", network: ["http://rocketleague.local:49200", "http://192.168.1.20:49200"] },
  ballchasingUpload: true,
  ballchasingUploads: DEFAULT_UPLOAD_RULES,
  ballchasingTokenSet: false,
  shortcuts: { backfill: "CommandOrControl+Alt+B", pause: "CommandOrControl+Alt+P", dashboard: "CommandOrControl+Alt+D", replayAgain: "CommandOrControl+Alt+R", starReplay: "CommandOrControl+Alt+S" },
  shortcutsUnavailable: [],
  notifications: { launch: true, replays: true, matchHistory: true, recording: true, stars: true },
  startAtLogin: true,
  port: 49200,
  allowLan: false,
  ui: DEFAULT_UI,
  restartPending: [],
  paths: { settingsFile: "C:\\cfg.json", logFile: "C:\\collector.log", dataDir: "C:\\data", dashboardUrl: "http://localhost:49200" },
};

function renderAt(url: string, extra: { canQuitGame?: boolean; replays?: ReplaysResponse; update?: AppUpdateResponse } = {}) {
  let current = config;
  const api = {
    settings: vi.fn(async () => ({ replayLeadSeconds: 10, canLaunchGame: false, canQuitGame: extra.canQuitGame ?? false, replayAgainShortcut: null, ballchasing: false })),
    sessions: vi.fn(async () => ({ items: [], nextCursor: null })),
    summary: vi.fn(async () => ({ matches: 0, record: { wins: 0, losses: 0, abandoned: 0 }, solo: { wins: 0, losses: 0, abandoned: 0 }, partied: { wins: 0, losses: 0, abandoned: 0 }, byTeamSize: {}, practiceSeconds: 0, firstStartedAt: null, lastStartedAt: null })),
    config: vi.fn(async () => current),
    patchConfig: vi.fn(async (p: ConfigPatch) => {
      const { ballchasingToken, ballchasingUploads, ...rest } = p;
      const uploads = { ...current.ballchasingUploads };
      for (const [k, r] of Object.entries(ballchasingUploads ?? {})) uploads[k as keyof typeof uploads] = { ...uploads[k as keyof typeof uploads], ...r };
      current = { ...current, ...rest, ballchasingUploads: uploads, ui: { ...current.ui, ...p.ui }, shortcuts: { ...current.shortcuts!, ...p.shortcuts } } as ConfigResponse;
      if (ballchasingToken !== undefined) current = { ...current, ballchasingTokenSet: ballchasingToken !== null };
      return { ok: true as const, config: current };
    }),
    testBallchasing: vi.fn(async () => ({ ok: true as const, name: "me", tier: null })),
    replays: vi.fn(async () => extra.replays ?? replaysData),
    startBackfill: vi.fn(async () => ({ ok: true, queued: 2 })),
    stopBackfill: vi.fn(async () => ({ ok: true })),
    setBackfillQuit: vi.fn(async () => ({ ok: true })),
    fetchMissingFromBallchasing: vi.fn(async () => ({ ok: true })),
    openInApp: vi.fn(async () => ({ ok: true })),
    appUpdate: vi.fn(async () => extra.update ?? { update: null, canInstall: true }),
    installUpdate: vi.fn(async () => ({ ok: true })),
    teammateSuggestions: vi.fn(async () => [{ primaryId: "Epic|teammate|0", name: "Teammate", matches: 9, lastPlayedAt: Date.now(), known: false }]),
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

describe("replays in settings", () => {
  it("Game & replays starts with the matches about to leave Match History, the counts and Play", async () => {
    const { api } = renderAt("/sessions#settings/game");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const notice = await within(dialog).findByRole("region", { name: /A match is about to leave Match History/ });
    expect(notice).toHaveTextContent("12 days left");
    expect(within(notice).getByRole("link")).toHaveAttribute("href", "/sessions/m3");
    expect(within(dialog).getByText("Only in Match History")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Play new matches" }));
    expect(api.startBackfill).toHaveBeenCalledWith(false, false);
    // Closing the game afterwards is only offered where the app can do it.
    expect(within(dialog).queryByRole("checkbox", { name: "Quit Rocket League when done" })).toBeNull();
  });

  it("offers to quit Rocket League when the replays are done, and remembers the choice", async () => {
    const { api } = renderAt("/sessions#settings/game", { canQuitGame: true });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const quit = await within(dialog).findByRole("checkbox", { name: "Quit Rocket League when done" });
    expect(quit).not.toBeChecked();
    await userEvent.click(quit);
    expect(api.patchConfig).toHaveBeenCalledWith({ ui: { quitAfterReplays: true } });
    await waitFor(() => expect(quit).toBeChecked());
    // Not running: nothing to tell the run.
    expect(api.setBackfillQuit).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Play all 3" }));
    expect(api.startBackfill).toHaveBeenCalledWith(true, true);
  });

  it("while replays play, the choice can still be changed", async () => {
    const running = { ...replaysData, backfill: { running: true, current: "A", done: 2, failed: 0, remaining: 9, remainingMs: 1_200_000, quitWhenDone: true } };
    const { api } = renderAt("/sessions#settings/game", { canQuitGame: true, replays: running });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(await within(dialog).findByText("Playing replay 3 of 12 · about 20 min left.")).toBeInTheDocument();
    const quit = within(dialog).getByRole("checkbox", { name: "Quit Rocket League when done" });
    expect(quit).toBeChecked();
    await userEvent.click(quit);
    expect(api.setBackfillQuit).toHaveBeenCalledWith(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    expect(api.stopBackfill).toHaveBeenCalled();
  });
});

describe("Play in the header", () => {
  it("shows how many replays are left to play and opens the same controls", async () => {
    const { api } = renderAt("/sessions", { canQuitGame: true });
    const button = await screen.findByRole("button", { name: "Play saved replays: 3 to play" });
    expect(button).toHaveTextContent("Play 3");
    // The popover it opens (closed, so hidden to the queries by default).
    const panel = document.getElementById(button.getAttribute("popovertarget")!)!;
    expect(panel).toHaveAttribute("aria-label", "Play saved replays");
    expect(within(panel).getByText("2 never recorded: become new matches")).toBeInTheDocument();
    expect(within(panel).getByRole("checkbox", { name: "Quit Rocket League when done", hidden: true })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Play new matches", hidden: true }));
    expect(api.startBackfill).toHaveBeenCalledWith(false, false);
  });

  it("shows the run's progress while replays play, with Stop", async () => {
    const running = { ...replaysData, backfill: { running: true, current: "A", done: 2, failed: 0, remaining: 9, remainingMs: 1_200_000, quitWhenDone: false } };
    const { api } = renderAt("/sessions", { replays: running });
    const button = await screen.findByRole("button", { name: "Playing replay 3 of 12 · about 20 min left. Options" });
    expect(button).toHaveTextContent("Replay 3 of 12");
    await userEvent.click(within(document.getElementById(button.getAttribute("popovertarget")!)!).getByRole("button", { name: "Stop", hidden: true }));
    expect(api.stopBackfill).toHaveBeenCalled();
  });

  it("isn't there when every saved replay has been played", async () => {
    renderAt("/sessions", { replays: { ...replaysData, toPlay: { unrecorded: 0, recorded: 0, seconds: 0 } } });
    await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() => expect(document.querySelector("[popover][aria-label='Play saved replays']")).toBeNull());
    expect(screen.queryByRole("button", { name: /Play saved replays/ })).toBeNull();
  });

  it("Ballchasing ends with getting the missing replays", async () => {
    const { api } = renderAt("/sessions#settings/ballchasing");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(await within(dialog).findByRole("heading", { name: "Missing replays" })).toBeInTheDocument();
    await userEvent.click(await within(dialog).findByRole("button", { name: "Get missing replays" }));
    expect(api.fetchMissingFromBallchasing).toHaveBeenCalled();
  });
});

describe("About", () => {
  it("is always in the nav, last, and says what the app is, its version and how it was made", async () => {
    const { router } = renderAt("/sessions");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const about = within(nav).getByRole("link", { name: "About" });
    expect(within(nav).getAllByRole("link").at(-1)).toBe(about);
    await userEvent.click(about);
    expect(router.state.location.pathname).toBe("/about");
    expect(await screen.findByRole("heading", { level: 1, name: "About" })).toBeInTheDocument();
    const version = (await import("../../../desktop/package.json")).version;
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(`Whiff version ${version}`);
    expect(screen.getByText(/vibe\s+coded/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "github.com/fwonkas/Whiff" })).toHaveAttribute("href", "https://github.com/fwonkas/Whiff");
    expect(about).toHaveAttribute("aria-current", "page");
    // No update found: no badge.
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("offers a found update after the version: clicking downloads, installs and restarts", async () => {
    const { api } = renderAt("/about", { update: { update: { version: "9.9.9", state: "downloading", installing: false }, canInstall: true } });
    const badge = await screen.findByRole("button", { name: "Update available" });
    expect(badge).toHaveAttribute("title", "Download and install Whiff 9.9.9, then restart Whiff");
    await userEvent.click(badge);
    expect(api.installUpdate).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Updating…" })).toBeDisabled();
  });

  it("says so when it's downloaded already", async () => {
    renderAt("/about", { update: { update: { version: "9.9.9", state: "ready", installing: false }, canInstall: true } });
    expect(await screen.findByRole("button", { name: "Update available" })).toHaveAttribute("title", "Install Whiff 9.9.9 and restart Whiff");
  });

  it("is only a label on another device", async () => {
    renderAt("/about", { update: { update: { version: "9.9.9", state: "ready", installing: false }, canInstall: false } });
    expect(await screen.findByText("Update available")).toHaveAttribute("title", "Whiff 9.9.9 can be installed from the desktop app.");
    expect(screen.queryByRole("button", { name: "Update available" })).toBeNull();
  });
});

describe("Trends and Practice, unfinished", () => {
  it("are hidden by default: no nav links, and their addresses open Sessions", async () => {
    const { router } = renderAt("/trends?teamSize=2");
    await waitFor(() => expect(router.state.location.pathname).toBe("/sessions"));
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Sessions", "About"]);
    await router.navigate({ to: "/practice" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/sessions"));
  });

  it("show once Settings → Advanced turns them on", async () => {
    const { api } = renderAt("/sessions#settings/advanced");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Show Trends and Practice" }));
    expect(api.patchConfig).toHaveBeenCalledWith({ ui: { showTrendsPractice: true } });
    const nav = screen.getByRole("navigation", { name: "Main" });
    await waitFor(() => expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Sessions", "Trends", "Practice", "About"]));
  });
});

describe("settings dialog", () => {
  it("opens from the header, keeps its tab in the URL hash and saves a change", async () => {
    const { api, router } = renderAt("/sessions?teamSize=2");
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(router.state.location.hash).toBe("settings/general");
    // The page's filters survive opening settings.
    expect(router.state.location.search).toEqual({ teamSize: 2 });

    await userEvent.click(within(dialog).getByRole("radio", { name: "Dark" }));
    expect(api.patchConfig).toHaveBeenCalledWith({ ui: { theme: "dark" } });
    expect(await within(dialog).findByText("Saved.")).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("dark");

    await userEvent.click(within(dialog).getByRole("tab", { name: "Player" }));
    expect(router.state.location.hash).toBe("settings/player");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Add" }));
    expect(api.patchConfig).toHaveBeenLastCalledWith({ knownTeammates: [{ primaryId: "Epic|teammate|0", name: "Teammate" }] });
  });

  it("Appearance picks the tray icon (desktop app)", async () => {
    const { api } = renderAt("/sessions#settings/general");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const tray = await within(dialog).findByRole("combobox", { name: "Tray icon" });
    expect(within(tray).getAllByRole("option").map((o) => o.textContent)).toEqual(["Default", "White", "Black"]);
    expect(tray).toHaveDisplayValue("Default");
    await userEvent.selectOptions(tray, "White");
    expect(api.patchConfig).toHaveBeenCalledWith({ ui: { trayIcon: "white" } });
    await waitFor(() => expect(tray).toHaveDisplayValue("White"));
  });

  it("a checkbox shows its change while saving, and goes back if the save fails (2026-11-27)", async () => {
    const { api } = renderAt("/sessions#settings/general");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const open = await within(dialog).findByRole("checkbox", { name: "Open the dashboard when Whiff starts" });
    let fail!: (e: Error) => void;
    vi.mocked(api.patchConfig).mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    await userEvent.click(open);
    // Still saving: no flicker back to the old value.
    expect(open).toBeChecked();
    await act(async () => fail(new Error("offline")));
    await waitFor(() => expect(open).not.toBeChecked());
  });

  it("Startup can open the dashboard every time Whiff starts", async () => {
    const { api } = renderAt("/sessions#settings/general");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(await within(dialog).findByRole("checkbox", { name: "Start Whiff when I sign in to Windows" })).toBeChecked();
    const open = within(dialog).getByRole("checkbox", { name: "Open the dashboard when Whiff starts" });
    expect(open).not.toBeChecked();
    await userEvent.click(open);
    expect(api.patchConfig).toHaveBeenCalledWith({ ui: { openDashboardOnLaunch: true } });
    await waitFor(() => expect(open).toBeChecked());
    // Windows decides whether the tray icon shows on the taskbar: point to its switch.
    expect(within(dialog).getByText(/Windows decides whether Whiff’s icon shows on the taskbar/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Open taskbar settings" }));
    expect(api.openInApp).toHaveBeenCalledWith("taskbarSettings");
  });

  it("Data & network shows this PC's address, and other devices' only with network access on", async () => {
    const { api } = renderAt("/sessions#settings/data");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(await within(dialog).findByText("http://localhost:49200")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Open in browser" }));
    expect(api.openInApp).toHaveBeenCalledWith("browser");
    expect(within(dialog).queryByText("Addresses")).toBeNull();
    expect(within(dialog).queryByRole("list", { name: "Dashboard addresses" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Open the dashboard from other devices on my network" }));
    const list = await within(dialog).findByRole("list", { name: "Dashboard addresses" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["http://rocketleague.local:49200", "http://192.168.1.20:49200"]);
  });

  it("opens on the tab in the hash and closes back to the page", async () => {
    const { router } = renderAt("/sessions#settings/shortcuts");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(await within(dialog).findByRole("tab", { name: "Shortcuts" })).toHaveAttribute("aria-selected", "true");
    expect(await within(dialog).findByRole("button", { name: "Replay the goal again: Ctrl+Alt+R" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close settings" }));
    expect(router.state.location.hash).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps auto-upload on but locked until a ballchasing key is saved", async () => {
    const { api } = renderAt("/sessions#settings/ballchasing");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const upload = await within(dialog).findByRole("checkbox", { name: "Upload saved replays automatically" });
    expect(upload).toBeChecked();
    expect(upload).toBeDisabled();
    expect(upload).toHaveAccessibleDescription("Needs an API key.");
    expect(within(dialog).getByRole("checkbox", { name: "Ranked" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Ranked" })).toBeDisabled();
    expect(within(dialog).getByRole("checkbox", { name: "Casual" })).not.toBeChecked();
    expect(within(dialog).getByRole("combobox", { name: "Casual: who can see them" })).toHaveDisplayValue("Public");
    expect(within(dialog).getByRole("combobox", { name: "Private: who can see them" })).toHaveDisplayValue("Private");

    await userEvent.type(within(dialog).getByLabelText("API key"), "abc123");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(upload).toBeEnabled());
    expect(upload).toBeChecked();
    const ranked = within(dialog).getByRole("combobox", { name: "Ranked: who can see them" });
    expect(ranked).toBeEnabled();
    // Casual is off, so its own settings wait until it's turned on.
    expect(within(dialog).getByRole("combobox", { name: "Casual: who can see them" })).toBeDisabled();
    await userEvent.selectOptions(ranked, "Unlisted");
    expect(api.patchConfig).toHaveBeenLastCalledWith({ ballchasingUploads: { ranked: { visibility: "unlisted" } } });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Ranked: group" }), "ranked-2026{Enter}");
    expect(api.patchConfig).toHaveBeenLastCalledWith({ ballchasingUploads: { ranked: { group: "ranked-2026" } } });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Casual" }));
    expect(api.patchConfig).toHaveBeenLastCalledWith({ ballchasingUploads: { casual: { enabled: true } } });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Tournament" }));
    expect(api.patchConfig).toHaveBeenLastCalledWith({ ballchasingUploads: { tournament: { enabled: false } } });
    expect(within(dialog).getByRole("textbox", { name: "Tournament: group" })).toBeDisabled();
    await userEvent.click(upload);
    expect(api.patchConfig).toHaveBeenLastCalledWith({ ballchasingUpload: false });
  });

  it("turns key presses into shortcuts only with a modifier", () => {
    const press = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
      acceleratorFor({ key: "", code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
    expect(press("KeyR", { ctrlKey: true, altKey: true })).toBe("CommandOrControl+Alt+R");
    expect(press("F9", { shiftKey: true })).toBe("Shift+F9");
    expect(press("KeyR")).toBeNull();
    expect(press("ControlLeft", { ctrlKey: true })).toBeNull();
  });
});
