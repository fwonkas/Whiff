import type { GameMessage } from "@rl/schema";

/**
 * Works out which player is me, so a new install needs no setup. In live play
 * (not replays, not goal replays) the camera's target is my car: checked on
 * 2026-11-03 across matches, freeplay and training, where it was me on
 * 97 to 100% of targeted ticks, the rest being no target at all.
 */
export const ME_MIN_TICKS = 300; // about 10 seconds at 30 packets a second
export const ME_MIN_SHARE = 0.95;

export class MeDetector {
  private counts = new Map<string, number>();
  private total = 0;
  private decided: string | null = null;

  /** Feed every message; returns my PrimaryId once, when it's certain. */
  feed(msg: GameMessage): string | null {
    if (this.decided || msg.Event !== "UpdateState") return null;
    const { Game: g, Players: players } = msg.Data;
    if (g.bReplay || !g.bHasTarget || !g.Target) return null;
    const target = players.find((p) => p.Shortcut === g.Target!.Shortcut);
    if (!target || target.PrimaryId.startsWith("Unknown|")) return null;
    this.total++;
    this.counts.set(target.PrimaryId, (this.counts.get(target.PrimaryId) ?? 0) + 1);
    if (this.total < ME_MIN_TICKS) return null;
    const [id, n] = [...this.counts].sort((a, b) => b[1] - a[1])[0]!;
    if (n / this.total < ME_MIN_SHARE) return null;
    this.decided = id;
    return id;
  }
}
