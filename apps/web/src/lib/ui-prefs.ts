import { DEFAULT_UI, type Theme, type UiSettings } from "@rl/api-contract";

/**
 * The settings file's UI preferences, cached in this browser so the theme is
 * right before the first request answers (index.html reads the same key) and
 * the "/" redirect can use the default filters. The settings file stays the
 * source of truth; storage can be missing or throw, so every access is guarded.
 */
const KEY = "rl-ui";

export function cachedUi(): UiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_UI, ...(JSON.parse(raw) as Partial<UiSettings>) } : DEFAULT_UI;
  } catch {
    return DEFAULT_UI;
  }
}

export function cacheUi(ui: UiSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ui));
  } catch {
    // Private window or blocked storage: the theme just applies a moment later.
  }
  applyTheme(ui.theme);
}

/** "auto" follows the system; light and dark pin it. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** The Sessions link's filters from the defaults. */
export function defaultSessionsSearch(ui: UiSettings): { teamSize?: 1 | 2 | 3; with?: "solo" | "party" } {
  return { ...(ui.defaultTeamSize ? { teamSize: ui.defaultTeamSize } : {}), ...(ui.defaultWith ? { with: ui.defaultWith } : {}) };
}
