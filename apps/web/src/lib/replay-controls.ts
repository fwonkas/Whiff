import { useConfig } from "./api.tsx";
import { useSharedLiveStatus } from "./live.ts";
import { cachedUi } from "./ui-prefs.ts";

export type WatchMode = "disabled" | "hidden" | "launch";

/**
 * What Watch buttons do while Rocket League isn't running (Settings → Game &
 * replays), and whether it's running. Before the live status is known it
 * counts as running.
 */
export function useWatchControls(): { mode: WatchMode; gameRunning: boolean; shown: boolean; enabled: boolean; markFast: boolean } {
  const ui = useConfig().data?.ui ?? cachedUi();
  const live = useSharedLiveStatus();
  const gameRunning = live === null || live.gameConnected;
  const mode: WatchMode = ui.watchWithoutGame ?? (ui.hideReplayControlsWithoutGame ? "hidden" : "disabled");
  return {
    mode,
    gameRunning,
    shown: gameRunning || mode !== "hidden",
    enabled: gameRunning || mode === "launch",
    // Settings → Advanced: mark replays played through too fast.
    markFast: ui.markFastPlaybacks ?? false,
  };
}

/** Whether Watch buttons (and the Sessions Replay column) show. */
export function useReplayControlsShown(): boolean {
  return useWatchControls().shown;
}

export const LAUNCHING_TEXT = "Starting Rocket League. The replay opens once it’s up.";
