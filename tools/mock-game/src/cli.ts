import { resolve } from "node:path";
import { startMockGame } from "./index.ts";

/**
 * Serve a recording as if it were the game:
 *   npm run mock -- <recording.ndjson[.gz]> [--speed 10] [--port 49124] [--max-gap 2000] [--loop]
 * Then run the collector (or anything else) against ws://localhost:<port>.
 */
const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const arg = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!arg) {
  console.error("Usage: npm run mock -- <recording> [--speed 10] [--port 49124] [--max-gap 2000] [--loop]");
  process.exit(1);
}

// npm runs workspace scripts from the workspace folder; resolve from where you ran the command.
const file = resolve(process.env.INIT_CWD ?? process.cwd(), arg);
const port = opt("port", 49124);
do {
  const game = await startMockGame({
    file,
    port,
    speed: opt("speed", 1),
    maxGapMs: opt("max-gap", 5000),
    log: (l) => console.log(`[mock] ${l}`),
  });
  console.log(`[mock] serving ${file} on ws://localhost:${game.port}, waiting for a client...`);
  await game.done;
  await game.close();
} while (args.includes("--loop"));
