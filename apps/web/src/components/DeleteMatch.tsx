import { useId, useRef } from "react";
import { useDeleteSession } from "../lib/api.tsx";
import styles from "./ReplayPanels.module.css";

/**
 * Delete a match, after a warning in a modal: what goes, what stays, and that
 * it can't be undone. `what` names the match ("Thu, Nov 5, 11:30 PM · Ranked
 * 3s · L 1–2"); `onDeleted` runs once it's gone (the match page leaves).
 */
export function DeleteMatch({ sessionId, what, onDeleted }: { sessionId: string; what: string; onDeleted?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const del = useDeleteSession();
  const titleId = useId();
  return (
    <>
      <button type="button" className={styles.button} data-kind="danger-solid" onClick={() => ref.current?.showModal?.()}>
        Delete match…
      </button>
      <dialog ref={ref} className={styles.confirm} aria-labelledby={titleId}>
        <h2 id={titleId} className={styles.confirmTitle}>
          Delete this match?
        </h2>
        <p className={styles.confirmWhat}>{what}</p>
        <ul className={styles.confirmList}>
          <li>Its stats, goals, touches and notes are removed from Whiff, with any replay playbacks of it.</li>
          <li>It leaves your records and trends. Re-importing recordings won’t bring it back.</li>
          <li>The raw recording and the replay file stay where they are. The replay isn’t offered for playing any more.</li>
        </ul>
        <p className={styles.confirmWarn}>This can’t be undone.</p>
        {del.isError && <p className={styles.failure}>Couldn’t delete it: {del.error.message}</p>}
        <div className={styles.buttons}>
          <button type="button" className={styles.button} onClick={() => ref.current?.close()} autoFocus>
            Cancel
          </button>
          <button
            type="button"
            className={styles.button}
            data-kind="danger-solid"
            disabled={del.isPending}
            onClick={() =>
              del.mutate(sessionId, {
                onSuccess: () => {
                  ref.current?.close();
                  onDeleted?.();
                },
              })
            }
          >
            {del.isPending ? "Deleting…" : "Delete match"}
          </button>
        </div>
      </dialog>
    </>
  );
}
