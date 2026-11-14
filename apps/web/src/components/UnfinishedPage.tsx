import type { ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { useConfig } from "../lib/api.tsx";
import { cachedUi } from "../lib/ui-prefs.ts";

/**
 * Trends and Practice aren't built out yet: shown only with Settings →
 * Advanced → "Show Trends and Practice" on; otherwise their address opens
 * Sessions. Waits for the settings so a fresh browser doesn't bounce off a
 * page that's turned on (falls back to the cached copy if they can't load).
 */
export function UnfinishedPage({ children }: { children: ReactNode }) {
  const config = useConfig();
  if (config.isPending) return null;
  const ui = config.data?.ui ?? cachedUi();
  return ui.showTrendsPractice ? children : <Navigate to="/sessions" replace />;
}
