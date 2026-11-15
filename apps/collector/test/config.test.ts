import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliConfigPath, repoConfigPath } from "../src/config.ts";

describe("settings for commands run from the repo", () => {
  const appData = () => {
    const dir = mkdtempSync(join(tmpdir(), "appdata-"));
    mkdirSync(join(dir, "Whiff"));
    writeFileSync(join(dir, "Whiff", "whiff.config.json"), "{}");
    return dir;
  };

  it("use the installed app's settings, where the player ID and data folder are", () => {
    const dir = appData();
    expect(cliConfigPath(["file.ndjson", "--force"], { APPDATA: dir })).toBe(join(dir, "Whiff", "whiff.config.json"));
  });

  it("take --config first, from where the command was run", () => {
    expect(cliConfigPath(["--config", "my.json"], { APPDATA: appData(), INIT_CWD: "/somewhere" })).toBe(join("/somewhere", "my.json"));
  });

  it("fall back to the repo's file without an installed app", () => {
    expect(cliConfigPath([], { APPDATA: mkdtempSync(join(tmpdir(), "appdata-")) })).toBe(repoConfigPath());
    expect(cliConfigPath([], {})).toBe(repoConfigPath());
  });
});
