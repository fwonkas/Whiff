import { useId, useRef, type ReactNode } from "react";
import styles from "./HelpTip.module.css";

/**
 * A small "?" that opens a longer explanation. A popover, not a title
 * tooltip, so it works on touch screens and with a keyboard, and Escape or a
 * click outside closes it. Placed under the button when it opens.
 */
export function HelpTip({ about, children }: { about: string; children: ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const place = () => {
    const b = button.current?.getBoundingClientRect();
    const t = tip.current;
    if (!b || !t) return;
    const below = b.bottom + 6;
    const fitsBelow = below + t.offsetHeight <= window.innerHeight - 8;
    t.style.top = `${fitsBelow ? below : Math.max(8, b.top - 6 - t.offsetHeight)}px`;
    t.style.left = `${Math.max(8, Math.min(b.left - 12, window.innerWidth - t.offsetWidth - 8))}px`;
  };
  return (
    <>
      <button ref={button} type="button" className={styles.button} popoverTarget={id} aria-label={`About ${about}`} title={`About ${about}`}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6.2 6.2a1.8 1.8 0 1 1 2.6 1.6c-.5.3-.8.6-.8 1.2v.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="11.6" r=".8" fill="currentColor" />
        </svg>
      </button>
      <div
        ref={tip}
        id={id}
        popover="auto"
        role="note"
        aria-label={about}
        className={styles.tip}
        onToggle={(e) => (e as unknown as ToggleEvent).newState === "open" && place()}
      >
        {children}
      </div>
    </>
  );
}
