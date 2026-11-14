import { DataPeek } from "../components/DataPeek.tsx";
import { usePractice } from "../lib/api.tsx";

/**
 * YOUR SCREEN. From the mockup:
 *
 * 1. Training packs: one card per training item with its attempt strip and
 *    success rate. Untagged packs get a "Tag this pack" control: save it with
 *    api.putPack(code, { name, type }) then api.patchSession(id, { packCode }),
 *    as a useMutation that invalidates keys.practice() on success. (Your first
 *    write path; there's an API test showing the calls.)
 * 2. Freeplay table: hide queue warm-ups under a minute; show game speed
 *    (null means it couldn't be measured) and touchesPerGameMinute.
 * 3. Phones: cards stack, the table gets a sticky first column.
 */

export function PracticePage() {
  const { data, isPending, isError, error } = usePractice();
  return (
    <main className="page">
      <h1 className="page-title">Practice</h1>
      {isPending ? (
        <p className="muted">Loading…</p>
      ) : isError ? (
        <p role="alert" className="notice">
          Couldn’t load practice: {error.message}
        </p>
      ) : (
        <>
          <p className="muted">
            {data.items.length} sessions, {data.packs.length} tagged packs. Not built yet: see the comment at the top of
            PracticePage.tsx.
          </p>
          <DataPeek label="Practice sessions" data={data.items} />
        </>
      )}
    </main>
  );
}
