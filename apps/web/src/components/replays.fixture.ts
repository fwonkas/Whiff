import type { ReplayMatchItem, ReplaysResponse } from "@rl/api-contract";

/** A Replays response for tests: one match about to leave Match History, one gone, one saved. */
export const day = new Date(2026, 10, 3, 21, 0).getTime();
const item = (over: Partial<ReplayMatchItem>): ReplayMatchItem => ({
  sessionId: "m1", startedAt: day, playlistId: 11, playlistName: "Ranked Doubles", arena: "Stadium_P", outcome: "win", goalsFor: 3, goalsAgainst: 1, mvp: false,
  source: "live", state: "saved", replayId: "A".repeat(32), played: true, history: null, notOnBallchasing: false, ...over,
});
export const replaysData: ReplaysResponse = {
  matches: [
    item({ sessionId: "m3", startedAt: day + 2000, state: "in-history", replayId: null, played: false, history: { position: 19, daysLeft: 12, atRisk: true } }),
    item({ sessionId: "m2", startedAt: day + 1000, state: "missing", replayId: null, played: false, outcome: "loss", goalsFor: 1, goalsAgainst: 2 }),
    item({ sessionId: "m1" }),
  ],
  counts: { matches: 3, saved: 1, played: 1, inHistory: 1, atRisk: 1, missing: 1 },
  toPlay: { unrecorded: 2, recorded: 1, seconds: 900 },
  backfill: { running: false, current: null, done: 0, failed: 0, remaining: 0, remainingMs: null, quitWhenDone: false },
  ballchasing: { configured: true, running: false, done: 0, total: 0, found: 0, upload: { enabled: false, pending: 0, uploaded: 0, waiting: null } },
  gameConnected: true,
  replayDirs: [],
};
