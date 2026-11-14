import type { DetailPlayer } from "@rl/api-contract";
import styles from "./match.module.css";

/**
 * The game's end-of-match scoreboard, my team first, each team by score.
 * A real table: on phones it scrolls sideways with the name column pinned.
 */
const COLUMNS = [
  { key: "score", label: "Score", short: "Score" },
  { key: "goals", label: "Goals", short: "G" },
  { key: "assists", label: "Assists", short: "A" },
  { key: "saves", label: "Saves", short: "Sv" },
  { key: "shots", label: "Shots", short: "Sh" },
  { key: "touches", label: "Touches", short: "T" },
  { key: "demos", label: "Demos", short: "D" },
] as const;

export function Scoreboard({ players, myTeam, mvpKey }: { players: DetailPlayer[]; myTeam: number | null; mvpKey: string | null }) {
  const teams = [...new Set(players.map((p) => p.team))].sort((a, b) => (a === myTeam ? -1 : b === myTeam ? 1 : a - b));
  return (
    <section className={`card ${styles.card}`} aria-labelledby="scoreboard-title">
      <h2 id="scoreboard-title" className={styles.cardTitle}>
        Scoreboard
      </h2>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.nameCol}>
                Player
              </th>
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" className="num">
                  <abbr title={c.label}>{c.short}</abbr>
                </th>
              ))}
            </tr>
          </thead>
          {teams.map((team) => {
            const rows = players.filter((p) => p.team === team).sort((a, b) => b.score - a.score);
            const mine = team === myTeam;
            return (
              <tbody key={team} data-team={mine ? "us" : "them"}>
                <tr className={styles.teamRow}>
                  <th scope="rowgroup" colSpan={COLUMNS.length + 1} className={styles.nameCol}>
                    {mine ? "Your team" : "Opponents"}
                    <span className="num muted"> · {rows.reduce((n, p) => n + p.goals, 0)} goals</span>
                  </th>
                </tr>
                {rows.map((p) => (
                  <tr key={p.key} data-me={p.isMe || undefined}>
                    <th scope="row" className={styles.nameCol}>
                      <span className={styles.playerName}>
                        {p.name}
                        {p.isMe && <span className="visually-hidden"> (you)</span>}
                      </span>
                      <span className={styles.tags}>
                        {p.key === mvpKey && <span className="mvp">MVP</span>}
                        {p.isKnownTeammate && !p.isMe && <span className={styles.tag}>Teammate</span>}
                        {p.isBot && <span className={styles.tag}>Bot</span>}
                        {p.joinedAt !== null && <span className={styles.tag}>Joined late</span>}
                        {p.leftAt !== null && <span className={styles.tag}>Left</span>}
                      </span>
                    </th>
                    {COLUMNS.map((c) => (
                      <td key={c.key} className="num">
                        {p[c.key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </section>
  );
}
