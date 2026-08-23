import { Suspense, lazy } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { ErrorBoundary } from "./ErrorBoundary";
import { AI_ASSISTANT_VISIBLE } from "./navigation";
import { EmptyState } from "@/components/EmptyState";
import type { Profile, SchedulePlan } from "@/domain/types";

// Route-level code splitting: every page is its own chunk.
const OnboardingPage = lazy(async () => ({ default: (await import("@/pages/onboarding/OnboardingPage")).OnboardingPage }));
const RecommendPage = lazy(async () => ({ default: (await import("@/pages/recommend/RecommendPage")).RecommendPage }));
const AssistantPage = lazy(async () => ({ default: (await import("@/pages/assistant/AssistantPage")).AssistantPage }));
const ExplorePage = lazy(async () => ({ default: (await import("@/pages/explore/ExplorePage")).ExplorePage }));
const SchedulePage = lazy(async () => ({ default: (await import("@/pages/schedule/SchedulePage")).SchedulePage }));
const DataPage = lazy(async () => ({ default: (await import("@/pages/data/DataPage")).DataPage }));

/**
 * Deliberately has no `<h1>`: `RouteFocusManager` waits for the real page
 * heading instead of focusing a placeholder that is about to unmount.
 */
function RouteFallback() {
  return <section className="page"><div className="empty-panel" role="status"><p>正在載入頁面…</p></div></section>;
}

function NotFoundPage() {
  return <EmptyState title="找不到這個頁面" body="網址可能已經變更或輸入錯誤。" action="回到推薦" href="/recommend" />;
}

export interface AppRoutesProps {
  profile?: Profile;
  plans: SchedulePlan[];
  activePlan?: SchedulePlan;
  selectPlan: (planId: string) => Promise<void>;
}

export function AppRoutes({ profile, plans, activePlan, selectPlan }: AppRoutesProps) {
  const location = useLocation();
  return (
    // Keyed by path so a thrown route does not keep the whole app on the error
    // fallback after the student navigates somewhere else.
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to={profile ? "/recommend" : "/onboarding"} replace />} />
          <Route path="/onboarding" element={<OnboardingPage profile={profile} />} />
          <Route path="/recommend" element={<RecommendPage profile={profile} />} />
          <Route path="/assistant" element={AI_ASSISTANT_VISIBLE ? <AssistantPage profile={profile} /> : <Navigate to="/recommend" replace />} />
          <Route path="/explore" element={<ExplorePage profile={profile} />} />
          <Route path="/schedule" element={<SchedulePage plans={plans} active={activePlan} profile={profile} selectPlan={selectPlan} />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
