/** Worker thread: parses replays with subtr-actor off the collector's event loop. */
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { extractReplay, loadSubtr } from "./extract.ts";

// If the parser can't load, every job says so as a setup problem (not the replay's fault).
let setupError: string | null = null;
try {
  loadSubtr((workerData as { wasmPath?: string } | undefined)?.wasmPath);
} catch (e) {
  setupError = e instanceof Error ? e.message : String(e);
}
parentPort!.on("message", (m: { id: number; path: string }) => {
  if (setupError) {
    parentPort!.postMessage({ id: m.id, ok: false, setup: true, error: setupError });
    return;
  }
  try {
    parentPort!.postMessage({ id: m.id, ok: true, extract: extractReplay(new Uint8Array(readFileSync(m.path))) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
