import type { Session } from "@rl/domain";
import { PLAYLISTS } from "@rl/schema";

/**
 * Was I the match's MVP? The game says so with an "MVP" stat feed event
 * naming the player, at the end of every match recorded live. Matches without
 * one (played from a replay, where the feed isn't kept, or a forfeit) fall
 * back to the game's rule: the top score on the winning team. Null outside
 * matches, and when I'm not in it.
 *
 * Never in 1s: the winner of a 1v1 is always its MVP, so it says nothing.
 */
export function wasMvp(s: Session): boolean | null {
  if (s.kind !== "match") return null;
  const me = s.players.find((p) => p.isMe);
  if (!me) return null;
  if (mvpTeamSize(s) === 1) return false;
  const event = s.statEvents.find((e) => e.eventName === "MVP");
  if (event) return event.mainKey === me.key;
  if (s.winnerTeam === null || me.team !== s.winnerTeam) return false;
  const top = Math.max(...s.players.filter((p) => p.team === me.team).map((p) => p.stats.score));
  return me.stats.score === top && top > 0;
}

/** The match's team size, as matchMetrics() works it out: the playlist's, else the lobby's. */
function mvpTeamSize(s: Session): number | null {
  return (s.playlistId !== null ? PLAYLISTS[s.playlistId]?.teamSize : undefined) ?? s.teamSize;
}
