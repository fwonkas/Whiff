import { PLAYLISTS } from "@rl/schema";
import { titleFor, type BallchasingListItem } from "./ballchasing.ts";

/** What Whiff knows about a match, from its database and the saved replay files. */
export interface RetitleLookup {
  /** The match GUID of a replay ID (upper case), if known. */
  guidOf(replayId: string): string | null;
  playlist(guid: string): number | null;
  start(guid: string): number | null;
}

export interface Retitle {
  id: string;
  from: string | null;
  to: string;
}

/**
 * The title an upload of mine should have, like new uploads get (item 43):
 * the playlist and when the match started. Whiff's own records first, else
 * what ballchasing parsed from the replay (its playlist name, and its date
 * less the match's length). Null when it already has that title or there's
 * too little to go on.
 */
export function planRetitle(item: BallchasingListItem, look: RetitleLookup): Retitle | null {
  const guid = item.match_guid?.toUpperCase() ?? (item.rocket_league_id ? look.guidOf(item.rocket_league_id.toUpperCase()) : null);
  const playlistId = guid ? look.playlist(guid) : null;
  const name =
    (playlistId !== null ? PLAYLISTS[playlistId]?.name : undefined) ??
    item.playlist_name ??
    (item.match_type === "Private" ? "Private Match" : item.match_type === "Tournament" ? "Tournament" : item.match_type ? "Online Match" : null);
  const ended = item.date ? Date.parse(item.date) : NaN;
  const startedAt = (guid ? look.start(guid) : null) ?? (Number.isFinite(ended) ? ended - (item.duration ?? 0) * 1000 : null);
  if (!name || startedAt === null) return null;
  const to = titleFor(name, startedAt);
  const from = item.replay_title ?? item.title ?? null;
  return from === to ? null : { id: item.id, from, to };
}

/**
 * fetch with at least `gapMs` between requests, so a long run stays under
 * ballchasing's rate limit (5000 an hour on Joe's tier: one per 720 ms).
 */
export function pacedFetch(
  gapMs: number,
  inner: typeof fetch = fetch,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now = () => Date.now(),
): typeof fetch {
  let next = 0;
  return (async (...args: Parameters<typeof fetch>) => {
    const t = now();
    const wait = next - t;
    next = Math.max(t, next) + gapMs;
    if (wait > 0) await sleep(wait);
    return inner(...args);
  }) as typeof fetch;
}
