import { closeSync, openSync, readSync } from "node:fs";

/**
 * Reads the header of a .replay file: the properties block before the
 * network data. On 2026-11-04 it held, among others, MatchGUID (the same ID
 * the Stats API sends), Id (the replay ID), Date (the match's end, UTC),
 * MatchStartEpoch, TeamSize, bForfeit, TotalSecondsPlayed, the scores and
 * a PlayerStats array. Only the header is read, a few kilobytes.
 *
 * Format: u32 header size, u32 CRC, u32 major and minor version (plus a u32
 * net version from 868.18 on), the game type string, then properties: a name,
 * a type name, a u64 size and a value, until the name "None". Strings are an
 * i32 length, then that many bytes (or UTF-16 code units when negative),
 * NUL-terminated.
 */

export type HeaderValue = string | number | bigint | boolean | HeaderValue[] | { [key: string]: HeaderValue };

export interface ReplayHeader {
  gameType: string;
  properties: Record<string, HeaderValue>;
}

export function parseReplayHeader(buf: Uint8Array): ReplayHeader {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const need = (n: number) => {
    if (p + n > buf.byteLength) throw new Error(`replay header ends early at byte ${p}`);
  };
  const u32 = () => (need(4), (p += 4), view.getUint32(p - 4, true));
  const i32 = () => (need(4), (p += 4), view.getInt32(p - 4, true));
  const u64 = () => (need(8), (p += 8), view.getBigUint64(p - 8, true));
  const str = () => {
    const n = i32();
    if (n === 0) return "";
    const bytes = n < 0 ? -n * 2 : n;
    need(bytes);
    const slice = buf.subarray(p, p + bytes);
    p += bytes;
    const text = n < 0 ? new TextDecoder("utf-16le").decode(slice) : new TextDecoder("latin1").decode(slice);
    return text.replace(/\0+$/, "");
  };
  const props = (): Record<string, HeaderValue> => {
    const out: Record<string, HeaderValue> = {};
    for (;;) {
      const name = str();
      if (name === "None") return out;
      const type = str();
      u64(); // size, not needed: every type below has a known shape
      out[name] = value(type);
    }
  };
  const value = (type: string): HeaderValue => {
    switch (type) {
      case "StrProperty":
      case "NameProperty":
        return str();
      case "IntProperty":
        return i32();
      case "FloatProperty":
        return need(4), (p += 4), view.getFloat32(p - 4, true);
      case "QWordProperty": {
        const v = u64();
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      case "BoolProperty":
        return need(1), buf[p++] !== 0;
      case "ByteProperty": {
        // An enum name then its value, a bare byte when the enum is "None",
        // and older platform values with no second string.
        const kind = str();
        if (kind === "None") return need(1), buf[p++]!;
        if (kind.startsWith("OnlinePlatform_")) return kind;
        return str();
      }
      case "ArrayProperty": {
        const n = i32();
        return Array.from({ length: n }, () => props());
      }
      case "StructProperty":
        str(); // struct type name
        return props();
      default:
        throw new Error(`unknown replay property type ${type} at byte ${p}`);
    }
  };

  u32(); // header size
  u32(); // CRC
  const major = u32();
  const minor = u32();
  if (major >= 868 && minor >= 18) u32(); // net version
  const gameType = str();
  return { gameType, properties: props() };
}

/** Read and parse just the header of a .replay file. */
export function readReplayHeader(path: string): ReplayHeader {
  const fd = openSync(path, "r");
  try {
    const sizeBuf = new Uint8Array(4);
    readSync(fd, sizeBuf, 0, 4, 0);
    const size = new DataView(sizeBuf.buffer).getUint32(0, true);
    // The header size counts from after the size and CRC fields.
    const buf = new Uint8Array(Math.min(size + 8, 4 * 1024 * 1024));
    readSync(fd, buf, 0, buf.byteLength, 0);
    return parseReplayHeader(buf);
  } finally {
    closeSync(fd);
  }
}

/** The fields the app uses, from a parsed header. */
export function replaySummary(h: ReplayHeader): {
  replayId: string | null;
  matchGuid: string | null;
  endedAt: number | null;
  startedAt: number | null;
  forfeit: boolean;
  teamSize: number | null;
  matchType: string | null;
  /** TotalSecondsPlayed. */
  seconds: number | null;
  /** NumFrames: the replay's last frame, as playback reports frames. */
  numFrames: number | null;
} {
  const p = h.properties;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
  const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : null);
  const date = s("Date")?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})$/);
  const start = n("MatchStartEpoch");
  return {
    replayId: s("Id")?.toUpperCase() ?? null,
    matchGuid: s("MatchGUID")?.toUpperCase() ?? null,
    endedAt: date ? Date.UTC(+date[1]!, +date[2]! - 1, +date[3]!, +date[4]!, +date[5]!, +date[6]!) : null,
    startedAt: start !== null ? start * 1000 : null,
    forfeit: p.bForfeit === true,
    teamSize: n("TeamSize"),
    matchType: s("MatchType"),
    seconds: n("TotalSecondsPlayed"),
    numFrames: n("NumFrames"),
  };
}
