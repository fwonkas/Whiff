import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { parseEnvelope, type GameCommand, type GameMessage, type ParseResult } from "@rl/schema";

/**
 * Raw log format, shared with the spike recorder: one JSON object per line,
 * stamped with receive time. This file is the source of truth; the database
 * can always be rebuilt from it.
 */
export type RawLine =
  | { receivedAt: number; msg: unknown }
  | { receivedAt: number; note: string }
  | { receivedAt: number; sent: GameCommand }
  | { receivedAt: number; unparsed: string };

export type RecordingEntry =
  | { receivedAt: number; kind: "message"; msg: GameMessage }
  | { receivedAt: number; kind: "invalid"; result: Extract<ParseResult, { ok: false }>; raw: unknown }
  | { receivedAt: number; kind: "note"; note: string }
  | { receivedAt: number; kind: "sent"; command: unknown };

export async function* readRecording(path: string): AsyncGenerator<RecordingEntry> {
  const input = createReadStream(path);
  const stream = path.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    const receivedAt = Number(row.receivedAt);
    if ("msg" in row) {
      const result = parseEnvelope(row.msg);
      yield result.ok
        ? { receivedAt, kind: "message", msg: result.msg }
        : { receivedAt, kind: "invalid", result, raw: row.msg };
    } else if ("note" in row) {
      yield { receivedAt, kind: "note", note: String(row.note) };
    } else if ("sent" in row) {
      yield { receivedAt, kind: "sent", command: row.sent };
    } else if ("unparsed" in row) {
      yield {
        receivedAt,
        kind: "invalid",
        result: { ok: false, reason: "invalid-json" },
        raw: row.unparsed,
      };
    }
  }
}

/**
 * Appends raw lines. The game's double-encoded Data is decoded before writing,
 * like the spike. The file is created on the first write, so a collector run
 * that never reaches the game leaves no empty file behind.
 */
export class RawLogWriter {
  private out: WriteStream | null = null;
  constructor(readonly path: string) {}
  write(line: RawLine): void {
    if (!this.out) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.out = createWriteStream(this.path, { flags: "a" });
    }
    this.out.write(JSON.stringify(line) + "\n");
  }
  close(): Promise<void> {
    const out = this.out;
    return out ? new Promise((resolve) => out.end(resolve)) : Promise.resolve();
  }
}

/**
 * Gzip finished raw logs in a folder (they shrink about 48 to 1), leaving the
 * one being written alone. Each is compressed to a temporary file, checked by
 * unpacking it and comparing the size with the original, and only then
 * renamed into place and the original removed, so a crash or a full disk
 * never loses a line. Ingest reads .ndjson.gz as it reads .ndjson. Streams,
 * so it doesn't hold up the collector. Returns the logs compressed.
 */
export async function compressRawLogs(dir: string, inUse: string | null, log?: (line: string) => void): Promise<string[]> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".ndjson"));
  } catch {
    return [];
  }
  const done: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (inUse && resolve(path) === resolve(inUse)) continue;
    const gz = `${path}.gz`;
    const tmp = `${gz}.tmp`;
    try {
      const size = statSync(path).size;
      if (existsSync(gz)) {
        // Left by an earlier run: keep it if it's whole, otherwise redo it.
        if ((await unpackedSize(gz)) === size) {
          unlinkSync(path);
          done.push(name);
          continue;
        }
        unlinkSync(gz);
      }
      await pipeline(createReadStream(path), createGzip({ level: 6 }), createWriteStream(tmp));
      if ((await unpackedSize(tmp)) !== size) throw new Error("the compressed copy didn't match");
      renameSync(tmp, gz);
      unlinkSync(path);
      done.push(name);
    } catch (e) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // leave it
      }
      log?.(`couldn't compress raw log ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (done.length) log?.(`compressed ${done.length} raw log${done.length === 1 ? "" : "s"}`);
  return done;
}

async function unpackedSize(gz: string): Promise<number> {
  let n = 0;
  await pipeline(createReadStream(gz), createGunzip(), async function* (chunks: AsyncIterable<Buffer>) {
    for await (const c of chunks) n += c.length;
  });
  return n;
}
