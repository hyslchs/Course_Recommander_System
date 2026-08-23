import { useEffect, useMemo, useState } from "react";
import { ScheduleWorkspace } from "./ScheduleWorkspace";
import { getCoursesByIds } from "@/data/api";
import type { Course, Profile, SchedulePlan } from "@/domain/types";

export function SchedulePage({ plans, active, profile, selectPlan }: { plans: SchedulePlan[]; active?: SchedulePlan; profile?: Profile; selectPlan: (planId: string) => Promise<void> }) {
  const courseIds = useMemo(() => active?.entries.map((entry) => entry.courseId) ?? [], [active?.entries]);
  const courseIdsKey = courseIds.join("\u0000");
  const [catalog, setCatalog] = useState<Course[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(Boolean(courseIds.length));
    setError("");
    void getCoursesByIds(courseIds).then((courses) => {
      if (!cancelled) setCatalog(courses);
    }).catch((caught) => {
      if (!cancelled) setError((caught as Error).message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [courseIdsKey]);
  // Transient states deliberately render no `<h1>`: the route's single `<h1>` is
  // the workspace's own page heading, and `RouteFocusManager` waits for it
  // instead of focusing a heading that is about to unmount (plan R9).
  if (loading) return <section className="page"><div className="empty-panel" role="status"><h2 className="page-title">正在載入課表</h2><p>只讀取目前方案中的課程。</p></div></section>;
  if (error) return <section className="page"><div className="notice danger" role="alert"><h2 className="page-title">無法載入課表</h2><p>{error}</p></div></section>;
  return <ScheduleWorkspace catalog={catalog} plans={plans} active={active} profile={profile} selectPlan={selectPlan} />;
}
