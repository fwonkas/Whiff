import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useConfig, useMeCandidates, usePatchConfig } from "../lib/api.tsx";
import styles from "./MeBanner.module.css";

/** "Epic" from "Epic|<account id>|0". */
const platformOf = (primaryId: string) => primaryId.split("|")[0] ?? "";

/**
 * After the app picks my player by itself (from the first live play), asks
 * once whether it got it right. "Not me" offers the others from that session;
 * picking one moves what was credited to the guess over to them.
 */
export function MeBanner() {
  const config = useConfig();
  const patch = usePatchConfig();
  const [picking, setPicking] = useState(false);
  const c = config.data;
  const show = !!c && c.editable && c.myPrimaryIds.length > 0 && !c.meConfirmed;
  const candidates = useMeCandidates(show && picking);
  if (!show) return null;

  const me = c.me[0];
  const name = me?.name ?? "this player";
  const failure = patch.isError ? patch.error.message : patch.data && !patch.data.ok ? patch.data.reason : null;
  const others = candidates.data ?? [];

  return (
    <div className={styles.wrap}>
      <section className={styles.banner} aria-labelledby="me-banner-title">
        <p id="me-banner-title" className={styles.text}>
          Recording you as <strong>{name}</strong>
          {me ? <span className={styles.platform}> ({platformOf(me.primaryId)})</span> : null}. Is that you?
        </p>
        <div className={styles.buttons}>
          <button type="button" className={styles.primary} disabled={patch.isPending} onClick={() => patch.mutate({ meConfirmed: true })}>
            Yes, that’s me
          </button>
          <button type="button" className={styles.secondary} aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
            Not me
          </button>
        </div>
        {picking && (
          <div className={styles.pick}>
            {candidates.isPending ? (
              <p className={styles.hint} role="status">
                Finding the other players…
              </p>
            ) : others.length ? (
              <>
                <p className={styles.hint}>Which of the other players in that session is you? What was recorded for {name} moves to them.</p>
                <ul className={styles.list}>
                  {others.map((o) => (
                    <li key={o.primaryId}>
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={patch.isPending}
                        onClick={() => patch.mutate({ myPrimaryIds: [o.primaryId], meConfirmed: true })}
                      >
                        {o.name}
                        <span className={styles.platform}> ({platformOf(o.primaryId)})</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className={styles.hint}>
              Or enter your player ID in{" "}
              <Link to="." search={(prev: Record<string, unknown>) => prev} hash="settings/player">
                Settings → Player
              </Link>
              .
            </p>
          </div>
        )}
        {failure && (
          <p className={styles.failure} role="alert">
            Couldn’t save it: {failure}
          </p>
        )}
      </section>
    </div>
  );
}
