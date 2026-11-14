import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "@rl/api-contract";
import { ApiProvider } from "./lib/api.tsx";
import { makeRouter } from "./router.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  // Data only changes when a session is saved, and the live feed invalidates then.
  defaultOptions: { queries: { staleTime: 5 * 60_000, refetchOnWindowFocus: false } },
});
const router = makeRouter(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApiProvider client={createApiClient()}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiProvider>
  </StrictMode>,
);
