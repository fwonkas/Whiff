import type { DetailGoal } from "@rl/api-contract";
import { formatClock } from "../../lib/format.ts";
import styles from "./match.module.css";

/**
 * Goals along the match clock: mine above the line, theirs below, overtime
 * past the 0:00 mark. The list under it is the accessible version and the
 * control: choosing a goal shows its build-up on the touch map.
 */
export function GoalTimeline({
  goals,
  selected,
  onSelect,
}: {
  goals: DetailGoal[];
  selected: number | null;
  onSelect: (i: number | null) => void;
}) {
  const timed = goals.map((g, i) => ({ ...g, i })).filter((g) => g.matchTime !== null);
  const end = Math.max(300, ...timed.map((g) => g.matchTime!));
  const pct = (t: number) => `${(t / end) * 100}%`;
  const overtime = end > 300;
  const minutes = [0, 60, 120, 180, 240, 300];

  let us = 0;
  let them = 0;
  const running = goals.map((g) => (g.forUs ? ++us : ++them, `${us}–${them}`));

  return (
    <section className={`card ${styles.card}`} aria-labelledby="timeline-title">
      <div className={styles.cardHead}>
        <h2 id="timeline-title" className={styles.cardTitle}>
          Goals
        </h2>
        {selected !== null && (
          <button type="button" className={styles.linkButton} onClick={() => onSelect(null)}>
            Show all touches
          </button>
        )}
      </div>

      {goals.length === 0 ? (
        <p className="muted">No goals.</p>
      ) : (
        <>
          <div className={styles.timeline} aria-hidden="true">
            {overtime && <span className={styles.otBand} style={{ left: pct(300), width: `calc(${pct(end)} - ${pct(300)})` }} />}
            <span className={styles.axis} />
            {minutes.map((t) => (
              <span key={t} className={styles.tick} style={{ left: pct(t) }}>
                <span className={`${styles.tickLabel} num`}>{formatClock(t)}</span>
              </span>
            ))}
            {overtime && end - 300 > end * 0.08 && (
              <span className={styles.tick} style={{ left: pct(end) }}>
                <span className={`${styles.tickLabel} num`}>{formatClock(end)}</span>
              </span>
            )}
            {timed.map((g) => (
              <span
                key={g.i}
                className={styles.marker}
                data-side={g.forUs ? "us" : "them"}
                data-selected={selected === g.i || undefined}
                style={{ left: pct(g.matchTime!) }}
                onClick={() => onSelect(selected === g.i ? null : g.i)}
              />
            ))}
          </div>

          <ol className={styles.goalList}>
            {goals.map((g, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={styles.goal}
                  data-side={g.forUs ? "us" : "them"}
                  aria-pressed={selected === i}
                  onClick={() => onSelect(selected === i ? null : i)}
                >
                  <span className={`${styles.goalClock} num`}>{formatClock(g.matchTime)}</span>
                  <span className={styles.goalWho}>
                    <strong>{g.forUs ? "Scored" : "Conceded"}</strong>
                    <span className="muted">
                      {" "}
                      · {g.scorerName ?? "Unknown"}
                      {g.assisterName ? `, assist ${g.assisterName}` : ""}
                    </span>
                  </span>
                  <span className={`${styles.goalMeta} num muted`}>
                    {Math.round(g.speedKmh)} km/h · {running[i]}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
