import type { ReactNode } from "react";
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Record3, SessionColumn, SessionListItem, SummaryResponse } from "@rl/api-contract";
import { FilterChips } from "../components/FilterChips.tsx";
import { useReplayControlsShown } from "../lib/replay-controls.ts";
import { ReplayAction } from "../components/ReplayAction.tsx";
import { StarToggle } from "../components/StarToggle.tsx";
import { TagList } from "../components/Tags.tsx";
import { HelpTip } from "../components/HelpTip.tsx";
import { AtRiskLine } from "../components/ReplayPanels.tsx";
import { useConfig, useSessions, useSummary } from "../lib/api.tsx";
import { gridVars, useColumns } from "../lib/columns.ts";
import { cachedUi } from "../lib/ui-prefs.ts";
import {
  arenaName,
  dayKey,
  formatDay,
  formatMinutes,
  formatPercent,
  formatTime,
  playlistShort,
  resultLabel,
} from "../lib/format.ts";
import styles from "./SessionsPage.module.css";
import { rangeOf } from "../lib/date-range.ts";

/**
 * The worked example for the other screens: filters from the URL, data from
 * query hooks, loading/error/empty states, and one markup that lays out as a
 * table on wide screens and as two-line cards on phones (CSS grid areas).
 */

const route = getRouteApi("/sessions");

export function SessionsPage() {
  const filters = route.useSearch();
  const config = useConfig();
  const pageSize = config.data?.ui.sessionsPageSize ?? cachedUi().sessionsPageSize;
  // A filter that narrows to matches (dates don't: practice in range still shows).
  const matchesOnly =
    filters.teamSize !== undefined ||
    filters.with !== undefined ||
    filters.playlist !== undefined ||
    filters.result !== undefined ||
    filters.replay !== undefined ||
    filters.starred !== undefined ||
    filters.tag !== undefined;
  const filtered = matchesOnly || filters.from !== undefined || filters.to !== undefined;
  const q = {
    teamSize: filters.teamSize,
    playlist: filters.playlist,
    with: filters.with,
    result: filters.result,
    replay: filters.replay,
    starred: filters.starred,
    tag: filters.tag,
    ...rangeOf(filters),
  };
  // Without a match filter, practice comes along too, for the per-day practice minutes.
  const sessions = useSessions({ kind: matchesOnly ? "match" : "all", ...q, limit: pageSize });
  const summary = useSummary(q);

  const items = sessions.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <main className={`page ${styles.page}`}>
      <div className={styles.titleRow}>
        <h1 className="page-title">Sessions</h1>
        {summary.data && <SummaryLine summary={summary.data} />}
      </div>

      <div className={styles.columns}>
        <div className={styles.main}>
          <FilterChips to="/sessions" current={filters} extras menus />

          {sessions.isPending ? (
        <p className="muted">Loading sessions…</p>
      ) : sessions.isError ? (
        <p role="alert" className="notice">
          Couldn’t load sessions: {sessions.error.message}. Is the collector running?
        </p>
      ) : items.filter((s) => s.kind === "match").length === 0 ? (
        <p className="muted">No matches{filtered ? " for these filters" : " yet. Play one with the collector running"}.</p>
      ) : (
        <SessionList
          items={items}
          more={{ has: sessions.hasNextPage, loading: sessions.isFetchingNextPage, load: () => void sessions.fetchNextPage() }}
        />
          )}
        </div>
        {summary.data && (
          <aside className={styles.side}>
            <SummaryCards summary={summary.data} filters={filters} matchesOnly={matchesOnly} />
            <AtRiskLine />
          </aside>
        )}
      </div>
    </main>
  );
}

function SummaryLine({ summary }: { summary: SummaryResponse }) {
  if (!summary.firstStartedAt || !summary.lastStartedAt) return null;
  return (
    <div className="muted" style={{ fontSize: 14 }}>
      {formatDay(summary.firstStartedAt)} – {formatDay(summary.lastStartedAt)} · {summary.matches} matches ·{" "}
      {formatMinutes(summary.practiceSeconds)} practice
    </div>
  );
}

const winLoss = (r: Record3) => `${r.wins}–${r.losses}`;
const left = (r: Record3) => (r.abandoned ? `${r.abandoned} left early` : "");
const any = (r: Record3) => r.wins + r.losses + r.abandoned > 0;
const decided = (r: Record3) => r.wins + r.losses > 0;
const rate = (r: Record3) => r.wins / (r.wins + r.losses);

/**
 * Cards about the matches the list shows, every filter applied. A card that
 * says nothing here is left out: Solo · With teammates when the teammates
 * chip already picks one (or one side has no decided matches), Practice under
 * a filter that lists only matches.
 */
function SummaryCards({
  summary,
  filters,
  matchesOnly,
}: {
  summary: SummaryResponse;
  filters: { with?: "solo" | "party"; result?: "win" | "loss" | "mvp" };
  matchesOnly: boolean;
}) {
  const { record } = summary;
  const stats = summary.stats as SummaryResponse["stats"] | undefined;
  const done = record.wins + record.losses;
  const mvpBadge = (of: number) =>
    of > 0 && (
      <span className="mvp" title="Share of the wins where you were MVP">
        {formatPercent(summary.mvps / of)} MVP
      </span>
    );
  // The Record card says what's worth saying for the result picked: a win rate means nothing among wins only.
  const recordCard =
    filters.result === "win"
      ? { label: "Wins", value: String(record.wins), sub: <span className={styles.recordSub}>{mvpBadge(summary.mvpWins)}</span> }
      : filters.result === "loss"
        ? {
            label: "Losses",
            value: String(record.losses),
            sub: stats ? (stats.margins.lostByOne ? `${stats.margins.lostByOne} by one goal` : "none by one goal") : "",
          }
        : filters.result === "mvp"
          ? {
              label: "MVP",
              value: String(summary.mvps),
              sub: summary.mvpWins ? `${formatPercent(summary.mvps / summary.mvpWins)} of ${summary.mvpWins} wins` : "",
            }
          : {
              label: "Record",
              value: winLoss(record),
              // Styled like the list's W pill and MVP badge; MVP is out of the wins (it goes to a winner), not counting 1s.
              sub: (
                <span className={styles.recordSub}>
                  {done > 0 && (
                    <span className="result" data-outcome="win">
                      {formatPercent(record.wins / done)} won
                    </span>
                  )}
                  {mvpBadge(summary.mvpWins)}
                  {left(record) && <span>{left(record)}</span>}
                </span>
              ),
            };
  const cards: { label: string; value: ReactNode; sub: ReactNode; wide?: boolean; help?: ReactNode }[] = [
    ...(any(record) ? [recordCard] : []),
    // Solo against with known teammates, as win rates (the Record card already has the totals); not among wins or losses only.
    ...(filters.with === undefined && filters.result === undefined && decided(summary.solo) && decided(summary.partied)
      ? [
          {
            label: "Solo · With teammates",
            // Two lines: the pair doesn't fit one line at card width (2026-11-06).
            value: (
              <span className={styles.splitValue}>
                <span>
                  <span className={styles.splitLabel}>Solo</span>
                  {formatPercent(rate(summary.solo))}
                </span>
                <span>
                  <span className={styles.splitLabel}>Teammates</span>
                  {formatPercent(rate(summary.partied))}
                </span>
              </span>
            ),
            sub: (
              <>
                <span className={styles.subLine}>won {winLoss(summary.solo)} solo</span>
                <span className={styles.subLine}>{winLoss(summary.partied)} with teammates</span>
              </>
            ),
          },
        ]
      : []),
    // (A summary without stats, from an older collector, just leaves these out.)
    ...(stats && stats.decided > 0 ? [closeGamesCard(stats, filters.result)] : []),
    ...(stats && stats.decided > 0
      ? [
          {
            label: "Per match",
            value: <PerMatchTable stats={stats} />,
            sub: "",
            wide: true,
            help: (
              <>
                <p>Your numbers in an average match, over the {stats.decided} won or lost matches listed (matches left early aren’t counted).</p>
                <p>
                  Mean: the total divided by the number of matches. Median: the middle match, half above and half below, so one huge game doesn’t pull
                  it around. A mean well above the median means a few big games carry it.
                </p>
                <p>Touch share: your touches out of everyone’s on your team.</p>
              </>
            ),
          },
        ]
      : []),
    ...(summary.replayStats && summary.replayStats.matches > 0 ? [replayCard(summary.replayStats)] : []),
    ...(!matchesOnly && summary.practiceSeconds > 0 ? [{ label: "Practice", value: formatMinutes(summary.practiceSeconds), sub: "freeplay and training" }] : []),
  ];
  if (!cards.length) return null;
  return (
    <section aria-label="Summary" className={styles.cards}>
      {cards.map((c) => (
        <div key={c.label} className={`card ${styles.cardItem}`} data-wide={c.wide || undefined}>
          <div className={`muted ${styles.cardLabel}`}>
            <span>{c.label}</span>
            {c.help && <HelpTip about={c.label}>{c.help}</HelpTip>}
          </div>
          {c.wide ? c.value : <div className={`num ${styles.cardValue}`}>{c.value}</div>}
          {c.sub && (
            <div className="muted" style={{ fontSize: 13 }}>
              {c.sub}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

/** How close the matches were: one-goal games, the average goal margin, and overtime. */
function closeGamesCard(stats: SummaryResponse["stats"], result: "win" | "loss" | "mvp" | undefined) {
  const { margins, overtime, decided: n } = stats;
  const diff = margins.meanDiff ?? 0;
  const oneGoal = result === "win" ? margins.wonByOne : result === "loss" ? margins.lostByOne : margins.oneGoal;
  const which = result === "win" ? "wins" : result === "loss" ? "losses" : "matches";
  const margin = `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(diff).toFixed(1)}`;
  // Among wins or losses only, the OT record would just repeat the filter.
  const otRecord = result === undefined && overtime.matches > 0 ? ` (${overtime.wins}–${overtime.losses})` : "";
  const otTitle =
    overtime.matches > 0
      ? `${overtime.matches} of ${n} ${which} went to overtime${otRecord ? `: you won ${overtime.wins} and lost ${overtime.losses}` : ""}`
      : `None of the ${n} ${which} went to overtime`;
  return {
    label: "Close games",
    value: `${formatPercent(oneGoal / n)}`,
    sub: (
      <>
        <span className={styles.subLine} title={`Your team’s goals minus the other team’s, averaged over the ${n} ${which}`}>
          Goal margin {margin}
        </span>
        <span className={styles.subLine} title={otTitle}>
          OT: {formatPercent(overtime.matches / n)}
          {otRecord}
        </span>
      </>
    ),
    help: (
      <>
        <p>
          The share of the {n} {which} listed that ended {result === "win" ? "in a win " : result === "loss" ? "in a loss " : ""}by one goal:{" "}
          {oneGoal} of them. Matches left early aren’t counted.
        </p>
        <p>Overtime always ends on one goal, so the matches that went to overtime are in this share too.</p>
      </>
    ),
  };
}

/** Replay analysis (subtr-actor) over the listed matches that have it: boost, positioning, 50/50s and races. */
function replayCard(r: SummaryResponse["replayStats"]) {
  const { fifties, races } = r;
  const share = (won: number, lost: number) => (won + lost > 0 ? formatPercent(won / (won + lost)) : "–");
  const from = r.matches === r.of ? `From all ${r.of} matches` : `From ${r.matches} of ${r.of} matches`;
  return {
    label: "From replays",
    value: (
      <>
        <CenterTable
          rows={[
            { key: "boost", label: "Average boost", center: r.perMatch.boost, whole: true },
            { key: "empty", label: "No boost", center: r.perMatch.boostEmpty, pct: true },
            { key: "back", label: "Last back", center: r.perMatch.lastBack, pct: true },
          ]}
        />
        <div className={styles.replayTotals}>
          <span>
            50/50s won <strong className="num">{share(fifties.won, fifties.lost)}</strong> <span className="num muted">({fifties.won}–{fifties.lost})</span>
          </span>
          <span>
            Races won <strong className="num">{share(races.won, races.lost)}</strong> <span className="num muted">({races.won}–{races.lost})</span>
          </span>
        </div>
      </>
    ),
    sub: from,
    wide: true,
    help: (
      <>
        <p>
          Worked out from the replay files, for the {r.matches} won or lost matches listed whose replay has been analyzed (out of {r.of}). Matches
          without a saved replay, or not analyzed yet, aren’t in these numbers.
        </p>
        <p>Average boost and no boost: over the time the ball was in play. Last back: the share of that time you were the one nearest your own goal.</p>
        <p>
          50/50s: challenges for the ball against an opponent outside kickoffs, won and lost (even ones left out). Races: who reached a loose ball
          first, you or an opponent.
        </p>
      </>
    ),
  };
}

const PER_MATCH: { key: keyof SummaryResponse["stats"]["perMatch"]; label: string; pct?: boolean }[] = [
  { key: "goals", label: "Goals" },
  { key: "assists", label: "Assists" },
  { key: "saves", label: "Saves" },
  { key: "shots", label: "Shots" },
  { key: "score", label: "Score" },
  { key: "touchShare", label: "Touch share", pct: true },
];

/** My numbers per decided match: mean and median (the median isn't pulled around by one big game). */
function PerMatchTable({ stats }: { stats: SummaryResponse["stats"] }) {
  return <CenterTable rows={PER_MATCH.map((r) => ({ ...r, center: stats.perMatch[r.key] }))} />;
}

interface CenterRow {
  key: string;
  label: string;
  center: { mean: number | null; median: number | null };
  pct?: boolean;
  /** Rounded to whole numbers (boost on the HUD's 0–100). */
  whole?: boolean;
}

/** A mean and median column per row. */
function CenterTable({ rows }: { rows: CenterRow[] }) {
  const show = (v: number | null, r: CenterRow) =>
    v === null ? "–" : r.pct ? formatPercent(v) : r.whole || v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return (
    // On a phone the two columns become one, "1.1/1": the same table, different cells shown.
    <table className={styles.perMatch}>
      <thead>
        <tr>
          <td />
          <th scope="col" data-wide-only>
            Mean
          </th>
          <th scope="col" data-wide-only>
            Median
          </th>
          <th scope="col" data-narrow-only>
            Mean/Median
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const mean = show(r.center.mean, r);
          const median = show(r.center.median, r);
          return (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td className="num" data-wide-only>
                {mean}
              </td>
              <td className="num" data-wide-only>
                {median}
              </td>
              <td className="num" data-narrow-only>
                {mean}/{median}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface Day {
  key: string;
  startedAt: number;
  matches: SessionListItem[];
  practiceSeconds: number;
}

/** Group sessions (already newest first) by local calendar day. */
export function groupByDay(items: SessionListItem[]): Day[] {
  const days: Day[] = [];
  for (const s of items) {
    const key = dayKey(s.startedAt);
    let day = days.at(-1);
    if (!day || day.key !== key) {
      day = { key, startedAt: s.startedAt, matches: [], practiceSeconds: 0 };
      days.push(day);
    }
    if (s.kind === "match") day.matches.push(s);
    else day.practiceSeconds += s.durationSeconds;
  }
  return days.filter((d) => d.matches.length);
}

interface More {
  has: boolean;
  loading: boolean;
  load: () => void;
}

/**
 * The match list scrolls by itself under the page's fixed top: the column
 * headings stay put, and each day's heading sticks below them while its
 * matches are in view, until the next day pushes it out. Older sessions load
 * as the end comes into view (the button does the same for keyboards and
 * when that can't be detected).
 */
function SessionList({ items, more }: { items: SessionListItem[]; more: More }) {
  const matches = items.filter((s) => s.kind === "match");
  const oldest = matches.at(-1);
  const chosen = useColumns("sessions");
  const head = useRef<HTMLDivElement>(null);
  const width = useContentWidth(head);
  const { cols, compact } = fitColumns(chosen, width);
  const grid = gridVars(compact ? SESSION_TRACKS_COMPACT : SESSION_TRACKS, cols);
  const replayColumn = useReplayControlsShown();
  return (
    <section
      aria-label="Matches"
      className={`card ${styles.list}`}
      data-no-replay={replayColumn ? undefined : true}
      data-compact={compact || undefined}
      data-scroll-restoration-id="sessions-list"
      tabIndex={-1}
    >
      <div ref={head} className={`${styles.row} ${styles.head}`} style={grid} aria-hidden="true">
        {cols.has("time") && <span className={styles.time}>Time</span>}
        {cols.has("playlist") && <span className={styles.playlist}>Playlist</span>}
        {cols.has("arena") && <span className={styles.arena}>Arena</span>}
        {cols.has("result") && <span className={styles.result}>Result</span>}
        {cols.has("score") && <span className={styles.score}>Score</span>}
        {cols.has("stats") && <span className={styles.line}>Stats</span>}
        {cols.has("touches") && <span className={styles.touches}>Touches</span>}
        {cols.has("share") && <span className={styles.share}>Touch share</span>}
        {cols.has("tags") && <span className={styles.tags}>Tags</span>}
        {replayColumn && <span className={styles.replayHead}>Replay</span>}
      </div>
      {groupByDay(items).map((day) => {
        const w = day.matches.filter((m) => m.outcome === "win").length;
        const l = day.matches.filter((m) => m.outcome === "loss").length;
        return (
          <section key={day.key} aria-label={formatDay(day.startedAt)}>
            <h2 className={styles.day}>
              {formatDay(day.startedAt)}
              <span className="muted">
                {day.matches.length} matches · {w}–{l}
                {day.practiceSeconds > 0 && ` · ${formatMinutes(day.practiceSeconds)} practice`}
              </span>
            </h2>
            <ul className={styles.rows}>
              {day.matches.map((m) => (
                <li key={m.id} className={styles.item}>
                  <span className={styles.starCell}>
                    <StarToggle sessionId={m.id} starred={m.starred} what={`the ${formatTime(m.startedAt)} match`} />
                  </span>
                  <MatchRow m={m} cols={cols} grid={grid} />
                  {replayColumn && (
                    <span className={styles.replay}>
                      <ReplayAction replay={m.replay} what={`the ${formatTime(m.startedAt)} match`} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <footer className={styles.end}>
        <span className="muted">
          {matches.length} {matches.length === 1 ? "match" : "matches"}
          {oldest ? ` back to ${formatDay(oldest.startedAt)}` : ""}
          {more.has ? "" : ", all of them"}
        </span>
        {more.has && <LoadOlder more={more} />}
      </footer>
    </section>
  );
}

/** Loads the next batch when it scrolls into view, or when pressed. */
function LoadOlder({ more }: { more: More }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { load, loading } = more;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loading) load();
    }, { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [load, loading]);
  return (
    <button ref={ref} type="button" className={styles.more} onClick={load} disabled={loading}>
      {loading ? "Loading older sessions…" : "Load older sessions"}
    </button>
  );
}

/** Each column's grid track, in display order (see lib/columns.ts). */
const SESSION_TRACKS: Record<SessionColumn, string> = {
  time: "84px",
  playlist: "96px",
  arena: "minmax(140px, 1.4fr)",
  result: "120px",
  score: "110px",
  stats: "150px",
  touches: "64px",
  share: "150px",
  tags: "minmax(90px, 1fr)",
};
const SESSION_TRACKS_COMPACT: Record<SessionColumn, string> = {
  ...SESSION_TRACKS,
  arena: "minmax(100px, 1fr)",
  result: "112px",
  score: "84px",
  touches: "56px",
  share: "112px",
};

/**
 * Which columns fit a list this wide (the heading row's content width; 0
 * when unknown or on a phone, whose layout is CSS's): all of them, then on
 * tighter tracks, then without Touch share, Touches and Stats in that order,
 * so Tags outlast them. Every other column stays.
 */
const DROP_ORDER: SessionColumn[] = ["share", "touches", "stats"];
const COLUMN_GAP = 12;
export function fitColumns(chosen: Set<SessionColumn>, width: number): { cols: Set<SessionColumn>; compact: boolean } {
  if (width <= 0) return { cols: chosen, compact: false };
  const need = (tracks: Record<SessionColumn, string>, cols: Set<SessionColumn>) =>
    [...cols].reduce((sum, c) => sum + minTrack(tracks[c]), 0) + COLUMN_GAP * Math.max(0, cols.size - 1);
  if (need(SESSION_TRACKS, chosen) <= width) return { cols: chosen, compact: false };
  let cols = chosen;
  for (const drop of [null, ...DROP_ORDER]) {
    if (drop) cols = new Set([...cols].filter((c) => c !== drop));
    if (need(SESSION_TRACKS_COMPACT, cols) <= width) break;
  }
  return { cols, compact: true };
}
/** A track's least width in px: "84px" or "minmax(140px, 1.4fr)". */
const minTrack = (track: string) => Number(/(\d+)px/.exec(track)?.[1] ?? 0);

/** An element's content width (inside its padding), kept up to date; 0 until measured or when hidden. */
function useContentWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const css = getComputedStyle(el);
      setWidth(Math.max(0, el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

function MatchRow({ m, cols, grid }: { m: SessionListItem; cols: Set<SessionColumn>; grid: CSSProperties }) {
  const score = `${m.goalsFor ?? "?"}–${m.goalsAgainst ?? "?"}`;
  return (
    <Link to="/sessions/$id" params={{ id: m.id }} className={styles.row} style={grid} aria-label={cols.has("time") ? undefined : rowLabel(m)}>
      {cols.has("time") && <span className={styles.time}>{formatTime(m.startedAt)}</span>}
      {cols.has("playlist") && <span className={styles.playlist}>{playlistShort(m.playlistId, m.playlistName)}</span>}
      {cols.has("arena") && <span className={`${styles.arena} muted`}>{arenaName(m.arena)}</span>}
      {cols.has("result") && <span className={styles.result}>
        <span className="result" data-outcome={m.outcome ?? "none"}>
          {resultLabel(m.outcome)}
        </span>
        <span className="num" aria-label={`score ${score}`}>
          {score}
        </span>
        {m.overtime && (
          <span className="ot" title="Overtime">
            OT<span className="visually-hidden">: overtime</span>
          </span>
        )}
      </span>}
      {cols.has("score") && (
        <span className={styles.score}>
          <span className="num" title="Your score">
            {m.me?.score ?? "—"}
          </span>
          {m.mvp && (
            <span className="mvp" title="You were MVP">
              MVP
            </span>
          )}
        </span>
      )}
      {cols.has("stats") && <span className={`${styles.line} num`}>
        {m.me ? (
          <>
            <Stat n={m.me.goals} label="G" title="goals" />
            <Stat n={m.me.assists} label="A" title="assists" />
            <Stat n={m.me.saves} label="Sv" title="saves" />
            <Stat n={m.me.shots} label="Sh" title="shots" />
          </>
        ) : (
          "—"
        )}
      </span>}
      {cols.has("touches") && <span className={`${styles.touches} num`}>{m.me?.touches ?? "—"}</span>}
      {cols.has("share") && (
        <span className={styles.share}>
          <span className={styles.bar} aria-hidden="true">
            <span style={{ width: formatPercent(m.touchShare) === "—" ? 0 : `${(m.touchShare ?? 0) * 100}%` }} />
          </span>
          <span className="num">{formatPercent(m.touchShare)}</span>
        </span>
      )}
      {cols.has("tags") && <TagList className={styles.tags} teammates={m.teammates} tags={m.tags} />}
    </Link>
  );
}

/** Without the time column, the link still says which match it is. */
function rowLabel(m: SessionListItem): string {
  return `${formatTime(m.startedAt)}, ${playlistShort(m.playlistId, m.playlistName)}, ${resultLabel(m.outcome)} ${m.goalsFor ?? "?"}–${m.goalsAgainst ?? "?"}${m.overtime ? " in overtime" : ""}${m.mvp ? ", MVP" : ""}`;
}

/** A number with its short label, read out in full by screen readers. */
function Stat({ n, label, title }: { n: number; label: string; title: string }) {
  return (
    <span className={styles.stat}>
      {n}
      <abbr title={title} aria-label={title} className="muted">
        {label}
      </abbr>
    </span>
  );
}
