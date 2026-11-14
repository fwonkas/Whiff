import { z } from "zod";

/**
 * Query and body schemas, shared by the server (to validate) and the web app
 * (to build URLs and typed search params). Values arrive as strings from URLs,
 * so numbers are coerced.
 */

export const TeamSize = z.coerce.number().int().min(1).max(3);
export const WithFilter = z.enum(["solo", "party"]);
/** Wins, losses, or matches I was MVP in. */
export const ResultFilter = z.enum(["win", "loss", "mvp"]);
export type ResultFilter = z.infer<typeof ResultFilter>;
/** Matches whose replay isn't saved yet ("attention": in Match History or gone), or is saved. */
export const ReplayFilter = z.enum(["attention", "saved"]);
export type ReplayFilter = z.infer<typeof ReplayFilter>;

export const SessionsQuery = z.object({
  /** "practice" = freeplay and training. Replays are never listed. */
  kind: z.enum(["all", "match", "practice"]).default("all"),
  teamSize: TeamSize.optional(),
  playlist: z.coerce.number().int().optional(),
  with: WithFilter.optional(),
  result: ResultFilter.optional(),
  replay: ReplayFilter.optional(),
  /** Cursor: only sessions that started before this time (ms). */
  before: z.coerce.number().int().optional(),
  /** Date range (ms): sessions that started at or after `since` and before `until`. */
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type SessionsQuery = z.infer<typeof SessionsQuery>;

export const PlaySessionsQuery = z.object({
  /** Cursor: only play sessions that started before this time (ms). */
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(30),
});
export type PlaySessionsQuery = z.infer<typeof PlaySessionsQuery>;

export const SummaryQuery = SessionsQuery.pick({ teamSize: true, playlist: true, with: true, result: true, replay: true, since: true, until: true });
export type SummaryQuery = z.infer<typeof SummaryQuery>;

export const METRIC_NAMES = [
  "touchShare",
  "medianTouchSpeed",
  "hardTouches",
  "contestedTouches",
  "possessionRuns",
  "air",
  "goals",
  "saves",
  "shotConversion",
] as const;
export const MetricName = z.enum(METRIC_NAMES);

export const TrendsQuery = z.object({
  /** Comma-separated metric names. */
  metrics: z
    .string()
    .default(METRIC_NAMES.join(","))
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(MetricName).min(1)),
  teamSize: TeamSize.optional(),
  playlist: z.coerce.number().int().optional(),
  with: WithFilter.optional(),
  window: z.coerce.number().int().min(1).max(50).default(5),
});
export type TrendsQuery = z.input<typeof TrendsQuery>;

export const PackType = z.enum(["offense", "defense"]);

export const PatchSessionBody = z.object({
  packCode: z.string().trim().min(1).max(40).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});
export type PatchSessionBody = z.infer<typeof PatchSessionBody>;

export const ReplayGotoBody = z.object({
  replayId: z.string().regex(/^[0-9A-Fa-f]{32}$/),
  frame: z.number().int().nonnegative(),
  /** Start this many seconds before the frame, to see the play leading up to it. Default: the replayLeadSeconds setting. */
  leadSeconds: z.number().min(0).max(60).optional(),
  /** mine: my car from my view; director: the game's director camera; keep: leave it. */
  camera: z.enum(["mine", "director", "keep"]).default("mine"),
  /** Start Rocket League first if it isn't running. */
  launch: z.boolean().optional(),
});
export type ReplayGotoBody = z.infer<typeof ReplayGotoBody>;

export const PutPackBody = z.object({
  name: z.string().trim().min(1).max(80),
  type: PackType,
});
export type PutPackBody = z.infer<typeof PutPackBody>;
