import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, redirect, type RouterHistory } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "./components/AppShell.tsx";
import { UnfinishedPage } from "./components/UnfinishedPage.tsx";
import { cachedUi, defaultSessionsSearch } from "./lib/ui-prefs.ts";
import { MatchPage } from "./routes/MatchPage.tsx";
import { PracticePage } from "./routes/PracticePage.tsx";
import { AboutPage } from "./routes/AboutPage.tsx";
import { SessionsPage } from "./routes/SessionsPage.tsx";
import { TrendsPage } from "./routes/TrendsPage.tsx";

/**
 * Routes, defined in code. Filters live in the URL as typed search params:
 * links are shareable, Back works, and each screen reads them with
 * Route.useSearch() instead of keeping its own filter state.
 */

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/sessions", search: defaultSessionsSearch(cachedUi()) });
  },
});

/** `.catch(undefined)` drops a bad value from a hand-edited URL instead of failing the page. */
const DateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined);

export const MatchFilters = z.object({
  teamSize: z.coerce.number().int().min(1).max(3).optional().catch(undefined),
  with: z.enum(["solo", "party"]).optional().catch(undefined),
  /** An extra mode by playlist (tournaments, Rumble…); team size and mode don't combine. */
  playlist: z.coerce.number().int().optional().catch(undefined),
  result: z.enum(["win", "loss", "mvp"]).optional().catch(undefined),
  /** Sessions: replay not saved yet ("attention") or saved. */
  replay: z.enum(["attention", "saved"]).optional().catch(undefined),
  /** Sessions: starred matches only. Absent (not false) when off, so the URL stays clean. */
  starred: z.literal(true).optional().catch(undefined),
  /** Date range, local days (YYYY-MM-DD), either end open. */
  from: DateParam,
  to: DateParam,
});
export type MatchFilters = z.infer<typeof MatchFilters>;

export const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  validateSearch: (search) => MatchFilters.parse(search),
  component: SessionsPage,
});

export const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id",
  component: MatchPage,
});

export const trendsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trends",
  validateSearch: (search) => MatchFilters.parse(search),
  // Trends compare like with like: no "all team sizes" view, 2v2 by default.
  beforeLoad: ({ search }) => {
    if (search.teamSize === undefined) throw redirect({ to: "/trends", search: { ...search, teamSize: 2 } });
  },
  component: () => (
    <UnfinishedPage>
      <TrendsPage />
    </UnfinishedPage>
  ),
});

export const practiceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/practice",
  component: () => (
    <UnfinishedPage>
      <PracticePage />
    </UnfinishedPage>
  ),
});

export const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: AboutPage,
});

/**
 * The Replays page moved into Sessions (2026-11-06): old links land on
 * Sessions with the same filters ("status" is Sessions' "replay").
 */
const OldReplayFilters = z.object({
  status: z.enum(["attention", "saved"]).optional().catch(undefined),
  result: z.enum(["win", "loss", "mvp"]).optional().catch(undefined),
  from: DateParam,
  to: DateParam,
});

export const replaysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/replays",
  validateSearch: (search) => OldReplayFilters.parse(search),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/sessions", search: { replay: search.status, result: search.result, from: search.from, to: search.to } });
  },
});

const routeTree = rootRoute.addChildren([indexRoute, sessionsRoute, sessionRoute, trendsRoute, practiceRoute, aboutRoute, replaysRoute]);

/** `history` is for tests (a memory history); the app uses the browser's. */
export function makeRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({ routeTree, context: { queryClient }, history, defaultPreload: "intent", scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
