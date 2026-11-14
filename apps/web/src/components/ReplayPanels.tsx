import { useId, useRef } from "react";
import { Link } from "@tanstack/react-router";
import type { ReplayMatchItem, ReplaysResponse } from "@rl/api-contract";
import { useConfig, usePatchConfig, useReplayActions, useReplays, useSettings } from "../lib/api.tsx";
import { formatDay, formatMinutes, formatTime, playlistShort, resultLabel } from "../lib/format.ts";
import styles from "./ReplayPanels.module.css";

/**
 * Where the replays stand and what to do about them, in Settings → Game &
 * replays: matches about to leave Match History, the counts, and playing
 * saved replays.
 */
export function ReplaysOverview() {
  const { data } = useReplays();
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className={styles.body}>
      <AtRisk data={data} />
      <Counts data={data} />
      <PlayPanel data={data} />
    </div>
  );
}

/** Downloading missing replays from ballchasing, in Settings → Ballchasing. */
export function BallchasingFetch() {
  const { data } = useReplays();
  if (!data) return null;
  return (
    <div className={styles.body}>
      <BallchasingPanel data={data} />
    </div>
  );
}

/**
 * On Sessions, only when something needs doing soon: one line, pointing to
 * where the list is (Settings → Game & replays).
 */
export function AtRiskLine() {
  const { data } = useReplays();
  const n = data?.counts.atRisk ?? 0;
  if (!n) return null;
  return (
    <p className={`notice ${styles.atRiskLine}`}>
      {n === 1 ? "A match is" : `${n} matches are`} about to leave Match History without a saved replay.{" "}
      <Link to="." search={(prev: Record<string, unknown>) => prev} hash="settings/game">
        See which
      </Link>
    </p>
  );
}

function historyText(m: ReplayMatchItem): string {
  if (!m.history) return "";
  const { position, daysLeft } = m.history;
  return `#${position} of 20 in Match History, ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;
}

function AtRisk({ data }: { data: ReplaysResponse }) {
  const risky = data.matches.filter((m) => m.history?.atRisk);
  if (!risky.length) return null;
  return (
    <section className="notice" aria-labelledby="at-risk-title">
      <h3 id="at-risk-title" className={styles.noticeTitle}>
        {risky.length === 1 ? "A match is" : `${risky.length} matches are`} about to leave Match History without a saved replay
      </h3>
      <p className={`${styles.noticeText} ${styles.small}`}>In Rocket League, open Match History, choose the match and save its replay.</p>
      <ul className={styles.riskList}>
        {risky.map((m) => (
          <li key={m.sessionId}>
            <Link to="/sessions/$id" params={{ id: m.sessionId }}>
              {formatDay(m.startedAt)}, {formatTime(m.startedAt)}
            </Link>{" "}
            · {playlistShort(m.playlistId, m.playlistName)} · {resultLabel(m.outcome)} {m.goalsFor ?? "?"}–{m.goalsAgainst ?? "?"}
            {m.history && (
              <span title={historyText(m)}>
                {" "}
                · {m.history.daysLeft} {m.history.daysLeft === 1 ? "day" : "days"} left
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Counts({ data }: { data: ReplaysResponse }) {
  const c = data.counts;
  const rows = [
    { label: "Saved replays", value: c.saved, hint: "the game can open these" },
    { label: "Played through", value: c.played, hint: "opponents’ car data and boost pickups are in" },
    { label: "Only in Match History", value: c.inHistory, hint: c.atRisk ? `${c.atRisk} about to drop out` : "save them in the game" },
    { label: "No replay", value: c.missing, hint: "out of Match History" },
  ];
  return (
    <dl className={styles.counts} aria-label="Replay counts">
      {rows.map((r) => (
        <div key={r.label} style={{ display: "contents" }}>
          <dt>
            {r.label}
            <span className={styles.countHint}>{r.hint}</span>
          </dt>
          <dd className="num">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlayPanel({ data }: { data: ReplaysResponse }) {
  return (
    <section className={styles.body} aria-labelledby="play-title">
      <h3 id="play-title" className={styles.sectionTitle}>
        Play saved replays
      </h3>
      <PlayControls data={data} />
    </section>
  );
}

/**
 * What there is to play and the buttons for it, or the run's progress and
 * Stop. With "Quit Rocket League when done" where the app can close the game
 * (the desktop app): the last choice is remembered, and it can be changed
 * while the replays play.
 */
function PlayControls({ data }: { data: ReplaysResponse }) {
  const { play, stop, quitWhenDone } = useReplayActions();
  const canQuit = useSettings().data?.canQuitGame === true;
  const config = useConfig();
  const patch = usePatchConfig();
  const quitId = useId();
  const needsGameId = useId();
  const b = data.backfill;
  const { unrecorded, recorded, seconds } = data.toPlay;
  const total = unrecorded + recorded;
  const quit = canQuit && (b.running ? b.quitWhenDone : (config.data?.ui.quitAfterReplays ?? false));
  const setQuit = (on: boolean) => {
    patch.mutate({ ui: { quitAfterReplays: on } });
    if (b.running) quitWhenDone.mutate(on);
  };
  const quitToggle = canQuit && (
    <label className={styles.check} htmlFor={quitId}>
      <input id={quitId} type="checkbox" checked={quit} onChange={(e) => setQuit(e.target.checked)} />
      <span>Quit Rocket League when done</span>
    </label>
  );
  const failure = play.data && !play.data.ok ? play.data.reason : play.isError ? play.error.message : null;
  // Real time plus loading and countdowns: the backfill's own estimate once it runs.
  const estimate = seconds ? formatMinutes(seconds + total * 20) : null;
  if (b.running) {
    return (
      <>
        <p className={styles.panelText} role="status">
          {playingText(b)}.
        </p>
        {quitToggle}
        <div className={styles.buttons}>
          <button type="button" className={styles.button} onClick={() => stop.mutate()} disabled={stop.isPending}>
            Stop
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      {total === 0 ? (
        <p className={styles.panelText}>Every saved replay has been played through.</p>
      ) : (
        <ul className={styles.riskList}>
          {unrecorded > 0 && (
            <li>
              {unrecorded} never recorded: {unrecorded === 1 ? "becomes a new match" : "become new matches"}
            </li>
          )}
          {recorded > 0 && (
            <li>
              {recorded} recorded: {recorded === 1 ? "adds" : "add"} opponents’ data, at 2x
            </li>
          )}
          {estimate && <li>About {estimate}</li>}
        </ul>
      )}
      {total > 0 && quitToggle}
      {/* A wrapper carries the hint: disabled buttons don't show hover text in every browser. */}
      <div className={styles.buttons} title={!data.gameConnected && total > 0 ? "Start Rocket League to play them" : undefined}>
        {unrecorded > 0 && (
          <button
            type="button"
            className={styles.button}
            data-kind="primary"
            onClick={() => play.mutate({ all: false, quitWhenDone: quit })}
            disabled={!data.gameConnected || play.isPending}
          >
            Play new matches
          </button>
        )}
        {total > 0 && (
          <button
            type="button"
            className={styles.button}
            data-kind={unrecorded > 0 ? undefined : "primary"}
            onClick={() => play.mutate({ all: true, quitWhenDone: quit })}
            disabled={!data.gameConnected || play.isPending}
            aria-describedby={!data.gameConnected ? needsGameId : undefined}
          >
            Play all {total}
          </button>
        )}
        {!data.gameConnected && total > 0 && (
          <span id={needsGameId} className="visually-hidden">
            Start Rocket League to play them.
          </span>
        )}
      </div>
      {failure && (
        <p className={styles.failure} role="status">
          Couldn’t start: {failure}.
        </p>
      )}
    </>
  );
}

function playingText(b: ReplaysResponse["backfill"]): string {
  const left = b.remainingMs !== null ? ` · about ${formatMinutes(b.remainingMs / 1000)} left` : "";
  return `Playing replay ${b.done + b.failed + 1} of ${b.done + b.failed + b.remaining + 1}${left}`;
}

/**
 * In the header, next to the game's status: how many saved replays are left
 * to play, opening the same controls as Settings → Game & replays; the run's
 * progress while it plays. Not there when there's nothing to play.
 */
export function HeaderPlay({ className }: { className?: string }) {
  const { data } = useReplays();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  if (!data) return null;
  const b = data.backfill;
  const total = data.toPlay.unrecorded + data.toPlay.recorded;
  if (!b.running && total === 0) return null;
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    const p = panel.current;
    if (!r || !p) return;
    p.style.top = `${r.bottom + 6}px`;
    p.style.left = `${Math.max(8, Math.min(r.right - p.offsetWidth, window.innerWidth - p.offsetWidth - 8))}px`;
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${styles.headerPlay} ${className ?? ""}`}
        popoverTarget={id}
        data-running={b.running || undefined}
        aria-label={b.running ? `${playingText(b)}. Options` : `Play saved replays: ${total} to play`}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
        </svg>
        {b.running ? (
          <span className="num">
            Replay {b.done + b.failed + 1} of {b.done + b.failed + b.remaining + 1}
          </span>
        ) : (
          <span className="num">Play {total}</span>
        )}
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="group"
        aria-label="Play saved replays"
        className={styles.playPopover}
        onToggle={(e) => (e as unknown as ToggleEvent).newState === "open" && place()}
      >
        <h3 className={styles.sectionTitle}>Play saved replays</h3>
        <PlayControls data={data} />
      </div>
    </>
  );
}

function BallchasingPanel({ data }: { data: ReplaysResponse }) {
  const { ballchasing } = useReplayActions();
  const bc = data.ballchasing;
  const missing = data.counts.missing + data.counts.inHistory;
  const failure = ballchasing.data && !ballchasing.data.ok ? ballchasing.data.reason : ballchasing.isError ? ballchasing.error.message : null;
  return (
    <>
      {!bc.configured ? (
        <p className={styles.panelText}>
          Replays you uploaded to ballchasing.com can fill the gaps once your API key is added above.
        </p>
      ) : bc.running ? (
        <p className={styles.panelText} role="status">
          Checked {bc.done} of {bc.total} · downloaded {bc.found}.
        </p>
      ) : (
        <>
          <p className={styles.panelText}>
            {missing
              ? `${missing} ${missing === 1 ? "match has" : "matches have"} no saved replay. Ballchasing has the ones you uploaded.`
              : "Every match has a saved replay."}
            {bc.total > 0 && ` Last run: downloaded ${bc.found} of ${bc.total}.`}
          </p>
          {missing > 0 && (
            <div className={styles.buttons}>
              <button type="button" className={styles.button} data-kind="primary" onClick={() => ballchasing.mutate()} disabled={ballchasing.isPending}>
                Get missing replays
              </button>
            </div>
          )}
        </>
      )}
      {failure && (
        <p className={styles.failure} role="status">
          Couldn’t start: {failure}.
        </p>
      )}
      {bc.upload.enabled && <UploadLine upload={bc.upload} />}
    </>
  );
}

/** Auto-upload of saved replays: what's left and anything holding it up. */
function UploadLine({ upload }: { upload: ReplaysResponse["ballchasing"]["upload"] }) {
  const sent = upload.uploaded ? `Uploaded ${upload.uploaded} since the app started. ` : "";
  return (
    <p className={`${styles.panelText} ${styles.small}`} role="status">
      {upload.waiting
        ? `${sent}Upload paused: ${upload.waiting}. It tries again later.`
        : upload.pending
          ? `${sent}Uploading saved replays: ${upload.pending} to go.`
          : upload.uploaded
            ? `${sent}Every saved replay is on ballchasing.`
            : "New saved replays upload to ballchasing automatically."}
    </p>
  );
}
