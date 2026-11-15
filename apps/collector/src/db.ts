import { mkdirSync } from "node:fs";
import type { PlayerReplayMetrics, ReplayAnalysis } from "@rl/metrics";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GameConnection, ReplayPlayback, Session, SessionKind, SessionPlayer } from "@rl/domain";
import { atFullSpeed, matchFromReplay, replayMatchId } from "./replays.ts";
import { isCasual, PLAYLISTS, playlistsOfSize } from "@rl/schema";

/**
 * SQLite projection of sessions. Rebuildable from the raw logs at any time:
 * saving a session replaces any earlier copy with the same id, so re-ingesting
 * a recording is safe.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('match','freeplay','training','replay')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  playlist_id INTEGER,
  arena TEXT,
  match_guid TEXT,
  replay_id TEXT,
  replay_date TEXT,
  my_team INTEGER,
  winner_team INTEGER,
  outcome TEXT CHECK (outcome IN ('win','loss','abandoned')),
  score_blue INTEGER,
  score_orange INTEGER,
  overtime INTEGER NOT NULL DEFAULT 0,
  partied INTEGER NOT NULL DEFAULT 0,
  queue_warmup INTEGER NOT NULL DEFAULT 0,
  game_speed REAL,
  team_size INTEGER,
  source TEXT NOT NULL DEFAULT 'live',
  forfeit INTEGER NOT NULL DEFAULT 0,
  playback TEXT,
  paused_seconds REAL NOT NULL DEFAULT 0,
  pack_code TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS sessions_guid ON sessions(match_guid);

CREATE TABLE IF NOT EXISTS session_players (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_key TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_bot INTEGER NOT NULL,
  is_me INTEGER NOT NULL,
  is_known_teammate INTEGER NOT NULL,
  team INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  joined_at INTEGER,
  left_at INTEGER,
  score INTEGER, goals INTEGER, shots INTEGER, assists INTEGER, saves INTEGER, touches INTEGER, demos INTEGER,
  PRIMARY KEY (session_id, player_key)
);

CREATE TABLE IF NOT EXISTS goals (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  match_time REAL,
  team INTEGER NOT NULL,
  scorer_key TEXT, assister_key TEXT, last_touch_key TEXT,
  speed_kmh REAL NOT NULL,
  goal_time REAL NOT NULL,
  x REAL, y REAL, z REAL,
  location_source TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS touches (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  match_time REAL,
  player_key TEXT NOT NULL,
  pre_speed REAL, post_speed REAL,
  x REAL, y REAL, z REAL,
  simultaneous INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS touches_session ON touches(session_id, at);

CREATE TABLE IF NOT EXISTS crossbar_hits (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  match_time REAL,
  x REAL, y REAL, z REAL,
  ball_speed REAL, impact_force REAL,
  last_touch_key TEXT
);

CREATE TABLE IF NOT EXISTS stat_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  match_time REAL,
  event_name TEXT NOT NULL,
  label TEXT,
  main_key TEXT,
  secondary_key TEXT
);

CREATE TABLE IF NOT EXISTS training_attempts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  time_limit REAL,
  outcome TEXT NOT NULL CHECK (outcome IN ('scored','conceded','none','reset')),
  ball_speed REAL,
  x REAL, y REAL, z REAL,
  touches INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS car_summaries (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_key TEXT NOT NULL,
  samples INTEGER NOT NULL,
  ground REAL, wall REAL, air REAL, boosting REAL, supersonic REAL, avg_speed REAL,
  PRIMARY KEY (session_id, player_key)
);

CREATE TABLE IF NOT EXISTS boost_pickups (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  match_time REAL,
  player_key TEXT,
  boost_type TEXT NOT NULL,
  x REAL, y REAL, z REAL
);

CREATE TABLE IF NOT EXISTS replay_frames (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  match_time REAL NOT NULL,
  frame INTEGER NOT NULL,
  PRIMARY KEY (session_id, match_time)
);

-- Training packs I've tagged. Sessions point here by pack_code.
CREATE TABLE IF NOT EXISTS packs (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('offense','defense'))
);

-- Game launches and quits. Quits help split play sessions.
CREATE TABLE IF NOT EXISTS game_connections (
  connected_at INTEGER PRIMARY KEY,
  disconnected_at INTEGER
);

CREATE TABLE IF NOT EXISTS ingested_files (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL
);

-- Live matches the settings left out (casual), by match GUID: their replays
-- aren't played through while casual matches stay off.
CREATE TABLE IF NOT EXISTS skipped_matches (
  guid TEXT PRIMARY KEY,
  playlist_id INTEGER,
  skipped_at INTEGER NOT NULL
);

-- Matches deleted in the app. Re-ingesting the raw logs skips them.
CREATE TABLE IF NOT EXISTS deleted_matches (
  key TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

-- What ballchasing said about a match's replay (found 0: not among my uploads).
CREATE TABLE IF NOT EXISTS ballchasing_checks (
  match_guid TEXT PRIMARY KEY,
  found INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);

-- subtr-actor's analysis of saved replays (redone when the analyzer changes); error set when it failed.
CREATE TABLE IF NOT EXISTS replay_analysis (
  replay_id TEXT PRIMARY KEY,
  match_guid TEXT,
  analyzer TEXT NOT NULL,
  analyzed_at INTEGER NOT NULL,
  error TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS replay_analysis_guid ON replay_analysis(match_guid);

-- Saved replays ballchasing has: uploaded by the app, already there, or downloaded from there.
CREATE TABLE IF NOT EXISTS ballchasing_uploads (
  replay_id TEXT PRIMARY KEY,
  ballchasing_id TEXT,
  how TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

const b = (x: boolean) => (x ? 1 : 0);

export class StatsDb {
  readonly db: DatabaseSync;
  /** The recordCasual setting (off by default, like the sessionizer's): see setRecordCasual. */
  private recordCasual = false;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // Columns added after the first release. Re-ingest with --force to fill them.
    const columns = (this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    const add = (name: string, def: string) => {
      if (!columns.includes(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${def}`);
    };
    add("team_size", "INTEGER");
    add("source", "TEXT NOT NULL DEFAULT 'live'");
    add("forfeit", "INTEGER NOT NULL DEFAULT 0");
    add("playback", "TEXT");
  }

  close(): void {
    this.db.close();
  }

  /**
   * Insert or replace a session and all its children, atomically. Then bring
   * the match rebuilt from a saved replay in line: it exists only while a
   * complete replay of one of my matches has no live recording.
   */
  /** Save a session. False when it belongs to a match deleted in the app, which stays deleted. */
  saveSession(s: Session): boolean {
    if (this.isDeleted(s)) return false;
    this.writeSession(s);
    if (s.matchGuid && (s.kind === "match" || s.kind === "replay")) this.reconcileReplayMatch(s.matchGuid);
    return true;
  }

  /**
   * Casual matches are kept only with the setting on (like the sessionizer):
   * off, no match is rebuilt from a casual replay and any rebuilt before goes;
   * on, the casual replays already played through become matches.
   */
  setRecordCasual(on: boolean): number {
    this.recordCasual = on;
    const casual = Object.entries(PLAYLISTS).filter(([, p]) => p.casual === true).map(([id]) => Number(id));
    const list = casual.join(",");
    if (!on) return Number(this.db.prepare(`DELETE FROM sessions WHERE id LIKE 'match-replay-%' AND playlist_id IN (${list})`).run().changes);
    const guids = this.db.prepare(`SELECT DISTINCT match_guid FROM sessions WHERE kind = 'replay' AND match_guid IS NOT NULL AND playlist_id IN (${list})`).all() as { match_guid: string }[];
    for (const g of guids) this.reconcileReplayMatch(g.match_guid);
    return 0;
  }

  /** A live match the settings left out (casual): see skippedGuids. */
  recordSkipped(s: Session): void {
    if (!s.matchGuid) return;
    this.db.prepare("INSERT OR REPLACE INTO skipped_matches (guid, playlist_id, skipped_at) VALUES (?, ?, ?)").run(s.matchGuid.toUpperCase(), s.playlistId, s.endedAt);
  }

  /** Match GUIDs (upper case) of live matches left out while casual matches are off; none while they're on. */
  skippedGuids(): Set<string> {
    if (this.recordCasual) return new Set();
    const rows = this.db.prepare("SELECT guid FROM skipped_matches").all() as { guid: string }[];
    return new Set(rows.map((r) => r.guid));
  }

  /**
   * The playlist of every match the app knows by GUID (upper case): matches and
   * replay playbacks, and live matches left out while casual was off.
   */
  playlistsByGuid(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT match_guid AS guid, playlist_id AS playlistId FROM sessions WHERE match_guid IS NOT NULL AND playlist_id IS NOT NULL AND kind IN ('match', 'replay')
         UNION ALL SELECT guid, playlist_id FROM skipped_matches WHERE playlist_id IS NOT NULL`,
      )
      .all() as { guid: string; playlistId: number }[];
    return new Map(rows.map((r) => [r.guid.toUpperCase(), r.playlistId]));
  }

  /** Match GUIDs of matches deleted in the app. */
  deletedGuids(): Set<string> {
    const rows = this.db.prepare("SELECT key FROM deleted_matches WHERE key LIKE 'guid:%'").all() as { key: string }[];
    return new Set(rows.map((r) => r.key.slice(5)));
  }

  private reconcileReplayMatch(guid: string): void {
    const derivedId = replayMatchId(guid);
    const live = this.db
      .prepare("SELECT 1 FROM sessions WHERE kind = 'match' AND source = 'live' AND match_guid = ? LIMIT 1")
      .get(guid);
    const best = live ? null : this.bestReplay(guid);
    const rebuilt = best ? matchFromReplay(best) : null;
    const derived = rebuilt && (this.recordCasual || !isCasual(rebuilt.playlistId)) ? rebuilt : null;
    if (derived) this.writeSession(derived);
    else this.db.prepare("DELETE FROM sessions WHERE id = ?").run(derivedId);
  }

  private isDeleted(s: Session): boolean {
    const keys = [s.id, ...(s.matchGuid ? [`guid:${s.matchGuid.toUpperCase()}`] : [])];
    return keys.some((k) => this.db.prepare("SELECT 1 FROM deleted_matches WHERE key = ?").get(k) !== undefined);
  }

  /**
   * Delete a match: its row and everything under it, the replay playbacks of
   * the same match, and a note so re-ingesting the raw logs doesn't bring it
   * back. The raw log itself is untouched. Returns false when there's no such match.
   */
  deleteMatch(id: string): boolean {
    const row = this.sessionRow(id);
    if (!row || row.kind !== "match") return false;
    const guid = row.match_guid?.toUpperCase() ?? null;
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      const mark = this.db.prepare("INSERT OR REPLACE INTO deleted_matches (key, deleted_at) VALUES (?, ?)");
      mark.run(id, now);
      if (guid) {
        mark.run(`guid:${guid}`, now);
        this.db.prepare("DELETE FROM sessions WHERE UPPER(match_guid) = ?").run(guid);
      }
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return true;
  }

  /** Matches with a complete replay playback recorded: match GUID → replay ID. */
  playedMatches(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT match_guid, replay_id FROM sessions WHERE kind = 'replay' AND match_guid IS NOT NULL AND json_extract(playback, '$.complete') = 1")
      .all() as { match_guid: string; replay_id: string | null }[];
    return new Map(rows.map((r) => [r.match_guid.toUpperCase(), (r.replay_id ?? "").toUpperCase()]));
  }

  /** Every match's GUID, by session ID. */
  matchGuids(): Map<string, string> {
    const rows = this.db.prepare("SELECT id, match_guid FROM sessions WHERE kind = 'match' AND match_guid IS NOT NULL").all() as { id: string; match_guid: string }[];
    return new Map(rows.map((r) => [r.id, r.match_guid.toUpperCase()]));
  }

  recordBallchasingCheck(guid: string, found: boolean): void {
    this.db.prepare("INSERT OR REPLACE INTO ballchasing_checks (match_guid, found, checked_at) VALUES (?, ?, ?)").run(guid.toUpperCase(), b(found), Date.now());
  }

  recordBallchasingUpload(replayId: string, ballchasingId: string | null, how: "uploaded" | "duplicate" | "already" | "downloaded"): void {
    this.db
      .prepare("INSERT OR REPLACE INTO ballchasing_uploads (replay_id, ballchasing_id, how, at) VALUES (?, ?, ?, ?)")
      .run(replayId.toUpperCase(), ballchasingId, how, Date.now());
  }

  saveReplayAnalysis(replayId: string, analyzer: string, result: { analysis: ReplayAnalysis } | { error: string }): void {
    const analysis = "analysis" in result ? result.analysis : null;
    this.db
      .prepare("INSERT OR REPLACE INTO replay_analysis (replay_id, match_guid, analyzer, analyzed_at, error, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(replayId.toUpperCase(), analysis?.matchGuid ?? null, analyzer, Date.now(), "error" in result ? result.error : null, analysis ? JSON.stringify(analysis) : null);
  }

  /** Which analyzer last looked at each replay. */
  replayAnalyzers(): Map<string, string> {
    const rows = this.db.prepare("SELECT replay_id, analyzer FROM replay_analysis").all() as { replay_id: string; analyzer: string }[];
    return new Map(rows.map((r) => [r.replay_id, r.analyzer]));
  }

  /**
   * My numbers from each match's replay analysis, by session ID: matched by my
   * PrimaryId in that match. The newest analysis wins when a match has several.
   */
  myReplayMetrics(): Map<string, PlayerReplayMetrics> {
    const rows = this.db
      .prepare(
        `SELECT s.id, p.primary_id, a.data FROM sessions s
         JOIN session_players p ON p.session_id = s.id AND p.is_me = 1
         JOIN replay_analysis a ON a.match_guid = UPPER(s.match_guid) AND a.data IS NOT NULL
         WHERE s.kind = 'match' ORDER BY a.analyzed_at`,
      )
      .all() as { id: string; primary_id: string; data: string }[];
    const out = new Map<string, PlayerReplayMetrics>();
    for (const r of rows) {
      const mine = (JSON.parse(r.data) as ReplayAnalysis).players.find((p) => p.primaryId === r.primary_id);
      if (mine) out.set(r.id, mine);
    }
    return out;
  }

  /** A match's analysis (by its GUID), or why there's none. */
  replayAnalysis(guid: string): { analysis: ReplayAnalysis | null; error: string | null; replayId: string } | null {
    const row = this.db
      .prepare("SELECT replay_id, error, data FROM replay_analysis WHERE match_guid = ? ORDER BY data IS NULL, analyzed_at DESC LIMIT 1")
      .get(guid.toUpperCase()) as { replay_id: string; error: string | null; data: string | null } | undefined;
    if (!row) return null;
    return { replayId: row.replay_id, error: row.error, analysis: row.data ? (JSON.parse(row.data) as ReplayAnalysis) : null };
  }

  /** Saved replays ballchasing has. */
  onBallchasing(): Set<string> {
    const rows = this.db.prepare("SELECT replay_id FROM ballchasing_uploads").all() as { replay_id: string }[];
    return new Set(rows.map((r) => r.replay_id));
  }

  /** Matches ballchasing was asked about and didn't have. */
  notOnBallchasing(): Set<string> {
    const rows = this.db.prepare("SELECT match_guid FROM ballchasing_checks WHERE found = 0").all() as { match_guid: string }[];
    return new Set(rows.map((r) => r.match_guid));
  }

  /** The most recent complete playback of a match's replay. */
  bestReplay(guid: string): Session | null {
    const id = this.bestReplayId(guid);
    return id ? this.loadSession(id) : null;
  }

  /**
   * The complete playback to take a match's data from: the newest at normal
   * speed, else the newest (a faster one misses a few touches; see FULL_SPEED_MAX).
   */
  private bestReplayId(guid: string): string | null {
    const rows = this.db
      .prepare("SELECT id, playback FROM sessions WHERE kind = 'replay' AND match_guid = ? ORDER BY started_at DESC")
      .all(guid) as { id: string; playback: string | null }[];
    const complete = rows.flatMap((r) => {
      const p = r.playback ? (JSON.parse(r.playback) as ReplayPlayback) : null;
      return p?.complete ? [{ id: r.id, p }] : [];
    });
    return (complete.find((r) => atFullSpeed(r.p) !== false) ?? complete[0])?.id ?? null;
  }

  /**
   * Match GUIDs (upper case) whose every complete playback ran faster than
   * normal speed. Playbacks from before speed was measured don't count as fast.
   */
  fastPlaybackGuids(): Set<string> {
    const rows = this.db
      .prepare("SELECT upper(match_guid) AS guid, playback FROM sessions WHERE kind = 'replay' AND match_guid IS NOT NULL AND json_extract(playback, '$.complete') = 1")
      .all() as { guid: string; playback: string }[];
    const full = new Set<string>();
    const fast = new Set<string>();
    for (const r of rows) (atFullSpeed(JSON.parse(r.playback) as ReplayPlayback) === false ? fast : full).add(r.guid);
    return new Set([...fast].filter((g) => !full.has(g)));
  }

  private writeSession(s: Session): void {
    const db = this.db;
    db.exec("BEGIN");
    try {
      // User-entered fields survive re-ingest.
      const kept = db.prepare("SELECT pack_code, note FROM sessions WHERE id = ?").get(s.id) as
        | { pack_code: string | null; note: string | null }
        | undefined;
      db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
      db.prepare(
        `INSERT INTO sessions (id, kind, started_at, ended_at, playlist_id, arena, match_guid, replay_id, replay_date,
           my_team, winner_team, outcome, score_blue, score_orange, overtime, partied, queue_warmup, game_speed,
           team_size, paused_seconds, pack_code, note, source, forfeit, playback)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.id, s.kind, s.startedAt, s.endedAt, s.playlistId, s.arena, s.matchGuid, s.replayId, s.replayDate,
        s.myTeam, s.winnerTeam, s.outcome, s.scoreBlue, s.scoreOrange, b(s.overtime), b(s.partied), b(s.queueWarmup),
        s.gameSpeed, s.teamSize, s.pausedSeconds, kept?.pack_code ?? null, kept?.note ?? null,
        s.source, b(s.forfeit), s.playback ? JSON.stringify(s.playback) : null,
      );

      const player = db.prepare(
        `INSERT INTO session_players VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of s.players) {
        const t = p.stats;
        player.run(s.id, p.key, p.primaryId, p.name, b(p.isBot), b(p.isMe), b(p.isKnownTeammate), p.team,
          p.firstSeenAt, p.lastSeenAt, p.joinedAt, p.leftAt, t.score, t.goals, t.shots, t.assists, t.saves, t.touches, t.demos);
      }

      const goal = db.prepare(`INSERT INTO goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      s.goals.forEach((g, i) =>
        goal.run(s.id, i + 1, g.at, g.matchTime, g.team, g.scorerKey, g.assisterKey, g.lastTouchKey, g.speedKmh,
          g.goalTime, g.location.x, g.location.y, g.location.z, g.locationSource),
      );

      const touch = db.prepare(`INSERT INTO touches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const t of s.touches) {
        touch.run(s.id, t.at, t.matchTime, t.playerKey, t.preSpeed, t.postSpeed, t.location.x, t.location.y, t.location.z, b(t.simultaneous));
      }

      const cb = db.prepare(`INSERT INTO crossbar_hits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const c of s.crossbarHits) {
        cb.run(s.id, c.at, c.matchTime, c.location.x, c.location.y, c.location.z, c.ballSpeed, c.impactForce, c.lastTouchKey);
      }

      const se = db.prepare(`INSERT INTO stat_events VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const e of s.statEvents) se.run(s.id, e.at, e.matchTime, e.eventName, e.label, e.mainKey, e.secondaryKey);

      const ta = db.prepare(`INSERT INTO training_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const a of s.trainingAttempts) {
        ta.run(s.id, a.seq, a.startedAt, a.endedAt, a.timeLimit, a.outcome, a.ballSpeed,
          a.location?.x ?? null, a.location?.y ?? null, a.location?.z ?? null, a.touches);
      }

      const car = db.prepare(`INSERT INTO car_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const c of s.carSummaries) {
        car.run(s.id, c.playerKey, c.samples, c.ground, c.wall, c.air, c.boosting, c.supersonic, c.avgSpeed);
      }

      const bp = db.prepare(`INSERT INTO boost_pickups VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const p of s.boostPickups) {
        bp.run(s.id, p.at, p.matchTime, p.playerKey, p.boostType, p.location.x, p.location.y, p.location.z);
      }

      const rf = db.prepare(`INSERT INTO replay_frames VALUES (?, ?, ?)`);
      for (const f of s.replayFrames) rf.run(s.id, f.matchTime, f.frame);

      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Insert or update a game launch, keyed by when it connected. */
  saveConnection(c: GameConnection): void {
    this.db
      .prepare(
        `INSERT INTO game_connections (connected_at, disconnected_at) VALUES (?, ?)
         ON CONFLICT(connected_at) DO UPDATE SET disconnected_at = COALESCE(excluded.disconnected_at, disconnected_at)`,
      )
      .run(c.connectedAt, c.disconnectedAt);
  }

  /** Replay IDs played through completely at least once. */
  /** Replay playbacks not marked complete that watched from the start with no skips: candidates for completeAtReplayEnd. */
  unfinishedPlaybacks(): { id: string; replayId: string }[] {
    const rows = this.db
      .prepare(
        "SELECT id, replay_id FROM sessions WHERE kind = 'replay' AND replay_id IS NOT NULL AND json_extract(playback, '$.complete') = 0 AND json_extract(playback, '$.gaps') = 0",
      )
      .all() as { id: string; replay_id: string }[];
    return rows.map((r) => ({ id: r.id, replayId: r.replay_id.toUpperCase() }));
  }

  /** The winning team of the live-recorded match with this GUID, if any. */
  liveWinner(guid: string): number | null {
    const row = this.db
      .prepare("SELECT winner_team FROM sessions WHERE kind = 'match' AND source = 'live' AND match_guid = ? AND winner_team IS NOT NULL LIMIT 1")
      .get(guid.toUpperCase()) as { winner_team: number } | undefined;
    return row?.winner_team ?? null;
  }

  playedReplayIds(): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT replay_id FROM sessions WHERE kind = 'replay' AND replay_id IS NOT NULL AND json_extract(playback, '$.complete') = 1")
      .all() as { replay_id: string }[];
    return new Set(rows.map((r) => r.replay_id.toUpperCase()));
  }

  /** Match GUIDs of live-recorded matches, upper case. */
  liveMatchGuids(): Set<string> {
    const rows = this.db.prepare("SELECT match_guid FROM sessions WHERE kind = 'match' AND source = 'live' AND match_guid IS NOT NULL").all() as {
      match_guid: string;
    }[];
    return new Set(rows.map((r) => r.match_guid.toUpperCase()));
  }

  /** Online matches recorded live, for the Match History check. Private matches don't appear there. */
  liveOnlineMatches(): { id: string; matchGuid: string; endedAt: number; playlistId: number | null; outcome: string | null }[] {
    return this.db
      .prepare(
        `SELECT id, match_guid AS matchGuid, ended_at AS endedAt, playlist_id AS playlistId, outcome FROM sessions
         WHERE kind = 'match' AND source = 'live' AND match_guid IS NOT NULL AND (playlist_id IS NULL OR playlist_id != 6)`,
      )
      .all() as { id: string; matchGuid: string; endedAt: number; playlistId: number | null; outcome: string | null }[];
  }

  /** Live-recorded matches with a GUID, for finding their replays elsewhere (ballchasing). Newest first. */
  liveMatchesForReplays(): { sessionId: string; matchGuid: string; endedAt: number; arena: string | null; scoreBlue: number | null; scoreOrange: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT id AS sessionId, match_guid AS matchGuid, ended_at AS endedAt, arena, score_blue AS scoreBlue, score_orange AS scoreOrange FROM sessions
         WHERE kind = 'match' AND source = 'live' AND match_guid IS NOT NULL ORDER BY ended_at DESC`,
      )
      .all() as { sessionId: string; matchGuid: string; endedAt: number; arena: string | null; scoreBlue: number | null; scoreOrange: number | null }[];
    return rows.map((r) => ({ ...r, matchGuid: r.matchGuid.toUpperCase() }));
  }

  /**
   * Known teammates changed: re-mark players and recompute each session's
   * "with teammates" (a known teammate on my team), so past matches move
   * between Solo and With teammates without re-ingesting.
   */
  setKnownTeammates(primaryIds: readonly string[]): void {
    const ids = JSON.stringify([...primaryIds]);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE session_players SET is_known_teammate = (primary_id IN (SELECT value FROM json_each(?)))").run(ids);
      this.db
        .prepare(
          `UPDATE sessions SET partied = EXISTS (
             SELECT 1 FROM session_players sp
             WHERE sp.session_id = sessions.id AND sp.is_known_teammate = 1 AND sp.is_me = 0 AND sp.team = sessions.my_team)
           WHERE my_team IS NOT NULL`,
        )
        .run();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The name the game last showed for a player, from the newest session with them. */
  latestName(primaryId: string): string | null {
    const row = this.db
      .prepare("SELECT sp.name FROM session_players sp JOIN sessions s ON s.id = sp.session_id WHERE sp.primary_id = ? ORDER BY s.started_at DESC LIMIT 1")
      .get(primaryId) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /** The other people (no bots) in the newest session with one of these players as me. */
  playersWithMe(me: readonly string[]): { primaryId: string; name: string }[] {
    const ids = JSON.stringify([...me]);
    return this.db
      .prepare(
        `SELECT primary_id AS primaryId, name FROM session_players WHERE is_bot = 0 AND is_me = 0 AND session_id = (
           SELECT sp.session_id FROM session_players sp JOIN sessions s ON s.id = sp.session_id
           WHERE sp.is_me = 1 AND sp.primary_id IN (SELECT value FROM json_each(?)) ORDER BY s.started_at DESC LIMIT 1)
         ORDER BY team, name`,
      )
      .all(ids) as { primaryId: string; name: string }[];
  }

  /**
   * My player was guessed wrong: in every session credited to one of `from`,
   * mark `to` as me instead, and redo what follows from it (my team, the
   * outcome, "with teammates"). Sessions without `to` in them lose their "me".
   */
  reassignMe(from: readonly string[], to: readonly string[]): void {
    const fromIds = JSON.stringify([...from]);
    const toIds = JSON.stringify([...to]);
    this.db.exec("BEGIN");
    try {
      const ids = (
        this.db
          .prepare("SELECT DISTINCT session_id AS id FROM session_players WHERE is_me = 1 AND primary_id IN (SELECT value FROM json_each(?))")
          .all(fromIds) as { id: string }[]
      ).map((r) => r.id);
      const sessions = JSON.stringify(ids);
      this.db
        .prepare("UPDATE session_players SET is_me = (primary_id IN (SELECT value FROM json_each(?))) WHERE session_id IN (SELECT value FROM json_each(?))")
        .run(toIds, sessions);
      this.db
        .prepare(
          `UPDATE sessions SET
             my_team = (SELECT team FROM session_players sp WHERE sp.session_id = sessions.id AND sp.is_me = 1 LIMIT 1)
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .run(sessions);
      this.db
        .prepare(
          `UPDATE sessions SET
             outcome = CASE WHEN outcome = 'abandoned' OR winner_team IS NULL OR my_team IS NULL THEN outcome WHEN winner_team = my_team THEN 'win' ELSE 'loss' END,
             partied = my_team IS NOT NULL AND EXISTS (
               SELECT 1 FROM session_players sp
               WHERE sp.session_id = sessions.id AND sp.is_known_teammate = 1 AND sp.is_me = 0 AND sp.team = sessions.my_team)
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .run(sessions);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Players who were on my team in matches, most frequent first. */
  teammateSuggestions(limit = 30): { primaryId: string; name: string; matches: number; lastPlayedAt: number; known: boolean }[] {
    const rows = this.db
      .prepare(
        `SELECT sp.primary_id AS primaryId, COUNT(DISTINCT s.id) AS matches, MAX(s.started_at) AS lastPlayedAt, MAX(sp.is_known_teammate) AS known,
           (SELECT sp2.name FROM session_players sp2 JOIN sessions s2 ON s2.id = sp2.session_id
            WHERE sp2.primary_id = sp.primary_id ORDER BY s2.started_at DESC LIMIT 1) AS name
         FROM session_players sp JOIN sessions s ON s.id = sp.session_id
         WHERE s.kind = 'match' AND sp.is_me = 0 AND sp.is_bot = 0 AND s.my_team IS NOT NULL AND sp.team = s.my_team
         GROUP BY sp.primary_id ORDER BY matches DESC, lastPlayedAt DESC LIMIT ?`,
      )
      .all(limit) as { primaryId: string; name: string; matches: number; lastPlayedAt: number; known: number }[];
    return rows.map((r) => ({ ...r, known: r.known === 1 }));
  }

  /**
   * Remove matches recorded before the never-started rule (see neverStarted):
   * 0–0, no touches anywhere. Re-ingesting the raw logs drops them the same way.
   */
  deleteNeverStartedMatches(): number {
    const r = this.db
      .prepare(
        `DELETE FROM sessions WHERE kind = 'match' AND COALESCE(score_blue, 0) = 0 AND COALESCE(score_orange, 0) = 0
           AND NOT EXISTS (SELECT 1 FROM touches t WHERE t.session_id = sessions.id)
           AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.session_id = sessions.id)
           AND NOT EXISTS (SELECT 1 FROM session_players sp WHERE sp.session_id = sessions.id AND sp.touches > 0)`,
      )
      .run();
    return Number(r.changes);
  }

  /** The sessions of the same sort (matches, or practice) just before and after one, by start time. */
  neighborIds(id: string): { previous: string | null; next: string | null } {
    const row = this.sessionRow(id);
    if (!row) return { previous: null, next: null };
    const kinds = row.kind === "match" ? ["match"] : row.kind === "replay" ? ["replay"] : ["freeplay", "training"];
    const json = JSON.stringify(kinds);
    const one = (sql: string) => (this.db.prepare(sql).get(json, row.started_at) as { id: string } | undefined)?.id ?? null;
    return {
      previous: one("SELECT id FROM sessions WHERE kind IN (SELECT value FROM json_each(?)) AND started_at < ? ORDER BY started_at DESC LIMIT 1"),
      next: one("SELECT id FROM sessions WHERE kind IN (SELECT value FROM json_each(?)) AND started_at > ? ORDER BY started_at ASC LIMIT 1"),
    };
  }

  /** When live-recorded matches ended. */
  liveMatchEnds(): number[] {
    return (this.db.prepare("SELECT ended_at FROM sessions WHERE kind = 'match' AND source = 'live'").all() as { ended_at: number }[]).map(
      (r) => r.ended_at,
    );
  }

  /** When the game quit, oldest first. */
  quitTimes(): number[] {
    return (
      this.db.prepare("SELECT disconnected_at FROM game_connections WHERE disconnected_at IS NOT NULL ORDER BY 1").all() as {
        disconnected_at: number;
      }[]
    ).map((r) => r.disconnected_at);
  }

  /** Start and end of every match and practice session, oldest first, for grouping into play sessions. */
  sessionTimes(): { id: string; kind: SessionKind; startedAt: number; endedAt: number }[] {
    return this.db
      .prepare("SELECT id, kind, started_at AS startedAt, ended_at AS endedAt FROM sessions WHERE kind != 'replay' ORDER BY started_at")
      .all() as { id: string; kind: SessionKind; startedAt: number; endedAt: number }[];
  }

  /** Has this exact file (by size and mtime) been ingested already? */
  alreadyIngested(path: string, size: number, mtimeMs: number): boolean {
    const row = this.db.prepare("SELECT size, mtime_ms FROM ingested_files WHERE path = ?").get(path) as
      | { size: number; mtime_ms: number }
      | undefined;
    return !!row && row.size === size && row.mtime_ms === Math.floor(mtimeMs);
  }

  markIngested(path: string, size: number, mtimeMs: number, sessions: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO ingested_files VALUES (?, ?, ?, ?, ?)")
      .run(path, size, Math.floor(mtimeMs), sessions, Date.now());
  }

  /**
   * The replay frame to seek to for a moment in a match, given the replay's
   * index. Uses the last indexed second at or before the target.
   */
  frameFor(replaySessionId: string, matchTime: number): number | null {
    const row = this.db
      .prepare(
        "SELECT frame FROM replay_frames WHERE session_id = ? AND match_time <= ? ORDER BY match_time DESC LIMIT 1",
      )
      .get(replaySessionId, matchTime) as { frame: number } | undefined;
    return row?.frame ?? null;
  }

  // --- reading --------------------------------------------------------------

  /** Session ids, newest first, with SQL-level filters. Practice = freeplay and training. */
  listSessionIds(f: SessionFilter = {}): { id: string; startedAt: number }[] {
    const where: string[] = ["kind != 'replay'"];
    const args: (string | number)[] = [];
    if (f.kinds?.length) {
      where.push(`kind IN (${f.kinds.map(() => "?").join(",")})`);
      args.push(...f.kinds);
    }
    if (f.playlistIds?.length) {
      where.push(`playlist_id IN (${f.playlistIds.map(() => "?").join(",")})`);
      args.push(...f.playlistIds);
    }
    if (f.excludePlaylistIds?.length) {
      where.push(`(playlist_id IS NULL OR playlist_id NOT IN (${f.excludePlaylistIds.map(() => "?").join(",")}))`);
      args.push(...f.excludePlaylistIds);
    }
    if (f.teamSize !== undefined) {
      const fixed = playlistsOfSize(f.teamSize);
      const fallback = fixed.length ? ` OR (team_size IS NULL AND playlist_id IN (${fixed.map(() => "?").join(",")}))` : "";
      where.push(`(team_size = ?${fallback})`);
      args.push(f.teamSize, ...fixed);
    }
    if (f.outcome !== undefined) {
      where.push("outcome = ?");
      args.push(f.outcome);
    }
    if (f.partied !== undefined) {
      where.push("partied = ?");
      args.push(f.partied ? 1 : 0);
    }
    if (f.since !== undefined) {
      where.push("started_at >= ?");
      args.push(f.since);
    }
    if (f.until !== undefined) {
      where.push("started_at < ?");
      args.push(f.until);
    }
    if (f.before !== undefined) {
      where.push("started_at < ?");
      args.push(f.before);
    }
    const limit = f.limit ? ` LIMIT ${Math.floor(f.limit)}` : "";
    return this.db
      .prepare(`SELECT id, started_at AS startedAt FROM sessions WHERE ${where.join(" AND ")} ORDER BY started_at DESC${limit}`)
      .all(...args) as { id: string; startedAt: number }[];
  }

  /** The stored row for a session, including fields I edit (pack code, note). */
  sessionRow(id: string): SessionRow | null {
    return (this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined) ?? null;
  }

  /** Rebuild a whole Session from its tables. */
  loadSession(id: string): Session | null {
    const r = this.sessionRow(id);
    if (!r) return null;
    const all = (table: string, order = "") =>
      this.db.prepare(`SELECT * FROM ${table} WHERE session_id = ?${order}`).all(id) as Record<string, any>[];
    const vec = (x: Record<string, any>) => ({ x: x.x, y: x.y, z: x.z });
    const players: SessionPlayer[] = all("session_players").map((p) => ({
      key: p.player_key,
      primaryId: p.primary_id,
      name: p.name,
      isBot: !!p.is_bot,
      isMe: !!p.is_me,
      isKnownTeammate: !!p.is_known_teammate,
      team: p.team,
      firstSeenAt: p.first_seen_at,
      lastSeenAt: p.last_seen_at,
      joinedAt: p.joined_at,
      leftAt: p.left_at,
      stats: { score: p.score, goals: p.goals, shots: p.shots, assists: p.assists, saves: p.saves, touches: p.touches, demos: p.demos },
    }));
    return {
      id: r.id,
      kind: r.kind,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      playlistId: r.playlist_id,
      arena: r.arena,
      matchGuid: r.match_guid,
      replayId: r.replay_id,
      replayDate: r.replay_date,
      myTeam: r.my_team,
      winnerTeam: r.winner_team,
      outcome: r.outcome,
      scoreBlue: r.score_blue,
      scoreOrange: r.score_orange,
      overtime: !!r.overtime,
      partied: !!r.partied,
      queueWarmup: !!r.queue_warmup,
      gameSpeed: r.game_speed,
      teamSize: r.team_size,
      pausedSeconds: r.paused_seconds,
      source: r.source,
      forfeit: !!r.forfeit,
      playback: r.playback ? (JSON.parse(r.playback) as ReplayPlayback) : null,
      boostPickups: all("boost_pickups", " ORDER BY at").map((p) => ({
        at: p.at,
        matchTime: p.match_time,
        playerKey: p.player_key,
        boostType: p.boost_type,
        location: vec(p),
      })),
      players,
      goals: all("goals", " ORDER BY seq").map((g) => ({
        at: g.at,
        matchTime: g.match_time,
        team: g.team,
        scorerKey: g.scorer_key,
        assisterKey: g.assister_key,
        lastTouchKey: g.last_touch_key,
        speedKmh: g.speed_kmh,
        goalTime: g.goal_time,
        location: vec(g),
        locationSource: g.location_source,
      })),
      touches: all("touches", " ORDER BY at").map((t) => ({
        at: t.at,
        matchTime: t.match_time,
        playerKey: t.player_key,
        preSpeed: t.pre_speed,
        postSpeed: t.post_speed,
        location: vec(t),
        simultaneous: !!t.simultaneous,
      })),
      crossbarHits: all("crossbar_hits", " ORDER BY at").map((c) => ({
        at: c.at,
        matchTime: c.match_time,
        location: vec(c),
        ballSpeed: c.ball_speed,
        impactForce: c.impact_force,
        lastTouchKey: c.last_touch_key,
      })),
      statEvents: all("stat_events", " ORDER BY at").map((e) => ({
        at: e.at,
        matchTime: e.match_time,
        eventName: e.event_name,
        label: e.label,
        mainKey: e.main_key,
        secondaryKey: e.secondary_key,
      })),
      trainingAttempts: all("training_attempts", " ORDER BY seq").map((a) => ({
        seq: a.seq,
        startedAt: a.started_at,
        endedAt: a.ended_at,
        timeLimit: a.time_limit,
        outcome: a.outcome,
        ballSpeed: a.ball_speed,
        location: a.x === null ? null : vec(a),
        touches: a.touches,
      })),
      carSummaries: all("car_summaries").map((c) => ({
        playerKey: c.player_key,
        samples: c.samples,
        ground: c.ground,
        wall: c.wall,
        air: c.air,
        boosting: c.boosting,
        supersonic: c.supersonic,
        avgSpeed: c.avg_speed,
      })),
      replayFrames: all("replay_frames", " ORDER BY match_time").map((f) => ({ frame: f.frame, matchTime: f.match_time })),
    };
  }

  /** The replay session recorded for a match, matched by GUID. */
  replayFor(matchGuid: string | null): { sessionId: string; replayId: string } | null {
    if (!matchGuid) return null;
    const row = this.db
      .prepare("SELECT id, replay_id FROM sessions WHERE kind = 'replay' AND match_guid = ? ORDER BY started_at DESC LIMIT 1")
      .get(matchGuid) as { id: string; replay_id: string } | undefined;
    return row ? { sessionId: row.id, replayId: row.replay_id } : null;
  }

  countSessions(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind != 'replay'").get() as { n: number }).n;
  }

  // --- things I edit ---------------------------------------------------------

  updateSession(id: string, fields: { packCode?: string | null; note?: string | null }): boolean {
    const sets: string[] = [];
    const args: (string | null)[] = [];
    if (fields.packCode !== undefined) {
      sets.push("pack_code = ?");
      args.push(fields.packCode);
    }
    if (fields.note !== undefined) {
      sets.push("note = ?");
      args.push(fields.note);
    }
    if (!sets.length) return this.sessionRow(id) !== null;
    const r = this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    return Number(r.changes) > 0;
  }

  packs(): { code: string; name: string; type: "offense" | "defense" }[] {
    return this.db.prepare("SELECT code, name, type FROM packs ORDER BY name").all() as {
      code: string;
      name: string;
      type: "offense" | "defense";
    }[];
  }

  putPack(code: string, name: string, type: "offense" | "defense"): void {
    this.db.prepare("INSERT OR REPLACE INTO packs (code, name, type) VALUES (?, ?, ?)").run(code, name, type);
  }
}

export interface SessionFilter {
  kinds?: Exclude<SessionKind, "replay">[];
  playlistIds?: number[];
  excludePlaylistIds?: number[];
  /** Measured lobby size; rows saved before it was measured fall back to the playlist's fixed size. */
  teamSize?: number;
  partied?: boolean;
  outcome?: "win" | "loss";
  since?: number;
  until?: number;
  before?: number;
  limit?: number;
}

/** A row of the sessions table, as stored. */
export interface SessionRow {
  id: string;
  kind: SessionKind;
  started_at: number;
  ended_at: number;
  playlist_id: number | null;
  arena: string | null;
  match_guid: string | null;
  replay_id: string | null;
  replay_date: string | null;
  my_team: number | null;
  winner_team: number | null;
  outcome: "win" | "loss" | "abandoned" | null;
  score_blue: number | null;
  score_orange: number | null;
  overtime: number;
  partied: number;
  queue_warmup: number;
  game_speed: number | null;
  team_size: number | null;
  source: "live" | "replay";
  forfeit: number;
  playback: string | null;
  paused_seconds: number;
  pack_code: string | null;
  note: string | null;
}
