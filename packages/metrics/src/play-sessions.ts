/**
 * Play sessions: one sitting of play, from the first match or practice to the
 * last before a real break. Sessions inside one sitting sit a few minutes
 * apart (queues, menus); tournament rounds can sit 10 to 35 minutes apart.
 * Gaps checked on 2026-11-03 against three weeks of my play.
 */

/** A gap this long always starts a new play session. */
export const PLAY_SESSION_GAP_MS = 40 * 60_000;
/** After quitting the game, a gap this long starts a new play session (a quick relaunch doesn't). */
export const PLAY_SESSION_QUIT_GAP_MS = 10 * 60_000;
/** A quit logged up to this long before the previous session's end still counts as after it. */
const QUIT_SLACK_MS = 5_000;

export interface Timed {
  id: string;
  startedAt: number;
  endedAt: number;
}

export interface PlaySessionGroup {
  /** "play-<startedAt>", stable while the first session stays the first. */
  id: string;
  startedAt: number;
  endedAt: number;
  sessionIds: string[];
}

export interface PlaySessionRules {
  gapMs: number;
  quitGapMs: number;
}

/**
 * Group sessions (any order) into play sessions, oldest first. A new one
 * starts after a gap of `gapMs`, or after `quitGapMs` when the game quit in
 * between.
 */
export function groupPlaySessions(
  sessions: readonly Timed[],
  quits: readonly number[],
  rules: PlaySessionRules = { gapMs: PLAY_SESSION_GAP_MS, quitGapMs: PLAY_SESSION_QUIT_GAP_MS },
): PlaySessionGroup[] {
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const quitTimes = [...quits].sort((a, b) => a - b);
  const groups: PlaySessionGroup[] = [];
  let current: PlaySessionGroup | null = null;
  for (const s of sorted) {
    if (current) {
      const gap = s.startedAt - current.endedAt;
      const quitBetween = quitTimes.some((q) => q >= current!.endedAt - QUIT_SLACK_MS && q <= s.startedAt);
      if (gap > rules.gapMs || (quitBetween && gap > rules.quitGapMs)) current = null;
    }
    if (!current) {
      current = { id: `play-${s.startedAt}`, startedAt: s.startedAt, endedAt: s.endedAt, sessionIds: [] };
      groups.push(current);
    }
    current.sessionIds.push(s.id);
    current.endedAt = Math.max(current.endedAt, s.endedAt);
  }
  return groups;
}
