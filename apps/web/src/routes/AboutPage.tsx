import styles from "./AboutPage.module.css";

/** Where the code lives. A placeholder until the repo is public. */
export const REPO_URL = "https://github.com/fwonkas/Whiff";

/** Name, version, what it is and how it was made. */
export function AboutPage() {
  return (
    <main className="page">
      <h1 className="page-title">About</h1>
      <section className={styles.card} aria-labelledby="about-name">
        <h2 id="about-name" className={styles.name}>
          Whiff <span className={`num muted ${styles.version}`}>version {__APP_VERSION__}</span>
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
