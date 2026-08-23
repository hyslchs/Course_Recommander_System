import { useMemo } from "react";
import { ScheduleWorkspace } from "./ScheduleWorkspace";
import { useCoursesByIds } from "@/data/queries";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";

export function SchedulePage() {
  const { activePlan } = useSchedulePlans();
  const courseIds = useMemo(() => activePlan?.entries.map((entry) => entry.courseId) ?? [], [activePlan?.entries]);
  const coursesQuery = useCoursesByIds(courseIds);
  // An empty plan resolves synchronously in `api.ts`, so it must not flash the
  // loading panel — that is what the old `setLoading(Boolean(courseIds.length))` did.
  const loading = courseIds.length > 0 && coursesQuery.isPending;
  const error = coursesQuery.error ? (coursesQuery.error as Error).message : "";
  // Transient states deliberately render no `<h1>`: the route's single `<h1>` is
  // the workspace's own page heading, and `RouteFocusManager` waits for it
  // instead of focusing a heading that is about to unmount (plan R9).
  if (loading) return <section className="page"><div className="empty-panel" role="status"><h2 className="page-title">正在載入課表</h2><p>只讀取目前方案中的課程。</p></div></section>;
  if (error) return <section className="page"><div className="notice danger" role="alert"><h2 className="page-title">無法載入課表</h2><p>{error}</p></div></section>;
  return <ScheduleWorkspace catalog={coursesQuery.data ?? []} />;
}
