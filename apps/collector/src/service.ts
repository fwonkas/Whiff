import type {
  SessionReplay,
  DetailGoal,
  DetailTouch,
  Pack,
  PlaySessionItem,
  PlaySessionsQuery,
  PlaySessionsResponse,
  PracticeItem,
  ReviewResponse,
  Record3,
  SessionDetailResponse,
  SessionListItem,
  SessionsQuery,
  SummaryQuery,
  TrendsResponse,
} from "@rl/api-contract";
import type { Session } from "@rl/domain";
import {
  matchSetStats,
  replaySetStats,
  wasMvp,
  attackUp,
  groupPlaySessions,
  matchMetrics,
  playSessionSplits,
  type PlaySessionGroup,
  practiceSpeed,
  practiceSummary,
  series,
  SERIES_METRICS,
  standardSplits,
  type MatchMetrics,
  type PlayerReplayMetrics,
  type SeriesMetric,
} from "@rl/metrics";
import { nonStandardPlaylists, isNonStandard, PLAYLISTS } from "@rl/schema";

/** The Tournament playlist: kept out of team-size filters, with a chip of its own. */
const TOURNAMENT = 34;
import type { SessionFilter, StatsDb } from "./db.ts";
import { listSavedReplays, MATCH_HISTORY_DAYS, MATCH_HISTORY_SIZE, matchHistoryRisk } from "./replay-files.ts";
import { readReplayHeader } from "./replay-header.ts";
import { enrichFromReplay } from "./replays.ts";

/**
 * Reads for the API. Sessions never change after they're saved (only the
 * pack code and note, which live on the row and are read fresh), so whole
 * sessions and their metrics are cached in memory.
 */
export class StatsService {
  private cache = new Map<string, { session: Session; metrics: MatchMetrics | null }>();

  constructor(
    readonly db: StatsDb,
    private readonly options: { practiceGameSpeed?: number | null; replayDirs?: string[]; matchHistoryWarn?: number } = {},
  ) {}

  /**
   * Call after saving a session so the next read sees it. A saved replay also
   * changes the match it belongs to (enriched, or rebuilt from the replay).
   */
  /** Settings changed: the practice speed fallback or the replay folders. Cached results are dropped. */
  configure(options: { practiceGameSpeed?: number | null; replayDirs?: string[]; matchHistoryWarn?: number }): void {
    Object.assign(this.options, options);
    this.invalidateAll();
  }

  invalidateAll(): void {
    this.cache.clear();
    this.replayCache = null;
    this.myReplayCache = null;
  }

  /** Replay files changed (downloaded, deleted, analyzed) or ballchasing was asked. */
  invalidateReplayStatus(): void {
    this.replayCache = null;
    this.myReplayCache = null;
  }

  private myReplayCache: Map<string, PlayerReplayMetrics> | null = null;
  private myReplayMetrics(): Map<string, PlayerReplayMetrics> {
    return (this.myReplayCache ??= this.db.myReplayMetrics());
  }

  private replayCache: { at: number; byId: Map<string, SessionReplay> } | null = null;

  /**
   * Every match's replay status: the file in the replays folder (by the
   * header's match GUID), else the game's Match History (the 20 newest online
   * matches of the last 30 days), else missing. Cached for a few seconds,
   * because it reads every replay file's header.
   */
  replayStatus(): Map<string, SessionReplay> {
    const now = Date.now();
    if (this.replayCache && now - this.replayCache.at < 5_000) return this.replayCache.byId;
    const saved = new Map(listSavedReplays(this.options.replayDirs ?? []).flatMap((r) => (r.matchGuid ? [[r.matchGuid, r.replayId] as const] : [])));
    const played = this.db.playedMatches();
    const fast = this.db.fastPlaybackGuids();
    const live = this.db.liveMatchGuids();
    const noUpload = this.db.notOnBallchasing();
    const dayMs = 86_400_000;
    const online = this.db.liveOnlineMatches();
    const history = online
      .filter((m) => now - m.endedAt <= MATCH_HISTORY_DAYS * dayMs)
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, MATCH_HISTORY_SIZE);
    const position = new Map(history.map((m, i) => [m.id, { i: i + 1, endedAt: m.endedAt }]));
    const risk = new Set(matchHistoryRisk(online, new Set(saved.keys()), now, this.options.matchHistoryWarn).atRisk.map((m) => m.id));
    const byId = new Map<string, SessionReplay>();
    for (const [id, guid] of this.db.matchGuids()) {
      const file = saved.get(guid) ?? null;
      const pos = position.get(id);
      const state = file ? "saved" : pos ? "in-history" : "missing";
      byId.set(id, {
        state,
        replayId: file ?? (played.get(guid) || null),
        played: played.has(guid),
        playedFast: fast.has(guid) && !live.has(guid),
        history: state === "in-history" && pos ? { position: pos.i, daysLeft: Math.max(0, Math.ceil(MATCH_HISTORY_DAYS - (now - pos.endedAt) / dayMs)), atRisk: risk.has(id) } : null,
        notOnBallchasing: noUpload.has(guid),
      });
    }
    this.replayCache = { at: now, byId };
    return byId;
  }

  invalidate(id: string, matchGuid?: string | null): void {
    this.cache.delete(id);
    // A new or replaced match can bring my numbers from an analysis already there.
    this.myReplayCache = null;
    if (matchGuid) {
      for (const [key, hit] of this.cache) if (hit.session.matchGuid === matchGuid) this.cache.delete(key);
    }
  }

  /** My replay-analysis numbers over the won or lost matches here, from those with an analyzed replay. */
  private replayStats(all: MatchMetrics[]) {
    const decided = all.filter((m) => m.outcome === "win" || m.outcome === "loss");
    const mine = this.myReplayMetrics();
    return replaySetStats(
      decided.map((m) => mine.get(m.sessionId)).filter((p) => p !== undefined),
      decided.length,
    );
  }

  /** A recorded session, as the metrics see it. */
  session(id: string): Session | null {
    return this.get(id)?.session ?? null;
  }

  private get(id: string) {
    let hit = this.cache.get(id);
    if (!hit) {
      let session = this.db.loadSession(id);
      if (!session) return null;
      if (session.kind === "match" && session.source === "live" && session.matchGuid) {
        const replay = this.db.bestReplay(session.matchGuid);
        if (replay) session = enrichFromReplay(session, replay);
      }
      hit = { session, metrics: matchMetrics(session) };
      this.cache.set(id, hit);
    }
    return hit;
  }

  private filter(q: Partial<SessionsQuery>): SessionFilter {
    const kinds: SessionFilter["kinds"] =
      q.with !== undefined || q.teamSize !== undefined || q.kind === "match"
        ? ["match"]
        : q.kind === "practice"
          ? ["freeplay", "training"]
          : undefined;
    const playlistIds = q.playlist !== undefined ? [q.playlist] : undefined;
    return {
      kinds,
      playlistIds,
      // A team-size filter means standard play: extra modes and tournaments have chips of their own.
      excludePlaylistIds: q.teamSize !== undefined && q.playlist === undefined ? [...nonStandardPlaylists(), TOURNAMENT] : undefined,
      outcome: q.result === "win" || q.result === "loss" ? q.result : undefined,
      teamSize: q.teamSize,
      partied: q.with === undefined ? undefined : q.with === "party",
      since: q.since,
      until: q.until,
      before: q.before,
      limit: q.limit,
    };
  }

  private pack(code: string | null): Pack | null {
    if (!code) return null;
    return this.db.packs().find((p) => p.code === code) ?? { code, name: code, type: "offense" };
  }

  /**
   * Play sessions, oldest first, with each session's group and each match's
   * place in it. Recomputed per request: a few hundred rows, and new sessions
   * and game quits both change the grouping.
   */
  private playSessionIndex() {
    const times = this.db.sessionTimes();
    const groups = groupPlaySessions(times, this.db.quitTimes());
    const groupOf = new Map<string, PlaySessionGroup>();
    const position = new Map<string, number>();
    const kindOf = new Map(times.map((t) => [t.id, t.kind]));
    for (const g of groups) {
      let n = 0;
      for (const id of g.sessionIds) {
        groupOf.set(id, g);
        if (kindOf.get(id) === "match") position.set(id, ++n);
      }
    }
    return { groups, groupOf, position };
  }

  listItem(id: string, index = this.playSessionIndex()): SessionListItem | null {
    const hit = this.get(id);
    const row = this.db.sessionRow(id);
    if (!hit || !row || hit.session.kind === "replay") return null;
    const s = hit.session;
    const me = s.players.find((p) => p.isMe);
    const m = hit.metrics;
    return {
      id: s.id,
      kind: s.kind as SessionListItem["kind"],
      startedAt: s.startedAt,
      durationSeconds: (s.endedAt - s.startedAt) / 1000,
      playlistId: s.playlistId,
      playlistName: s.playlistId !== null ? (PLAYLISTS[s.playlistId]?.name ?? null) : null,
      arena: s.arena,
      outcome: s.outcome,
      goalsFor: m?.goalsFor ?? null,
      goalsAgainst: m?.goalsAgainst ?? null,
      overtime: s.overtime,
      forfeit: s.forfeit,
      leftSettled: s.leftSettled ?? false,
      source: s.source,
      partied: s.partied,
      queueWarmup: s.queueWarmup,
      ...(s.kind === "match" ? { gameSpeed: null, gameSpeedSource: null } : practiceSpeed(s, this.options.practiceGameSpeed)),
      me: me ? { ...me.stats, team: me.team } : null,
      touchShare: m?.touchShare ?? null,
      mvp: wasMvp(s),
      replay: s.kind === "match" ? (this.replayStatus().get(s.id) ?? { state: "missing", replayId: null, played: false, history: null, notOnBallchasing: false }) : null,
      teammates: s.players.filter((p) => p.isKnownTeammate && !p.isMe && p.team === s.myTeam).map((p) => p.name),
      pack: this.pack(row.pack_code),
      playSessionId: index.groupOf.get(s.id)?.id ?? null,
    };
  }

  /**
   * The filters that aren't columns: MVP (from the match's stats) and the
   * replay's state (from the replay folders and Match History). Null when
   * neither is asked for.
   */
  private postFilter(q: Partial<SessionsQuery>): ((id: string) => boolean) | null {
    if (q.result !== "mvp" && !q.replay) return null;
    const index = this.playSessionIndex();
    const replays = q.replay ? this.replayStatus() : null;
    return (id) => {
      if (q.result === "mvp" && !this.listItem(id, index)?.mvp) return false;
      if (replays) {
        const saved = replays.get(id)?.state === "saved";
        if ((q.replay === "saved") !== saved) return false;
      }
      return true;
    };
  }

  sessions(q: SessionsQuery) {
    const index = this.playSessionIndex();
    // MVP and replay state aren't columns: filter the items, then page.
    const keep = this.postFilter(q);
    let rows = this.db.listSessionIds(this.filter({ ...q, kind: keep ? "match" : q.kind, limit: keep ? undefined : q.limit + 1 }));
    if (keep) rows = rows.filter((r) => keep(r.id)).slice(0, q.limit + 1);
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => this.listItem(r.id, index)).filter((x): x is SessionListItem => x !== null),
      nextCursor: rows.length > q.limit ? (page.at(-1)?.startedAt ?? null) : null,
    };
  }

  /** Matches for records, trends and splits. Private matches count only when asked for by playlist. */
  /**
   * The matches the Sessions list shows for these filters (extra modes
   * included when no mode is picked, result and dates applied), as metrics.
   */
  private matchMetricsFor(q: Partial<SessionsQuery>): MatchMetrics[] {
    const keep = this.postFilter(q);
    return this.db
      .listSessionIds(this.filter({ ...q, kind: "match", limit: undefined, before: undefined }))
      .filter((r) => !keep || keep(r.id))
      .map((r) => this.get(r.id)?.metrics ?? null)
      .filter((m): m is MatchMetrics => m !== null);
  }

  /**
   * The Sessions cards and filter chips. Everything describes the matches the
   * list shows for these filters, dates included; the chip counts cover each
   * chip's own choice within the same dates, so a chip is off exactly when
   * its list would be empty or the same as All.
   */
  /** Trends and splits compare like with like: standard play only unless a mode is named. */
  private standardMetricsFor(q: Partial<SessionsQuery>): MatchMetrics[] {
    return this.matchMetricsFor(q).filter((m) => q.playlist !== undefined || !isNonStandard(m.playlistId ?? null));
  }

  summary(q: SummaryQuery) {
    const all = this.matchMetricsFor(q);
    const record = (ms: MatchMetrics[]): Record3 => ({
      wins: ms.filter((m) => m.outcome === "win").length,
      losses: ms.filter((m) => m.outcome === "loss").length,
      abandoned: ms.filter((m) => m.outcome === "abandoned").length,
    });
    const byTeamSize: Partial<Record<"1" | "2" | "3", Record3>> = {};
    for (const size of [1, 2, 3] as const) {
      const ms = all.filter((m) => m.teamSize === size);
      if (ms.length) byTeamSize[String(size) as "1" | "2" | "3"] = record(ms);
    }
    const dates = { since: q.since, until: q.until, limit: undefined, before: undefined };
    const listed = (teamSize: 1 | 2 | 3 | undefined, w?: "solo" | "party") =>
      this.db.listSessionIds(this.filter({ kind: "match", teamSize, with: w, ...dates })).length;
    const counts = (size?: 1 | 2 | 3) => ({ total: listed(size), solo: listed(size, "solo"), party: listed(size, "party") });
    const filterCounts = { all: counts(), "1": counts(1), "2": counts(2), "3": counts(3) };
    const modes = [TOURNAMENT, ...nonStandardPlaylists()]
      .map((id) => ({
        playlistId: id,
        name: PLAYLISTS[id]?.name ?? `Playlist ${id}`,
        matches: this.db.listSessionIds(this.filter({ kind: "match", playlist: id, ...dates })).length,
      }))
      .filter((m) => m.matches > 0);
    const index = this.playSessionIndex();
    const base = { kind: "match" as const, teamSize: q.teamSize, playlist: q.playlist, with: q.with, ...dates };
    // Each filter's counts apply every other filter: results within the replay filter, and the other way round.
    const replays = this.replayStatus();
    const replayOk = (id: string) => !q.replay || (q.replay === "saved") === (replays.get(id)?.state === "saved");
    const listedIds = this.db.listSessionIds(this.filter(base)).filter((r) => replayOk(r.id));
    const count = (result: "win" | "loss") => this.db.listSessionIds(this.filter({ ...base, result })).filter((r) => replayOk(r.id)).length;
    const resultCounts = {
      total: listedIds.length,
      win: count("win"),
      loss: count("loss"),
      mvp: listedIds.filter((r) => this.listItem(r.id, index)?.mvp).length,
    };
    const resultOk = this.postFilter({ result: q.result === "mvp" ? "mvp" : undefined });
    const forReplays = this.db
      .listSessionIds(this.filter({ ...base, result: q.result }))
      .filter((r) => !resultOk || resultOk(r.id))
      .map((r) => replays.get(r.id)?.state === "saved");
    const replayCounts = { total: forReplays.length, saved: forReplays.filter(Boolean).length, attention: forReplays.filter((s) => !s).length };
    const mvps = this.db
      .listSessionIds(this.filter({ ...q, kind: "match", limit: undefined, before: undefined }))
      .filter((r) => replayOk(r.id) && this.listItem(r.id, index)?.mvp).length;
    const practice = this.db.listSessionIds(this.filter({ kind: "practice", ...dates })).map((r) => this.get(r.id)?.session);
    const starts = all.map((m) => m.startedAt);
    return {
      matches: all.length,
      record: record(all),
      mvps,
      mvpWins: (q.result ? this.matchMetricsFor({ ...q, result: undefined }) : all).filter((m) => m.outcome === "win" && m.teamSize !== 1).length,
      stats: matchSetStats(all),
      replayStats: this.replayStats(all),
      solo: record(all.filter((m) => !m.partied)),
      partied: record(all.filter((m) => m.partied)),
      byTeamSize,
      practiceSeconds: practice.reduce((n, s) => n + (s ? (s.endedAt - s.startedAt) / 1000 : 0), 0),
      firstStartedAt: starts.length ? Math.min(...starts) : null,
      lastStartedAt: starts.length ? Math.max(...starts) : null,
      filterCounts,
      modes,
      resultCounts,
      replayCounts,
    };
  }

  detail(id: string): SessionDetailResponse | null {
    const hit = this.get(id);
    const row = this.db.sessionRow(id);
    const item = this.listItem(id);
    if (!hit || !row || !item) return null;
    const s = hit.session;
    const myTeam = s.myTeam ?? 0;
    const name = (key: string | null) => (key ? (s.players.find((p) => p.key === key)?.name ?? null) : null);
    const teamOf = new Map(s.players.map((p) => [p.key, p.team]));
    const meKey = s.players.find((p) => p.isMe)?.key;
    const touches: DetailTouch[] = s.touches.map((t) => {
      const v = attackUp(t.location, myTeam);
      return {
        at: t.at,
        matchTime: t.matchTime,
        owner: t.playerKey === meKey ? "me" : teamOf.get(t.playerKey) === myTeam ? "teammate" : "opponent",
        playerKey: t.playerKey,
        x: v.x,
        y: v.y,
        z: v.z,
        postSpeed: t.postSpeed,
      };
    });
    const goals: DetailGoal[] = s.goals.map((g) => {
      const v = attackUp(g.location, myTeam);
      return {
        matchTime: g.matchTime,
        forUs: g.team === myTeam,
        scorerName: name(g.scorerKey),
        assisterName: name(g.assisterKey),
        speedKmh: g.speedKmh,
        ...v,
        locationReliable: g.locationSource !== "goal",
      };
    });
    return {
      session: { ...item, note: row.note, endedAt: s.endedAt, pausedSeconds: s.pausedSeconds },
      players: s.players.map((p) => ({
        ...p.stats,
        key: p.key,
        name: p.name,
        team: p.team,
        isMe: p.isMe,
        isBot: p.isBot,
        isKnownTeammate: p.isKnownTeammate,
        joinedAt: p.joinedAt,
        leftAt: p.leftAt,
      })),
      goals,
      touches,
      statEvents: s.statEvents.map((e) => ({ matchTime: e.matchTime, eventName: e.eventName, label: e.label, playerName: name(e.mainKey) })),
      cars: s.carSummaries.map((c) => ({ ...c, name: name(c.playerKey) })),
      boostPickups: s.boostPickups.map((p) => ({
        matchTime: p.matchTime,
        playerKey: p.playerKey,
        playerName: name(p.playerKey),
        boostType: p.boostType,
        ...attackUp(p.location, myTeam),
      })),
      metrics: hit.metrics,
      practice: practiceSummary(s, { packType: item.pack?.type ?? null, defaultGameSpeed: this.options.practiceGameSpeed }),
      replay: this.db.replayFor(s.matchGuid),
      neighbors: this.neighbors(id),
    };
  }

  trends(q: { metrics: SeriesMetric[]; window: number } & Partial<SummaryQuery>): TrendsResponse {
    const ms = this.standardMetricsFor(q);
    const out: TrendsResponse["series"] = {};
    for (const metric of q.metrics) {
      const def = SERIES_METRICS[metric];
      out[metric] = { label: def.label, unit: def.unit, points: series(ms, metric, q.window) };
    }
    return { matches: ms.length, series: out };
  }

  splits() {
    const ms = this.standardMetricsFor({});
    return { splits: [...standardSplits(ms), ...playSessionSplits(ms, this.playSessionIndex().position)] };
  }

  /** Moments to review in a match's replay, with replay frames where known. */
  private neighbors(id: string): SessionDetailResponse["neighbors"] {
    const ids = this.db.neighborIds(id);
    const brief = (nid: string | null) => {
      const item = nid ? this.listItem(nid) : null;
      return item
        ? { id: item.id, startedAt: item.startedAt, playlistId: item.playlistId, playlistName: item.playlistName, outcome: item.outcome, goalsFor: item.goalsFor, goalsAgainst: item.goalsAgainst }
        : null;
    };
    return { previous: brief(ids.previous), next: brief(ids.next) };
  }

  review(id: string): ReviewResponse | null {
    const hit = this.get(id);
    if (!hit || hit.session.kind !== "match") return null;
    const s = hit.session;
    const guid = s.matchGuid?.toUpperCase() ?? null;
    const saved = guid ? listSavedReplays(this.options.replayDirs ?? []).find((r) => r.matchGuid === guid) : undefined;
    const playback = guid ? this.db.bestReplay(guid) : null;
    let headerGoals: { frame: number; team: number | null }[] = [];
    if (saved) {
      try {
        const goals = readReplayHeader(saved.path).properties.Goals;
        if (Array.isArray(goals)) {
          headerGoals = goals.map((g) => {
            const o = g as Record<string, unknown>;
            return { frame: typeof o.frame === "number" ? o.frame : -1, team: typeof o.PlayerTeam === "number" ? o.PlayerTeam : null };
          });
        }
      } catch {
        // Unreadable header: fall back to a playback's frame index.
      }
    }
    // The header lists the same goals in the same order; trust it only when the counts agree.
    const byOrder = headerGoals.length === s.goals.length && headerGoals.every((h, i) => h.team === null || h.team === s.goals[i]!.team);
    const name = (key: string | null) => (key ? (s.players.find((p) => p.key === key)?.name ?? null) : null);
    const moments = s.goals.map((g, i) => {
      let frame: number | null = byOrder && headerGoals[i]!.frame >= 0 ? headerGoals[i]!.frame : null;
      if (frame === null && playback && g.matchTime !== null) frame = this.db.frameFor(playback.id, g.matchTime);
      return {
        id: `goal-${i + 1}`,
        kind: g.team === s.myTeam ? ("goal-for" as const) : ("goal-against" as const),
        matchTime: g.matchTime,
        playerName: name(g.scorerKey),
        frame,
      };
    });
    const replayId = saved?.replayId ?? playback?.replayId?.toUpperCase() ?? null;
    return {
      replay: replayId ? { replayId, saved: !!saved, played: !!playback, playedFast: this.replayStatus().get(id)?.playedFast ?? false } : null,
      moments,
    };
  }

  playSessions(q: PlaySessionsQuery): PlaySessionsResponse {
    const all = this.playSessionIndex().groups.filter((g) => q.before === undefined || g.startedAt < q.before).reverse();
    const page = all.slice(0, q.limit);
    return { items: page.map((g) => this.playSessionItem(g)), nextCursor: all.length > q.limit ? (page.at(-1)?.startedAt ?? null) : null };
  }

  private playSessionItem(g: PlaySessionGroup): PlaySessionItem {
    const sessions = g.sessionIds.map((id) => this.get(id)?.session).filter((s): s is Session => !!s);
    const matches = sessions.filter((s) => s.kind === "match");
    const standard = matches.filter((s) => !isNonStandard(s.playlistId));
    const count = (o: string) => standard.filter((s) => s.outcome === o).length;
    const playlists = new Map<number, number>();
    for (const s of matches) if (s.playlistId !== null) playlists.set(s.playlistId, (playlists.get(s.playlistId) ?? 0) + 1);
    return {
      id: g.id,
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      durationSeconds: (g.endedAt - g.startedAt) / 1000,
      matches: matches.length,
      record: { wins: count("win"), losses: count("loss"), abandoned: count("abandoned") },
      practiceSeconds: sessions.filter((s) => s.kind !== "match").reduce((n, s) => n + (s.endedAt - s.startedAt) / 1000, 0),
      playlists: [...playlists]
        .map(([id, n]) => ({ id, name: PLAYLISTS[id]?.name ?? `Playlist ${id}`, count: n }))
        .sort((a, b) => b.count - a.count),
      sessionIds: g.sessionIds,
    };
  }

  practice() {
    const items: PracticeItem[] = this.db
      .listSessionIds({ kinds: ["freeplay", "training"] })
      .map((r) => {
        const hit = this.get(r.id);
        const pack = this.pack(this.db.sessionRow(r.id)?.pack_code ?? null);
        const sum = hit ? practiceSummary(hit.session, { packType: pack?.type ?? null, defaultGameSpeed: this.options.practiceGameSpeed }) : null;
        return sum ? { ...sum, pack, arena: hit!.session.arena } : null;
      })
      .filter((x): x is PracticeItem => x !== null);
    return { items, packs: this.db.packs() };
  }
}
