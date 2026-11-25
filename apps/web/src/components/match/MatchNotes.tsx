import { useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePatchSession } from "../../lib/api.tsx";
import panels from "../ReplayPanels.module.css";
import styles from "./MatchNotes.module.css";

/**
 * My notes on a match, in Markdown. Shown formatted, with Edit; raw HTML in a
 * note isn't rendered and links open outside the app. Ctrl+Enter (⌘+Enter)
 * saves and Escape cancels while editing.
 */
export function MatchNotes({ sessionId, note }: { sessionId: string; note: string | null }) {
  const patch = usePatchSession();
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  const save = () => {
    if (draft === null) return;
    const text = draft.trim();
    patch.mutate({ id: sessionId, body: { note: text || null } }, { onSuccess: () => setDraft(null) });
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(null);
    }
  };

  if (!editing && !note)
    return (
      <div className={styles.empty}>
        <button type="button" className={panels.button} onClick={() => setDraft("")}>
          Add notes
        </button>
      </div>
    );

  return (
    <section className={`card ${styles.notes}`} aria-labelledby={`notes-${sessionId}`}>
      <div className={styles.head}>
        <h2 id={`notes-${sessionId}`} className={styles.title}>
          Notes
        </h2>
        {!editing && (
          <button type="button" className={panels.button} aria-label="Edit notes" onClick={() => setDraft(note ?? "")}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            className={styles.text}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={keys}
            aria-label="Notes"
            aria-describedby={`notes-hint-${sessionId}`}
            maxLength={20_000}
            autoFocus
          />
          <div className={styles.actions}>
            <button type="button" className={panels.button} data-kind="primary" disabled={patch.isPending} onClick={save}>
              Save
            </button>
            <button type="button" className={panels.button} disabled={patch.isPending} onClick={() => setDraft(null)}>
              Cancel
            </button>
            <span id={`notes-hint-${sessionId}`} className="muted">
              Markdown. Ctrl+Enter saves.
            </span>
          </div>
          {patch.isError && (
            <p role="alert" className={styles.error}>
              Couldn’t save the notes: {patch.error.message}
            </p>
          )}
        </>
      ) : (
        <div className={styles.body}>
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
            {note}
          </Markdown>
        </div>
      )}
    </section>
  );
}
