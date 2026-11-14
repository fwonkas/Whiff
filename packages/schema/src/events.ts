import { z } from "zod";

/**
 * Schemas for messages from the Rocket League Stats API, written against
 * real recordings rather than the docs alone. Where the game disagrees with
 * the docs, the comment says so. Objects are "loose": unknown fields survive
 * parsing so a game patch adds data instead of breaking the collector.
 */

export const Vector = z.looseObject({ X: z.number(), Y: z.number(), Z: z.number() });
export type Vector = z.infer<typeof Vector>;

/** Compact player reference used inside events. */
export const PlayerRef = z.looseObject({
  Name: z.string(),
  Shortcut: z.number(),
  TeamNum: z.number(),
});
export type PlayerRef = z.infer<typeof PlayerRef>;

/** `MatchGuid` is present on every event but empty in live play; ticks carry the real one. */
const MatchGuid = z.string().optional().default("");

export const TickPlayer = z.looseObject({
  Name: z.string(),
  /** "Platform|Uid|Splitscreen". Bots all share "Unknown|0|0". */
  PrimaryId: z.string(),
  Shortcut: z.number(),
  TeamNum: z.number(),
  Score: z.number(),
  Goals: z.number(),
  Shots: z.number(),
  Assists: z.number(),
  Saves: z.number(),
  Touches: z.number(),
  CarTouches: z.number(),
  Demos: z.number(),
  /** 28 slots in practice (the docs show 6). */
  Loadout: z.array(z.string()).optional(),
  // Car state: only for me and teammates in live play, everyone in replays.
  // Boolean flags are omitted when false.
  bHasCar: z.boolean().optional(),
  /** km/h (the docs say Unreal units/s; the game sends km/h). */
  Speed: z.number().optional(),
  Boost: z.number().optional(),
  bBoosting: z.boolean().optional(),
  bOnGround: z.boolean().optional(),
  /** Arrives together with bOnGround: true. */
  bOnWall: z.boolean().optional(),
  bPowersliding: z.boolean().optional(),
  bDemolished: z.boolean().optional(),
  bSupersonic: z.boolean().optional(),
  PickupClass: z.string().nullable().optional(),
  Attacker: PlayerRef.optional(),
});
export type TickPlayer = z.infer<typeof TickPlayer>;

export const Team = z.looseObject({
  /** "Blue"/"Orange", or a club name. Use TeamNum, never Name. */
  Name: z.string(),
  TeamNum: z.number(),
  Score: z.number(),
  ColorPrimary: z.string(),
  ColorSecondary: z.string(),
});

export const TickGame = z.looseObject({
  Teams: z.array(Team),
  PlaylistId: z.number(),
  /** Counts down in regulation, up in overtime and freeplay, down per shot in training. */
  TimeSeconds: z.number(),
  bOvertime: z.boolean(),
  Ball: z.looseObject({ Speed: z.number(), TeamNum: z.number() }),
  /** True during goal replays in live play as well as saved replays. */
  bReplay: z.boolean(),
  bHasWinner: z.boolean(),
  Winner: z.string(),
  Arena: z.string(),
  bHasTarget: z.boolean(),
  Target: PlayerRef.optional(),
  /** Replay only. SeekReplay TimeSeconds targets Frame / 30. */
  Frame: z.number().optional(),
  Elapsed: z.number().optional(),
});

const ev = <E extends string, S extends z.ZodType>(event: E, data: S) =>
  z.object({ Event: z.literal(event), Data: data });

const MatchOnly = z.looseObject({ MatchGuid });

export const UpdateState = ev(
  "UpdateState",
  z.looseObject({ MatchGuid, Players: z.array(TickPlayer), Game: TickGame }),
);

export const BallHit = ev(
  "BallHit",
  z.looseObject({
    MatchGuid,
    Players: z.array(PlayerRef),
    Ball: z.looseObject({ PreHitSpeed: z.number(), PostHitSpeed: z.number(), Location: Vector }),
  }),
);

export const BoostPickup = ev(
  "BoostPickup",
  z.looseObject({
    MatchGuid,
    Player: PlayerRef,
    Location: Vector,
    BoostAmount: z.number(),
    BoostType: z.string(),
    bReplay: z.boolean().optional(),
  }),
);

export const ClockUpdatedSeconds = ev(
  "ClockUpdatedSeconds",
  z.looseObject({ MatchGuid, TimeSeconds: z.number(), bOvertime: z.boolean() }),
);

const LastTouch = z.looseObject({ Player: PlayerRef, Speed: z.number() });

export const CrossbarHit = ev(
  "CrossbarHit",
  z.looseObject({
    MatchGuid,
    BallLocation: Vector,
    BallSpeed: z.number(),
    ImpactForce: z.number(),
    BallLastTouch: LastTouch.optional(),
  }),
);

/**
 * Online matches send this twice per goal: once at the goal, and again with a
 * blank scorer when the goal replay ends. The second one's ImpactLocation is
 * the reliable one. In training, every shot attempt ends with one GoalScored,
 * made or missed.
 */
export const GoalScored = ev(
  "GoalScored",
  z.looseObject({
    MatchGuid,
    GoalSpeed: z.number(),
    GoalTime: z.number(),
    ImpactLocation: Vector,
    Scorer: PlayerRef,
    Assister: PlayerRef.optional(),
    BallLastTouch: LastTouch.optional(),
  }),
);

export const MatchEnded = ev("MatchEnded", z.looseObject({ MatchGuid, WinnerTeamNum: z.number() }));

const PlayerPresence = z.looseObject({ MatchGuid, PlayerName: z.string(), PrimaryId: z.string() });
export const PlayerJoined = ev("PlayerJoined", PlayerPresence);
export const PlayerLeft = ev("PlayerLeft", PlayerPresence);

/** FileName is the replay ID, which is also the .replay file name in DemosEpic. No MatchGuid. */
export const ReplayCreated = ev(
  "ReplayCreated",
  z.looseObject({ MatchGuid, FileName: z.string(), Date: z.string() }),
);

export const StatfeedEvent = ev(
  "StatfeedEvent",
  z.looseObject({
    MatchGuid,
    EventName: z.string(),
    Type: z.string(),
    MainTarget: PlayerRef,
    SecondaryTarget: PlayerRef.optional(),
  }),
);

const simple = <E extends string>(e: E) => ev(e, MatchOnly);
export const CountdownBegin = simple("CountdownBegin");
export const GoalReplayEnd = simple("GoalReplayEnd");
export const GoalReplayStart = simple("GoalReplayStart");
export const GoalReplayWillEnd = simple("GoalReplayWillEnd");
export const MatchCreated = simple("MatchCreated");
export const MatchDestroyed = simple("MatchDestroyed");
export const MatchInitialized = simple("MatchInitialized");
/** Also sent by the pause menu offline, by SetMatchPaused and by SetGameSpeed 0. */
export const MatchPaused = simple("MatchPaused");
export const MatchUnpaused = simple("MatchUnpaused");
export const PodiumStart = simple("PodiumStart");
export const RoundStarted = simple("RoundStarted");

export const KnownMessage = z.discriminatedUnion("Event", [
  UpdateState,
  BallHit,
  BoostPickup,
  ClockUpdatedSeconds,
  CountdownBegin,
  CrossbarHit,
  GoalReplayEnd,
  GoalReplayStart,
  GoalReplayWillEnd,
  GoalScored,
  MatchCreated,
  MatchDestroyed,
  MatchEnded,
  MatchInitialized,
  MatchPaused,
  MatchUnpaused,
  PlayerJoined,
  PlayerLeft,
  PodiumStart,
  ReplayCreated,
  RoundStarted,
  StatfeedEvent,
]);
export type GameMessage = z.infer<typeof KnownMessage>;
export type EventName = GameMessage["Event"];
export type MessageOf<E extends EventName> = Extract<GameMessage, { Event: E }>;
export const EVENT_NAMES = KnownMessage.options.map((o) => o.shape.Event.value) as EventName[];
