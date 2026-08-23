import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Lock, MapPin, Sparkle, Warning } from "@phosphor-icons/react";
import { getCatalog, getEmbeddingBundle } from "@/data/api";
import { getAllRecords, putRecord } from "@/data/db";
import { courseConflicts, meetingsConflict } from "@/domain/eligibility";
import {
  buildScheduleBlocks,
  CORE_SCHEDULE_SECTIONS,
  EXTENDED_SCHEDULE_SECTIONS,
  formatMeetings,
  hasUnscheduledMeeting,
  SCHEDULE_SECTIONS,
  sectionGridSpan,
  unplacedBlock,
  weekdayLabels,
  weekPatternLabel,
  type ScheduleBlock,
} from "@/domain/schedule";
import { coursesInPlan } from "@/domain/scheduleUtils";
import { rankScheduleSlotCourses } from "@/domain/scheduleRecommendation";
import type { ScheduleSlotRecommendationResult } from "@/domain/scheduleRecommendation";
import { Modal, useFeedback } from "@/components/ui";
import type { CompletedCourse, Course, FixedScheduleEntry, Profile, RecommendationCategory, ScheduleEntry, SchedulePlan } from "@/domain/types";
import { CourseDetails } from "./CourseDetails";
import { ManualCoursePanel } from "./ManualCoursePanel";
import { SlotRecommendationDialog } from "./SlotRecommendationDialog";
import {
  scheduleRecommendationCategories,
  SlotRecommendationContext,
  type SelectedScheduleSlot,
  type SlotRecommendationContextValue,
} from "./SlotRecommendationContext";

interface LoadedSlotRecommendationData {
  catalog: Course[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
  completed: CompletedCourse[];
  dismissedIds: string[];
}

export function ScheduleWorkspace({ catalog, plans, active, profile, selectPlan }: { catalog: Course[]; plans: SchedulePlan[]; active?: SchedulePlan; profile?: Profile; selectPlan: (planId: string) => Promise<void> }) {
  const [viewMode, setViewMode] = useState<"auto" | "core" | "full">("auto");
  const [selectedBlock, setSelectedBlock] = useState<ScheduleBlock>();
  const [selectedSlot, setSelectedSlot] = useState<SelectedScheduleSlot>();
  const [slotRecommendation, setSlotRecommendation] = useState<ScheduleSlotRecommendationResult>();
  const [slotCategoryFilters, setSlotCategoryFilters] = useState<RecommendationCategory[]>([...scheduleRecommendationCategories]);
  const [loadedSlotRecommendationData, setLoadedSlotRecommendationData] = useState<LoadedSlotRecommendationData>();
  const [slotRecommendationLoading, setSlotRecommendationLoading] = useState(false);
  const [slotRecommendationError, setSlotRecommendationError] = useState("");
  const [addingRecommendedCourseId, setAddingRecommendedCourseId] = useState("");
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const slotRequestRef = useRef(0);
  const slotButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [activeSlotKey, setActiveSlotKey] = useState("");
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
  const occupiedSlotKeys = new Set(blocks.flatMap((block) => block.sections.map((section) => `${block.weekday}-${section}`)));
  const emptySlotKeys = visibleSections.flatMap((section) => visibleDays.map((day) => `${day}-${section}`)).filter((key) => !occupiedSlotKeys.has(key));
  const resolvedActiveSlotKey = emptySlotKeys.includes(activeSlotKey) ? activeSlotKey : (emptySlotKeys[0] ?? "");
  const mobileOpenSections = visibleSections.filter((section) => !occupiedSlotKeys.has(`${mobileDay}-${section}`));
  const gridStyle = { gridTemplateColumns: `72px repeat(${visibleDays.length}, minmax(150px, 1fr))`, gridTemplateRows: `44px repeat(${visibleSections.length}, 72px)` } satisfies CSSProperties;

  useEffect(() => { if (!visibleDays.includes(mobileDay)) setMobileDay(visibleDays[0]); }, [mobileDay, visibleDays]);
  useEffect(() => { if (resolvedActiveSlotKey !== activeSlotKey) setActiveSlotKey(resolvedActiveSlotKey); }, [activeSlotKey, resolvedActiveSlotKey]);

  const openDetails = (block: ScheduleBlock, trigger: HTMLButtonElement) => {
    detailTriggerRef.current = trigger;
    setSelectedBlock(block);
  };
  const closeDetails = useCallback(() => {
    setSelectedBlock(undefined);
    window.requestAnimationFrame(() => detailTriggerRef.current?.focus());
  }, []);

  const rankLoadedSlotRecommendations = (
    slot: SelectedScheduleSlot,
    data: LoadedSlotRecommendationData,
    categoryFilters: RecommendationCategory[],
  ) => rankScheduleSlotCourses({
    catalog: data.catalog,
    courseIds: data.courseIds,
    vectors: data.vectors,
    dimension: data.dimension,
    scheduledCourses: courses,
    fixedMeetings: fixedEntries.flatMap((entry) => entry.meetings),
    weekday: slot.weekday,
    section: slot.section,
    profile,
    completed: data.completed,
    dismissedIds: data.dismissedIds,
    categoryFilters,
  });

  const loadSlotRecommendations = async (
    slot: SelectedScheduleSlot,
    categoryFilters: RecommendationCategory[] = [...scheduleRecommendationCategories],
  ) => {
    setSelectedSlot(slot);
    setSlotCategoryFilters(categoryFilters);
    setSlotRecommendation(undefined);
    setLoadedSlotRecommendationData(undefined);
    setSlotRecommendationError("");
    setSlotRecommendationLoading(true);
    const requestId = ++slotRequestRef.current;
    try {
      const [fullCatalog, bundle, completed, dismissed] = await Promise.all([
        getCatalog(),
        getEmbeddingBundle(),
        getAllRecords<CompletedCourse & { id: string }>("completedCourses"),
        getAllRecords<{ id: string }>("dismissedCourses"),
      ]);
      if (requestId !== slotRequestRef.current) return;
      const loadedData: LoadedSlotRecommendationData = {
        catalog: fullCatalog,
        courseIds: bundle.index.course_ids,
        vectors: bundle.vectors,
        dimension: bundle.index.dimension,
        completed,
        dismissedIds: dismissed.map((item) => item.id),
      };
      setLoadedSlotRecommendationData(loadedData);
      setSlotRecommendation(rankLoadedSlotRecommendations(slot, loadedData, categoryFilters));
    } catch (error) {
      if (requestId === slotRequestRef.current) setSlotRecommendationError((error as Error).message || "無法讀取課程向量");
    } finally {
      if (requestId === slotRequestRef.current) setSlotRecommendationLoading(false);
    }
  };
  const closeSlotRecommendations = () => {
    slotRequestRef.current += 1;
    setSelectedSlot(undefined);
    setSlotRecommendation(undefined);
    setLoadedSlotRecommendationData(undefined);
    setSlotCategoryFilters([...scheduleRecommendationCategories]);
    setSlotRecommendationError("");
    setSlotRecommendationLoading(false);
  };
  const applySlotCategoryFilters = (categoryFilters: RecommendationCategory[]) => {
    setSlotCategoryFilters(categoryFilters);
    if (selectedSlot && loadedSlotRecommendationData) {
      setSlotRecommendation(rankLoadedSlotRecommendations(selectedSlot, loadedSlotRecommendationData, categoryFilters));
    }
  };
  const toggleSlotCategoryFilter = (category: RecommendationCategory) => {
    const categoryFilters = scheduleRecommendationCategories.filter((item) => (
      item === category ? !slotCategoryFilters.includes(item) : slotCategoryFilters.includes(item)
    ));
    applySlotCategoryFilters(categoryFilters);
  };
  const addRecommendedCourse = async (courseId: string) => {
    if (!active || addingRecommendedCourseId) return;
    const course = loadedSlotRecommendationData?.catalog.find((item) => item.course_id === courseId) ?? catalog.find((item) => item.course_id === courseId);
    if (!course) return;
    if (active.entries.some((entry) => entry.courseId === courseId)) {
      notify("這門課已經在目前課表中", "error");
      return;
    }
    const currentCourses = coursesInPlan(catalog, active);
    const courseConflict = courseConflicts(course, currentCourses);
    const fixedConflict = meetingsConflict(course.meetings, (active.fixedEntries ?? []).flatMap((entry) => entry.meetings));
    if (courseConflict.conflict || courseConflict.uncertain || fixedConflict.conflict || fixedConflict.uncertain) {
      notify("課表內容已變更，這門課目前無法安全排入。請重新產生推薦。", "error");
      if (selectedSlot) void loadSlotRecommendations(selectedSlot, slotCategoryFilters);
      return;
    }
    setAddingRecommendedCourseId(courseId);
    try {
      await putRecord("schedulePlans", { ...active, entries: [...active.entries, { courseId, locked: false }], updatedAt: new Date().toISOString() });
      notify(`已將「${course.name_zh}」加入「${active.name}」`);
      closeSlotRecommendations();
    } catch (error) {
      notify("加入課表失敗：" + (error as Error).message, "error");
    } finally {
      setAddingRecommendedCourseId("");
    }
  };
  const onSlotKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, dayIndex: number, sectionIndex: number) => {
    const direction = {
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    }[event.key] as [number, number] | undefined;
    let nextDayIndex = dayIndex;
    let nextSectionIndex = sectionIndex;
    if (event.key === "Home") nextDayIndex = 0;
    else if (event.key === "End") nextDayIndex = visibleDays.length - 1;
    else if (direction) {
      nextSectionIndex += direction[0];
      nextDayIndex += direction[1];
    } else return;
    event.preventDefault();
    while (nextDayIndex >= 0 && nextDayIndex < visibleDays.length && nextSectionIndex >= 0 && nextSectionIndex < visibleSections.length) {
      const key = `${visibleDays[nextDayIndex]}-${visibleSections[nextSectionIndex]}`;
      const target = slotButtonRefs.current.get(key);
      if (target) {
        setActiveSlotKey(key);
        target.focus();
        return;
      }
      if (event.key === "Home" || event.key === "End") nextDayIndex += event.key === "Home" ? 1 : -1;
      else {
        nextSectionIndex += direction![0];
        nextDayIndex += direction![1];
      }
    }
  };

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

  const slotRecommendationValue: SlotRecommendationContextValue = {
    slot: selectedSlot,
    result: slotRecommendation,
    loading: slotRecommendationLoading,
    error: slotRecommendationError,
    addingCourseId: addingRecommendedCourseId,
    categoryFilters: slotCategoryFilters,
    close: closeSlotRecommendations,
    retry: () => { if (selectedSlot) void loadSlotRecommendations(selectedSlot, slotCategoryFilters); },
    add: (courseId) => void addRecommendedCourse(courseId),
    toggleCategory: toggleSlotCategoryFilter,
    selectAllCategories: () => applySlotCategoryFilters([...scheduleRecommendationCategories]),
  };

  return <section className="page"><div className="page-heading"><div><div className="eyebrow">安排多個選課方案</div><h1>我的課表</h1></div><button className="primary" type="button" onClick={createPlan}>新增方案</button></div>
    <div className="plan-tabs" role="tablist" aria-label="課表方案">{plans.map((plan, index) => <button ref={(element) => { planTabRefs.current[index] = element; }} type="button" role="tab" id={"plan-tab-" + plan.id} aria-controls={"plan-panel-" + plan.id} aria-selected={plan.id === active?.id} tabIndex={plan.id === active?.id ? 0 : -1} className={plan.id === active?.id ? "active" : ""} onKeyDown={(event) => onPlanTabKeyDown(event, index)} onClick={() => void selectPlan(plan.id)} key={plan.id}>{plan.name}</button>)}</div>
    {/* `<h2>`, not `<h1>`: the page heading above already owns this route's single `<h1>` (plan R9). */}
    {!active ? <section className="empty-state"><h2 className="page-title">先建立一個課表方案</h2><p>建立課表後，你可以加入課程並檢查衝堂。</p><button className="primary" type="button" onClick={createPlan}>建立第一個方案</button></section> : <>
      <div id={"plan-panel-" + active.id} role="tabpanel" aria-labelledby={"plan-tab-" + active.id}><div className="schedule-plan-actions"><strong>目前方案：{active.name}</strong><button type="button" onClick={renamePlan}>重新命名</button><button onClick={() => void duplicatePlan()}>建立副本</button><button onClick={printSchedule}>列印／另存 PDF</button></div>
      <ManualCoursePanel catalog={catalog} plan={active} />
      <div className="schedule-summary"><strong>{courses.length} 門課</strong><span>{credits} 學分</span>{fixedEntries.length > 0 && <span>{fixedEntries.length} 個固定時段</span>}{conflictCount > 0 && <span className="schedule-conflict-summary"><Warning aria-hidden="true" />{conflictCount} 門課衝堂</span>}{unplacedCourses.length > 0 && <span>待安排 {unplacedCourses.length} 門</span>}</div>
      <div className="schedule-view-toolbar"><div><strong>點空白時段找適合的課</strong><span>系統會依目前課表推測興趣，並檢查課程的所有上課節次。</span></div><div className="segmented-control" role="group" aria-label="課表顯示範圍"><button className={viewMode === "auto" ? "active" : ""} aria-pressed={viewMode === "auto"} onClick={() => setViewMode("auto")}>智慧</button><button className={viewMode === "core" ? "active" : ""} aria-pressed={viewMode === "core"} onClick={() => setViewMode("core")}>核心時段{viewMode === "core" && hiddenSourceIds.size > 0 ? `（隱藏 ${hiddenSourceIds.size} 門）` : ""}</button><button className={viewMode === "full" ? "active" : ""} aria-pressed={viewMode === "full"} onClick={() => setViewMode("full")}>完整課表</button></div></div>
      {viewMode === "core" && hiddenSourceIds.size > 0 && <div className="notice schedule-hidden-notice">目前折疊範圍內有 {hiddenSourceIds.size} 門課。<button onClick={() => setViewMode("auto")}>顯示有課時段</button></div>}
      <div className="mobile-day-picker"><label>查看星期<select value={mobileDay} onChange={(event) => setMobileDay(Number(event.target.value))}>{visibleDays.map((day) => <option value={day} key={day}>星期{weekdayLabels[day - 1]}</option>)}</select></label></div>
      <div className="timetable" aria-label={`${active.name}課表`}><div className="schedule-grid" style={gridStyle} role="grid"><div className="schedule-corner" role="columnheader">節次</div>{visibleDays.map((day, dayIndex) => <div className="schedule-day-header" role="columnheader" key={day} style={{ gridColumn: dayIndex + 2, gridRow: 1 }}>星期{weekdayLabels[day - 1]}</div>)}{visibleSections.map((section, sectionIndex) => <div className={`schedule-section-label ${EXTENDED_SCHEDULE_SECTIONS.includes(section as typeof EXTENDED_SCHEDULE_SECTIONS[number]) ? "extended" : ""}`} role="rowheader" key={section} style={{ gridColumn: 1, gridRow: sectionIndex + 2 }}>{section}</div>)}{visibleSections.flatMap((section, sectionIndex) => visibleDays.map((day, dayIndex) => {
        const key = `${day}-${section}`;
        const occupied = occupiedSlotKeys.has(key);
        return <div className={`schedule-cell ${occupied ? "occupied" : ""}`} role="gridcell" aria-label={`星期${weekdayLabels[day - 1]} ${section}`} key={key} style={{ gridColumn: dayIndex + 2, gridRow: sectionIndex + 2 }}>{!occupied && <button ref={(element) => { if (element) slotButtonRefs.current.set(key, element); else slotButtonRefs.current.delete(key); }} type="button" className="schedule-slot-button" tabIndex={resolvedActiveSlotKey === key ? 0 : -1} aria-label={`推薦星期${weekdayLabels[day - 1]} ${section} 可以排入的課程`} onFocus={() => setActiveSlotKey(key)} onKeyDown={(event) => onSlotKeyDown(event, dayIndex, sectionIndex)} onClick={() => void loadSlotRecommendations({ weekday: day, section })}><Sparkle aria-hidden="true" /><span>找課</span></button>}</div>;
      }))}{blocks.map((block) => {
        const dayIndex = visibleDays.indexOf(block.weekday); const span = sectionGridSpan(block, visibleSections); if (dayIndex === -1 || !span) return null;
        const blockStyle = { gridColumn: dayIndex + 2, gridRow: `${span.start + 2} / span ${span.span}`, width: `calc(${100 / block.laneCount}% - 6px)`, marginLeft: `calc(${block.lane * 100 / block.laneCount}% + 3px)` } as CSSProperties;
        return <button type="button" className={`class-block ${block.source === "fixed" ? "fixed" : ""} ${block.conflict ? "conflict" : ""}`} style={blockStyle} data-course-name={block.name} key={block.id} onClick={(event) => openDetails(block, event.currentTarget)} aria-label={`${block.name}，星期${weekdayLabels[block.weekday - 1]} ${block.sections.join("到")}${block.conflict ? "，有衝堂" : ""}`}><strong>{block.name}</strong><small>{block.teacher}</small>{block.room && <small><MapPin aria-hidden="true" />{block.room}</small>}<span className="class-block-tags">{weekPatternLabel(block.weekPattern) && <em>{weekPatternLabel(block.weekPattern)}</em>}{block.conflict && <em className="conflict-tag"><Warning aria-hidden="true" />衝堂</em>}</span></button>;
      })}</div><div className="mobile-schedule-list">{!mobileBlocks.length && <p className="muted">星期{weekdayLabels[mobileDay - 1]}目前沒有課程。</p>}{mobileBlocks.map((block) => <button key={block.id} className={`mobile-schedule-block ${block.source === "fixed" ? "fixed" : ""} ${block.conflict ? "conflict" : ""}`} onClick={(event) => openDetails(block, event.currentTarget)}><span><strong>{block.sections.join("–")}　{block.name}</strong><small>{block.teacher}{block.room ? ` · ${block.room}` : ""}</small></span><span>{weekPatternLabel(block.weekPattern)}{block.conflict ? <Warning aria-label="有衝堂" /> : null}</span></button>)}<div className="mobile-open-slots"><strong>點空堂找課</strong><div>{mobileOpenSections.map((section) => <button type="button" key={section} onClick={() => void loadSlotRecommendations({ weekday: mobileDay, section })}><Sparkle aria-hidden="true" />{section}</button>)}</div></div></div></div>
      {unplacedCourses.length > 0 && <section className="unplaced-courses"><div><h2>時間未定／待安排</h2><p>這些課程不會被誤放進星期一；指定時間後才會出現在格狀課表。</p></div>{unplacedCourses.map((course) => <button key={course.course_id} onClick={(event) => openDetails(unplacedBlock(course), event.currentTarget)}><strong>{course.name_zh}</strong><span>{formatMeetings(course)}</span></button>)}</section>}
      {lastRemoved && <div className="undo-toast" role="status"><span>已從課表移除課程。</span><button onClick={() => void undoRemove()}>復原</button><button aria-label="關閉" onClick={() => setLastRemoved(undefined)}>×</button></div>}
      <div className="schedule-list">{fixedEntries.map((entry) => <div key={entry.id} className="fixed-schedule-entry"><span><strong>{entry.name}</strong><small>{formatMeetings(entry)} · {entry.teacher ?? "固定時段"}</small></span><span>固定時段</span></div>)}{courses.map((course) => { const entry = active.entries.find((item) => item.courseId === course.course_id)!; return <div key={course.course_id}><span><strong>{course.name_zh}{entry.meetingsOverride && <em className="manual-time-tag">手動時間</em>}</strong><small>{formatMeetings(course)}</small></span><button onClick={() => void toggleLock(course.course_id)}>{entry.locked ? <><Lock aria-hidden="true" />已鎖定</> : "鎖定"}</button><button onClick={() => void removeEntry(course.course_id)}>移除</button></div>; })}</div>
      {selectedBlock && <CourseDetails block={selectedBlock} catalog={catalog} scheduledCourses={courses} plan={active} onClose={closeDetails} />}
      <SlotRecommendationContext.Provider value={slotRecommendationValue}><SlotRecommendationDialog /></SlotRecommendationContext.Provider>
      </div>
    </>}
    <Modal open={Boolean(planDialog)} title={planDialog === "create" ? "建立課表方案" : "重新命名課表方案"} onClose={() => setPlanDialog("")} initialFocusRef={planNameRef}>
      <label htmlFor="plan-name"><strong>方案名稱</strong></label>
      <input ref={planNameRef} id="plan-name" value={planName} maxLength={80} onChange={(event) => setPlanName(event.target.value)} />
      <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setPlanDialog("")}>取消</button><button type="button" disabled={!planName.trim()} onClick={() => void savePlanName()}>儲存</button></div>
    </Modal>
  </section>;
}
