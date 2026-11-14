import { z } from "zod";
import { EVENT_NAMES, KnownMessage, type EventName, type GameMessage } from "./events.ts";

/** The game double-encodes: Data arrives as a JSON string inside the envelope. */
const Envelope = z.object({
  Event: z.string(),
  Data: z.union([z.string(), z.record(z.string(), z.unknown())]),
});

export type ParseResult =
  | { ok: true; msg: GameMessage }
  | { ok: false; reason: "invalid-json" | "unknown-event" | "invalid-shape"; event?: string; error?: string };

const known = new Set<string>(EVENT_NAMES);

/** Parse an already-decoded envelope object (e.g. from a recording). */
export function parseEnvelope(value: unknown): ParseResult {
  const env = Envelope.safeParse(value);
  if (!env.success) return { ok: false, reason: "invalid-shape", error: z.prettifyError(env.error) };
  let data: unknown = env.data.Data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return { ok: false, reason: "invalid-json", event: env.data.Event };
    }
  }
  if (!known.has(env.data.Event)) return { ok: false, reason: "unknown-event", event: env.data.Event };
  const parsed = KnownMessage.safeParse({ Event: env.data.Event, Data: data });
  if (!parsed.success) {
    return { ok: false, reason: "invalid-shape", event: env.data.Event, error: z.prettifyError(parsed.error) };
  }
  return { ok: true, msg: parsed.data };
}

/** Parse one raw message as received from the game's socket. */
export function parseMessage(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  return parseEnvelope(value);
}

/** Encode a message the way the game does, for the mock game. */
export function encodeLikeGame(event: EventName | string, data: unknown): string {
  return JSON.stringify({ Event: event, Data: JSON.stringify(data) });
}
