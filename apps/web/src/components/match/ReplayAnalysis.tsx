import { useState } from "react";
import type { DetailPlayer } from "@rl/api-contract";
import type {
  PlayerReplayMetrics,
  ReplayAnalysis as Analysis,
  ReplayMoment,
} from "@rl/metrics";
import { useReplayAnalysis, useReplayGoto } from "../../lib/api.tsx";
import { LAUNCHING_TEXT, useWatchControls } from "../../lib/replay-controls.ts";
import { useSharedLiveStatus } from "../../lib/live.ts";
import { formatClock } from "../../lib/format.ts";
import styles from "./match.module.css";
import review from "../ReplayReview.module.css";

/**
 * Positioning, boost and challenges for every player, from the match's
 * saved replay (subtr-actor), and my moments worth a second look, each a
 * jump into the replay in the game.
 */
export function ReplayAnalysis({
  sessionId,
  players,
  myTeam,
}: {
  sessionId: string;
  players: DetailPlayer[];
  myTeam: number | null;
}) {
  const { data, isPending, isError, error } = useReplayAnalysis(sessionId);
  if (isPending || data?.state === "no-replay") return null;
  return (
    <section className={`card ${styles.card}`} aria-labelledby="analysis-title">
      <div className={styles.cardHead}>
        <h2 id="analysis-title" className={styles.cardTitle}>
          Positioning, boost and challenges
        </h2>
        <span className={`muted ${styles.caption}`}>From the saved replay</span>
      </div>
      {isError ? (
        <p className="muted">Couldn’t load the analysis: {error.message}</p>
      ) : data.state === "pending" ? (
        <p className="muted" role="status">
          The replay is waiting to be analyzed. Replays are analyzed one at a
          time, a few seconds each, and not while you’re playing.
        </p>
      ) : data.state === "failed" ? (
        <p className="muted">
          Couldn’t analyze the replay: {data.error}. It’s tried again when the
          analyzer is updated.
        </p>
      ) : (
        <>
          <MetricsTable
            analysis={data.analysis}
            players={players}
            myTeam={myTeam}
          />
          <Moments
            analysis={data.analysis}
            replayId={data.replayId}
            players={players}
          />
        </>
      )}
    </section>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function MetricsTable({
  analysis,
  players,
  myTeam,
}: {
  analysis: Analysis;
  players: DetailPlayer[];
  myTeam: number | null;
}) {
  const isMe = (p: PlayerReplayMetrics) =>
    players.some((d) => d.key === p.primaryId && d.isMe);
  // The names the rest of the page uses (the recording's), the replay's otherwise.
  const nameOf = (p: PlayerReplayMetrics) =>
    players.find((d) => d.key === p.primaryId)?.name ?? p.name;
  // Positioning shares mean nothing without teammates.
  const solo = analysis.teamSize === 1;
  const teams = [...new Set(analysis.players.map((p) => p.team))].sort(
    (a, b) => (a === myTeam ? -1 : b === myTeam ? 1 : a - b),
  );
  const groups = [
    ...(solo ? [] : [{ label: "Positioning", span: 2 }]),
    { label: "Boost", span: 4 },
    { label: "Challenges", span: 3 },
  ];
  const columns: {
    key: string;
    short: string;
    title: string;
    value: (p: PlayerReplayMetrics) => string;
  }[] = [
    ...(solo
      ? []
      : [
          {
            key: "back",
            short: "Back",
            title: "Share of live play as your team’s last player back",
            value: (p: PlayerReplayMetrics) => pct(p.positioning.lastBack),
          },
          {
            key: "first",
            short: "1st man",
            title:
              "Share of live play as your team’s first man (closest in the play)",
            value: (p: PlayerReplayMetrics) => pct(p.positioning.firstMan),
          },
        ]),
    {
      key: "avg",
      short: "Avg",
      title: "Average boost during live play (0–100)",
      value: (p) => String(Math.round(p.boost.average)),
    },
    {
      key: "empty",
      short: "Empty",
      title: "Share of live play with no boost",
      value: (p) => pct(p.boost.empty),
    },
    {
      key: "big",
      short: "Big",
      title: "Big pads taken",
      value: (p) => String(p.boost.bigPads),
    },
    {
      key: "wasted",
      short: "Wasted",
      title: "Boost collected over 100 (pads taken when nearly full)",
      value: (p) => String(Math.round(p.boost.overfill)),
    },
    {
      key: "fifties",
      short: "50/50",
      title: "50/50s won–lost, outside kickoffs",
      value: (p) => `${p.challenges.fifties.won}–${p.challenges.fifties.lost}`,
    },
    {
      key: "races",
      short: "Races",
      title:
        "Races to the ball won–lost: you touched it first, or an opponent did while you were going for it",
      value: (p) => `${p.challenges.wonRace}–${p.challenges.beatenToBall}`,
    },
    {
      key: "whiffs",
      short: "Whiffs",
      title: "Attempts at the ball that missed it",
      value: (p) => String(p.challenges.whiffs),
    },
  ];
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <td className={styles.nameCol} />
            {groups.map((g) => (
              <th
                key={g.label}
                scope="colgroup"
                colSpan={g.span}
                className={styles.groupHead}
              >
                {g.label}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col" className={styles.nameCol}>
              Player
            </th>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="num">
                <abbr title={c.title}>{c.short}</abbr>
              </th>
            ))}
          </tr>
        </thead>
        {teams.map((team) => {
          const rows = analysis.players.filter((p) => p.team === team);
          const mine = team === myTeam;
          return (
            <tbody key={team} data-team={mine ? "us" : "them"}>
              <tr className={styles.teamRow}>
                <th
                  scope="rowgroup"
                  colSpan={columns.length + 1}
                  className={styles.nameCol}
                >
                  {mine ? "Your team" : "Opponents"}
                </th>
              </tr>
              {rows.map((p) => (
                <tr key={p.primaryId} data-me={isMe(p) || undefined}>
                  <th scope="row" className={styles.nameCol}>
                    <span className={styles.playerName}>
                      {nameOf(p)}
                      {isMe(p) && (
                        <span className="visually-hidden"> (you)</span>
                      )}
                    </span>
                  </th>
                  {columns.map((c) => (
                    <td key={c.key} className="num">
                      {c.value(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/** Moments about me worth reviewing: the misses, by default; all of mine on request. */
function Moments({
  analysis,
  replayId,
  players,
}: {
  analysis: Analysis;
  replayId: string;
  players: DetailPlayer[];
}) {
  const me = players.find((p) => p.isMe)?.key ?? null;
  const goto = useReplayGoto();
  const live = useSharedLiveStatus();
  const gameRunning = live === null || live.gameConnected;
  const [onlyMisses, setOnlyMisses] = useState(true);
  const { shown: controlsShown, enabled: watchEnabled } = useWatchControls();
  const [watching, setWatching] = useState<number | null>(null);
  if (!me) return null;
  const name = (id: string | null) =>
    id
      ? (players.find((p) => p.key === id)?.name ??
        analysis.players.find((p) => p.primaryId === id)?.name ??
        "someone")
      : "someone";

  const describe = (
    m: ReplayMoment,
  ): { text: string; miss: boolean } | null => {
    switch (m.kind) {
      case "whiff":
        return m.player === me ? { text: "Whiffed", miss: true } : null;
      case "beaten":
        if (m.player === me)
          return { text: `Beaten to the ball by ${name(m.other)}`, miss: true };
        return m.other === me
          ? { text: `Beat ${name(m.player)} to the ball`, miss: false }
          : null;
      case "fifty":
        if (m.player !== me) return null;
        return m.won === false
          ? { text: `Lost a 50/50 to ${name(m.other)}`, miss: true }
          : {
              text: m.won
                ? `Won a 50/50 against ${name(m.other)}`
                : `Even 50/50 with ${name(m.other)}`,
              miss: false,
            };
      case "demo":
        if (m.other === me)
          return { text: `Demoed by ${name(m.player)}`, miss: true };
        return m.player === me
          ? { text: `Demoed ${name(m.other)}`, miss: false }
          : null;
      case "conceded-last-back":
        return m.player === me
          ? {
              text: `Conceded while you were last back (${name(m.other)} scored)`,
              miss: true,
            }
          : null;
      default:
        return null;
    }
  };
  const mine = analysis.moments.flatMap((m, i) => {
    const d = describe(m);
    return d ? [{ ...m, ...d, i }] : [];
  });
  const shown = onlyMisses ? mine.filter((m) => m.miss) : mine;
  const misses = mine.filter((m) => m.miss).length;

  const result = goto.data;
  const status = goto.isPending
    ? "Asking Rocket League…"
    : goto.isError
      ? `Couldn’t reach the collector: ${goto.error.message}`
      : result && !result.ok
        ? `Can’t jump to it: ${result.reason}.`
        : result?.ok
          ? result.status === "launching"
            ? LAUNCHING_TEXT
            : result.status === "loading"
              ? "Loading the replay in Rocket League. It jumps there once it’s open."
              : "Jumped there in Rocket League, 5 seconds before."
          : "";

  return (
    <div className={styles.momentsBlock}>
      <div className={review.controls}>
        <h3 className={styles.subTitle}>Your moments</h3>
        <div className={review.toggle} role="group" aria-label="Which moments">
          <button
            type="button"
            aria-pressed={onlyMisses}
            onClick={() => setOnlyMisses(true)}
          >
            To review <span className="num">{misses}</span>
          </button>
          <button
            type="button"
            aria-pressed={!onlyMisses}
            onClick={() => setOnlyMisses(false)}
          >
            All <span className="num">{mine.length}</span>
          </button>
        </div>
      </div>
      {shown.length ? (
        <ol className={`${review.moments} ${styles.momentList}`}>
          {shown.map((m) => (
            <li
              key={m.i}
              className={review.moment}
              data-kind={m.miss ? "goal-against" : "goal-for"}
            >
              <span className={`${review.clock} num`}>
                {formatClock(m.matchTime)}
              </span>
              <span className={review.what}>
                <strong>{m.text}</strong>
              </span>
              {controlsShown && (
                <button
                  type="button"
                  className={review.watch}
                  disabled={
                    !watchEnabled || (goto.isPending && watching === m.i)
                  }
                  title={
                    gameRunning || watchEnabled
                      ? undefined
                      : "Start Rocket League to watch it"
                  }
                  onClick={() => {
                    setWatching(m.i);
                    goto.mutate({
                      replayId,
                      frame: m.frame,
                      leadSeconds: 5,
                      launch: !gameRunning,
                    });
                  }}
                  aria-label={`Watch: ${m.text}, ${formatClock(m.matchTime)}`}
                >
                  Watch
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">Nothing to review here.</p>
      )}
      <p className={review.status} role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
