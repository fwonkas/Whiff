import { useState } from "react";
import type { DetailGoal, DetailTouch } from "@rl/api-contract";
import { formatClock } from "../../lib/format.ts";
import styles from "./match.module.css";

/**
 * Every ball touch on a top-down field, my team attacking up. Touches come
 * rotated so my team attacks toward +y, and +x is the attacker's left, so the
 * SVG draws (−x, −y): up the screen is +y, and left is +x.
 *
 * With a goal chosen in the timeline, only its build-up shows (the touches in
 * the seconds before it), numbered and joined in order.
 */

const BUILD_UP_SECONDS = 12;
type Owner = DetailTouch["owner"];
const OWNERS: { owner: Owner; label: string }[] = [
  { owner: "me", label: "You" },
  { owner: "teammate", label: "Teammates" },
  { owner: "opponent", label: "Opponents" },
];

const WHO: Record<Owner, string> = { me: "You", teammate: "Teammate", opponent: "Opponent" };

// Field geometry (Unreal units): half-width 4096, half-length 5120, corners cut about 1150, goals 1786 wide and 880 deep.
const W = 4096;
const L = 5120;
const C = 1150;
const GOAL = 893;
const DEPTH = 880;
const FIELD = `M ${-W + C} ${-L} H ${W - C} L ${W} ${-L + C} V ${L - C} L ${W - C} ${L} H ${-W + C} L ${-W} ${L - C} V ${-L + C} Z`;

export function TouchMap({ touches, goals, selectedGoal, teamSize }: { touches: DetailTouch[]; goals: DetailGoal[]; selectedGoal: number | null; teamSize: number | null }) {
  const [shown, setShown] = useState<Record<Owner, boolean>>({ me: true, teammate: true, opponent: true });
  const goal = selectedGoal !== null ? goals[selectedGoal] : undefined;
  const buildUp =
    goal?.matchTime !== null && goal?.matchTime !== undefined ? { from: goal.matchTime - BUILD_UP_SECONDS, to: goal.matchTime } : null;
  const inWindow = buildUp ? touches.filter((t) => t.matchTime !== null && t.matchTime >= buildUp.from && t.matchTime <= buildUp.to) : touches;
  const visible = inWindow.filter((t) => shown[t.owner]);
  const counts = Object.fromEntries(OWNERS.map((o) => [o.owner, inWindow.filter((t) => t.owner === o.owner).length])) as Record<Owner, number>;
  const owners = teamSize === 1 ? OWNERS.filter((o) => o.owner !== "teammate") : OWNERS;

  return (
    <section className={`card ${styles.card}`} aria-labelledby="touchmap-title">
      <div className={styles.cardHead}>
        <h2 id="touchmap-title" className={styles.cardTitle}>
          {goal ? `Build-up to the ${goal.forUs ? "goal" : "goal against"} at ${formatClock(goal.matchTime)}` : "Touch map"}
        </h2>
      </div>
      <div className={styles.legend} role="group" aria-label="Whose touches">
        {owners.map((o) => (
          <button
            key={o.owner}
            type="button"
            className={styles.legendItem}
            aria-pressed={shown[o.owner]}
            onClick={() => setShown((s) => ({ ...s, [o.owner]: !s[o.owner] }))}
          >
            <svg viewBox="-12 -12 24 24" width="14" height="14" aria-hidden="true">
              <Mark owner={o.owner} x={0} y={0} r={8} />
            </svg>
            {o.label} <span className="num muted">{counts[o.owner]}</span>
          </button>
        ))}
      </div>

      <svg
        className={styles.field}
        viewBox={`${-W - 200} ${-L - DEPTH - 200} ${2 * W + 400} ${2 * (L + DEPTH) + 400}`}
        role="img"
        aria-label={`${visible.length} touches${goal ? " before the goal" : ""} on the field, your team attacking up`}
      >
        <path d={FIELD} className={styles.pitch} />
        {/* Goals: theirs at the top (I attack up), mine at the bottom. */}
        <rect x={-GOAL} y={-L - DEPTH} width={2 * GOAL} height={DEPTH} className={styles.goalBox} data-side="them" />
        <rect x={-GOAL} y={L} width={2 * GOAL} height={DEPTH} className={styles.goalBox} data-side="us" />
        {/* Thirds and the halfway line. */}
        <line x1={-W} x2={W} y1={0} y2={0} className={styles.lineMark} />
        <circle cx={0} cy={0} r={1000} className={styles.lineMark} fill="none" />
        <line x1={-W} x2={W} y1={-L / 3} y2={-L / 3} className={styles.thirdMark} />
        <line x1={-W} x2={W} y1={L / 3} y2={L / 3} className={styles.thirdMark} />

        {buildUp && visible.length > 1 && (
          <polyline points={visible.map((t) => `${-t.x},${-t.y}`).join(" ")} className={styles.path} />
        )}
        {visible.map((t, i) => (
          <g key={`${t.at}-${i}`}>
            <Mark owner={t.owner} x={-t.x} y={-t.y} r={buildUp ? 150 : 110} />
            {buildUp && (
              <text x={-t.x + 200} y={-t.y} className={styles.order} dy="0.35em">
                {i + 1}
              </text>
            )}
            <title>{`${WHO[t.owner]} at ${formatClock(t.matchTime)}, ball at ${Math.round(t.postSpeed)} km/h after`}</title>
          </g>
        ))}
        {/* Where goals went in: the ball's position as it scored. */}
        {goals.map((g, i) =>
          g.locationReliable && (selectedGoal === null || selectedGoal === i) ? (
            <g key={`goal-${i}`} className={styles.goalSpot} data-side={g.forUs ? "us" : "them"}>
              <circle cx={-g.x} cy={-g.y} r={170} />
              <text x={-g.x} y={-g.y} dy="0.35em">
                G
              </text>
            </g>
          ) : null,
        )}
      </svg>
      <p className={`muted ${styles.caption}`}>
        Your team attacks up. {buildUp ? `The ${BUILD_UP_SECONDS} seconds before the goal, in order.` : "Choose a goal to see its build-up."}
      </p>
    </section>
  );
}

/** Shape as well as color: me a filled circle, teammates a ring, opponents a cross. */
function Mark({ owner, x, y, r }: { owner: Owner; x: number; y: number; r: number }) {
  if (owner === "me") return <circle cx={x} cy={y} r={r} className={styles.markMe} />;
  if (owner === "teammate") return <circle cx={x} cy={y} r={r * 0.85} className={styles.markMate} />;
  const d = r * 0.8;
  return <path d={`M ${x - d} ${y - d} L ${x + d} ${y + d} M ${x + d} ${y - d} L ${x - d} ${y + d}`} className={styles.markThem} />;
}
