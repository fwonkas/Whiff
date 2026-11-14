import { analyzeReplay, analyzerName, type ReplayAnalysis, type SubtrExtract } from "@rl/metrics";
import { SUBTR_VERSION } from "./subtr/extract.ts";
import { SubtrSetupError } from "./subtr/pool.ts";

/** What the analyzer needs from the collector. */
export interface AnalyzerDeps {
  /** Saved replays (newest first), with their match GUIDs. */
  replays: () => { replayId: string; path: string; mtimeMs: number; matchGuid: string | null }[];
  /** The analyzer each replay was last analyzed with. */
  analyzed: () => Map<string, string>;
  /** Parse a replay (in a worker). */
  extract: (path: string) => Promise<SubtrExtract>;
  save: (replayId: string, analyzer: string, result: { analysis: ReplayAnalysis } | { error: string }) => void;
  /** False while a match or practice is being played, so parsing doesn't compete with the game. */
  canRun: () => boolean;
  log?: (line: string) => void;
  now?: () => number;
}

export interface AnalyzerStatus {
  /** Saved replays not analyzed with the current analyzer yet. */
  pending: number;
  running: boolean;
  analyzed: number;
  failed: number;
}

const SETTLE_MS = 30_000;

/**
 * Works through saved replays in the background, one at a time, newest
 * first: subtr-actor in a worker, then the metrics. A replay is done once per
 * analyzer version (a failure too, so a broken file isn't retried until the
 * library or the rules change).
 */
export class ReplayAnalyzer {
  readonly analyzer = analyzerName(SUBTR_VERSION);
  private busy = false;
  private done = 0;
  private failed = 0;
  /** After a setup failure: wait before trying again, and say it once. */
  private setupUntil = 0;
  private setupLogged = false;

  constructor(private readonly deps: AnalyzerDeps) {}

  private todo() {
    const seen = this.deps.analyzed();
    const now = this.deps.now?.() ?? Date.now();
    return this.deps.replays().filter((r) => seen.get(r.replayId) !== this.analyzer && now - r.mtimeMs > SETTLE_MS);
  }

  status(): AnalyzerStatus {
    return { pending: this.todo().length, running: this.busy, analyzed: this.done, failed: this.failed };
  }

  /** Analyze the next replay. Resolves with its ID, or null when there was nothing to do (or it can't run now). */
  async tick(): Promise<string | null> {
    if (this.busy || !this.deps.canRun() || (this.deps.now?.() ?? Date.now()) < this.setupUntil) return null;
    const next = this.todo()[0];
    if (!next) return null;
    this.busy = true;
    const started = this.deps.now?.() ?? Date.now();
    try {
      const analysis = analyzeReplay(await this.deps.extract(next.path));
      this.deps.save(next.replayId, this.analyzer, { analysis });
      this.done++;
      this.deps.log?.(`analyzed replay ${next.replayId} in ${((this.deps.now?.() ?? Date.now()) - started) / 1000}s`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (e instanceof SubtrSetupError) {
        // Not this replay's fault: record nothing, try again in a while.
        this.setupUntil = (this.deps.now?.() ?? Date.now()) + 10 * 60_000;
        if (!this.setupLogged) this.deps.log?.(`replay analysis can't run: ${error}`);
        this.setupLogged = true;
        return null;
      }
      this.deps.save(next.replayId, this.analyzer, { error });
      this.failed++;
      this.deps.log?.(`couldn't analyze replay ${next.replayId}: ${error}`);
    } finally {
      this.busy = false;
    }
    return next.replayId;
  }
}
