/**
 * Gameplay metrics from a saved replay, via subtr-actor's stats timeline.
 *
 * The collector runs subtr-actor (WASM, in a worker) and keeps only what's
 * below as a `SubtrExtract`: the players, a few event streams, the boost
 * tracks and each frame's time. This file turns that into per-player
 * positioning, boost and challenge numbers plus a list of moments worth
 * reviewing. It's pure so it can be tested on a recording and re-run
 * whenever the rules change, without parsing the replay again.
 *
 * Units: subtr-actor reports boost as 0..255 like the game's network data;
 * everything here is 0..100 like the HUD. Times are replay seconds
 * (`time`), frames are replay frames (the replay remote seeks by frame).
 */

// --- input: what the collector keeps from subtr-actor ------------------------

/** subtr-actor's player ID: `{ Epic: "…" }`, `{ PlayStation: { online_id, … } }`, … */
export type SubtrPlayerId = Record<string, unknown>;

export interface SubtrPlayer {
  remote_id: SubtrPlayerId;
  name: string;
}

export interface SubtrEvent {
  stream: string;
  payload: Record<string, unknown>;
}

export interface SubtrTrack {
  player_id: SubtrPlayerId;
  is_team_0: boolean;
  quantity: string;
  points: { frame: number; value: number }[];
}

export interface SubtrExtract {
  /** subtr-actor's version, for re-running analysis when it changes. */
  version: string;
  replayId: string | null;
  matchGuid: string | null;
  mapName: string | null;
  teamSize: number | null;
  team0Score: number | null;
  team1Score: number | null;
  players: { team0: SubtrPlayer[]; team1: SubtrPlayer[] };
  /** Per frame: replay time, seconds left on the clock and whether play was live. */
  frames: { time: number; clock: number; live: boolean }[];
  events: SubtrEvent[];
  tracks: SubtrTrack[];
  /** Seconds each player was in live play. */
  activeSeconds: { player_id: SubtrPlayerId; seconds: number }[];
}

/** The streams the collector keeps (the rest is large and unused so far). */
export const SUBTR_STREAMS = [
  "rotation_role",
  "depth_role",
  "shadow_defense",
  "boost_pickups",
  "fifty_fifty",
  "beaten_to_ball",
  "whiff",
  "demolition",
  "touch",
  "timeline",
  "goal_context",
] as const;

/** Tracks the collector keeps. */
export const SUBTR_TRACKS = ["boost_amount", "boost_collected", "boost_overfill", "boost_stolen", "boost_used"] as const;

// --- output -----------------------------------------------------------------

export interface PlayerReplayMetrics {
  /** As the Stats API writes it ("Epic|…|0"), so it matches live recordings. */
  primaryId: string;
  name: string;
  /** 0 blue, 1 orange. */
  team: 0 | 1;
  liveSeconds: number;
  positioning: {
    /** Share of live play as the team's first man (closest in the play), from subtr-actor's rotation roles. */
    firstMan: number;
    secondMan: number;
    /** Share as the team's last player back. */
    lastBack: number;
    /** Share as the team's most forward player. */
    mostForward: number;
    /** Seconds shadowing an attacker (retreating goal-side at a distance). */
    shadowSeconds: number;
  };
  boost: {
    /** Time-weighted over live play, 0..100. */
    average: number;
    /** Share of live play with no boost (under 1). */
    empty: number;
    /** Share with 100. */
    full: number;
    collected: number;
    /** Collected beyond 100: wasted pickups. */
    overfill: number;
    stolen: number;
    used: number;
    bigPads: number;
    smallPads: number;
    /** Pads taken on the opponents' side. */
    steals: number;
  };
  challenges: {
    /** 50/50s outside kickoffs. */
    fifties: { won: number; lost: number; even: number };
    kickoffs: { won: number; lost: number; even: number };
    /** Lost the race to the ball to an opponent. */
    beatenToBall: number;
    /** Beat an opponent to the ball. */
    wonRace: number;
    whiffs: number;
    touches: number;
  };
  demos: { inflicted: number; taken: number };
  /** Goals my team conceded while I was the last one back. */
  concededAsLastBack: number;
}

export type MomentKind = "goal" | "shot" | "save" | "assist" | "demo" | "fifty" | "beaten" | "whiff" | "conceded-last-back";

export interface ReplayMoment {
  kind: MomentKind;
  frame: number;
  /** Replay seconds. */
  time: number;
  /** Seconds played, overtime continuing past 300 (like a live recording's matchTime). */
  matchTime: number;
  /** The player the moment is about. */
  player: string;
  /** Another player involved (the demo victim, who won the race…). */
  other: string | null;
  /** For a 50/50: whether the player's team won it (null: even). */
  won?: boolean | null;
}

export interface ReplayAnalysis {
  /** "subtr-actor <version> / rules <n>": stored results are redone when this changes. */
  analyzer: string;
  replayId: string | null;
  matchGuid: string | null;
  mapName: string | null;
  teamSize: number | null;
  score: [number, number] | null;
  players: PlayerReplayMetrics[];
  moments: ReplayMoment[];
}

/** Bump when the rules below change, so stored analyses are redone. */
export const REPLAY_RULES_VERSION = 2;

export const analyzerName = (subtrVersion: string) => `subtr-actor ${subtrVersion} / rules ${REPLAY_RULES_VERSION}`;

// --- IDs ----------------------------------------------------------------------

/** subtr-actor's platform names, as the Stats API spells them in PrimaryIds. */
const PLATFORMS: Record<string, string> = { Epic: "Epic", Steam: "Steam", PlayStation: "PS4", PsyNet: "PS4", Xbox: "XboxOne", Switch: "Switch" };

/** A subtr-actor player ID as a Stats API PrimaryId; bots get "bot:<name>" like live recordings. */
export function primaryIdOf(id: SubtrPlayerId, name: string): string {
  const [platform, value] = Object.entries(id)[0] ?? [];
  if (!platform || PLATFORMS[platform] === undefined) return `bot:${name}`;
  const raw = typeof value === "object" && value !== null ? (value as { online_id?: unknown }).online_id : value;
  return `${PLATFORMS[platform]}|${String(raw)}|0`;
}

const idKey = (id: unknown) => JSON.stringify(id);

// --- the rules ------------------------------------------------------------------

const BOOST_SCALE = 100 / 255;

interface Span {
  frame: number;
  end_frame: number;
  duration: number;
}

export function analyzeReplay(x: SubtrExtract): ReplayAnalysis {
  const all = [...x.players.team0.map((p) => ({ p, team: 0 as const })), ...x.players.team1.map((p) => ({ p, team: 1 as const }))];
  const ids = new Map(all.map(({ p }) => [idKey(p.remote_id), primaryIdOf(p.remote_id, p.name)]));
  const pid = (id: unknown): string | null => (id ? (ids.get(idKey(id)) ?? null) : null);
  // Match time per frame: from the clock in regulation, then live seconds since it reached 0.
  const matchTimes: number[] = [];
  let otLive = 0;
  let regulationOver = false;
  for (let f = 0; f < x.frames.length; f++) {
    const fr = x.frames[f]!;
    if (fr.clock > 0 && !regulationOver) matchTimes.push(300 - fr.clock);
    else {
      if (regulationOver && fr.live && f > 0) otLive += Math.max(0, fr.time - x.frames[f - 1]!.time);
      regulationOver = true;
      matchTimes.push(300 + otLive);
    }
  }
  const clampFrame = (f: number) => Math.max(0, Math.min(x.frames.length - 1, f));

  const metrics = new Map<string, PlayerReplayMetrics>(
    all.map(({ p, team }) => [
      primaryIdOf(p.remote_id, p.name),
      {
        primaryId: primaryIdOf(p.remote_id, p.name),
        name: p.name,
        team,
        liveSeconds: 0,
        positioning: { firstMan: 0, secondMan: 0, lastBack: 0, mostForward: 0, shadowSeconds: 0 },
        boost: { average: 0, empty: 0, full: 0, collected: 0, overfill: 0, stolen: 0, used: 0, bigPads: 0, smallPads: 0, steals: 0 },
        challenges: {
          fifties: { won: 0, lost: 0, even: 0 },
          kickoffs: { won: 0, lost: 0, even: 0 },
          beatenToBall: 0,
          wonRace: 0,
          whiffs: 0,
          touches: 0,
        },
        demos: { inflicted: 0, taken: 0 },
        concededAsLastBack: 0,
      },
    ]),
  );
  const of = (id: unknown) => {
    const p = pid(id);
    return p ? metrics.get(p) : undefined;
  };
  for (const a of x.activeSeconds) {
    const m = of(a.player_id);
    if (m) m.liveSeconds = a.seconds;
  }

  const moments: ReplayMoment[] = [];
  const moment = (kind: MomentKind, frame: number, player: string | null, other: string | null = null, extra: Partial<ReplayMoment> = {}) => {
    if (!player) return;
    const i = clampFrame(frame);
    moments.push({ kind, frame, time: x.frames[i]?.time ?? 0, matchTime: matchTimes[i] ?? 0, player, other, ...extra });
  };

  // Seconds per role, from spans.
  const roleSeconds = new Map<string, Record<string, number>>();
  const addRole = (id: unknown, role: string, seconds: number) => {
    const p = pid(id);
    if (!p) return;
    const r = roleSeconds.get(p) ?? {};
    r[role] = (r[role] ?? 0) + seconds;
    roleSeconds.set(p, r);
  };

  for (const { stream, payload: e } of x.events) {
    switch (stream) {
      case "rotation_role":
        addRole(e.player, `rotation:${e.state}`, (e as unknown as Span).duration);
        break;
      case "depth_role":
        addRole(e.player, `depth:${e.state}`, (e as unknown as Span).duration);
        break;
      case "shadow_defense": {
        const m = of(e.player);
        if (m) m.positioning.shadowSeconds += (e as unknown as Span).duration;
        break;
      }
      case "boost_pickups": {
        const m = of(e.player_id);
        if (!m) break;
        if (e.pad_type === "big") m.boost.bigPads++;
        else m.boost.smallPads++;
        if (e.is_steal) m.boost.steals++;
        break;
      }
      case "fifty_fifty": {
        const winner0 = e.winning_team_is_team_0 as boolean | null | undefined;
        const key = e.is_kickoff ? "kickoffs" : "fifties";
        for (const [side, team0] of [
          ["team_zero_player", true],
          ["team_one_player", false],
        ] as const) {
          const m = of(e[side]);
          if (!m) continue;
          const won = winner0 === null || winner0 === undefined ? null : winner0 === team0;
          m.challenges[key][won === null ? "even" : won ? "won" : "lost"]++;
          if (!e.is_kickoff) moment("fifty", Number(e.start_frame), m.primaryId, pid(e[team0 ? "team_one_player" : "team_zero_player"]), { won });
        }
        break;
      }
      case "beaten_to_ball": {
        const loser = of(e.player);
        const winner = of(e.winner);
        if (loser) loser.challenges.beatenToBall++;
        if (winner) winner.challenges.wonRace++;
        moment("beaten", Number(e.frame), loser?.primaryId ?? null, winner?.primaryId ?? null);
        break;
      }
      case "whiff": {
        const m = of(e.player);
        if (m) m.challenges.whiffs++;
        moment("whiff", Number(e.frame), m?.primaryId ?? null);
        break;
      }
      case "demolition": {
        const a = of(e.attacker);
        const v = of(e.victim);
        if (a) a.demos.inflicted++;
        if (v) v.demos.taken++;
        moment("demo", Number(e.frame), a?.primaryId ?? null, v?.primaryId ?? null);
        break;
      }
      case "touch": {
        const m = of(e.player);
        if (m) m.challenges.touches++;
        break;
      }
      case "timeline": {
        const kind = String(e.kind).toLowerCase();
        if (kind === "goal" || kind === "shot" || kind === "save" || kind === "assist") moment(kind, Number(e.frame), pid(e.player_id));
        break;
      }
      case "goal_context": {
        const m = of(e.defending_team_most_back_player);
        if (m) {
          m.concededAsLastBack++;
          moment("conceded-last-back", Number(e.frame), m.primaryId, pid(e.scorer));
        }
        break;
      }
    }
  }

  for (const m of metrics.values()) {
    const r = roleSeconds.get(m.primaryId) ?? {};
    const live = m.liveSeconds || 1;
    m.positioning.firstMan = (r["rotation:first_man"] ?? 0) / live;
    m.positioning.secondMan = (r["rotation:second_man"] ?? 0) / live;
    m.positioning.lastBack = (r["depth:most_back"] ?? 0) / live;
    m.positioning.mostForward = (r["depth:most_forward"] ?? 0) / live;
  }

  // Boost: totals are the tracks' last values; level shares are weighted by live frame time.
  for (const t of x.tracks) {
    const m = of(t.player_id);
    if (!m || !t.points.length) continue;
    const last = t.points[t.points.length - 1]!.value * BOOST_SCALE;
    if (t.quantity === "boost_collected") m.boost.collected = last;
    else if (t.quantity === "boost_overfill") m.boost.overfill = last;
    else if (t.quantity === "boost_stolen") m.boost.stolen = last;
    else if (t.quantity === "boost_used") m.boost.used = last;
    else if (t.quantity === "boost_amount") Object.assign(m.boost, boostLevels(t.points, x.frames));
  }

  moments.sort((a, b) => a.frame - b.frame);
  return {
    analyzer: analyzerName(x.version),
    replayId: x.replayId,
    matchGuid: x.matchGuid,
    mapName: x.mapName,
    teamSize: x.teamSize,
    score: x.team0Score !== null && x.team1Score !== null ? [x.team0Score, x.team1Score] : null,
    players: [...metrics.values()],
    moments,
  };
}

/** Average, empty and full shares of a boost track (points change the value from their frame on), over live frames. */
function boostLevels(points: { frame: number; value: number }[], frames: SubtrExtract["frames"]) {
  let i = 0;
  let value = points[0]!.value;
  let total = 0;
  let sum = 0;
  let empty = 0;
  let full = 0;
  for (let f = 0; f < frames.length - 1; f++) {
    while (i < points.length && points[i]!.frame <= f) value = points[i++]!.value;
    if (!frames[f]!.live) continue;
    const dt = frames[f + 1]!.time - frames[f]!.time;
    if (!(dt > 0)) continue;
    const v = value * BOOST_SCALE;
    total += dt;
    sum += v * dt;
    if (v < 1) empty += dt;
    if (v >= 99.5) full += dt;
  }
  return total ? { average: sum / total, empty: empty / total, full: full / total } : { average: 0, empty: 0, full: 0 };
}
