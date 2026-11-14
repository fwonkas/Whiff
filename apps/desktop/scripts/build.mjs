// Bundles the main process (and the collector, schema, metrics and API code it
// uses) into one CommonJS file for Electron. Electron itself stays external;
// node:sqlite and the rest of Node come from Electron's own Node.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// ESM code in the collector asks import.meta.url for its own location (used only in development); give it the bundle's.
const metaUrl = {
  define: { "import.meta.url": "__bundleUrl" },
  banner: { js: 'const __bundleUrl = require("node:url").pathToFileURL(__filename).href;' },
};
await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(root, "dist", "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  ...metaUrl,
  sourcemap: "linked",
  logLevel: "warning",
});
console.log("built dist/main.cjs");

// The replay parser: subtr-actor's worker and its WASM, outside the asar
// archive (extraResources) so a worker thread can load them from disk.
mkdirSync(join(root, "subtr"), { recursive: true });
await build({
  entryPoints: [join(root, "..", "collector", "src", "subtr", "worker.ts")],
  outfile: join(root, "subtr", "worker.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "warning",
  ...metaUrl,
});
const require = createRequire(join(root, "..", "collector", "package.json"));
copyFileSync(require.resolve("@rlrml/subtr-actor/rl_replay_subtr_actor_bg.wasm"), join(root, "subtr", "subtr-actor.wasm"));
console.log("built subtr/worker.cjs");
