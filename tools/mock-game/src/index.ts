import { WebSocketServer } from "ws";
import { readRecording } from "@rl/collector";
import { encodeLikeGame } from "@rl/schema";

export interface MockGameOptions {
  file: string;
  /** 0 picks a free port. The real game uses 49124. */
  port?: number;
  /** Playback speed relative to the recording. */
  speed?: number;
  /** Cap on any single wait, in ms, to skip idle stretches (menus, pauses). */
  maxGapMs?: number;
  /** Wait for a client before playing. */
  waitForClient?: boolean;
  log?: (line: string) => void;
}

export interface RunningMockGame {
  port: number;
  /** Resolves when the whole recording has been sent. */
  done: Promise<{ sent: number }>;
  /** Commands received from clients, as parsed JSON. */
  commands: unknown[];
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for the game: serves a recorded session over WebSocket with the
 * original timing (scaled), encoding messages the way the game does
 * (Data double-encoded as a string). Logs commands it receives.
 */
export async function startMockGame(opts: MockGameOptions): Promise<RunningMockGame> {
  const { file, speed = 1, maxGapMs = Infinity, waitForClient = true } = opts;
  const log = opts.log ?? (() => {});
  const wss = new WebSocketServer({ port: opts.port ?? 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const commands: unknown[] = [];

  wss.on("connection", (ws) => {
    log("client connected");
    ws.on("message", (data) => {
      try {
        const cmd = JSON.parse(String(data));
        commands.push(cmd);
        log(`command: ${JSON.stringify(cmd)}`);
      } catch {
        /* ignore */
      }
    });
  });

  const done = (async () => {
    if (waitForClient && wss.clients.size === 0) await new Promise((r) => wss.once("connection", r));
    // Give the client a moment to attach its handlers.
    await sleep(50);
    let prevAt: number | null = null;
    let sent = 0;
    for await (const entry of readRecording(file)) {
      if (entry.kind !== "message") continue;
      if (prevAt !== null) {
        const wait = Math.min((entry.receivedAt - prevAt) / speed, maxGapMs);
        if (wait >= 1) await sleep(wait);
      }
      prevAt = entry.receivedAt;
      const text = encodeLikeGame(entry.msg.Event, entry.msg.Data);
      for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(text);
      sent++;
    }
    log(`finished: ${sent} messages`);
    return { sent };
  })();

  return {
    port,
    done,
    commands,
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
