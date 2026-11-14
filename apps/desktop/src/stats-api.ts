import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableStatsApi, findRocketLeagueInstalls, readStatsApi, statsApiIniPath } from "@rl/collector";

export type StatsApiCheck =
  | { kind: "on" | "off"; iniPath: string; webPort: number }
  | { kind: "not-found" };

/** Is the Stats API on in the first Rocket League install found? */
export function checkStatsApi(): StatsApiCheck {
  if (process.platform !== "win32") return { kind: "not-found" };
  for (const dir of findRocketLeagueInstalls()) {
    const iniPath = statsApiIniPath(dir);
    if (!iniPath) continue;
    try {
      const s = readStatsApi(readFileSync(iniPath, "utf8"));
      return { kind: s.packetSendRate > 0 ? "on" : "off", iniPath, webPort: s.webPort };
    } catch {
      // Unreadable: try the next install.
    }
  }
  return { kind: "not-found" };
}

/**
 * Set PacketSendRate=30. The game usually lives under Program Files, which
 * needs administrator rights to change, so when a plain write is refused the
 * new file is copied into place by an elevated PowerShell (Windows shows its
 * permission prompt).
 */
export async function turnOnStatsApi(iniPath: string): Promise<void> {
  const next = enableStatsApi(readFileSync(iniPath, "utf8"));
  try {
    writeFileSync(iniPath, next);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw e;
  }
  const staged = join(mkdtempSync(join(tmpdir(), "whiff-")), "TAStatsAPI.ini");
  writeFileSync(staged, next);
  const quote = (p: string) => `'${p.replace(/'/g, "''")}'`;
  const inner = `Copy-Item -LiteralPath ${quote(staged)} -Destination ${quote(iniPath)} -Force`;
  const outer = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',${quote(inner)}`;
  await new Promise<void>((resolve, reject) =>
    execFile("powershell.exe", ["-NoProfile", "-Command", outer], (err) => (err ? reject(err) : resolve())),
  );
  if (readStatsApi(readFileSync(iniPath, "utf8")).packetSendRate <= 0) {
    throw new Error("The setting didn't change (the permission prompt may have been declined).");
  }
}
