import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BallchasingClient, BallchasingError } from "./ballchasing.ts";
import { cliConfigPath, loadConfig, paths } from "./config.ts";
import { listSavedReplays, replayDirsIn } from "./replay-files.ts";
import { pacedFetch, planRetitle, type Retitle } from "./retitle.ts";

/**
 * Retitle my replays already on ballchasing the way Whiff titles new uploads:
 * "Ranked Doubles 2026-11-14 20:13" (playlist and start).
 *   npm run retitle                 lists what would change
 *   npm run retitle -- --apply      changes them
 *   --config <file>                 the settings file (default: the desktop app's, else the repo's)
 *   --per-hour <n>                  request budget (default 4800, under the 5000/hour limit)
 * Every request is paced; a 429 waits a minute and tries again. Safe to stop
 * and run again: ones already titled are skipped. Reads Whiff's database
 * without changing it, so the app can keep running.
 */

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = args.includes("--apply");
const perHour = Number(opt("--per-hour") ?? 4800);
const configPath = cliConfigPath(args);

const cfg = loadConfig(configPath);
if (!cfg.ballchasingToken) {
  console.error(`No ballchasing API key in ${configPath}.`);
  process.exit(1);
}
const gapMs = Math.ceil(3_600_000 / perHour);
const client = new BallchasingClient(cfg.ballchasingToken, pacedFetch(gapMs));

// What Whiff knows: match GUIDs of replays (analysis and the saved files), playlists and starts.
const db = new DatabaseSync(paths(cfg).db, { readOnly: true });
const rows = <T>(sql: string) => db.prepare(sql).all() as T[];
const guids = new Map<string, string>();
for (const r of rows<{ replayId: string; guid: string }>("SELECT replay_id AS replayId, match_guid AS guid FROM replay_analysis WHERE match_guid IS NOT NULL"))
  guids.set(r.replayId.toUpperCase(), r.guid.toUpperCase());
const replayDirs = cfg.replayDirs ?? replayDirsIn(join(homedir(), "Documents"));
for (const r of listSavedReplays(replayDirs)) if (r.matchGuid) guids.set(r.replayId.toUpperCase(), r.matchGuid.toUpperCase());
const playlists = new Map<string, number>();
for (const r of rows<{ guid: string; playlistId: number }>(
  `SELECT match_guid AS guid, playlist_id AS playlistId FROM sessions WHERE match_guid IS NOT NULL AND playlist_id IS NOT NULL AND kind IN ('match', 'replay')
   UNION ALL SELECT guid, playlist_id FROM skipped_matches WHERE playlist_id IS NOT NULL`,
))
  playlists.set(r.guid.toUpperCase(), r.playlistId);
const starts = new Map<string, number>();
for (const r of rows<{ guid: string; startedAt: number }>(
  "SELECT match_guid AS guid, MIN(started_at) AS startedAt FROM sessions WHERE kind = 'match' AND match_guid IS NOT NULL GROUP BY UPPER(match_guid)",
))
  starts.set(r.guid.toUpperCase(), r.startedAt);
db.close();
const look = { guidOf: (id: string) => guids.get(id) ?? null, playlist: (g: string) => playlists.get(g) ?? null, start: (g: string) => starts.get(g) ?? null };

async function withRetry<T>(what: string, f: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof BallchasingError && e.status === 429) || attempt >= 5) throw e;
      console.log(`  rate limited (${what}); waiting a minute`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
}

console.log(`Settings: ${configPath}\nListing your uploads on ballchasing…`);
const mine = await withRetry("listing", () => client.myReplays(Date.UTC(2015, 0, 1), Date.now() + 86_400_000));
const plan = mine.map((m) => planRetitle(m, look)).filter((r): r is Retitle => r !== null);
console.log(`${mine.length} uploads; ${plan.length} to retitle (the rest already have their title, or there's too little to go on).`);
if (!apply) {
  for (const r of plan.slice(0, 20)) console.log(`  ${r.id}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`);
  if (plan.length > 20) console.log(`  …and ${plan.length - 20} more`);
  if (plan.length) console.log(`\nRun again with --apply to change them (about ${Math.ceil((plan.length * gapMs) / 60_000)} min at ${perHour} requests an hour).`);
  process.exit(0);
}

let done = 0;
let failed = 0;
for (const r of plan) {
  try {
    await withRetry(r.id, () => client.setTitle(r.id, r.to));
    done++;
  } catch (e) {
    failed++;
    console.log(`  ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if ((done + failed) % 25 === 0 || done + failed === plan.length) console.log(`${done + failed} of ${plan.length} (${failed} failed)`);
}
console.log(`Done: ${done} retitled${failed ? `, ${failed} failed (run again to retry them)` : ""}.`);
