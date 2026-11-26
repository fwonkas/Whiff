/** Playlist IDs observed in recordings. Unknown IDs are stored as-is. */
export const PLAYLISTS: Record<
  number,
  {
    name: string;
    mode: "match" | "freeplay" | "training";
    /** Fixed team size. Without one (private matches, limited-time modes) it's measured from the lobby. */
    teamSize?: number;
    ranked?: boolean;
    /**
     * Not standard soccar: private matches, extra modes (Hoops, Rumble,
     * Dropshot, Snow Day) and limited-time modes. Listed, but left out of
     * records, trends and splits so they don't skew standard play; asking for
     * the playlist by ID includes them.
     */
    nonStandard?: boolean;
    /** Casual (unranked) matchmaking. Not recorded unless the settings say so. */
    casual?: boolean;
  }
> = {
  1: { name: "Casual Duel", mode: "match", teamSize: 1, ranked: false, casual: true },
  2: { name: "Casual Doubles", mode: "match", teamSize: 2, ranked: false, casual: true },
  3: { name: "Casual Standard", mode: "match", teamSize: 3, ranked: false, casual: true },
  4: { name: "Casual Chaos", mode: "match", teamSize: 4, ranked: false, casual: true, nonStandard: true },
  /** Seen 2026-11-13 (Joe: a casual Snow Day match); was "Unknown playlist" until then. */
  15: { name: "Casual Snow Day", mode: "match", teamSize: 3, ranked: false, casual: true, nonStandard: true },
  6: { name: "Private Match", mode: "match", ranked: false, nonStandard: true },
  /**
   * Seen 2026-11-15 (Joe: "Honor Duel"): a 1v1 that follows a match, played
   * with that match's rules and mode (this one after a ranked match), teams
   * named Challenger and Defender; was "Unknown playlist". Neither ranked nor
   * casual, and never counts toward rank: kept whatever the casual setting
   * says, and left out of standard records like the extra modes. The game's
   * replay list labels its replays "Casual" (Joe, 2026-11-26); ballchasing
   * uploads still go under the Ranked rule, since `casual` isn't set.
   */
  53: { name: "Honor Duel", mode: "match", teamSize: 1, ranked: false, nonStandard: true },
  9: { name: "Freeplay", mode: "freeplay" },
  /** Freeplay you start from the menu with your party online (2026-11-10): grey teams, no clock. Practice, not a match. */
  73: { name: "Online Freeplay", mode: "freeplay" },
  10: { name: "Ranked Duel", mode: "match", teamSize: 1, ranked: true },
  11: { name: "Ranked Doubles", mode: "match", teamSize: 2, ranked: true },
  13: { name: "Ranked Standard", mode: "match", teamSize: 3, ranked: true },
  21: { name: "Training", mode: "training" },
  67: { name: "Spooky Cube", mode: "match", ranked: false, nonStandard: true, casual: true },
  34: { name: "Tournament", mode: "match", ranked: false },
  27: { name: "Ranked Hoops", mode: "match", teamSize: 2, ranked: true, nonStandard: true },
  28: { name: "Ranked Rumble", mode: "match", teamSize: 3, ranked: true, nonStandard: true },
  29: { name: "Ranked Dropshot", mode: "match", teamSize: 3, ranked: true, nonStandard: true },
  30: { name: "Ranked Snow Day", mode: "match", teamSize: 3, ranked: true, nonStandard: true },
};

/** Playlists with this fixed team size. */
export const playlistsOfSize = (size: number) =>
  Object.entries(PLAYLISTS)
    .filter(([, p]) => p.teamSize === size)
    .map(([id]) => Number(id));

export const nonStandardPlaylists = () =>
  Object.entries(PLAYLISTS)
    .filter(([, p]) => p.nonStandard)
    .map(([id]) => Number(id));

export const isCasual = (id: number | null) => id !== null && PLAYLISTS[id]?.casual === true;

export const isNonStandard = (id: number | null) => id !== null && PLAYLISTS[id]?.nonStandard === true;

export const playlistMode = (id: number): "match" | "freeplay" | "training" => PLAYLISTS[id]?.mode ?? "match";

/** Regulation length in seconds for every observed match playlist. */
export const REGULATION_SECONDS = 300;
