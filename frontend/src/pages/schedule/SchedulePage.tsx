import { useMemo } from "react";
import { Button } from "@heroui/react";
import { ScheduleWorkspace } from "./ScheduleWorkspace";
import { useCoursesByIds } from "@/data/queries";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { LoadingSkeleton, StateAlert } from "@/components/ui";

export function SchedulePage() {
  const { activePlan } = useSchedulePlans();
  const courseIds = useMemo(() => activePlan?.entries.map((entry) => entry.courseId) ?? [], [activePlan?.entries]);
  const coursesQuery = useCoursesByIds(courseIds);
  // An empty plan resolves synchronously in `api.ts`, so it must not flash the
  // loading panel — that is what the old `setLoading(Boolean(courseIds.length))` did.
  const loading = courseIds.length > 0 && coursesQuery.isPending;
  const error = coursesQuery.error ? (coursesQuery.error as Error).message : "";
  // The short-lived loading state deliberately has no `<h1>`: RouteFocusManager
  // waits for the workspace heading. A terminal error does own an `<h1>`, since
  // it remains until the student explicitly retries.
  if (loading) return <section className="page"><LoadingSkeleton caption={<><h2 className="page-title">正在載入課表</h2><p>只讀取目前方案中的課程。</p></>} count={4} label="正在載入課表" variant="list" /></section>;
  const retryAction = <Button className="mt-2 min-h-11" isDisabled={coursesQuery.isFetching} isPending={coursesQuery.isFetching} variant="secondary" onPress={() => void coursesQuery.refetch()}>{coursesQuery.isFetching ? "重新載入中…" : "重新載入課表"}</Button>;
  if (error && !coursesQuery.data) return <section className="page"><h1 className="page-title">無法載入課表</h1><StateAlert action={retryAction} title="課表資料暫時無法取得" tone="danger">{error}</StateAlert></section>;
  return <ScheduleWorkspace
    catalog={coursesQuery.data ?? []}
    loadWarning={error ? { message: "課表更新失敗，目前顯示上次取得的資料。", retry: () => void coursesQuery.refetch(), retrying: coursesQuery.isFetching } : undefined}
  />;
}
