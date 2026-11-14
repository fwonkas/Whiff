import { createContext, useContext, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LiveMessage } from "@rl/api-contract";
import { keys } from "./api.tsx";

/**
 * Connects to the collector's /live feed. Tracks whether the game is
 * connected and refreshes cached data when a session is saved, so the
 * Sessions screen updates by itself after each match.
 */
export function useLiveStatus(): { connected: boolean; gameConnected: boolean } {
  const queryClient = useQueryClient();
  const [state, setState] = useState({ connected: false, gameConnected: false });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const open = () => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`;
      ws = new WebSocket(url);
      ws.onopen = () => setState((s) => ({ ...s, connected: true }));
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as LiveMessage;
        if (m.type === "status") setState({ connected: true, gameConnected: m.gameConnected });
        if (m.type === "session") void queryClient.invalidateQueries({ queryKey: keys.all });
      };
      ws.onclose = () => {
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
