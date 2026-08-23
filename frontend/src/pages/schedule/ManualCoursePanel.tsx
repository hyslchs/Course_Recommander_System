import { useEffect, useState } from "react";
import { useCourses } from "@/data/queries";
import { putRecord } from "@/data/db";
import { courseConflicts, meetingsConflict } from "@/domain/eligibility";
import { formatMeetings, parseManualSections, weekdayLabels } from "@/domain/schedule";
import { coursesInPlan } from "@/domain/scheduleUtils";
import { ConfirmDialog, useFeedback } from "@/components/ui";
import type { Course, ScheduleEntry, SchedulePlan } from "@/domain/types";

export function ManualCoursePanel({ catalog, plan }: { catalog: Course[]; plan: SchedulePlan }) {
  const [query, setQuery] = useState("");
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [useCustomTime, setUseCustomTime] = useState(false);
  const [customWeekday, setCustomWeekday] = useState(3);
  const [customSections, setCustomSections] = useState("D5,D6");
  const [adding, setAdding] = useState(false);
  const [pendingConflict, setPendingConflict] = useState<{ entry: ScheduleEntry; courseName: string; reason: string }>();
  // This panel used to own a third feedback channel — an inline `.notice`
  // paragraph whose role flipped between `alert` and `status`. It now goes
  // through the same queue as everything else (plan §6.3-3), which is also what
  // fixes the old failure mode: the message sat in the card, below the fold on
  // a phone, while the button that triggered it was on screen.
  const { notify } = useFeedback();
  const showMessage = (text: string, kind: "success" | "error") => notify(text, kind);
  const normalizedQuery = query.trim();
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(normalizedQuery), 250);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery]);
  const searchQuery = useCourses(debouncedQuery ? { q: debouncedQuery, page: 1, pageSize: 50 } : null);
  const courseOptions: Course[] = normalizedQuery ? (searchQuery.data?.items ?? []) : [];
  useEffect(() => {
    if (searchQuery.error) showMessage("搜尋課程失敗：" + (searchQuery.error as Error).message, "error");
  }, [searchQuery.error]);
  const selectedCourse = courseOptions.find((course) => course.course_id === selectedCourseId);
  const customTimeRequired = Boolean(selectedCourse && !selectedCourse.meetings.some((meeting) => meeting.weekday && meeting.sections.length));
  const customTimeActive = useCustomTime || customTimeRequired;

  const saveEntry = async (entry: ScheduleEntry, courseName: string, warning?: string) => {
    setAdding(true);
    try {
      await putRecord("schedulePlans", { ...plan, entries: [...plan.entries, entry], updatedAt: new Date().toISOString() });
      setSelectedCourseId("");
      setQuery("");
      setUseCustomTime(false);
      showMessage(warning ? warning + "你仍選擇加入，請再確認課表。" : "已加入「" + courseName + "」。", warning ? "error" : "success");
      setPendingConflict(undefined);
    } catch (error) {
      showMessage("加入課表失敗：" + (error as Error).message, "error");
    } finally {
      setAdding(false);
    }
  };
  const addCourse = async () => {
    if (!selectedCourse) return showMessage("請先搜尋並選擇要加入的課程。", "error");
    if (plan.entries.some((entry) => entry.courseId === selectedCourse.course_id)) return showMessage("這門課已經在目前課表中。", "error");
    let meetings = selectedCourse.meetings;
    if (customTimeActive) {
      const sections = parseManualSections(customSections);
      if (!sections.length) return showMessage("請輸入有效節次，例如 D5,D6 或 DN。", "error");
      meetings = [{ weekday: customWeekday, sections, room: null, week_pattern: "A" }];
    }
    if (!meetings.length) return showMessage("這門課沒有可用的上課時間，請使用指定時間加入。", "error");
    const entry: ScheduleEntry = { courseId: selectedCourse.course_id, locked: false, ...(customTimeActive ? { meetingsOverride: meetings } : {}) };
    const scheduledCourse = { ...selectedCourse, meetings };
    const courseConflict = courseConflicts(scheduledCourse, coursesInPlan(catalog, plan));
    const fixedConflict = meetingsConflict(meetings, (plan.fixedEntries ?? []).flatMap((item) => item.meetings));
    if (courseConflict.conflict || fixedConflict.conflict || courseConflict.uncertain || fixedConflict.uncertain) {
      const reason = courseConflict.conflict || fixedConflict.conflict ? "這門課與目前課表或固定時段衝堂。" : "這門課的週次資料不完整，可能與目前課表衝堂。";
      setPendingConflict({ entry, courseName: selectedCourse.name_zh, reason });
      return;
    }
    await saveEntry(entry, selectedCourse.name_zh);
  };
  return <section className="card schedule-add-card">
    <h2>手動加入課程</h2>
    <p>可搜尋學校分發的課程；加入後推薦會一併檢查衝堂。</p>
    <div className="schedule-add-grid">
      <label>搜尋課程<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="輸入課名、課號或教師，例如：國文" /></label>
      <label>選擇課程<select value={selectedCourseId} onChange={(event) => setSelectedCourseId(event.target.value)} disabled={!courseOptions.length}><option value="">{courseOptions.length ? "請選擇課程" : "請先輸入搜尋文字"}</option>{courseOptions.map((course) => <option key={course.course_id} value={course.course_id}>{course.name_zh}｜{course.ava_no}｜{formatMeetings(course)}</option>)}</select></label>
    </div>
    {selectedCourse && <>
      <p className="muted">課程資料時間：{formatMeetings(selectedCourse)}</p>
      <label className="check"><input type="checkbox" checked={customTimeActive} disabled={customTimeRequired} onChange={(event) => setUseCustomTime(event.target.checked)} />使用指定時間加入{customTimeRequired ? "（此課程沒有完整時間）" : ""}</label>
      {customTimeActive && <div className="schedule-add-grid"><label>星期<select value={customWeekday} onChange={(event) => setCustomWeekday(Number(event.target.value))}>{weekdayLabels.map((day, index) => <option key={index + 1} value={index + 1}>星期{day}</option>)}</select></label><label>節次<input value={customSections} onChange={(event) => setCustomSections(event.target.value)} placeholder="例如 D5,D6 或 DN" /></label></div>}
    </>}
    <button className="primary" type="button" onClick={() => void addCourse()} disabled={!selectedCourse || adding} aria-busy={adding}>{adding ? "加入中…" : "加入「" + plan.name + "」"}</button>
    <ConfirmDialog open={Boolean(pendingConflict)} title="確認加入衝堂課程" description={<p>{pendingConflict?.reason}仍要加入課表嗎？</p>} confirmLabel="仍要加入" busy={adding} onCancel={() => setPendingConflict(undefined)} onConfirm={() => pendingConflict && saveEntry(pendingConflict.entry, pendingConflict.courseName, pendingConflict.reason)} />
  </section>;
}
