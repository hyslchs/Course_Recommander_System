import { useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./AppShell";
import { createQueryClient } from "./queryClient";
import { AppRoutes } from "./routes";
import { AnalyticsRouteTracker } from "@/analytics/RouteTracker";
import { LoadingSkeleton, StateAlert } from "@/components/ui";
import { LocalDataProvider, useLocalDataState } from "@/hooks/localData";
import { SchedulePlanProvider } from "@/hooks/useSchedulePlans";
import { useFeatures } from "@/data/queries";

/**
 * Provider assembly. Server reads go through TanStack Query; local IndexedDB
 * data is mirrored once by `LocalDataProvider` and read from context, so no page
 * or card subscribes to a store on its own.
 */
function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AnalyticsFeatureBootstrap />
      <LocalDataProvider>
        <LocalDataGate>
          <SchedulePlanProvider>
            {/* Renders nothing; it is the single `page_view` producer. */}
            <AnalyticsRouteTracker />
            <AppShell>
              <AppRoutes />
            </AppShell>
          </SchedulePlanProvider>
        </LocalDataGate>
      </LocalDataProvider>
    </QueryClientProvider>
  );
}

/** Loads the runtime kill switch before any Phase 1-only event is emitted. */
function AnalyticsFeatureBootstrap() {
  useFeatures();
  return null;
}

function LocalDataGate({ children }: { children: ReactNode }) {
  const { status, error, retry, retrying } = useLocalDataState();
  if (status === "loading") {
    return <section className="page"><LoadingSkeleton count={3} label="正在讀取這台裝置上的個人資料…" variant="text" /></section>;
  }
  if (status === "unavailable") {
    return (
      <main id="main-content">
        <section className="page">
          <h1>無法讀取這台裝置上的資料</h1>
          <StateAlert
            action={(
              <div className="mt-3 flex flex-wrap gap-2">
                <Button className="min-h-11" isDisabled={retrying} isPending={retrying} onPress={() => void retry()}>
                  {retrying ? "重新連線中…" : "重新連線儲存空間"}
                </Button>
                <Button className="min-h-11" variant="secondary" onPress={() => window.location.reload()}>重新載入頁面</Button>
              </div>
            )}
            title="尚未確認資料是否存在"
            tone="danger"
          >
            {error?.message ?? "瀏覽器目前無法存取個人資料。請確認未封鎖網站儲存空間後再重試。"}
          </StateAlert>
        </section>
      </main>
    );
  }
  return children;
}

export default App;
