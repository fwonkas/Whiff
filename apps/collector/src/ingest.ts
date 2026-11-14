import type { CollectorConfig, GameConnection, Session } from "@rl/domain";
import { readRecording } from "./recording.ts";
import { Sessionizer } from "./sessionizer.ts";

export interface IngestReport {
  sessions: Session[];
  /** Matches left out by the settings (casual), for StatsDb.recordSkipped. */
  skipped: Session[];
  /** Game launches and quits, from the collector's connected and disconnected notes. */
  connections: GameConnection[];
  messages: number;
  invalid: number;
}

/** Run one recording (plain or .gz NDJSON) through a fresh sessionizer. */
export async function ingestRecording(path: string, config: CollectorConfig): Promise<IngestReport> {
  const sessions: Session[] = [];
  const skipped: Session[] = [];
  const s = new Sessionizer(config, (x) => sessions.push(x), (x) => skipped.push(x));
  const connections: GameConnection[] = [];
  let messages = 0;
  let invalid = 0;
  for await (const entry of readRecording(path)) {
    if (entry.kind === "message") {
      messages++;
      s.ingest(entry.receivedAt, entry.msg);
    } else if (entry.kind === "invalid") invalid++;
    // A new connection also ends the last one, for logs written before "disconnected" notes.
    // Pausing recording ends the session in progress, like the game closing.
    else if (entry.kind === "note" && entry.note === "paused") s.disconnect();
    // The collector ended a batch's last replay, still open in the game on its final frame.
    else if (entry.kind === "note" && entry.note === "replay-ended") s.endReplay(entry.receivedAt);
    else if (entry.kind === "note" && (entry.note === "disconnected" || entry.note === "connected")) {
      s.disconnect();
      const open = connections.at(-1);
      if (entry.note === "connected") connections.push({ connectedAt: entry.receivedAt, disconnectedAt: null });
      else if (open && open.disconnectedAt === null) open.disconnectedAt = entry.receivedAt;
    }
  }
  s.flush();
  sessions.sort((a, b) => a.startedAt - b.startedAt);
  return { sessions, skipped, connections, messages, invalid };
}
