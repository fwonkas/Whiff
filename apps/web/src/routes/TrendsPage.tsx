import { getRouteApi } from "@tanstack/react-router";
import { DataPeek } from "../components/DataPeek.tsx";
import { FilterChips } from "../components/FilterChips.tsx";
import { useSplits, useTrends } from "../lib/api.tsx";

/**
 * YOUR SCREEN. Filters (team size defaults to 2, plus solo/teammates) already
 * come from the URL and drive the query. To build, from the mockup:
 *
 * 1. One chart per metric in data.series: points have value (per match) and
 *    average (trailing 5). Party matches filled, solo hollow; a dashed line at
 *    an even touch share (100 / team size). Pick a chart library or draw SVG.
 * 2. The "not enough data yet" notice while there are under ~2 weeks of matches.
 * 3. The Splits table from useSplits(), small samples dimmed.
 * 4. Phones: charts one per row (auto-fit grid), Splits with a sticky first column.
 */

const route = getRouteApi("/trends");

export function TrendsPage() {
  const search = route.useSearch();
  const filters = { ...search, teamSize: search.teamSize ?? 2 };
  const trends = useTrends({ teamSize: filters.teamSize, with: filters.with });
  const splits = useSplits();

  return (
    <main className="page">
      <h1 className="page-title">Trends</h1>
      <FilterChips to="/trends" allowAll={false} current={search} />
      {trends.isPending ? (
        <p className="muted">Loading…</p>
      ) : trends.isError ? (
        <p role="alert" className="notice">
          Couldn’t load trends: {trends.error.message}
        </p>
      ) : (
        <>
          <p className="muted">
            {trends.data.matches} matches. Not built yet: charts and splits. See the comment at the top of TrendsPage.tsx.
          </p>
          <DataPeek label="Series" data={trends.data.series} />
        </>
      )}
      {splits.data && <DataPeek label="Splits" data={splits.data.splits} />}
    </main>
  );
}
