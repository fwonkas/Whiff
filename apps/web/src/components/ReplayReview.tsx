import { useId, useState, type ReactNode } from "react";
import type { ReviewMoment, SessionReplay } from "@rl/api-contract";
import { ReplayAction } from "./ReplayAction.tsx";
import { LAUNCHING_TEXT, useWatchControls } from "../lib/replay-controls.ts";
import {
  useFetchReplayFromBallchasing,
  useLaunchGame,
  useReplayGoto,
  useReview,
  useSettings,
} from "../lib/api.tsx";
import { useSharedLiveStatus } from "../lib/live.ts";
import { formatClock } from "../lib/format.ts";
import styles from "./ReplayReview.module.css";

/**
 * Replay review for one match: its goals, each with a button that makes
 * Rocket League load the saved replay and start a few seconds before the
 * goal. Goals against come first because they're what review is for (build
 * plan step 5: review a session's conceded goals in under five minutes).
 */

/** Lead times offered; the settings file's replayLeadSeconds is the default and is always offered. */
const LEADS = [3, 6, 10, 15];
const CAMERAS = [
  { value: "mine", label: "My car" },
  { value: "director", label: "Director" },
] as const;
type Camera = (typeof CAMERAS)[number]["value"];

export function ReplayReview({
  sessionId,
  replay: listed = null,
}: {
  sessionId: string;
  replay?: SessionReplay | null;
}) {
  // The match's Watch button (or "Save in game" flag) sits in the card's title row.
  const action = <ReplayAction replay={listed} what="this match" />;
  const replayState = replayStatusText(listed);
  const {
    shown: controlsShown,
    enabled: watchEnabled,
    mode: watchMode,
  } = useWatchControls();
  const { data, isPending, isError, error } = useReview(sessionId);
  const goto = useReplayGoto();
  const download = useFetchReplayFromBallchasing(sessionId);
  const live = useSharedLiveStatus();
  const launch = useLaunchGame();
  // Unknown (no shell around this) counts as running; the collector answers either way.
  const gameRunning = live === null || live.gameConnected;
  const [onlyAgainst, setOnlyAgainst] = useState(true);
  const settings = useSettings();
  const defaultLead = settings.data?.replayLeadSeconds ?? 10;
  const [chosenLead, setLead] = useState<number | null>(null);
  const lead = chosenLead ?? defaultLead;
  const leads = [...new Set([...LEADS, defaultLead])].sort((a, b) => a - b);
  const [camera, setCamera] = useState<Camera>("mine");
  const [watching, setWatching] = useState<string | null>(null);
  const leadId = useId();
  const cameraId = useId();

  if (isPending) return <Card action={action} status={replayState}>Loading…</Card>;
  if (isError)
    return (
      <Card action={action} status={replayState}>
        Couldn’t load the replay review: {error.message}
      </Card>
    );

  const { replay, moments } = data;
  const against = moments.filter((m) => m.kind === "goal-against");
  const shown = onlyAgainst ? against : moments;

  if (!moments.length)
    return <Card action={action} status={replayState}>No goals in this match.</Card>;

  const canWatch = !!replay?.saved && controlsShown;
  const watch = (m: ReviewMoment) => {
    if (!replay || m.frame === null) return;
    setWatching(m.id);
    goto.mutate({
      replayId: replay.replayId,
      frame: m.frame,
      leadSeconds: lead,
      camera,
      launch: !gameRunning,
    });
  };

  const again = settings.data?.replayAgainShortcut;
  const afterJump = `It pauses after the goal${again ? `; ${again} goes back to the start` : ""}.`;
  const result = goto.data;
  const status = goto.isPending
    ? "Asking Rocket League…"
    : goto.isError
      ? `Couldn’t reach the collector: ${goto.error.message}`
      : result && !result.ok
        ? `Can’t jump to it: ${result.reason}.`
        : result?.ok
          ? result.status === "launching"
            ? `${LAUNCHING_TEXT} ${afterJump}`
            : result.status === "loading"
              ? `Loading the replay in Rocket League. It jumps to the goal once it’s open. ${afterJump}`
              : `Jumped to the goal in Rocket League. ${afterJump}`
          : "";

  return (
    <Card action={action} status={replayState}>
      <div className={styles.controls}>
        <div className={styles.toggle} role="group" aria-label="Which goals">
          <button
            type="button"
            aria-pressed={onlyAgainst}
            onClick={() => setOnlyAgainst(true)}
          >
            Goals against <span className="num">{against.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={!onlyAgainst}
            onClick={() => setOnlyAgainst(false)}
          >
            All goals <span className="num">{moments.length}</span>
          </button>
        </div>
        {canWatch && (
          <div className={styles.options}>
            <label className={styles.lead} htmlFor={cameraId}>
              Camera
              <select
                id={cameraId}
                value={camera}
                onChange={(e) => setCamera(e.target.value as Camera)}
              >
                {CAMERAS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.lead} htmlFor={leadId}>
              Start
              <select
                id={leadId}
                value={lead}
                onChange={(e) => setLead(Number(e.target.value))}
              >
                {leads.map((s) => (
                  <option key={s} value={s}>
                    {s} s
                  </option>
                ))}
              </select>
              before
            </label>
          </div>
        )}
      </div>

      {!replay && (
        <p className="muted">
          No saved replay of this match.{" "}
          {settings.data?.ballchasing
            ? "Get it from your ballchasing uploads, or save it"
            : "Save it"}{" "}
          from Match History in the game to review it here.
        </p>
      )}
      {replay && !replay.saved && (
        <p className="muted">
          The replay file isn’t in your replays folder any more, so the game
          can’t open it.
        </p>
      )}
      {canWatch && !gameRunning && watchMode !== "launch" && (
        <p className={`muted ${styles.fetch}`}>
          Start Rocket League to watch these goals.
          {settings.data?.canLaunchGame && (
            <button
              type="button"
              className={styles.watch}
              onClick={() => launch.mutate()}
              disabled={launch.isPending}
            >
              {launch.isPending ? "Launching…" : "Launch Rocket League"}
            </button>
          )}
        </p>
      )}
      {!canWatch && settings.data?.ballchasing && (
        <div className={styles.fetch}>
          <button
            type="button"
            className={styles.watch}
            onClick={() => download.mutate()}
            disabled={download.isPending}
          >
            {download.isPending
              ? "Looking on ballchasing…"
              : "Get it from ballchasing"}
          </button>
          <span className="muted" role="status">
            {download.isError
              ? `Couldn’t reach the collector: ${download.error.message}`
              : download.data && !download.data.ok
                ? `Couldn’t get it: ${download.data.reason}.`
                : ""}
          </span>
        </div>
      )}

      {shown.length ? (
        <ol className={styles.moments}>
          {shown.map((m) => (
            <li key={m.id} className={styles.moment} data-kind={m.kind}>
              <span className={`${styles.clock} num`}>
                {formatClock(m.matchTime)}
              </span>
              <span className={styles.what}>
                <strong>
                  {m.kind === "goal-against" ? "Conceded" : "Scored"}
                </strong>
                {m.playerName && (
                  <span className="muted"> · {m.playerName}</span>
                )}
              </span>
              {canWatch && (
                <button
                  type="button"
                  className={styles.watch}
                  onClick={() => watch(m)}
                  disabled={
                    m.frame === null ||
                    !watchEnabled ||
                    (goto.isPending && watching === m.id)
                  }
                  aria-label={`Watch the ${m.kind === "goal-against" ? "goal conceded" : "goal scored"} at ${formatClock(m.matchTime)}`}
                >
                  {m.frame === null ? "No frame" : "Watch"}
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No goals against in this match.</p>
      )}

      <p className={styles.status} role="status" aria-live="polite">
        {status}
      </p>
    </Card>
  );
}

function Card({
  children,
  action,
  status,
}: {
  children: ReactNode;
  action: ReactNode;
  status: string | null;
}) {
  return (
    <section
      className={`card ${styles.section}`}
      aria-labelledby="replay-review-title"
    >
      <div className={styles.head}>
        <h2 id="replay-review-title" className={styles.title}>
          Replay review
        </h2>
        {action}
      </div>
      {status && <p className={`muted ${styles.status}`}>{status}</p>}
      {children}
    </section>
  );
}

/** Where the match's replay stands, in a few words: saved and played, still in Match History, or gone. */
function replayStatusText(r: SessionReplay | null): string | null {
  if (!r) return null;
  if (r.state === "saved") return r.played ? "Replay saved · played through" : "Replay saved · not played through yet";
  if (r.state === "in-history" && r.history)
    return `Only in Match History · #${r.history.position} of 20, ${r.history.daysLeft} ${r.history.daysLeft === 1 ? "day" : "days"} left`;
  return r.played ? "No saved replay · was played through" : null;
}
