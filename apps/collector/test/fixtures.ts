import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
export const fixture = (name: string) => join(FIXTURE_DIR, `${name}.ndjson.gz`);
export const allFixtures = () =>
  readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".ndjson.gz"))
    .map((f) => f.replace(".ndjson.gz", ""));

/** Fixtures are anonymized: my PrimaryId becomes this, a known teammate becomes "Epic|teammate|0". */
export const ME = "Epic|me|0";
export const TEAMMATE = "Epic|teammate|0";

/** A fixture's lines, unzipped. */
export function fixtureLines(name: string): string[] {
  return gunzipSync(readFileSync(fixture(name))).toString("utf8").split("\n").filter(Boolean);
}

/** Write lines as a recording in a temporary folder. Returns its path. */
export function writeRecording(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "rl-rec-")), "recording.ndjson");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/**
 * Write a recording made of slices of fixtures with collector notes
 * ("connected", "disconnected") between them. Each slice after the first is
 * moved to start `gapMs` after the line before it. Returns its path.
 */
export async function spliceRecording(
  parts: ({ fixture: string; fraction?: number; gapMs?: number } | { note: string; afterMs?: number })[],
): Promise<string> {
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { gunzipSync } = await import("node:zlib");
  const { tmpdir } = await import("node:os");
  const out: string[] = [];
  let last = 0;
  for (const p of parts) {
    if ("note" in p) {
      last += p.afterMs ?? 1;
      out.push(JSON.stringify({ receivedAt: last, note: p.note }));
      continue;
    }
    const lines = gunzipSync(readFileSync(fixture(p.fixture))).toString("utf8").split("\n").filter(Boolean);
    const rows = lines.slice(0, Math.round(lines.length * (p.fraction ?? 1))).map((l) => JSON.parse(l) as { receivedAt: number });
    const shift = last && rows.length ? last + (p.gapMs ?? 1000) - rows[0]!.receivedAt : 0;
    for (const row of rows) {
      row.receivedAt += shift;
      last = row.receivedAt;
      out.push(JSON.stringify(row));
    }
  }
  const path = join(mkdtempSync(join(tmpdir(), "rl-splice-")), "spliced.ndjson");
  writeFileSync(path, out.join("\n") + "\n");
  return path;
}
