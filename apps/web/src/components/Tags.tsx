import { useId, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { usePatchSession, useTags } from "../lib/api.tsx";
import styles from "./Tags.module.css";

/** A person icon marks a known teammate's tag, which Whiff adds by itself. */
export function TagLabel({ tag, teammate }: { tag: string; teammate: boolean }) {
  return (
    <>
      {teammate && (
        <>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className={styles.person}>
            <circle cx="8" cy="5" r="3" />
            <path d="M2 15c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5z" />
          </svg>
          <span className="visually-hidden">With </span>
        </>
      )}
      {tag}
    </>
  );
}

/** Teammate tags first, then mine, without repeating a name. */
function merged(teammates: string[], tags: string[]) {
  const seen = new Set(teammates.map((t) => t.toLowerCase()));
  return [...teammates.map((tag) => ({ tag, teammate: true })), ...tags.filter((t) => !seen.has(t.toLowerCase())).map((tag) => ({ tag, teammate: false }))];
}

/** A match's tags in the Sessions list (inside the row's link, so nothing here is interactive). */
export function TagList({ tags, teammates, className = "" }: { tags: string[]; teammates: string[]; className?: string }) {
  const all = merged(teammates, tags);
  return (
    <span className={`${styles.list} ${className}`}>
      {all.map((t) => (
        <span key={t.tag} className={styles.tag} data-teammate={t.teammate || undefined}>
          <TagLabel {...t} />
        </span>
      ))}
    </span>
  );
}

/**
 * A match's tags on its page. Known teammates' tags are automatic; my own are
 * added here (suggesting tags already used) and removed with their ×. Each
 * tag links to the Sessions list filtered by it.
 */
export function TagEditor({ sessionId, tags, teammates }: { sessionId: string; tags: string[]; teammates: string[] }) {
  const patch = usePatchSession();
  const known = useTags();
  const [draft, setDraft] = useState("");
  const listId = useId();
  // Show a change at once; the saved list arrives when the page refreshes.
  const pending = patch.isPending && patch.variables?.id === sessionId ? patch.variables.body.tags : undefined;
  const mine = pending ?? tags;
  const taken = new Set([...mine, ...teammates].map((t) => t.toLowerCase()));
  const teammateNames = new Set((known.data?.teammates ?? []).map((t) => t.toLowerCase()));
  const suggestions = (known.data?.tags ?? []).map((t) => t.tag).filter((t) => !taken.has(t.toLowerCase()) && !teammateNames.has(t.toLowerCase()));

  const save = (next: string[]) => patch.mutate({ id: sessionId, body: { tags: next } });
  const add = (e: FormEvent) => {
    e.preventDefault();
    const tag = draft.trim().replace(/\s+/g, " ");
    setDraft("");
    if (tag && !taken.has(tag.toLowerCase())) save([...mine, tag]);
  };

  return (
    <div className={styles.editor}>
      <ul className={styles.list} aria-label="Tags">
        {merged(teammates, mine).map((t) => (
          <li key={t.tag} className={styles.tag} data-teammate={t.teammate || undefined}>
            <Link to="/sessions" search={{ tag: t.tag }} className={styles.link} title={t.teammate ? "Known teammate, tagged automatically" : `Matches tagged ${t.tag}`}>
              <TagLabel {...t} />
            </Link>
            {!t.teammate && (
              <button type="button" className={styles.remove} aria-label={`Remove tag ${t.tag}`} onClick={() => save(mine.filter((m) => m !== t.tag))}>
                <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className={styles.add} onSubmit={add}>
        <input
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          list={listId}
          maxLength={40}
          placeholder="Add a tag"
          aria-label="Add a tag"
          enterKeyHint="done"
          autoComplete="off"
        />
        <datalist id={listId}>
          {suggestions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {draft.trim() && (
          <button type="submit" className={styles.addButton}>
            Add
          </button>
        )}
      </form>
      {patch.isError && patch.variables?.body.tags && (
        <p role="alert" className={styles.error}>
          Couldn’t save the tags: {patch.error.message}
        </p>
      )}
    </div>
  );
}
