import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLAYLISTS } from "@rl/schema";
import { cliConfigPath, loadConfig, paths } from "./config.ts";
import { StatsDb } from "./db.ts";
import { ingestRecording } from "./ingest.ts";
import type { Session } from "@rl/domain";

/**
 * Backfill: ingest recordings into the database.
 *   npm run ingest -- <file or folder> [...more] [--force] [--config <file>]
 * Folders are searched recursively for *.ndjson and *.ndjson.gz.
 * Files already ingested (same size and modified time) are skipped unless --force.
 * Settings (your player ID, the data folder) come from the installed app's
 * settings file unless --config says otherwise (cliConfigPath). Without a
 * player ID it stops: matches would be saved with nobody marked as you.
 */

const args = process.argv.slice(2);
const force = args.includes("--force");
const configAt = args.indexOf("--config");
const targets = args.filter((a, i) => !a.startsWith("--") && !(configAt >= 0 && i === configAt + 1));
if (!targets.length) {
  console.error("Usage: npm run ingest -- <recording file or folder> [...] [--force]");
  process.exit(1);
}

const find = (p: string): string[] => {
  const st = statSync(p);
  if (st.isFile()) return [p];
  return readdirSync(p, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith("_") || d.name === "node_modules") return [];
    const full = join(p, d.name);
    if (d.isDirectory()) return find(full);
    return /\.ndjson(\.gz)?$/.test(d.name) ? [full] : [];
  });
};

const configPath = cliConfigPath(args);
const cfg = loadConfig(configPath);
console.log(`Settings: ${configPath}\nDatabase: ${paths(cfg).db}`);
if (!cfg.myPrimaryIds.length) {
  console.error("No player ID (myPrimaryIds) in those settings, so no player would be marked as you. Nothing was imported.");
  console.error("Point at the right settings file with --config <file>.");
  process.exit(1);
}
const db = new StatsDb(paths(cfg).db);
db.setRecordCasual(cfg.recordCasual ?? false);

const describe = (s: Session) => {
  const pl = s.playlistId !== null ? (PLAYLISTS[s.playlistId]?.name ?? `playlist ${s.playlistId}`) : "";
  const when = new Date(s.startedAt).toLocaleString();
  const score = s.kind === "match" ? ` ${s.scoreBlue}-${s.scoreOrange} ${s.outcome ?? "incomplete"}${s.overtime ? " (OT)" : ""}` : "";
  const extra =
    s.kind === "training"
      ? ` ${s.trainingAttempts.filter((a) => a.outcome !== "reset").length} attempts`
      : s.kind === "replay"
        ? ` replay ${s.replayId}`
        : "";
  return `  ${when}  ${s.kind.padEnd(8)} ${pl}${score}${extra}`;
};

let total = 0;
// npm runs workspace scripts from the workspace folder; resolve paths from where you ran the command.
const base = process.env.INIT_CWD ?? process.cwd();
for (const file of targets.flatMap((t) => find(resolve(base, t)))) {
  const st = statSync(file);
  if (!force && db.alreadyIngested(file, st.size, st.mtimeMs)) {
    console.log(`skip ${file} (already ingested)`);
    continue;
  }
  const { sessions, skipped, connections, messages, invalid } = await ingestRecording(file, cfg);
  for (const s of skipped) db.recordSkipped(s);
  for (const s of sessions) db.saveSession(s);
  for (const c of connections) db.saveConnection(c);
  db.markIngested(file, st.size, st.mtimeMs, sessions.length);
  total += sessions.length;
  console.log(`${file}: ${messages} messages, ${invalid} unreadable, ${sessions.length} sessions`);
  for (const s of sessions) console.log(describe(s));
}
console.log(`\nDone: ${total} sessions saved to ${paths(cfg).db}`);
db.close();
