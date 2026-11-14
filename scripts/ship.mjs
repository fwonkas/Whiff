#!/usr/bin/env node
// scripts/ship.mjs — build the desktop app, then open the release folder
// or launch the NSIS installer.
//
// Usage:
//   npm run ship        → npm ci + desktop:dist, then open release folder in Explorer
//   npm run ship -- --run → same, then launch the installer exe

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const desktopDir = path.join(rootDir, "apps", "desktop");
const releaseDir = path.join(desktopDir, "release");

const run = (cmd, cwd) => {
  console.log(`\n> ${cmd}`);
  const res = spawnSync(cmd, { cwd, stdio: "inherit", shell: true });
  if (res.status !== 0) {
    console.error(`"${cmd}" failed with exit code ${res.status ?? "?"}`);
    process.exit(res.status ?? 1);
  }
};

// Resolve the installer path from build.nsis.artifactName, substituting
// electron-builder placeholders. Falls back to the newest *.exe in release/.
function pickInstaller() {
  const pkg = JSON.parse(
    readFileSync(path.join(desktopDir, "package.json"), "utf8"),
  );
  const tpl = pkg.build?.nsis?.artifactName;

  if (tpl) {
    const productName =
      pkg.build?.productName ?? pkg.productName ?? pkg.name ?? "";
    const name = tpl
      .replaceAll("${productName}", productName)
      .replaceAll("${version}", pkg.version ?? "")
      .replaceAll("${ext}", "exe") // NSIS target always produces .exe
      .replaceAll("${os}", "win")
      .replaceAll("${arch}", process.arch === "arm64" ? "arm64" : "x64");

    const candidate = path.join(releaseDir, name);
    if (existsSync(candidate)) return candidate;
    console.warn(`Artifact from package.json not found: ${candidate}`);
  }

  // Fallback: most recently modified .exe in the release folder
  try {
    const exes = readdirSync(releaseDir)
      .filter((f) => f.toLowerCase().endsWith(".exe"))
      .map((f) => ({
        name: f,
        mtime: statSync(path.join(releaseDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (exes.length > 0) {
      console.warn(`Using newest exe instead: ${exes[0].name}`);
      return path.join(releaseDir, exes[0].name);
    }
  } catch {
    /* release dir missing */
  }

  return null;
}

const launchInstaller = process.argv.includes("--run");

run("npm ci", rootDir);
run("npm run desktop:dist", rootDir);

if (launchInstaller) {
  const exe = pickInstaller();
  if (!exe) {
    console.error("No installer found in release folder.");
    process.exit(1);
  }
  console.log(`\nLaunching: ${exe}`);
  // empty "" argument = title token for `start`, so paths with spaces work
  spawn("cmd.exe", ["/c", "start", "", exe], {
    detached: true,
    stdio: "ignore",
  }).unref();
} else {
  console.log(`\nOpening: ${releaseDir}`);
  spawn("explorer.exe", [releaseDir], {
    detached: true,
    stdio: "ignore",
  }).unref();
}
