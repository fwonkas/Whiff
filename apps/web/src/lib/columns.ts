import type { CSSProperties } from "react";
import {
  DEFAULT_REPLAY_COLUMNS,
  DEFAULT_SESSION_COLUMNS,
  REPLAY_COLUMNS,
  SESSION_COLUMNS,
  type ReplayColumn,
  type SessionColumn,
} from "@rl/api-contract";
import { useConfig } from "./api.tsx";
import { cachedUi } from "./ui-prefs.ts";

/**
 * Configurable list columns. The settings file's ui.sessionsColumns and
 * ui.replaysColumns say which show (null: the defaults); they always show in
 * the list's own order. Each list lays its grid out from the visible columns
 * through two CSS variables, so hiding one gives its space to the others,
 * and phones keep their own two-line layout.
 */

export function useColumns(list: "sessions"): Set<SessionColumn>;
export function useColumns(list: "replays"): Set<ReplayColumn>;
export function useColumns(list: "sessions" | "replays"): Set<string> {
  const config = useConfig();
  const ui = config.data?.ui ?? cachedUi();
  const chosen = list === "sessions" ? ui.sessionsColumns : ui.replaysColumns;
  const all: readonly string[] = list === "sessions" ? SESSION_COLUMNS : REPLAY_COLUMNS;
  const defaults: readonly string[] = list === "sessions" ? DEFAULT_SESSION_COLUMNS : DEFAULT_REPLAY_COLUMNS;
  return new Set(all.filter((c) => (chosen ?? defaults).includes(c)));
}

/** --cols and --areas for a row grid: each visible column's track, in order, then any fixed trailing columns. */
export function gridVars<K extends string>(tracks: Record<K, string>, visible: Set<K>, trailing: Record<string, string> = {}): CSSProperties {
  const keys = (Object.keys(tracks) as K[]).filter((k) => visible.has(k));
  const all = [...keys.map((k) => [k, tracks[k]] as const), ...Object.entries(trailing)];
  return { "--cols": all.map(([, t]) => t).join(" "), "--areas": `"${all.map(([k]) => k).join(" ")}"` } as CSSProperties;
}
