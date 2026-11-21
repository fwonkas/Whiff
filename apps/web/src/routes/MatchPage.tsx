import { useEffect, useState } from "react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import type { NeighborSession, SessionDetailResponse } from "@rl/api-contract";
import { DeleteMatch } from "../components/DeleteMatch.tsx";
import { HelpTip } from "../components/HelpTip.tsx";
import { ReplayReview } from "../components/ReplayReview.tsx";
import { StarToggle } from "../components/StarToggle.tsx";
import panels from "../components/ReplayPanels.module.css";
import { GoalTimeline } from "../components/match/GoalTimeline.tsx";
import { ReplayAnalysis } from "../components/match/ReplayAnalysis.tsx";
import { Scoreboard } from "../components/match/Scoreboard.tsx";
import { TouchMap } from "../components/match/TouchMap.tsx";
import styles from "../components/match/match.module.css";
import { usePatchSession, useSession } from "../lib/api.tsx";
import { arenaName, formatDay, formatMinutes, formatPercent, formatTime, playlistShort, resultLabel, resultWords } from "../lib/format.ts";

/**
 * One session. Matches: the goal timeline and replay review beside the touch
 * map, then the scoreboard. Choosing a goal shows its build-up on the map.
 * Practice: a few numbers. On phones everything stacks.
 */

const route = getRouteApi("/sessions/$id");

export function MatchPage() {
  const { id } = route.useParams();
  const { data, isPending, isError, error } = useSession(id);
  const [selectedGoal, setSelectedGoal] = useState<number | null>(null);
  const navigate = useNavigate();
  // A different match (previous/next): start without a goal chosen.
  useEffect(() => setSelectedGoal(null), [id]);

  if (isPending) return <main className="page muted">Loading…</main>;
  if (isError)
    return (
      <main className="page">
        <p role="alert" className="notice">
          Couldn’t load this session: {error.message}
        </p>
      </main>
    );

  const s = data.session;
  const title =
    s.kind === "match"
      ? `${resultWords(s.outcome)} ${s.goalsFor}–${s.goalsAgainst}${s.overtime ? " in overtime" : ""}`
      : playlistShort(s.playlistId, s.playlistName);
  const myTeam = s.me?.team ?? null;

  return (
    <main className="page">
      <nav className={styles.pager} aria-label={s.kind === "match" ? "Matches" : "Sessions"}>
        <Link to="/sessions" className={styles.pagerAll}>
          All sessions
        </Link>
        <span className={styles.pagerSteps}>
          <Neighbor n={data.neighbors.previous} rel="prev" />
          <Neighbor n={data.neighbors.next} rel="next" />
        </span>
      </nav>
      <div>
        {/* The star sits between the title and its badges; it's a button, so it stays out of the heading. */}
        <div className={styles.titleLine}>
          <h1 className="page-title">{title}</h1>
          {s.kind === "match" && <StarToggle sessionId={s.id} starred={s.starred} what="this match" size="title" />}
          {s.mvp && (
            <span className="mvp" title="You were MVP">
              MVP
            </span>
          )}
        </div>
        <p className="muted" style={{ margin: "8px 0 0" }}>
          {[
            playlistShort(s.playlistId, s.playlistName),
            arenaName(s.arena),
            `${formatDay(s.startedAt)}, ${formatTime(s.startedAt)}`,
            formatMinutes(s.durationSeconds),
            s.teammates.length ? `With ${s.teammates.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {s.kind === "match" && <LeftEarly session={s} />}
      </div>

      {s.kind === "match" ? (
        <>
          <div className={styles.columns}>
            <div className={styles.stack}>
              <GoalTimeline goals={data.goals} selected={selectedGoal} onSelect={setSelectedGoal} />
              <ReplayReview sessionId={s.id} replay={s.replay} />
            </div>
            <TouchMap touches={data.touches} goals={data.goals} selectedGoal={selectedGoal} teamSize={data.metrics?.teamSize ?? null} />
          </div>
          <Scoreboard players={data.players} myTeam={myTeam} mvpKey={mvpKey(data, myTeam)} />
          <ReplayAnalysis sessionId={s.id} players={data.players} myTeam={myTeam} />
          <div className={panels.deleteRow}>
            <DeleteMatch
              sessionId={s.id}
              what={`${formatDay(s.startedAt)}, ${formatTime(s.startedAt)} · ${playlistShort(s.playlistId, s.playlistName)} · ${resultLabel(s.outcome)} ${s.goalsFor ?? "?"}–${s.goalsAgainst ?? "?"}`}
              onDeleted={() => void navigate({ to: "/sessions" })}
            />
          </div>
        </>
      ) : (
        <PracticeFacts practice={data.practice} />
      )}
    </main>
  );
}

/**
 * Whose MVP it was: the game's MVP event, or the game's rule without one
 * (the top score on the winning team). Matches wasMvp() in @rl/metrics:
 * none in 1s, where the winner is always MVP.
 */
export function mvpKey(data: SessionDetailResponse, myTeam: number | null): string | null {
  if (data.metrics?.teamSize === 1) return null;
  const named = data.statEvents.find((e) => e.eventName === "MVP")?.playerName;
  if (named) return data.players.find((p) => p.name === named)?.key ?? null;
  const o = data.session.outcome;
  if (myTeam === null || (o !== "win" && o !== "loss")) return null;
  const winners = data.players.filter((p) => (o === "win" ? p.team === myTeam : p.team !== myTeam));
  const top = winners.reduce<(typeof winners)[number] | null>((best, p) => (!best || p.score > best.score ? p : best), null);
  return top && top.score > 0 ? top.key : null;
}

/** "‹ Previous · Tue 9:12 PM · L 1–3", a link to the session before or after this one. */
function Neighbor({ n, rel }: { n: NeighborSession | null; rel: "prev" | "next" }) {
  const label = rel === "prev" ? "Previous" : "Next";
  if (!n) return <span className={`${styles.pagerLink} muted`} aria-disabled="true">{rel === "prev" ? `‹ ${label}` : `${label} ›`}</span>;
  const what = n.outcome ? ` · ${resultLabel(n.outcome)} ${n.goalsFor ?? "?"}–${n.goalsAgainst ?? "?"}` : ` · ${playlistShort(n.playlistId, n.playlistName)}`;
  const detail = `${formatTime(n.startedAt)}${what}`;
  return (
    <Link to="/sessions/$id" params={{ id: n.id }} rel={rel} className={styles.pagerLink} aria-label={`${label}: ${formatDay(n.startedAt)}, ${detail}`}>
      {rel === "prev" && "‹ "}
      {label}
      <span className={`muted ${styles.pagerDetail}`}> · {detail}</span>
      {rel === "next" && " ›"}
    </Link>
  );
}

function PracticeFacts({ practice }: { practice: SessionDetailResponse["practice"] }) {
  if (!practice) return <p className="muted">No practice numbers for this session.</p>;
  const speed = practice.gameSpeed !== null ? `${Math.round(practice.gameSpeed * 100)}%` : "Unknown";
  const facts =
    practice.kind === "freeplay"
      ? [
          { label: "Active time", value: formatMinutes(practice.activeSeconds) },
          { label: "Game speed", value: speed },
          { label: "Touches", value: String(practice.touches) },
          { label: "Touches per game minute", value: practice.touchesPerGameMinute !== null ? practice.touchesPerGameMinute.toFixed(1) : "—" },
          { label: "Goals", value: String(practice.goals) },
          { label: "Aerial touches", value: String(practice.aerialTouches) },
          { label: "Time in the air", value: formatPercent(practice.air) },
        ]
      : [
          { label: "Attempts", value: String(practice.attempts) },
          { label: "Success", value: formatPercent(practice.successRate) },
          { label: "Scored", value: String(practice.scored) },
          { label: "Conceded", value: String(practice.conceded) },
          { label: "Restarted after a touch", value: String(practice.restartedAfterTouch) },
          { label: "Game speed", value: speed },
        ];
  return (
    <dl className={styles.facts}>
      {facts.map((f) => (
        <div key={f.label} className={`card ${styles.fact}`}>
          <dt>{f.label}</dt>
          <dd className="num">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A match I left before it ended counts as "left early". When its result was
 * settled anyway (my teammates had gone, the deficit couldn't be made up),
 * this counts it as the result its score shows; it can be undone. Not for a
 * tied score, which settles nothing.
 */
function LeftEarly({ session: s }: { session: SessionDetailResponse["session"] }) {
  const patch = usePatchSession();
  const set = (leftSettled: boolean) => patch.mutate({ id: s.id, body: { leftSettled } });
  const failed = patch.isError ? <span className={styles.leftEarlyError}> Couldn’t change it: {patch.error.message}</span> : null;
  if (s.teammatesLeft) {
    return <p className={styles.leftEarly}>You left before the end, after all your teammates had, so it counts as a {s.outcome === "win" ? "win" : "loss"}.</p>;
  }
  if (s.leftSettled) {
    return (
      <p className={styles.leftEarly}>
        You left before the end, after the result was settled, so it counts as a {s.outcome === "win" ? "win" : "loss"}.{" "}
        <button type="button" className={panels.button} disabled={patch.isPending} onClick={() => set(false)}>
          Count as left early
        </button>
        {failed}
      </p>
    );
  }
  if (s.outcome !== "abandoned" || s.goalsFor === null || s.goalsAgainst === null || s.goalsFor === s.goalsAgainst) return null;
  const word = s.goalsFor > s.goalsAgainst ? "win" : "loss";
  return (
    <p className={styles.leftEarly}>
      You left before the match ended.{" "}
      <button type="button" className={panels.button} disabled={patch.isPending} onClick={() => set(true)}>
        Count it as a {word}
      </button>
      <HelpTip about="leaving early">
        If the result was already settled when you left (your teammates had gone, or there was no coming back), count the match as the {word} its score
        shows. It then counts in your record like any other {word}, and Whiff keeps the choice when recordings are imported again. You can change it back.
      </HelpTip>
      {failed}
    </p>
  );
}
