import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { startCollector } from "./collector.ts";
import { CONFIG_FILE, loadConfig, paths, repoConfigPath } from "./config.ts";

const cfg = loadConfig();
const p = paths(cfg);
if (!cfg.myPrimaryIds.length) console.warn(`Warning: set myPrimaryIds in ${CONFIG_FILE} so your player is recognized.`);

const collector = await startCollector({
  ...cfg,
  dbPath: p.db,
  rawDir: p.rawDir,
  webRoot: p.webRoot,
  ballchasingToken: () => loadConfig().ballchasingToken ?? null,
  settingsFile: repoConfigPath(),
});
console.log(`Collector running. Data: ${cfg.dataDir}`);
console.log(`App: http://localhost:${collector.port}`);
if (cfg.allowLan) {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i!.address}:${collector.port}`);
  console.log(`On your network (allowLan is on): ${lan.join(", ") || "no network address found"}`);
}
console.log(`Waiting for the game at ${cfg.gameUrl} (PacketSendRate must be above 0 in TAStatsAPI.ini). Ctrl+C to stop.`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await collector.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
