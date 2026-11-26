import { createContext, useContext, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LiveMessage } from "@rl/api-contract";
import { keys } from "./api.tsx";

/** Messages that mean data may have changed are gathered this long, then the screens fetch once. */
const REFRESH_DELAY_MS = 250;

/**
 * Connects to the collector's /live feed. Tracks whether the game is
 * connected and refreshes cached data when the collector says it changed (a
 * session saved, a replay saved, analyzed or uploaded, a star from another
 * device, an import), and after reconnecting, since messages were missed.
 * Only the queries on screen fetch again; the rest are marked stale. The
 * settings form's data ("config") is left alone, so an edit isn't undone.
 */
export function useLiveStatus(): { connected: boolean; gameConnected: boolean } {
  const queryClient = useQueryClient();
  const [state, setState] = useState({ connected: false, gameConnected: false });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let wasOpen = false;
    // The game's state as last heard (undefined until the first status after connecting).
    let lastGame: boolean | undefined;
    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(
        () => void queryClient.invalidateQueries({ queryKey: keys.all, predicate: (q) => q.queryKey[1] !== "config" }),
        REFRESH_DELAY_MS,
      );
    };

    const open = () => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`;
      ws = new WebSocket(url);
      ws.onopen = () => {
        setState((s) => ({ ...s, connected: true }));
        // Back after a drop (the collector restarted, the PC slept): whatever changed meanwhile was missed.
        if (wasOpen) refresh();
        wasOpen = true;
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as LiveMessage;
        if (m.type === "status") {
          setState({ connected: true, gameConnected: m.gameConnected });
          // The game started or closed: queries that carry it (the Play and Watch buttons) are out of date.
          if (lastGame !== undefined && lastGame !== m.gameConnected) refresh();
          lastGame = m.gameConnected;
        }
        if (m.type === "session" || m.type === "changed") refresh();
      };
      ws.onclose = () => {
        lastGame = undefined;
        setState({ connected: false, gameConnected: false });
        if (!closed) retry = setTimeout(open, 3000);
      };
    };
    // Deferred one tick: React StrictMode mounts, unmounts and remounts in
    // development, and a socket closed mid-handshake makes Vite's proxy log EPIPE.
    retry = setTimeout(open, 0);

    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(refreshTimer);
      ws?.close();
    };
  }, [queryClient]);

  return state;
}

/**
 * The live status, shared from the app shell so screens don't each open a
 * socket. Null outside the shell (component tests): treat as unknown.
 */
export const LiveStatusContext = createContext<{ connected: boolean; gameConnected: boolean } | null>(null);
export const useSharedLiveStatus = () => useContext(LiveStatusContext);
