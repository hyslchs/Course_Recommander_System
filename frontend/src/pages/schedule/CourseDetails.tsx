import { useEffect, useState } from "react";
import { formatMeetings, type ScheduleBlock } from "@/domain/schedule";
import { SideDrawer } from "@/components/ui";
import type { Course, SchedulePlan } from "@/domain/types";

/** Plan §5.1: `lg` is where course details become a right-hand side panel. */
const DESKTOP_DRAWER = "(min-width: 1024px)";

/**
 * Live match for a media query. Written here rather than pulled from a
 * dependency because it is four lines, and deliberately tolerant of a
 * `matchMedia` that returns a fresh object per call (which is what the jsdom
 * stub in `src/test/setup.ts` does) — the listener is attached to the same
 * `MediaQueryList` it read `matches` from.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Course / fixed-slot details.
 *
 * T35 moved this off `Modal` and onto `SideDrawer`: plan §4.5 wants a right-hand
 * panel on the desktop timetable (the grid stays visible beside it) and a bottom
 * sheet with a drag handle on a phone. Both are the same React Aria dialog
 * underneath, so the focus trap, Escape and return-focus contract is unchanged;
 * `closeLabel` keeps the "關閉對話框" wording the workspace test pins.
 */
export function CourseDetails({ block, catalog, scheduledCourses, plan, onClose }: { block: ScheduleBlock; catalog: Course[]; scheduledCourses: Course[]; plan: SchedulePlan; onClose: () => void }) {
  const isDesktop = useMediaQuery(DESKTOP_DRAWER);
  const scheduledCourse = block.source === "course" ? scheduledCourses.find((course) => course.course_id === block.sourceId) : undefined;
  const originalCourse = block.source === "course" ? catalog.find((course) => course.course_id === block.sourceId) : undefined;
  const scheduleEntry = block.source === "course" ? plan.entries.find((entry) => entry.courseId === block.sourceId) : undefined;
  const fixedEntry = block.source === "fixed" ? plan.fixedEntries?.find((entry) => entry.id === block.sourceId) : undefined;
  return <SideDrawer open title={scheduledCourse?.name_zh ?? fixedEntry?.name ?? block.name} onClose={onClose} className="schedule-dialog" closeLabel="關閉對話框" placement={isDesktop ? "right" : "bottom"}>
    <div className="eyebrow">{block.source === "course" ? "課程詳細資訊" : "固定時段"}</div>
    {scheduledCourse && originalCourse ? <>
      {originalCourse.name_en && <p className="muted">{originalCourse.name_en}</p>}
      <div className="schedule-detail-meta"><span><strong>課號</strong>{originalCourse.ava_no || originalCourse.course_id}</span><span><strong>教師</strong>{originalCourse.teacher || "教師未定"}</span><span><strong>學分</strong>{originalCourse.credits ?? "未提供"}</span><span><strong>類別</strong>{originalCourse.required_elective_name || "未提供"}</span><span><strong>開課單位</strong>{originalCourse.official_department_label ?? originalCourse.department_display ?? originalCourse.department}</span></div>
      <section><h3>課表採用時間</h3><p>{formatMeetings(scheduledCourse)}</p>{scheduleEntry?.meetingsOverride && <><span className="manual-time-tag">手動指定</span><p className="muted">校方原始時間：{formatMeetings(originalCourse)}</p></>}</section>
      {(originalCourse.prerequisite || originalCourse.enrollment_note) && <section><h3>選課條件</h3>{originalCourse.prerequisite && <p><strong>先備條件：</strong>{originalCourse.prerequisite}</p>}{originalCourse.enrollment_note && <p><strong>選課備註：</strong>{originalCourse.enrollment_note}</p>}</section>}
      <section><h3>課程目標</h3><p className="schedule-objective">{originalCourse.sections.objective || "未提供"}</p></section>
      <a className="primary button-link schedule-outline-link" href={originalCourse.source_url} target="_blank" rel="noreferrer">開啟官方完整課綱</a>
    </> : <><p>{formatMeetings(fixedEntry ?? { meetings: [] })}</p><p><strong>說明：</strong>{fixedEntry?.source ?? "固定課表時段"}</p><p className="muted">固定時段不是課程，因此沒有官方課綱連結。</p></>}
  </SideDrawer>;
}
