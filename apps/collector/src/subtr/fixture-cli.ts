/**
 * Make an anonymized replay-analysis fixture from a saved replay:
 *   npm run replay-fixture -- <file.replay> <name> [--me <PrimaryId>]
 * Writes fixtures/<name>.subtr.json.gz: subtr-actor's extract with my ID
 * as Epic|me|0 (from --me or the settings file), known teammates as
 * Epic|teammate|0 and everyone else as anonNNNN / Player-NNN.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { primaryIdOf, type SubtrExtract, type SubtrPlayerId } from "@rl/metrics";
import { findRepoRoot, loadConfig } from "../config.ts";
import { extractReplay } from "./extract.ts";

export function anonymizeExtract(x: SubtrExtract, me: readonly string[], teammates: readonly string[] = []): SubtrExtract {
  const all = [...x.players.team0, ...x.players.team1];
  const swap = new Map<string, { id: SubtrPlayerId; name: string }>();
  let n = 0;
  for (const p of all) {
    const primary = primaryIdOf(p.remote_id, p.name);
    const key = JSON.stringify(p.remote_id);
    if (me.includes(primary)) swap.set(key, { id: { Epic: "me" }, name: p.name });
    else if (teammates.includes(primary)) swap.set(key, { id: { Epic: "teammate" }, name: "Teammate" });
    else {
      const platform = Object.keys(p.remote_id)[0] ?? "Epic";
      const anon = `anon${String(++n).padStart(4, "0")}`;
      const value = typeof p.remote_id[platform] === "object" ? { online_id: anon } : anon;
      swap.set(key, { id: { [platform]: value }, name: `Player-${String(n).padStart(3, "0")}` });
    }
  }
  const names = new Map(all.map((p) => [p.name, swap.get(JSON.stringify(p.remote_id))!.name]));
  // Every player ID object anywhere in the extract is one of these; names too.
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const s = swap.get(JSON.stringify(v));
      if (s) return s.id;
      return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, walk(w)]));
    }
    if (typeof v === "string" && names.has(v)) return names.get(v);
    return v;
  };
  return walk(x) as SubtrExtract;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, name] = process.argv.slice(2).filter((a, i, all) => a !== "--me" && all[i - 1] !== "--me");
  if (!file || !name) {
    console.error("usage: npm run replay-fixture -- <file.replay> <name> [--me <PrimaryId>]");
    process.exit(1);
  }
  const meArg = process.argv.indexOf("--me");
  const cfg = loadConfig();
  const me = meArg > 0 ? [process.argv[meArg + 1]!] : cfg.myPrimaryIds;
  const x = anonymizeExtract(extractReplay(new Uint8Array(readFileSync(file))), me, cfg.knownTeammates.map((t) => t.primaryId));
  const out = join(findRepoRoot(), "fixtures", `${name}.subtr.json.gz`);
  writeFileSync(out, gzipSync(JSON.stringify(x), { level: 9 }));
  console.log(`wrote ${out}`);
}
