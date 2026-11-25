import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readReplayHeader, replaySummary } from "./replay-header.ts";

/**
 * Saved replays on disk. The game keeps them in
 * `<Documents>\My Games\Rocket League\TAGame\DemosEpic` (Epic) or `\Demos`
 * (Steam), named `<replay ID>.replay`; the ID is what LoadReplay takes. On
 * 2026-11-04 my Documents folder was redirected into OneDrive, so callers pass
 * the real Documents folder rather than assuming one.
 */

export interface SavedReplay {
  replayId: string;
  path: string;
  /** Saved at the end of the match (automatic saves), or later when saved from match history. */
  mtimeMs: number;
  /** From the file's header; null when it couldn't be read. */
  matchGuid: string | null;
  /** The match's end, from the header's Date (UTC). */
  matchEndedAt: number | null;
  /** Seconds of play, from the header's TotalSecondsPlayed. */
  seconds: number | null;
  /** The header's MatchType: Online, Private, Tournament, Offline… */
  matchType: string | null;
  /** The header's NumFrames: where playback ends. */
  numFrames: number | null;
}

export const replayDirsIn = (documentsDir: string) =>
  ["DemosEpic", "Demos"].map((d) => join(documentsDir, "My Games", "Rocket League", "TAGame", d));

/**
 * What's in the replay folders, cheaply (names only, no headers read): it
 * changes when the game saves a replay or one is deleted, so open dashboards
 * can be told.
 */
export function replayFolderSignature(dirs: readonly string[]): string {
  const names: string[] = [];
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) if (name.endsWith(".replay")) names.push(`${dir}|${name}`);
    } catch {
      names.push(`${dir}|unreadable`);
    }
  }
  return names.sort().join("\n");
}

export function listSavedReplays(dirs: readonly string[]): SavedReplay[] {
  const out: SavedReplay[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = name.match(/^([0-9A-Fa-f]{32})\.replay$/);
      if (!m) continue;
      const path = join(dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue; // gone
      }
      let matchGuid: string | null = null;
      let matchEndedAt: number | null = null;
      let seconds: number | null = null;
      let matchType: string | null = null;
      let numFrames: number | null = null;
      try {
        const h = replaySummary(readReplayHeader(path));
        matchGuid = h.matchGuid;
        matchEndedAt = h.endedAt;
        seconds = h.seconds;
        matchType = h.matchType;
        numFrames = h.numFrames;
      } catch {
        // An unreadable header: fall back to the file time.
      }
      out.push({ replayId: m[1]!.toUpperCase(), path, mtimeMs, matchGuid, matchEndedAt, seconds, matchType, numFrames });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Fallback when a header can't be read: a replay saved this close to a live match's end is that match's replay. */
export const REPLAY_MATCH_WINDOW_MS = 5 * 60_000;

export interface BackfillPlan {
  /** Matches I never recorded live: these become new matches. Newest first. */
  unrecorded: string[];
  /** Matches I recorded live: playing these adds opponents' car data and boost pickups. Newest first. */
  recorded: string[];
  /** Seconds of play per replay ID, for time estimates. */
  seconds: Record<string, number>;
}

/**
 * Which saved replays are worth playing: not already played through, split by
 * whether a live recording of the match exists. The header's MatchGUID
 * decides; the file time is only a fallback, because a replay saved later
 * from match history has a later time (24 minutes on one 2026-11-02 replay).
 */
export function planBackfill(
  replays: readonly SavedReplay[],
  played: ReadonlySet<string>,
  live: { guids: ReadonlySet<string>; ends: readonly number[] },
): BackfillPlan {
  const liveMatchEnds = live.ends;
  const ends = [...liveMatchEnds].sort((a, b) => a - b);
  const nearAMatch = (t: number) => {
    // Binary search for the closest end.
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return [ends[lo - 1], ends[lo]].some((e) => e !== undefined && Math.abs(e - t) <= REPLAY_MATCH_WINDOW_MS);
  };
  const plan: BackfillPlan = { unrecorded: [], recorded: [], seconds: {} };
  for (const r of [...replays].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (played.has(r.replayId)) continue;
    const recorded = r.matchGuid ? live.guids.has(r.matchGuid) : nearAMatch(r.matchEndedAt ?? r.mtimeMs);
    (recorded ? plan.recorded : plan.unrecorded).push(r.replayId);
    if (r.seconds) plan.seconds[r.replayId] = r.seconds;
  }
  return plan;
}

/**
 * Match History in the game shows the 20 most recent matches from the past 30
 * days, and replays can be saved from there (rocketleague.com, "Introducing
 * Match History"). A match without a saved replay is gone for good once it
 * drops out.
 */
export const MATCH_HISTORY_SIZE = 20;
export const MATCH_HISTORY_DAYS = 30;
/**
 * Warn when an unsaved match is this close to the end of the list (by default
 * positions 16 to 20). Was 3; a fast night (22 matches in 2¼ hours,
 * 2026-11-06) used that up in about 20 minutes and a replay was lost.
 */
export const MATCH_HISTORY_WARN_LAST = 5;
/** Or this close to the 30-day limit. */
export const MATCH_HISTORY_WARN_DAYS = 3;

export interface HistoryMatch {
  matchGuid: string;
  endedAt: number;
}

export interface MatchHistoryRisk<M extends HistoryMatch = HistoryMatch> {
  /** Recent matches still in Match History with no saved replay, newest first. */
  unsaved: M[];
  /** Of those, the ones about to drop out. */
  atRisk: M[];
  /** For each match in Match History (by GUID, upper case): how many more matches drop it out (1: the next one). */
  dropsIn: Map<string, number>;
}

export function matchHistoryRisk<M extends HistoryMatch>(
  matches: readonly M[],
  savedGuids: ReadonlySet<string>,
  now: number,
  warnLast = MATCH_HISTORY_WARN_LAST,
): MatchHistoryRisk<M> {
  const dayMs = 86_400_000;
  const history = [...matches]
    .filter((m) => now - m.endedAt <= MATCH_HISTORY_DAYS * dayMs)
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, MATCH_HISTORY_SIZE);
  const unsaved = history.filter((m) => !savedGuids.has(m.matchGuid.toUpperCase()));
  const atRisk = unsaved.filter((m) => {
    const position = history.indexOf(m) + 1;
    const nearEnd = history.length >= MATCH_HISTORY_SIZE - warnLast + 1 && position > MATCH_HISTORY_SIZE - warnLast;
    const nearExpiry = now - m.endedAt > (MATCH_HISTORY_DAYS - MATCH_HISTORY_WARN_DAYS) * dayMs;
    return nearEnd || nearExpiry;
  });
  const dropsIn = new Map(history.map((m, i) => [m.matchGuid.toUpperCase(), MATCH_HISTORY_SIZE - i]));
  return { unsaved, atRisk, dropsIn };
}
