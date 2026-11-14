#!/usr/bin/env node
// scripts/release.mjs — tag a release; GitHub Actions builds and publishes it.
//
// Usage:
//   npm run release              → release the version in apps/desktop/package.json
//   npm run release -- patch     → bump 0.2.1 → 0.2.2 first (also minor, major or 1.2.3)
//
// Checks you're on an up-to-date, clean main, commits the bump (if any), tags
// v<version> and pushes both. The "Desktop app" workflow then tests, builds the
// installer and publishes the release; installed copies update from it.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "apps", "desktop", "package.json");
const REPO = "fwonkas/Whiff";

function git(args, { quiet = false } = {}) {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (res.status !== 0 && !quiet) fail(`git ${args.join(" ")} failed:\n${res.stderr.trim()}`);
  return res.status === 0 ? res.stdout.trim() : null;
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function bump(version, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = version.split(".").map(Number);
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "major") return `${major + 1}.0.0`;
  fail(`Unknown version "${how}": use patch, minor, major or a version like 1.2.3.`);
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") fail(`Releases come from main (you're on ${branch}).`);
if (git(["status", "--porcelain"])) fail("Commit or stash your changes first.");
git(["fetch", "--tags", "origin"]);
const behind = git(["rev-list", "--count", "HEAD..origin/main"]);
if (behind !== "0") fail(`main is ${behind} commit(s) behind origin: run git pull first.`);

const text = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(text);
const how = process.argv[2];
const version = how ? bump(pkg.version, how) : pkg.version;
const tag = `v${version}`;
if (git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { quiet: true })) {
  fail(`${tag} is already released. Bump the version: npm run release -- patch`);
}

if (version !== pkg.version) {
  writeFileSync(pkgPath, text.replace(`"version": "${pkg.version}"`, `"version": "${version}"`));
  git(["commit", "-q", "-m", `Release ${version}`, "--", pkgPath]);
  console.log(`Bumped ${pkg.version} → ${version}.`);
}

git(["tag", "-a", tag, "-m", `Whiff ${version}`]);
git(["push", "--atomic", "origin", "main", tag]);
console.log(`\nPushed ${tag}. GitHub Actions now tests, builds and publishes it (about 10 minutes):`);
console.log(`  https://github.com/${REPO}/actions`);
console.log(`  https://github.com/${REPO}/releases/tag/${tag}`);
