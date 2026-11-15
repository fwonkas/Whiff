import { useAppUpdate, useInstallUpdate } from "../lib/api.tsx";
import styles from "./AboutPage.module.css";

/** Where the code lives. A placeholder until the repo is public. */
export const REPO_URL = "https://github.com/fwonkas/Whiff";

/**
 * After the version, when the desktop app's update check found a newer one:
 * a button that downloads it (if it isn't yet), installs it and restarts.
 * Elsewhere (a phone, the browser on another device) just the badge.
 */
function UpdateBadge() {
  const { data } = useAppUpdate();
  const install = useInstallUpdate();
  const update = data?.update;
  if (!update) return null;
  const busy = update.installing || install.isPending || install.isSuccess;
  if (!data.canInstall) {
    return (
      <span className={styles.update} title={`Whiff ${update.version} can be installed from the desktop app.`}>
        Update available
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.update}
      disabled={busy}
      onClick={() => install.mutate()}
      title={
        busy
          ? `Installing Whiff ${update.version}. Whiff restarts when it's done.`
          : update.state === "ready"
            ? `Install Whiff ${update.version} and restart Whiff`
            : `Download and install Whiff ${update.version}, then restart Whiff`
      }
    >
      {busy ? "Updating…" : "Update available"}
    </button>
  );
}

/** Name, version, what it is and how it was made. */
export function AboutPage() {
  return (
    <main className="page">
      <h1 className="page-title">About</h1>
      <section className={styles.card} aria-labelledby="about-name">
        <h2 id="about-name" className={styles.name}>
          Whiff <span className={`num muted ${styles.version}`}>version {__APP_VERSION__}</span>
          <UpdateBadge />
        </h2>
        <p>
          Records your Rocket League matches, practice and replays through the game’s Stats API, and shows how you play over time: results,
          per-match stats, replay analysis and trends worth acting on. Everything stays on your PC.
        </p>
        <p>
          Built with AI: written almost entirely by Claude, Anthropic’s AI model, from one player’s requests and feedback (in other words, vibe
          coded). Expect rough edges.
        </p>
        <p>
          Not affiliated with or endorsed by Psyonix or Epic Games. Rocket League is a trademark of Psyonix.
        </p>
        <p>
          Source code: <a href={REPO_URL}>{REPO_URL.replace("https://", "")}</a>
        </p>
      </section>
    </main>
  );
}
