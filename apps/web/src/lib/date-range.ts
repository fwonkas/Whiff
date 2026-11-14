/**
 * The date filter: local days in the URL (YYYY-MM-DD), either end open,
 * both ends included. As a time range: from the start of `from` to the end
 * of `to`.
 */
export interface DayRange {
  from?: string;
  to?: string;
}

const startOfDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
};

/** As the API's `since` / `until` (ms; `until` exclusive). */
export function rangeOf({ from, to }: DayRange): { since?: number; until?: number } {
  return {
    ...(from ? { since: startOfDay(from) } : {}),
    ...(to ? { until: startOfDay(to) + 86_400_000 } : {}),
  };
}

export function inRange(at: number, r: DayRange): boolean {
  const { since, until } = rangeOf(r);
  return (since === undefined || at >= since) && (until === undefined || at < until);
}

const short = (day: string) => new Date(startOfDay(day)).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** "All dates", "Since Nov 1", "Until Nov 3", "Nov 1 – Nov 3", "Nov 1". */
export function rangeLabel({ from, to }: DayRange): string {
  if (from && to) return from === to ? short(from) : `${short(from)} – ${short(to)}`;
  if (from) return `Since ${short(from)}`;
  if (to) return `Until ${short(to)}`;
  return "All dates";
}
