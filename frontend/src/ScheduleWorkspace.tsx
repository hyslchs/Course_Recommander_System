import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Lock, MapPin, Warning } from "@phosphor-icons/react";
import { putRecord } from "./db";
import { courseConflicts, meetingsConflict } from "./eligibility";
import {
  buildScheduleBlocks,
  CORE_SCHEDULE_SECTIONS,
  EXTENDED_SCHEDULE_SECTIONS,
  hasUnscheduledMeeting,
  SCHEDULE_SECTIONS,
  sectionGridSpan,
  type ScheduleBlock,
} from "./schedule";
import { coursesInPlan } from "./scheduleUtils";
import type { Course, FixedScheduleEntry, Meeting, ScheduleEntry, SchedulePlan } from "./types";
import { ConfirmDialog, Modal, useFeedback } from "./ui";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];

function weekPatternLabel(pattern: string | null): string {
  if (pattern?.toUpperCase() === "S") return "單週";
  if (pattern?.toUpperCase() === "D") return "雙週";
  return "";
}

export function formatMeetings(item: { meetings: Meeting[] }): string {
  if (!item.meetings.length) return "時間未定";
  return item.meetings.map((meeting) => {
    const day = meeting.weekday && meeting.weekday >= 1 && meeting.weekday <= 7
      ? `星期${weekdays[meeting.weekday - 1]}` : "星期未定";
    const sections = meeting.sections.length ? meeting.sections.join("、") : "節次未定";
    const details = [meeting.room, weekPatternLabel(meeting.week_pattern)].filter(Boolean).join(" · ");
    return `${day} ${sections}${details ? ` ${details}` : ""}`;
  }).join("；");
}

function parseManualSections(value: string): string[] {
  return [...new Set(
    value
      .toUpperCase()
      .split(/[,\s、，；;]+/)
      .map((section) => section.trim())
      .filter((section) => /^(?:D(?:N|[0-8])|E[0-4])$/.test(section)),
  )];
}

function ManualCoursePanel({ catalog, plan }: { catalog: Course[]; plan: SchedulePlan }) {
  const [query, setQuery] = useState("");
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [useCustomTime, setUseCustomTime] = useState(false);
  const [customWeekday, setCustomWeekday] = useState(3);
  const [customSections, setCustomSections] = useState("D5,D6");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const [adding, setAdding] = useState(false);
  const [pendingConflict, setPendingConflict] = useState<{ entry: ScheduleEntry; courseName: string; reason: string }>();
  const showMessage = (text: string, kind: "success" | "error") => { setMessage(text); setMessageKind(kind); };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const courseOptions = useMemo(() => {
    if (!normalizedQuery) return [];
    return catalog
      .filter((course) => [course.name_zh, course.name_en, course.ava_no, course.course_id, course.teacher, course.department]
        .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)))
      .sort((left, right) => left.name_zh.localeCompare(right.name_zh, "zh-Hant") || left.course_id.localeCompare(right.course_id))
      .slice(0, 50);
  }, [catalog, normalizedQuery]);
  const selectedCourse = catalog.find((course) => course.course_id === selectedCourseId);
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
    setMessage("");
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
      {customTimeActive && <div className="schedule-add-grid"><label>星期<select value={customWeekday} onChange={(event) => setCustomWeekday(Number(event.target.value))}>{weekdays.map((day, index) => <option key={index + 1} value={index + 1}>星期{day}</option>)}</select></label><label>節次<input value={customSections} onChange={(event) => setCustomSections(event.target.value)} placeholder="例如 D5,D6 或 DN" /></label></div>}
    </>}
    {message && <p className={"notice " + (messageKind === "error" ? "danger" : "")} role={messageKind === "error" ? "alert" : "status"}>{message}</p>}
    <button className="primary" type="button" onClick={() => void addCourse()} disabled={!selectedCourse || adding} aria-busy={adding}>{adding ? "加入中…" : "加入「" + plan.name + "」"}</button>
    <ConfirmDialog open={Boolean(pendingConflict)} title="確認加入衝堂課程" description={<p>{pendingConflict?.reason}仍要加入課表嗎？</p>} confirmLabel="仍要加入" busy={adding} onCancel={() => setPendingConflict(undefined)} onConfirm={() => pendingConflict && saveEntry(pendingConflict.entry, pendingConflict.courseName, pendingConflict.reason)} />
  </section>;
}

function CourseDetails({ block, catalog, scheduledCourses, plan, onClose }: { block: ScheduleBlock; catalog: Course[]; scheduledCourses: Course[]; plan: SchedulePlan; onClose: () => void }) {
  const scheduledCourse = block.source === "course" ? scheduledCourses.find((course) => course.course_id === block.sourceId) : undefined;
  const originalCourse = block.source === "course" ? catalog.find((course) => course.course_id === block.sourceId) : undefined;
  const scheduleEntry = block.source === "course" ? plan.entries.find((entry) => entry.courseId === block.sourceId) : undefined;
  const fixedEntry = block.source === "fixed" ? plan.fixedEntries?.find((entry) => entry.id === block.sourceId) : undefined;
  return <Modal open title={scheduledCourse?.name_zh ?? fixedEntry?.name ?? block.name} onClose={onClose} className="schedule-dialog">
    <div className="eyebrow">{block.source === "course" ? "課程詳細資訊" : "固定時段"}</div>
    {scheduledCourse && originalCourse ? <>
      {originalCourse.name_en && <p className="muted">{originalCourse.name_en}</p>}
      <div className="schedule-detail-meta"><span><strong>課號</strong>{originalCourse.ava_no || originalCourse.course_id}</span><span><strong>教師</strong>{originalCourse.teacher || "教師未定"}</span><span><strong>學分</strong>{originalCourse.credits ?? "未提供"}</span><span><strong>類別</strong>{originalCourse.required_elective_name || "未提供"}</span><span><strong>開課單位</strong>{originalCourse.official_department_label ?? originalCourse.department_display ?? originalCourse.department}</span></div>
      <section><h3>課表採用時間</h3><p>{formatMeetings(scheduledCourse)}</p>{scheduleEntry?.meetingsOverride && <><span className="manual-time-tag">手動指定</span><p className="muted">校方原始時間：{formatMeetings(originalCourse)}</p></>}</section>
      {(originalCourse.prerequisite || originalCourse.enrollment_note) && <section><h3>選課條件</h3>{originalCourse.prerequisite && <p><strong>先備條件：</strong>{originalCourse.prerequisite}</p>}{originalCourse.enrollment_note && <p><strong>選課備註：</strong>{originalCourse.enrollment_note}</p>}</section>}
      <section><h3>課程目標</h3><p className="schedule-objective">{originalCourse.sections.objective || "未提供"}</p></section>
      <a className="primary button-link schedule-outline-link" href={originalCourse.source_url} target="_blank" rel="noreferrer">開啟官方完整課綱</a>
    </> : <><p>{formatMeetings(fixedEntry ?? { meetings: [] })}</p><p><strong>說明：</strong>{fixedEntry?.source ?? "固定課表時段"}</p><p className="muted">固定時段不是課程，因此沒有官方課綱連結。</p></>}
  </Modal>;
}

function unplacedBlock(course: Course): ScheduleBlock {
  return { id: `unplaced-${course.course_id}`, source: "course", sourceId: course.course_id, name: course.name_zh, teacher: course.teacher || "教師未定", weekday: 1, sections: [], startSection: "D1", endSection: "D1", room: null, weekPattern: null, meetingIndex: 0, lane: 0, laneCount: 1, conflict: false };
}

export function ScheduleWorkspace({ catalog, plans, active, selectPlan }: { catalog: Course[]; plans: SchedulePlan[]; active?: SchedulePlan; selectPlan: (planId: string) => Promise<void> }) {
  const [viewMode, setViewMode] = useState<"auto" | "core" | "full">("auto");
  const [selectedBlock, setSelectedBlock] = useState<ScheduleBlock>();
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [mobileDay, setMobileDay] = useState(1);
  const [lastRemoved, setLastRemoved] = useState<{ planId: string; entry: ScheduleEntry }>();
  const [planDialog, setPlanDialog] = useState<"create" | "rename" | "">("");
  const [planName, setPlanName] = useState("");
  const planNameRef = useRef<HTMLInputElement>(null);
  const planTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { notify } = useFeedback();
  const courses = coursesInPlan(catalog, active);
  const fixedEntries: FixedScheduleEntry[] = active?.fixedEntries ?? [];
  const blocks = buildScheduleBlocks(courses, fixedEntries);
  const hasWeekendCourse = blocks.some((block) => block.weekday > 5);
  const hasExtendedCourse = blocks.some((block) => block.sections.some((section) => EXTENDED_SCHEDULE_SECTIONS.includes(section as typeof EXTENDED_SCHEDULE_SECTIONS[number])));
  const visibleDays = viewMode === "full" || (viewMode === "auto" && hasWeekendCourse) ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
  const visibleSections: readonly string[] = viewMode === "full" || (viewMode === "auto" && hasExtendedCourse) ? SCHEDULE_SECTIONS : CORE_SCHEDULE_SECTIONS;
  const hiddenSourceIds = new Set(blocks.filter((block) => !visibleDays.includes(block.weekday) || block.sections.some((section) => !visibleSections.includes(section))).map((block) => block.sourceId));
  const conflictCount = new Set(blocks.filter((block) => block.conflict).map((block) => block.sourceId)).size;
  const unplacedCourses = courses.filter(hasUnscheduledMeeting);
  const credits = courses.reduce((sum, course) => sum + (course.credits ?? 0), 0);
  const mobileBlocks = blocks.filter((block) => block.weekday === mobileDay && sectionGridSpan(block, visibleSections));
  const gridStyle = { gridTemplateColumns: `72px repeat(${visibleDays.length}, minmax(150px, 1fr))`, gridTemplateRows: `44px repeat(${visibleSections.length}, 72px)` } satisfies CSSProperties;

  useEffect(() => { if (!visibleDays.includes(mobileDay)) setMobileDay(visibleDays[0]); }, [mobileDay, visibleDays]);

  const openDetails = (block: ScheduleBlock, trigger: HTMLButtonElement) => {
    detailTriggerRef.current = trigger;
    setSelectedBlock(block);
  };
  const closeDetails = useCallback(() => {
    setSelectedBlock(undefined);
    window.requestAnimationFrame(() => detailTriggerRef.current?.focus());
  }, []);

  const createPlan = () => {
    setPlanName("方案 " + (plans.length + 1));
    setPlanDialog("create");
  };
  const renamePlan = () => {
    if (!active) return;
    setPlanName(active.name);
    setPlanDialog("rename");
  };
  const savePlanName = async () => {
    const name = planName.trim();
    if (!name) return;
    if (planDialog === "create") {
      const now = new Date().toISOString();
      const plan: SchedulePlan = { id: crypto.randomUUID(), name, entries: [], createdAt: now, updatedAt: now };
      await putRecord("schedulePlans", plan);
      await selectPlan(plan.id);
      notify("已建立課表方案「" + name + "」");
    } else if (active && name !== active.name) {
      await putRecord("schedulePlans", { ...active, name, updatedAt: new Date().toISOString() });
      notify("課表方案已重新命名");
    }
    setPlanDialog("");
  };
  const onPlanTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !plans.length) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? plans.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + plans.length) % plans.length;
    const next = plans[nextIndex];
    planTabRefs.current[nextIndex]?.focus();
    void selectPlan(next.id);
  };
  const duplicatePlan = async () => {
    if (!active) return;
    const now = new Date().toISOString();
    const plan: SchedulePlan = { ...active, id: crypto.randomUUID(), name: `${active.name}（副本）`, entries: active.entries.map((entry) => ({ ...entry, meetingsOverride: entry.meetingsOverride?.map((meeting) => ({ ...meeting, sections: [...meeting.sections] })) })), fixedEntries: active.fixedEntries?.map((entry) => ({ ...entry, meetings: entry.meetings.map((meeting) => ({ ...meeting, sections: [...meeting.sections] })) })), createdAt: now, updatedAt: now };
    await putRecord("schedulePlans", plan);
    await selectPlan(plan.id);
  };
  const printSchedule = () => {
    setViewMode("full");
    window.setTimeout(() => window.print(), 0);
  };
  const toggleLock = async (courseId: string) => {
    if (!active) return;
    await putRecord("schedulePlans", { ...active, entries: active.entries.map((item) => item.courseId === courseId ? { ...item, locked: !item.locked } : item), updatedAt: new Date().toISOString() });
  };
  const removeEntry = async (courseId: string) => {
    if (!active) return;
    const entry = active.entries.find((item) => item.courseId === courseId);
    if (!entry) return;
    await putRecord("schedulePlans", { ...active, entries: active.entries.filter((item) => item.courseId !== courseId), updatedAt: new Date().toISOString() });
    setLastRemoved({ planId: active.id, entry });
    if (selectedBlock?.sourceId === courseId) {
      detailTriggerRef.current = null;
      setSelectedBlock(undefined);
    }
  };
  const undoRemove = async () => {
    if (!lastRemoved) return;
    const plan = plans.find((item) => item.id === lastRemoved.planId);
    if (plan && !plan.entries.some((item) => item.courseId === lastRemoved.entry.courseId)) await putRecord("schedulePlans", { ...plan, entries: [...plan.entries, lastRemoved.entry], updatedAt: new Date().toISOString() });
    setLastRemoved(undefined);
  };

  return <section className="page"><div className="page-heading"><div><div className="eyebrow">安排多個選課方案</div><h1>我的課表</h1></div><button className="primary" type="button" onClick={createPlan}>新增方案</button></div>
    <div className="plan-tabs" role="tablist" aria-label="課表方案">{plans.map((plan, index) => <button ref={(element) => { planTabRefs.current[index] = element; }} type="button" role="tab" id={"plan-tab-" + plan.id} aria-controls={"plan-panel-" + plan.id} aria-selected={plan.id === active?.id} tabIndex={plan.id === active?.id ? 0 : -1} className={plan.id === active?.id ? "active" : ""} onKeyDown={(event) => onPlanTabKeyDown(event, index)} onClick={() => void selectPlan(plan.id)} key={plan.id}>{plan.name}</button>)}</div>
    {!active ? <section className="empty-state"><h1>先建立一個課表方案</h1><p>建立課表後，你可以加入課程並檢查衝堂。</p><button className="primary" type="button" onClick={createPlan}>建立第一個方案</button></section> : <>
      <div id={"plan-panel-" + active.id} role="tabpanel" aria-labelledby={"plan-tab-" + active.id}><div className="schedule-plan-actions"><strong>目前方案：{active.name}</strong><button type="button" onClick={renamePlan}>重新命名</button><button onClick={() => void duplicatePlan()}>建立副本</button><button onClick={printSchedule}>列印／另存 PDF</button></div>
      <ManualCoursePanel catalog={catalog} plan={active} />
      <div className="schedule-summary"><strong>{courses.length} 門課</strong><span>{credits} 學分</span>{fixedEntries.length > 0 && <span>{fixedEntries.length} 個固定時段</span>}{conflictCount > 0 && <span className="schedule-conflict-summary"><Warning aria-hidden="true" />{conflictCount} 門課衝堂</span>}{unplacedCourses.length > 0 && <span>待安排 {unplacedCourses.length} 門</span>}</div>
      <div className="schedule-view-toolbar"><div><strong>顯示範圍</strong><span>智慧模式會在有課時自動展開週末與延伸節次。</span></div><div className="segmented-control" role="group" aria-label="課表顯示範圍"><button className={viewMode === "auto" ? "active" : ""} aria-pressed={viewMode === "auto"} onClick={() => setViewMode("auto")}>智慧</button><button className={viewMode === "core" ? "active" : ""} aria-pressed={viewMode === "core"} onClick={() => setViewMode("core")}>核心時段{viewMode === "core" && hiddenSourceIds.size > 0 ? `（隱藏 ${hiddenSourceIds.size} 門）` : ""}</button><button className={viewMode === "full" ? "active" : ""} aria-pressed={viewMode === "full"} onClick={() => setViewMode("full")}>完整課表</button></div></div>
      {viewMode === "core" && hiddenSourceIds.size > 0 && <div className="notice schedule-hidden-notice">目前折疊範圍內有 {hiddenSourceIds.size} 門課。<button onClick={() => setViewMode("auto")}>顯示有課時段</button></div>}
      <div className="mobile-day-picker"><label>查看星期<select value={mobileDay} onChange={(event) => setMobileDay(Number(event.target.value))}>{visibleDays.map((day) => <option value={day} key={day}>星期{weekdays[day - 1]}</option>)}</select></label></div>
      <div className="timetable" aria-label={`${active.name}課表`}><div className="schedule-grid" style={gridStyle} role="grid"><div className="schedule-corner" role="columnheader">節次</div>{visibleDays.map((day, dayIndex) => <div className="schedule-day-header" role="columnheader" key={day} style={{ gridColumn: dayIndex + 2, gridRow: 1 }}>星期{weekdays[day - 1]}</div>)}{visibleSections.map((section, sectionIndex) => <div className={`schedule-section-label ${EXTENDED_SCHEDULE_SECTIONS.includes(section as typeof EXTENDED_SCHEDULE_SECTIONS[number]) ? "extended" : ""}`} role="rowheader" key={section} style={{ gridColumn: 1, gridRow: sectionIndex + 2 }}>{section}</div>)}{visibleSections.flatMap((section, sectionIndex) => visibleDays.map((day, dayIndex) => <div className="schedule-cell" role="gridcell" aria-label={`星期${weekdays[day - 1]} ${section}`} key={`${day}-${section}`} style={{ gridColumn: dayIndex + 2, gridRow: sectionIndex + 2 }} />))}{blocks.map((block) => {
        const dayIndex = visibleDays.indexOf(block.weekday); const span = sectionGridSpan(block, visibleSections); if (dayIndex === -1 || !span) return null;
        const blockStyle = { gridColumn: dayIndex + 2, gridRow: `${span.start + 2} / span ${span.span}`, width: `calc(${100 / block.laneCount}% - 6px)`, marginLeft: `calc(${block.lane * 100 / block.laneCount}% + 3px)` } as CSSProperties;
        return <button type="button" className={`class-block ${block.source === "fixed" ? "fixed" : ""} ${block.conflict ? "conflict" : ""}`} style={blockStyle} data-course-name={block.name} key={block.id} onClick={(event) => openDetails(block, event.currentTarget)} aria-label={`${block.name}，星期${weekdays[block.weekday - 1]} ${block.sections.join("到")}${block.conflict ? "，有衝堂" : ""}`}><strong>{block.name}</strong><small>{block.teacher}</small>{block.room && <small><MapPin aria-hidden="true" />{block.room}</small>}<span className="class-block-tags">{weekPatternLabel(block.weekPattern) && <em>{weekPatternLabel(block.weekPattern)}</em>}{block.conflict && <em className="conflict-tag"><Warning aria-hidden="true" />衝堂</em>}</span></button>;
      })}</div><div className="mobile-schedule-list">{!mobileBlocks.length && <p className="muted">星期{weekdays[mobileDay - 1]}目前沒有課程。</p>}{mobileBlocks.map((block) => <button key={block.id} className={`mobile-schedule-block ${block.source === "fixed" ? "fixed" : ""} ${block.conflict ? "conflict" : ""}`} onClick={(event) => openDetails(block, event.currentTarget)}><span><strong>{block.sections.join("–")}　{block.name}</strong><small>{block.teacher}{block.room ? ` · ${block.room}` : ""}</small></span><span>{weekPatternLabel(block.weekPattern)}{block.conflict ? <Warning aria-label="有衝堂" /> : null}</span></button>)}</div></div>
      {unplacedCourses.length > 0 && <section className="unplaced-courses"><div><h2>時間未定／待安排</h2><p>這些課程不會被誤放進星期一；指定時間後才會出現在格狀課表。</p></div>{unplacedCourses.map((course) => <button key={course.course_id} onClick={(event) => openDetails(unplacedBlock(course), event.currentTarget)}><strong>{course.name_zh}</strong><span>{formatMeetings(course)}</span></button>)}</section>}
      {lastRemoved && <div className="undo-toast" role="status"><span>已從課表移除課程。</span><button onClick={() => void undoRemove()}>復原</button><button aria-label="關閉" onClick={() => setLastRemoved(undefined)}>×</button></div>}
      <div className="schedule-list">{fixedEntries.map((entry) => <div key={entry.id} className="fixed-schedule-entry"><span><strong>{entry.name}</strong><small>{formatMeetings(entry)} · {entry.teacher ?? "固定時段"}</small></span><span>固定時段</span></div>)}{courses.map((course) => { const entry = active.entries.find((item) => item.courseId === course.course_id)!; return <div key={course.course_id}><span><strong>{course.name_zh}{entry.meetingsOverride && <em className="manual-time-tag">手動時間</em>}</strong><small>{formatMeetings(course)}</small></span><button onClick={() => void toggleLock(course.course_id)}>{entry.locked ? <><Lock aria-hidden="true" />已鎖定</> : "鎖定"}</button><button onClick={() => void removeEntry(course.course_id)}>移除</button></div>; })}</div>
      {selectedBlock && <CourseDetails block={selectedBlock} catalog={catalog} scheduledCourses={courses} plan={active} onClose={closeDetails} />}
      </div>
    </>}
    <Modal open={Boolean(planDialog)} title={planDialog === "create" ? "建立課表方案" : "重新命名課表方案"} onClose={() => setPlanDialog("")} initialFocusRef={planNameRef}>
      <label htmlFor="plan-name"><strong>方案名稱</strong></label>
      <input ref={planNameRef} id="plan-name" value={planName} maxLength={80} onChange={(event) => setPlanName(event.target.value)} />
      <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setPlanDialog("")}>取消</button><button type="button" disabled={!planName.trim()} onClick={() => void savePlanName()}>儲存</button></div>
    </Modal>
  </section>;
}
