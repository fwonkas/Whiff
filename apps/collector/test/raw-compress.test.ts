import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ingestRecording } from "../src/ingest.ts";
import { compressRawLogs } from "../src/recording.ts";
import { fixture, ME } from "./fixtures.ts";

describe("compressing finished raw logs", () => {
  it("gzips every log but the one in use, and ingest reads them the same", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-raw-"));
    // A real recording, as the collector writes it (plain NDJSON).
    const plain = (await import("node:zlib")).gunzipSync(readFileSync(fixture("replay-ends-at-clock-1"))).toString();
    writeFileSync(join(dir, "2026-11-06T15-14-42.ndjson"), plain);
    writeFileSync(join(dir, "2026-11-06T16-00-00.ndjson"), '{"receivedAt":1,"note":"connected"}\n');
    const before = await ingestRecording(join(dir, "2026-11-06T15-14-42.ndjson"), { myPrimaryIds: [ME], knownTeammates: [] });

    const done = await compressRawLogs(dir, join(dir, "2026-11-06T16-00-00.ndjson"));
    expect(done).toEqual(["2026-11-06T15-14-42.ndjson"]);
    expect(readdirSync(dir).sort()).toEqual(["2026-11-06T15-14-42.ndjson.gz", "2026-11-06T16-00-00.ndjson"]);
    const after = await ingestRecording(join(dir, "2026-11-06T15-14-42.ndjson.gz"), { myPrimaryIds: [ME], knownTeammates: [] });
    expect(after.sessions).toEqual(before.sessions);
  });

  it("finishes a run that stopped halfway, and redoes a broken copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-raw-"));
    const line = '{"receivedAt":1,"note":"connected"}\n';
    // Whole copy left beside its original: the original goes.
    writeFileSync(join(dir, "a.ndjson"), line);
    writeFileSync(join(dir, "a.ndjson.gz"), gzipSync(line));
    // Broken copy: compressed again.
    writeFileSync(join(dir, "b.ndjson"), line.repeat(3));
    writeFileSync(join(dir, "b.ndjson.gz"), gzipSync(line));
    expect((await compressRawLogs(dir, null)).sort()).toEqual(["a.ndjson", "b.ndjson"]);
    expect(readdirSync(dir).sort()).toEqual(["a.ndjson.gz", "b.ndjson.gz"]);
    expect((await import("node:zlib")).gunzipSync(readFileSync(join(dir, "b.ndjson.gz"))).toString()).toBe(line.repeat(3));
  });
});
