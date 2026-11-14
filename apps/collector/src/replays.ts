import { REPLAY_START_MAX_FRAME } from "./sessionizer.ts";
import type { ReplayPlayback, Session } from "@rl/domain";

/**
 * Saved replays as a source of match data. Playing a replay back sends the
 * same Stats API messages as the live match, minus the stat feed and the
 * match end, plus boost pickups and every player's car. Checked on
 * 2026-11-01 against a live recording of the same tournament match: final
 * score and every player's stats identical, goals identical, 93% of touches.
 */

/** The id of the match rebuilt from a replay, one per match GUID. */
export const replayMatchId = (guid: string) => `match-replay-${guid}`;

/** ReplayCreated's Date is the match's end, in UTC: "2026-11-02 05-23-27". */
export function parseReplayDate(date: string | null): number | null {
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/**
 * A match session rebuilt from a complete playback of one of my matches.
 * Event times move from playback time to when the match was played: the
 * replay's date marks the end, and the playback's game time gives the length.
 * Null when the playback is incomplete or I'm not in the match.
 */
export function matchFromReplay(replay: Session): Session | null {
  if (replay.kind !== "replay" || !replay.playback?.complete || !replay.matchGuid || replay.myTeam === null) return null;
  const { startOffsetMs, endOffsetMs } = replay.playback;
  const endedAt = parseReplayDate(replay.replayDate) ?? replay.startedAt + endOffsetMs;
  const startedAt = endedAt - (endOffsetMs - startOffsetMs);
  const shift = endedAt - (replay.startedAt + endOffsetMs);
  const move = <T extends { at: number }>(xs: T[]) => xs.map((x) => ({ ...x, at: x.at + shift }));
  return {
    ...replay,
    id: replayMatchId(replay.matchGuid),
    kind: "match",
    source: "replay",
    startedAt,
    endedAt,
    pausedSeconds: 0,
    playback: null,
    replayFrames: [],
    players: replay.players.map((p) => ({ ...p, firstSeenAt: p.firstSeenAt + shift, lastSeenAt: p.lastSeenAt + shift })),
    goals: move(replay.goals),
    touches: move(replay.touches),
    crossbarHits: move(replay.crossbarHits),
    statEvents: move(replay.statEvents),
    boostPickups: move(replay.boostPickups),
  };
}

/**
 * A live match with what only its replay has: other players' car summaries
 * (live play sends car state for my team only) and boost pickups. Boost
 * pickup times are moved onto the live match by match clock.
 */
export function enrichFromReplay(live: Session, replay: Session): Session {
  const have = new Set(live.carSummaries.map((c) => c.playerKey));
  const anchor = (s: Session) => s.goals.find((g) => g.matchTime !== null) ?? s.touches.find((t) => t.matchTime !== null);
  const a = anchor(live);
  const b = anchor(replay);
  const shift = a && b ? a.at - (a.matchTime ?? 0) * 1000 - (b.at - (b.matchTime ?? 0) * 1000) : live.startedAt - replay.startedAt;
  return {
    ...live,
    carSummaries: [...live.carSummaries, ...replay.carSummaries.filter((c) => !have.has(c.playerKey))],
    boostPickups: live.boostPickups.length ? live.boostPickups : replay.boostPickups.map((p) => ({ ...p, at: p.at + shift })),
  };
}

/**
 * A playback that reached the replay file's last frame (the header's
 * NumFrames, which is exactly the last frame playback reports), from the
 * start and with no skips, watched the whole match, whatever the clock showed
 * or however it ended (a forfeit long after the last goal included). Returns
 * the session marked complete, with the result the final score gives (a
 * forfeit can end tied: then the live match's winner, when known), or null
 * when it isn't such a playback or is already complete.
 */
export function completeAtReplayEnd(s: Session, numFrames: number | null, liveWinner: number | null = null): Session | null {
  const p = s.playback;
  if (s.kind !== "replay" || !p || p.complete || numFrames === null) return null;
  if (p.gaps !== 0 || p.firstFrame === null || p.firstFrame > REPLAY_START_MAX_FRAME || p.lastFrame === null) return null;
  if (p.lastFrame < numFrames - REPLAY_END_SLACK_FRAMES) return null;
  const decided = s.scoreBlue !== null && s.scoreOrange !== null && s.scoreBlue !== s.scoreOrange;
  const winnerTeam = decided ? (s.scoreBlue! > s.scoreOrange! ? 0 : 1) : liveWinner;
  return {
    ...s,
    playback: { ...p, complete: true, endReason: p.endReason ?? "end" },
    winnerTeam,
    outcome: s.myTeam === null || winnerTeam === null ? s.outcome : winnerTeam === s.myTeam ? "win" : "loss",
  };
}

/**
 * Faster than this and a playback misses some of the game's BallHit events
 * (2x kept 93–100% of them, 2026-11-06). 1x measures about 1.05: the replay's
 * game time runs a little ahead of the clock.
 */
export const FULL_SPEED_MAX = 1.2;

/** Watched at normal speed (or slower); null when its speed wasn't measured. */
export function atFullSpeed(p: ReplayPlayback | null): boolean | null {
  return p?.speed == null ? null : p.speed <= FULL_SPEED_MAX;
}

/** Playback's last frame was NumFrames exactly on 2026-11-06; a little slack for a tick that lands just short. */
const REPLAY_END_SLACK_FRAMES = 3;
