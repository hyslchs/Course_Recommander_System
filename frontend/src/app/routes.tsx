import { Suspense, lazy } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { ErrorBoundary } from "./ErrorBoundary";
import { AI_ASSISTANT_VISIBLE } from "./navigation";
import { EmptyState, LoadingSkeleton } from "@/components/ui";
import { useLocalDataState, useProfile } from "@/hooks/localData";

// Route-level code splitting: every page is its own chunk.
const OnboardingPage = lazy(async () => ({ default: (await import("@/pages/onboarding/OnboardingPage")).OnboardingPage }));
const RecommendPage = lazy(async () => ({ default: (await import("@/pages/recommend/RecommendPage")).RecommendPage }));
const AssistantPage = lazy(async () => ({ default: (await import("@/pages/assistant/AssistantPage")).AssistantPage }));
const ExplorePage = lazy(async () => ({ default: (await import("@/pages/explore/ExplorePage")).ExplorePage }));
const SchedulePage = lazy(async () => ({ default: (await import("@/pages/schedule/SchedulePage")).SchedulePage }));
const DataPage = lazy(async () => ({ default: (await import("@/pages/data/DataPage")).DataPage }));
const PrivacyPage = lazy(async () => ({ default: (await import("@/pages/privacy/PrivacyPage")).PrivacyPage }));

/**
 * Deliberately has no `<h1>`: `RouteFocusManager` waits for the real page
 * heading instead of focusing a placeholder that is about to unmount.
 */
function RouteFallback() {
  return <section className="page"><LoadingSkeleton count={3} label="正在載入頁面…" variant="text" /></section>;
}

function NotFoundPage() {
  return <EmptyState action="回到推薦" body="網址可能已經變更或輸入錯誤。" href="/recommend" title="找不到這個頁面" variant="first-run" />;
}

export function AppRoutes() {
  const profile = useProfile();
  const { status: localDataStatus } = useLocalDataState();
  const location = useLocation();
  if (localDataStatus !== "ready" && localDataStatus !== "degraded") return <RouteFallback />;
  return (
    // Keyed by path so a thrown route does not keep the whole app on the error
    // fallback after the student navigates somewhere else.
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to={profile ? "/recommend" : "/onboarding"} replace />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/recommend" element={<RecommendPage />} />
          <Route path="/assistant" element={AI_ASSISTANT_VISIBLE ? <AssistantPage /> : <Navigate to="/recommend" replace />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/data" element={<DataPage />} />
          {/* Reachable without a profile, and deliberately not in the primary
              nav: it is a footer/consent link, not a feature. */}
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
