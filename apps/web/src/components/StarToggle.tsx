import { usePatchSession } from "../lib/api.tsx";
import styles from "./StarToggle.module.css";

/**
 * Star or unstar a match (a favorite). A toggle button: the label stays the
 * same and `aria-pressed` says whether it's on. It shows the new state at once
 * and goes back if the change fails. `what` names the match for screen
 * readers ("the 8:13 PM match").
 */
export function StarToggle({ sessionId, starred, what, size = "list" }: { sessionId: string; starred: boolean; what: string; size?: "list" | "title" }) {
  const patch = usePatchSession();
  const pending = patch.isPending && patch.variables?.id === sessionId ? patch.variables.body.starred : undefined;
  const on = pending ?? starred;
  return (
    <button
      type="button"
      className={styles.star}
      data-size={size}
      aria-pressed={on}
      aria-label={`Star ${what}`}
      title={on ? "Starred (click to unstar)" : "Star this match"}
      onClick={() => patch.mutate({ id: sessionId, body: { starred: !on } })}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" />
      </svg>
    </button>
  );
}
