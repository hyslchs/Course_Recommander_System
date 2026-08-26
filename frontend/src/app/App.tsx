import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./AppShell";
import { createQueryClient } from "./queryClient";
import { AppRoutes } from "./routes";
import { AnalyticsRouteTracker } from "@/analytics/RouteTracker";
import { LocalDataProvider } from "@/hooks/localData";
import { SchedulePlanProvider } from "@/hooks/useSchedulePlans";

/**
 * Provider assembly. Server reads go through TanStack Query; local IndexedDB
 * data is mirrored once by `LocalDataProvider` and read from context, so no page
 * or card subscribes to a store on its own.
 */
function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <LocalDataProvider>
        <SchedulePlanProvider>
          {/* Renders nothing; it is the single `page_view` producer. */}
          <AnalyticsRouteTracker />
          <AppShell>
            <AppRoutes />
          </AppShell>
        </SchedulePlanProvider>
      </LocalDataProvider>
    </QueryClientProvider>
  );
}

export default App;
