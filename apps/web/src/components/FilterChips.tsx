import { Fragment, useId, useRef, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { SummaryResponse } from "@rl/api-contract";
import { useSummary } from "../lib/api.tsx";
import type { MatchFilters } from "../router.tsx";
import styles from "./FilterChips.module.css";
import { rangeLabel, rangeOf, type DayRange } from "../lib/date-range.ts";

/**
 * Filter chips as links: each one is the current URL with one search param
 * changed. They work with Back, middle-click and copy-link for free.
 *
 * A chip that would show nothing, or exactly what its group's "all" chip
 * shows, is turned off (not a link), with the reason as hover text: in 1s
 * there are no teammates, so Solo is the same as Anyone and With teammates is
 * empty. Choosing a team size drops a teammate filter that wouldn't apply
 * there, so the list never ends up empty from the filters alone.
 */

type Size = 1 | 2 | 3;
type With = "solo" | "party";
type Counts = SummaryResponse["filterCounts"];

const TEAM_SIZES: { label: string; value: Size | undefined }[] = [
  { label: "All", value: undefined },
  { label: "1s", value: 1 },
  { label: "2s", value: 2 },
  { label: "3s", value: 3 },
];

const WITH: { label: string; value: With | undefined }[] = [
  { label: "Anyone", value: undefined },
  { label: "Solo", value: "solo" },
  { label: "With teammates", value: "party" },
];

const bucket = (counts: Counts, size: Size | undefined) =>
  counts[size === undefined ? "all" : (String(size) as "1" | "2" | "3")];

/** Why a teammate filter would do nothing at a team size, or null when it narrows the list. */
function withProblem(
  counts: Counts,
  size: Size | undefined,
  w: With,
): string | null {
  const b = bucket(counts, size);
  const n = w === "solo" ? b.solo : b.party;
  if (n === 0)
    return w === "party"
      ? "No matches with a known teammate here"
      : "No solo matches here";
  if (n === b.total) return "Same as Anyone here";
  return null;
}

export function FilterChips({
  to,
  allowAll = true,
  current,
  extras = false,
  menus = false,
}: {
  to: "/sessions" | "/trends";
  allowAll?: boolean;
  current: MatchFilters;
  /** Mode chips (tournaments, Rumble…) and result chips: Sessions only. */
  extras?: boolean;
  /** Teammates and result as dropdown chips (like Other), to fit one row beside the cards. */
  menus?: boolean;
}) {
  // Unfiltered: the counts cover every combination, whatever the page shows.
  const navigate = useNavigate();
  const dates = rangeOf(current);
  const all = useSummary(dates).data;
  const counts = all?.filterCounts;
  // The current mode and teammates, for the result chips.
  // Results within the replay filter; replay states within the result filter (the page's own query, so cached).
  const here = useSummary({ teamSize: current.teamSize, playlist: current.playlist, with: current.with, replay: current.replay, ...dates }).data?.resultCounts;
  const replayHere = useSummary(
    menus ? { teamSize: current.teamSize, playlist: current.playlist, with: current.with, result: current.result, replay: current.replay, ...dates } : {},
  ).data?.replayCounts;

  const sizeProblem = (size: Size): string | null => {
    if (!counts) return null;
    const n = bucket(counts, size).total;
    if (n === 0) return `No ${size}s matches`;
    if (allowAll && n === counts.all.total) return "Same as All";
    return null;
  };
  /** A team size keeps the teammate filter only where it still narrows the list. */
  const withFor = (size: Size | undefined) =>
    current.with && counts && withProblem(counts, size, current.with)
      ? undefined
      : current.with;
  const chip = {
    className: "chip",
    activeOptions: { includeSearch: true, explicitUndefined: true },
  } as const;

  return (
    <div className={menus ? styles.menusRow : undefined} style={menus ? undefined : { display: "flex", flexWrap: "wrap", gap: "12px 24px" }}>
      <div className="chips" role="group" aria-label="Mode">
        {TEAM_SIZES.filter((t) => allowAll || t.value !== undefined).map(
          (t) => {
            const problem = t.value === undefined ? null : sizeProblem(t.value);
            if (problem && current.teamSize !== t.value)
              return <Off key={t.label} label={t.label} why={problem} />;
            return (
              // The router marks the link matching the current URL with aria-current="page".
              // Search matching is partial, so "All" (teamSize: undefined) would match every URL;
              // explicitUndefined makes it match only when the param is absent.
              <Link
                key={t.label}
                to={to}
                search={(prev: MatchFilters) => ({
                  ...prev,
                  teamSize: t.value,
                  playlist: undefined,
                  with: withFor(t.value),
                })}
                {...chip}
              >
                {t.label}
              </Link>
            );
          },
        )}
        {extras &&
          all?.modes &&
          (() => {
            const tournaments = all.modes.find((m) => m.playlistId === TOURNAMENT);
            const others = all.modes.filter((m) => m.playlistId !== TOURNAMENT);
            const modeLink = (m: { playlistId: number }) => (prev: MatchFilters) => ({ ...prev, teamSize: undefined, playlist: m.playlistId });
            return (
              <>
                {tournaments ? (
                  <Link to={to} search={modeLink(tournaments)} {...chip}>
                    Tournaments
                  </Link>
                ) : (
                  <Off label="Tournaments" why="No tournament matches" />
                )}
                {others.length > 0 && (
                  <OtherModes modes={others} current={current.playlist}>
                    {(m, close) => (
                      <Link to={to} search={modeLink(m)} className={styles.option} onClick={close} activeOptions={chip.activeOptions}>
                        {modeLabel(m.name)}
                        <span className="num muted">{m.matches}</span>
                      </Link>
                    )}
                  </OtherModes>
                )}
              </>
            );
          })()}
      </div>
      {menus ? (
        <div className="chips" role="group" aria-label="Teammates">
          <ChipMenu label={WITH.find((w) => w.value === current.with)?.label ?? "Anyone"} active={current.with !== undefined} name="Teammates">
            {(close) =>
              WITH.map((w) => {
                const problem =
                  w.value === undefined || !counts || current.playlist !== undefined
                    ? null
                    : withProblem(counts, current.teamSize as Size | undefined, w.value);
                if (problem && current.with !== w.value) return <OffOption key={w.label} label={w.label} why={problem} />;
                const b = counts ? bucket(counts, current.teamSize as Size | undefined) : null;
                const n = !b || current.playlist !== undefined ? null : w.value === undefined ? b.total : w.value === "solo" ? b.solo : b.party;
                return (
                  <Link
                    key={w.label}
                    to={to}
                    search={(prev: MatchFilters) => ({ ...prev, with: w.value })}
                    className={styles.option}
                    onClick={close}
                    activeOptions={chip.activeOptions}
                  >
                    {w.label}
                    {n !== null && <span className="num muted">{n}</span>}
                  </Link>
                );
              })
            }
          </ChipMenu>
        </div>
      ) : (
      <div className="chips" role="group" aria-label="Teammates">
        {WITH.map((w) => {
          // Per-mode teammate counts aren't known; extra modes keep both chips.
          const problem =
            w.value === undefined || !counts || current.playlist !== undefined
              ? null
              : withProblem(
                  counts,
                  current.teamSize as Size | undefined,
                  w.value,
                );
          if (problem && current.with !== w.value)
            return <Off key={w.label} label={w.label} why={problem} />;
          return (
            <Link
              key={w.label}
              to={to}
              search={(prev: MatchFilters) => ({ ...prev, with: w.value })}
              className="chip"
              activeOptions={{ includeSearch: true, explicitUndefined: true }}
            >
              {w.label}
            </Link>
          );
        })}
      </div>
      )}
      {extras && (
        <DateRangeChip
          value={{ from: current.from, to: current.to }}
          onChange={(patch) => void navigate({ to, search: (prev: MatchFilters) => ({ ...prev, ...patch }) })}
        />
      )}
      {extras && here && menus && <ResultMenu to={to} counts={here} current={current.result} />}
      {extras && menus && replayHere && <ReplayMenu counts={replayHere} current={current.replay} />}
      {extras && here && !menus && (
        <ResultChips
          counts={here}
          current={current.result}
          link={(value, label) => (
            <Link
              key={label}
              to={to}
              search={(prev: MatchFilters) => ({ ...prev, result: value })}
              {...chip}
            >
              {label}
            </Link>
          )}
        />
      )}
    </div>
  );
}

const TOURNAMENT = 34;

/**
 * A chip that opens a list of choices, named after the current one. The list
 * is a popover, so it isn't clipped by the chip row (which scrolls sideways
 * on phones), and Escape or a click outside closes it.
 */
function ChipMenu({ label, active, name, children }: { label: ReactNode; active: boolean; name?: string; children: (close: () => void) => ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Placed under the chip when it opens (fixed: the popover lives in the top layer).
  const place = () => {
    const b = button.current?.getBoundingClientRect();
    const l = list.current;
    if (!b || !l) return;
    l.style.top = `${b.bottom + 6}px`;
    l.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - l.offsetWidth - 8))}px`;
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`chip ${styles.other}`}
        popoverTarget={id}
        aria-current={active ? "page" : undefined}
        aria-haspopup="true"
      >
        {/* "Teammates: Anyone" for screen readers, where the choice alone wouldn't say what it filters. */}
        {name && <span className="visually-hidden">{name}: </span>}
        {label}
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      <div ref={list} id={id} popover="auto" className={styles.menu} onToggle={(e) => (e as unknown as ToggleEvent).newState === "open" && place()}>
        {children(() => list.current?.hidePopover?.())}
      </div>
    </>
  );
}

/** An option in a ChipMenu that would do nothing here: shown, not a link, with why. */
function OffOption({ label, why }: { label: string; why: string }) {
  return (
    <span className={styles.option} aria-disabled="true" title={why}>
      {label}
      <span className="visually-hidden">: {why.toLowerCase()}</span>
    </span>
  );
}

/**
 * The less common modes (Rumble, Snow Day, private…) behind one chip. It
 * reads "Other" until one of them is picked, then names it; picking any other
 * chip turns it back to "Other".
 */
function OtherModes({
  modes,
  current,
  children,
}: {
  modes: SummaryResponse["modes"];
  current: number | undefined;
  children: (m: SummaryResponse["modes"][number], close: () => void) => ReactNode;
}) {
  const picked = modes.find((m) => m.playlistId === current);
  return (
    <ChipMenu label={picked ? modeLabel(picked.name) : "Other"} active={!!picked}>
      {(close) => modes.map((m) => <Fragment key={m.playlistId}>{children(m, close)}</Fragment>)}
    </ChipMenu>
  );
}

/** "Ranked Snow Day" reads as "Snow Day" next to 1s, 2s and 3s. */
const modeLabel = (name: string) =>
  name.replace(/^Ranked /, "").replace(/^Tournament$/, "Tournaments").replace(/^Private Match$/, "Private");

export type Result = "win" | "loss" | "mvp";
const RESULTS: {
  label: string;
  value: Result | undefined;
  key: "total" | Result;
}[] = [
  { label: "Any result", value: undefined, key: "total" },
  { label: "Wins", value: "win", key: "win" },
  { label: "Losses", value: "loss", key: "loss" },
  { label: "MVP", value: "mvp", key: "mvp" },
];

/**
 * Wins, losses and MVP, for Sessions and Replays. Like the other chips, one
 * that would show nothing or everything is off.
 */
export function ResultChips({
  counts,
  current,
  link,
}: {
  counts: { total: number; win: number; loss: number; mvp: number };
  current: Result | undefined;
  link: (value: Result | undefined, label: string) => ReactNode;
}) {
  return (
    <div className="chips" role="group" aria-label="Result">
      {RESULTS.map((r) => {
        const n = counts[r.key];
        const problem =
          r.value === undefined
            ? null
            : n === 0
              ? `None here`
              : n === counts.total
                ? "Same as Any result here"
                : null;
        if (problem && current !== r.value)
          return <Off key={r.label} label={r.label} why={problem} />;
        return link(r.value, r.label);
      })}
    </div>
  );
}

const REPLAY_STATES = [
  { label: "Any replay", value: undefined, key: "total" },
  { label: "Needs attention", value: "attention", key: "attention" },
  { label: "Saved", value: "saved", key: "saved" },
] as const;

/**
 * The replay filter: matches whose replay isn't saved in the game yet (still
 * in Match History, or gone), or saved ones.
 */
function ReplayMenu({ counts, current }: { counts: { total: number; attention: number; saved: number }; current: "attention" | "saved" | undefined }) {
  const label = REPLAY_STATES.find((r) => r.value === current)?.label ?? "Any replay";
  return (
    <div className="chips" role="group" aria-label="Replay">
      <ChipMenu label={label} active={current !== undefined} name="Replay">
        {(close) =>
          REPLAY_STATES.map((r) => {
            const n = counts[r.key];
            const problem = r.value === undefined ? null : n === 0 ? "None here" : n === counts.total ? "Same as Any replay here" : null;
            if (problem && current !== r.value) return <OffOption key={r.label} label={r.label} why={problem} />;
            return (
              <Link
                key={r.label}
                to="/sessions"
                search={(prev: MatchFilters) => ({ ...prev, replay: r.value })}
                className={styles.option}
                onClick={close}
                activeOptions={{ includeSearch: true, explicitUndefined: true }}
              >
                {r.label}
                <span className="num muted">{n}</span>
              </Link>
            );
          })
        }
      </ChipMenu>
    </div>
  );
}

/** The result filter as a dropdown chip, with counts. */
function ResultMenu({ to, counts, current }: { to: "/sessions" | "/trends"; counts: { total: number; win: number; loss: number; mvp: number }; current: Result | undefined }) {
  return (
    <div className="chips" role="group" aria-label="Result">
      <ChipMenu label={RESULTS.find((r) => r.value === current)?.label ?? "Any result"} active={current !== undefined} name="Result">
        {(close) =>
          RESULTS.map((r) => {
            const n = counts[r.key];
            const problem = r.value === undefined ? null : n === 0 ? "None here" : n === counts.total ? "Same as Any result here" : null;
            if (problem && current !== r.value) return <OffOption key={r.label} label={r.label} why={problem} />;
            return (
              <Link
                key={r.label}
                to={to}
                search={(prev: MatchFilters) => ({ ...prev, result: r.value })}
                className={styles.option}
                onClick={close}
                activeOptions={{ includeSearch: true, explicitUndefined: true }}
              >
                {r.label}
                <span className="num muted">{n}</span>
              </Link>
            );
          })
        }
      </ChipMenu>
    </div>
  );
}

/** A chip that's off: not a link, with why as hover text (and for screen readers). */
export function Off({ label, why }: { label: ReactNode; why: string }) {
  return (
    <span className="chip" aria-disabled="true" title={why}>
      {label}
      <span className="visually-hidden">: {why.toLowerCase()}</span>
    </span>
  );
}

/**
 * The date filter as a chip: "All dates" until a range is set, then the
 * range. It opens a small form with From and To (either can be left open)
 * and All dates. Changes apply as they're made, as a patch on the URL's
 * current range (so quick edits don't undo each other).
 */
export function DateRangeChip({ value, onChange }: { value: DayRange; onChange: (patch: DayRange) => void }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const set = value.from !== undefined || value.to !== undefined;
  const place = () => {
    const b = button.current?.getBoundingClientRect();
    const l = panel.current;
    if (!b || !l) return;
    l.style.top = `${b.bottom + 6}px`;
    l.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - l.offsetWidth - 8))}px`;
  };
  const day = (v: string) => (v ? v : undefined);
  return (
    <div className="chips" role="group" aria-label="Dates">
      <button ref={button} type="button" className={`chip ${styles.other}`} popoverTarget={id} aria-current={set ? "page" : undefined} aria-haspopup="dialog">
        {rangeLabel(value)}
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-label="Dates"
        className={`${styles.menu} ${styles.dates}`}
        onToggle={(e) => (e as unknown as ToggleEvent).newState === "open" && place()}
      >
        <label className={styles.dateField}>
          From
          <input type="date" value={value.from ?? ""} max={value.to} onChange={(e) => onChange({ from: day(e.target.value) })} />
        </label>
        <label className={styles.dateField}>
          To
          <input type="date" value={value.to ?? ""} min={value.from} onChange={(e) => onChange({ to: day(e.target.value) })} />
        </label>
        <button
          type="button"
          className={styles.option}
          disabled={!set}
          onClick={() => {
            onChange({ from: undefined, to: undefined });
            panel.current?.hidePopover?.();
          }}
        >
          All dates
        </button>
      </div>
    </div>
  );
}
