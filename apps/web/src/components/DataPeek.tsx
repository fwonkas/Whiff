/** A collapsible raw view of API data, for building screens against real responses. Remove when done. */
export function DataPeek({ label, data }: { label: string; data: unknown }) {
  return (
    <details className="card" style={{ padding: "12px 16px" }}>
      <summary style={{ cursor: "pointer", minHeight: 32 }}>{label}</summary>
      <pre style={{ margin: 0, maxHeight: 480, overflow: "auto", fontSize: 12, color: "var(--text-soft)" }}>
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}
