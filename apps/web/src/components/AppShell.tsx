import { useEffect } from "react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useConfig, useLaunchGame, useSettings } from "../lib/api.tsx";
import { LiveStatusContext, useLiveStatus } from "../lib/live.ts";
import { cacheUi, cachedUi, defaultSessionsSearch } from "../lib/ui-prefs.ts";
import { MeBanner } from "./MeBanner.tsx";
import { HeaderPlay } from "./ReplayPanels.tsx";
import { SETTINGS_TABS, SettingsDialog, type SettingsTab } from "./SettingsDialog.tsx";
import styles from "./AppShell.module.css";

/** How long the indicator says "Launching…" before going back to "Game not running". */
const LAUNCH_WAIT_MS = 3 * 60_000;

export function AppShell() {
  const live = useLiveStatus();
  const settings = useSettings();
  const config = useConfig();
  const ui = config.data?.ui ?? cachedUi();
  useEffect(() => {
    if (config.data) cacheUi(config.data.ui);
  }, [config.data]);

  // Settings open as #settings or #settings/<tab>, so the tray (and Back) can drive them.
  const hash = useRouterState({ select: (s) => s.location.hash });
  const navigate = useNavigate();
  const settingsTab = hash === "settings" || hash.startsWith("settings/") ? ((hash.split("/")[1] ?? "general") as SettingsTab) : null;
  const openSettings = (tab: SettingsTab) =>
    void navigate({ to: ".", search: (prev: Record<string, unknown>) => prev, hash: `settings/${tab}`, replace: settingsTab !== null });
  const closeSettings = () => void navigate({ to: ".", search: (prev: Record<string, unknown>) => prev, hash: "", replace: true });
  const launch = useLaunchGame();
  const { reset } = launch;

  const launching = launch.isPending || (launch.data?.ok === true && launch.data.status === "launching");
  // Back to normal once the game connects, or after a while if it never does.
  useEffect(() => {
    if (!launching) return;
    if (live.gameConnected) return void reset();
    const t = setTimeout(reset, LAUNCH_WAIT_MS);
    return () => clearTimeout(t);
  }, [launching, live.gameConnected, reset]);

  const canLaunch = live.connected && !live.gameConnected && settings.data?.canLaunchGame === true && !launching;
  const status = !live.connected
    ? "Collector offline"
    : live.gameConnected
      ? "Game connected"
      : launching
        ? "Launching Rocket League…"
        : "Game not running";
  const failure = launch.isError
    ? "Couldn’t reach the collector."
    : launch.data && !launch.data.ok && !live.gameConnected
      ? `Couldn’t launch: ${launch.data.reason}.`
      : null;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.bar}>
          <Link to="/sessions" className={styles.brand}>
            Whiff
          </Link>
          <nav aria-label="Main" className={styles.nav}>
            {/* The router sets aria-current="page" on the active link; ignore filters when matching. */}
            <Link to="/sessions" search={defaultSessionsSearch(ui)} className={styles.navLink} activeOptions={{ includeSearch: false }}>
              Sessions
            </Link>
            {ui.showTrendsPractice && (
              <>
                <Link
                  to="/trends"
                  search={ui.defaultTeamSize ? { teamSize: ui.defaultTeamSize, ...(ui.defaultWith ? { with: ui.defaultWith } : {}) } : {}}
                  className={styles.navLink}
                  activeOptions={{ includeSearch: false }}
                >
                  Trends
                </Link>
                <Link to="/practice" className={styles.navLink} activeOptions={{ includeSearch: false }}>
                  Practice
                </Link>
              </>
            )}
            <Link to="/about" className={styles.navLink}>
              About
            </Link>
          </nav>
          <HeaderPlay className={styles.play} />
          <div className={styles.status} role="status">
            {canLaunch ? (
              <button type="button" className={styles.launch} onClick={() => launch.mutate()}>
                <span className={styles.dot} aria-hidden="true" />
                {status}
                <span className={styles.launchAction}>Launch</span>
              </button>
            ) : (
              <>
                <span className={styles.dot} data-on={live.gameConnected} data-busy={launching} aria-hidden="true" />
                {status}
              </>
            )}
            {failure && <span className={styles.failure}>{failure}</span>}
          </div>
          <button type="button" className={styles.gear} aria-label="Settings" title="Settings" onClick={() => openSettings("general")}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>
      <div className={styles.content} data-scroll-restoration-id="content">
        <LiveStatusContext.Provider value={live}>
          <MeBanner />
          <Outlet />
        </LiveStatusContext.Provider>
      </div>
      {settingsTab && (
        <SettingsDialog
          tab={SETTINGS_TABS.some((t) => t.id === settingsTab) ? settingsTab : "general"}
          onTab={openSettings}
          onClose={closeSettings}
        />
      )}
    </div>
  );
}
