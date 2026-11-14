import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SUBTR_STREAMS, SUBTR_TRACKS, type SubtrExtract, type SubtrPlayer } from "@rl/metrics";
import * as subtr from "@rlrml/subtr-actor";

/**
 * subtr-actor (WASM) behind our own interface: one call from replay bytes to
 * the `SubtrExtract` the metrics use. The library churns quickly, so it's
 * pinned, and everything it returns is read here and nowhere else.
 */
export const SUBTR_VERSION = "1.5.1";

/** The WASM file, in node_modules (the desktop app passes its own copy's path). */
export function defaultWasmPath(): string {
  return createRequire(import.meta.url).resolve("@rlrml/subtr-actor/rl_replay_subtr_actor_bg.wasm");
}

let loaded = false;
export function loadSubtr(wasmPath?: string): void {
  if (loaded) return;
  // Its main() logs a line on load; keep the collector's output clean.
  const log = console.log;
  console.log = () => {};
  try {
    // Looked up only when no path is given: the desktop app passes its own copy and has no node_modules.
    subtr.initSync({ module: readFileSync(wasmPath ?? defaultWasmPath()) });
  } finally {
    console.log = log;
  }
  loaded = true;
}

interface RawTimeline {
  replay_meta: { team_zero: SubtrPlayer[]; team_one: SubtrPlayer[]; all_headers: [string, unknown][] };
  events: { events: { meta: { stream: string }; payload: { payload: Record<string, unknown> } }[] };
  frames: { time: number; seconds_remaining: number; is_live_play: boolean }[];
  accumulation_tracks: SubtrExtract["tracks"];
  activity_summary: { players: { player_id: Record<string, unknown>; active_seconds: number }[] };
}

const keep = new Set<string>(SUBTR_STREAMS);
const keepTracks = new Set<string>(SUBTR_TRACKS);

/** Parse a replay and keep what the metrics read. Takes a few seconds: run it in a worker. */
export function extractReplay(bytes: Uint8Array): SubtrExtract {
  loadSubtr();
  const t = subtr.get_stats_timeline(bytes, false) as RawTimeline;
  const header = new Map(t.replay_meta.all_headers);
  const str = (k: string) => (typeof header.get(k) === "string" ? (header.get(k) as string) : null);
  const num = (k: string) => (typeof header.get(k) === "number" ? (header.get(k) as number) : null);
  const player = ({ remote_id, name }: SubtrPlayer): SubtrPlayer => ({ remote_id, name });
  return {
    version: SUBTR_VERSION,
    replayId: str("Id")?.toUpperCase() ?? null,
    matchGuid: str("MatchGUID")?.toUpperCase() ?? null,
    mapName: str("MapName"),
    teamSize: num("TeamSize"),
    team0Score: num("Team0Score") ?? 0,
    team1Score: num("Team1Score") ?? 0,
    players: { team0: t.replay_meta.team_zero.map(player), team1: t.replay_meta.team_one.map(player) },
    frames: t.frames.map((f) => ({ time: f.time, clock: f.seconds_remaining, live: f.is_live_play })),
    events: t.events.events.filter((e) => keep.has(e.meta.stream)).map((e) => ({ stream: e.meta.stream, payload: e.payload.payload })),
    tracks: t.accumulation_tracks.filter((tr) => keepTracks.has(tr.quantity)),
    activeSeconds: t.activity_summary.players.map((p) => ({ player_id: p.player_id, seconds: p.active_seconds })),
  };
}
