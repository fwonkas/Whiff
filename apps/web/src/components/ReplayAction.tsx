import type { SessionReplay } from "@rl/api-contract";
import { useReplayWatch } from "../lib/api.tsx";
import { useWatchControls } from "../lib/replay-controls.ts";
import styles from "./ReplayAction.module.css";

/**
 * A match's replay at a glance: a Watch button when the replay is saved
 * (opens it in the game from the start), or a "Save in game" flag when only
 * the game's Match History still has it, more urgent when ballchasing doesn't
 * have it either. Nothing when it's gone.
 */
export function ReplayAction({ replay, what, compact = false }: { replay: SessionReplay | null; what: string; compact?: boolean }) {
  const watch = useReplayWatch();
  const { gameRunning, shown, enabled, markFast } = useWatchControls();
  if (!replay) return null;

  if (replay.state === "saved" && replay.replayId) {
    if (!shown) return null;
    const failed = watch.data && !watch.data.ok ? watch.data.reason : watch.isError ? watch.error.message : null;
    const fast = markFast && replay.playedFast === true;
    const fastNote = "Only played through faster than 1x, so a few touches are missing. Watch it through at normal speed to fill them in.";
    const title = failed
      ? `Couldn’t open it: ${failed}`
      : (gameRunning
          ? "Open the replay in Rocket League"
          : enabled
            ? "Start Rocket League and open the replay"
            : "Start Rocket League to watch") + (fast ? `. ${fastNote}` : "");
    return (
      <button
        type="button"
        className={styles.watch}
        data-compact={compact || undefined}
        data-failed={failed ? true : undefined}
        data-fast={fast || undefined}
        disabled={!enabled || watch.isPending}
        title={title}
        aria-label={`Watch the replay of ${what}${failed ? `. Couldn’t open it: ${failed}` : fast ? `. ${fastNote}` : ""}`}
        onClick={() => watch.mutate({ replayId: replay.replayId!, launch: !gameRunning })}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
        </svg>
        {!compact && <span>{watch.isPending ? "Opening…" : watch.data?.ok ? (watch.data.status === "launching" ? "Starting…" : "Opened") : "Watch"}</span>}
      </button>
    );
  }

  if (replay.state === "in-history") {
    const h = replay.history;
    const where = h ? `#${h.position} of 20 in Match History, ${h.daysLeft} ${h.daysLeft === 1 ? "day" : "days"} left` : "in Match History";
    const title = `No saved replay: only the game’s Match History has it (${where})${replay.notOnBallchasing ? ", and ballchasing doesn’t" : ""}. Save it there to keep it.`;
    return (
      <span className={styles.flag} data-urgent={replay.notOnBallchasing || h?.atRisk || undefined} title={title}>
        <span aria-hidden="true">{compact ? "Save" : "Save in game"}</span>
        <span className="visually-hidden">{title}</span>
      </span>
    );
  }
  return null;
}
