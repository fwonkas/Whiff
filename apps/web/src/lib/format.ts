import type { Outcome } from "@rl/domain";

/** Display helpers. Times show in the browser's own time zone. */

const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export const formatDay = (ms: number) => day.format(ms);
export const formatTime = (ms: number) => time.format(ms);

/** A stable key for grouping by local calendar day. */
export const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

export const formatMinutes = (seconds: number) => `${Math.round(seconds / 60)} min`;

export const formatPercent = (fraction: number | null | undefined, digits = 0) =>
  fraction === null || fraction === undefined ? "—" : `${(fraction * 100).toFixed(digits)}%`;

/**
 * Match time (seconds played, overtime continuing past 300) as the in-game
 * clock shows it: "4:57" in regulation, "+0:43" in overtime.
 */
export function formatClock(matchTime: number | null): string {
  if (matchTime === null) return "";
  const t = Math.round(matchTime);
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return t > 300 ? `+${mmss(t - 300)}` : mmss(300 - t);
}

export const resultLabel = (o: Outcome | null) => (o === "win" ? "W" : o === "loss" ? "L" : o === "abandoned" ? "Left" : "—");

export const resultWords = (o: Outcome | null) =>
  o === "win" ? "Win" : o === "loss" ? "Loss" : o === "abandoned" ? "Left early" : "No result";

export const recordText = (r: { wins: number; losses: number; abandoned: number }) =>
  `${r.wins}–${r.losses}${r.abandoned ? ` (+${r.abandoned} left)` : ""}`;

/** Short names for the Sessions list. */
export const PLAYLIST_SHORT: Record<number, string> = {
  3: "Casual 3s",
  6: "Private",
  9: "Freeplay",
  10: "Ranked 1s",
  11: "Ranked 2s",
  13: "Ranked 3s",
  21: "Training",
  27: "Hoops",
  28: "Rumble",
  29: "Dropshot",
  30: "Snow Day",
  34: "Tournament",
  67: "Spooky Cube",
};
export const playlistShort = (id: number | null, fallback: string | null) =>
  (id !== null ? PLAYLIST_SHORT[id] : undefined) ?? fallback ?? "Unknown playlist";

/**
 * Arena asset names to display names, matched in freeplay on 2026-10-24
 * (all standard Soccar arenas). Suffixes aren't consistent ("GRS" means
 * Salty Shallows, Pitched or Salty Fest depending on the arena), so this is
 * an exact lookup. Unknown assets fall back to a cleaned-up asset name.
 */
const ARENA_NAMES: Record<string, string> = {
  underwater_p: "AquaDome",
  underwater_grs_p: "AquaDome (Salty Shallows)",
  park_p: "Beckwith Park",
  park_night_p: "Beckwith Park (Midnight)",
  park_snowy_p: "Beckwith Park (Snowy)",
  park_rainy_p: "Beckwith Park (Stormy)",
  mall_day_p: "Boostfield Mall",
  cs_p: "Champions Field",
  cs_day_p: "Champions Field (Day)",
  outlaw_p: "Deadeye Canyon",
  outlaw_oasis_p: "Deadeye Canyon (Oasis)",
  stadium_p: "DFH Stadium",
  stadium_race_day_p: "DFH Stadium (Circuit)",
  stadium_day_p: "DFH Stadium (Day)",
  stadium_winter_p: "DFH Stadium (Snowy)",
  stadium_foggy_p: "DFH Stadium (Stormy)",
  stadium_10a_p: "DFH Stadium (10th Anniversary)",
  woods_p: "Drift Woods",
  woods_night_p: "Drift Woods (Night)",
  ff_dusk_p: "Estadio Vida",
  farm_p: "Farmstead",
  farm_night_p: "Farmstead (Night)",
  farm_hw_p: "Farmstead (Spooky)",
  farm_grs_p: "Farmstead (Pitched)",
  chn_stadium_p: "Forbidden Temple",
  chn_stadium_day_p: "Forbidden Temple (Day)",
  fni_stadium_p: "Forbidden Temple (Fire & Ice)",
  uf_day_p: "Futura Garden",
  uf_night_p: "Futura Garden (Night)",
  eurostadium_p: "Mannfield",
  eurostadium_dusk_p: "Mannfield (Dusk)",
  eurostadium_night_p: "Mannfield (Night)",
  eurostadium_snownight_p: "Mannfield (Snowy)",
  eurostadium_rainy_p: "Mannfield (Stormy)",
  neotokyo_standard_p: "Neo Tokyo",
  neotokyo_toon_p: "Neo Tokyo (Comic)",
  neotokyo_hax_p: "Neo Tokyo (Hacked)",
  neotokyo_arcade_p: "Neo Tokyo (Arcade)",
  music_p: "Neon Fields",
  paname_dusk_p: "Parc de Paris",
  beach_p: "Salty Shores",
  beach_night_p: "Salty Shores (Night)",
  beach_night_grs_p: "Salty Shores (Salty Fest)",
  street_p: "Sovereign Heights",
  arc_standard_p: "Starbase ARC",
  arc_darc_p: "Starbase ARC (Aftermath)",
  trainstation_p: "Urban Central",
  trainstation_dawn_p: "Urban Central (Dawn)",
  trainstation_night_p: "Urban Central (Night)",
  utopiastadium_p: "Utopia Coliseum",
  utopiastadium_dusk_p: "Utopia Coliseum (Dusk)",
  utopiastadium_lux_p: "Utopia Coliseum (Gilded)",
  utopiastadium_snow_p: "Utopia Coliseum (Snowy)",
  wasteland_s_p: "Wasteland",
  wasteland_night_s_p: "Wasteland (Night)",
  wasteland_grs_p: "Wasteland (Pitched)",
};

export function arenaName(raw: string | null): string {
  if (!raw) return "";
  return (
    ARENA_NAMES[raw.toLowerCase()] ??
    raw
      .replace(/_p$/i, "")
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
  );
}
