import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Lock, Sparkle, Warning } from "@phosphor-icons/react";
import { Button, Tabs, ToggleButton, ToggleButtonGroup, Toolbar } from "@heroui/react";
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
  type ScheduleBlock,
} from "@/domain/schedule";
import { coursesInPlan } from "@/domain/scheduleUtils";
import { rankScheduleSlotCourses } from "@/domain/scheduleRecommendation";
import type { ScheduleSlotRecommendationResult } from "@/domain/scheduleRecommendation";
import { useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { Modal, StateAlert, useFeedback } from "@/components/ui";
import type { CompletedCourse, Course, FixedScheduleEntry, RecommendationCategory, ScheduleEntry, SchedulePlan } from "@/domain/types";
import { ClassBlock } from "./ClassBlock";
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

export function ScheduleWorkspace({ catalog }: { catalog: Course[] }) {
  // Plans and profile come from context, not props (plan §6.3-2). `catalog` stays
  // a prop: it is the schedule route's own fetch, not shared app state.
  const { plans, activePlan: active, selectPlan } = useSchedulePlans();
  const profile = useProfile();
  // The undo action now outlives the render that queued it (it lives in the
  // toast queue, not in component state), so it has to read the current plans
  // rather than the ones captured when the course was removed.
  const plansRef = useRef(plans);
  plansRef.current = plans;
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
  // Kept deliberately (plan §6.4): this monotonic request id is already a correct
  // stale-response guard, and the three sources it awaits — `getCatalog`,
  // `getEmbeddingBundle` and IndexedDB — are all outside the Query cache, so there
  // is nothing for Query to guard here.
  const slotRequestRef = useRef(0);
  const slotButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [activeSlotKey, setActiveSlotKey] = useState("");
  const [mobileDay, setMobileDay] = useState(1);
  const [planDialog, setPlanDialog] = useState<"create" | "rename" | "">("");
  const [planName, setPlanName] = useState("");
  const planNameRef = useRef<HTMLInputElement>(null);
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
    // Was a bespoke `.undo-toast` rendered next to the timetable. It is now the
    // one shared queue (plan §6.3-3), which also gets it the 6s timeout and the
    // politeness mapping for free.
    notify("已從課表移除課程。", "success", { label: "復原", onAction: () => undoRemove({ planId: active.id, entry }) });
    if (selectedBlock?.sourceId === courseId) {
      detailTriggerRef.current = null;
      setSelectedBlock(undefined);
    }
  };
  const undoRemove = async (removed: { planId: string; entry: ScheduleEntry }) => {
    const plan = plansRef.current.find((item) => item.id === removed.planId);
    if (plan && !plan.entries.some((item) => item.courseId === removed.entry.courseId)) await putRecord("schedulePlans", { ...plan, entries: [...plan.entries, removed.entry], updatedAt: new Date().toISOString() });
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

  return <section className="page" data-page="schedule"><div className="page-heading"><div><div className="eyebrow">安排多個選課方案</div><h1>我的課表</h1></div><button className="primary" type="button" onClick={createPlan}>新增方案</button></div>
    {/* `<h2>`, not `<h1>`: the page heading above already owns this route's single `<h1>` (plan R9). */}
    {!active ? <section className="empty-state"><h2 className="page-title">先建立一個課表方案</h2><p>建立課表後，你可以加入課程並檢查衝堂。</p><button className="primary" type="button" onClick={createPlan}>建立第一個方案</button></section> :
      /* The hand-rolled tablist (a `role="tablist"` div, manual `aria-selected`,
         manual `tabIndex` and an `onPlanTabKeyDown` that re-implemented
         Arrow/Home/End) is gone: React Aria's `Tabs` owns the roving tabindex,
         the tab/panel wiring and the automatic activation. Only the selected
         plan's panel is rendered, which is exactly what `Tabs.Panel` mounts. */
      <Tabs selectedKey={active.id} onSelectionChange={(key) => void selectPlan(String(key))}>
      <Tabs.ListContainer><Tabs.List aria-label="課表方案" className="schedule-plan-tabs">{plans.map((plan) => <Tabs.Tab id={plan.id} key={plan.id}>{plan.name}<Tabs.Indicator /></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer>
      <Tabs.Panel id={active.id}>
      <Toolbar aria-label="課表方案操作" className="schedule-plan-actions"><strong>目前方案：{active.name}</strong><Button variant="secondary" onPress={renamePlan}>重新命名</Button><Button variant="secondary" onPress={() => void duplicatePlan()}>建立副本</Button><Button variant="secondary" onPress={printSchedule}>列印／另存 PDF</Button></Toolbar>
      <ManualCoursePanel catalog={catalog} plan={active} />
      <div className="schedule-summary"><strong>{courses.length} 門課</strong><span>{credits} 學分</span>{fixedEntries.length > 0 && <span>{fixedEntries.length} 個固定時段</span>}</div>
      {/* Was a `.schedule-conflict-summary` span wedged into the count strip, i.e.
          a warning that looked like a statistic and was announced as one. */}
      {conflictCount > 0 && <StateAlert className="schedule-conflict-alert" live="polite" title="課表有衝堂" tone="danger">{conflictCount} 門課的上課時間互相重疊，格線上以紅色斜線標示。</StateAlert>}
      <Toolbar aria-label="課表顯示設定" className="schedule-view-toolbar"><div><strong>點空白時段找適合的課</strong><span>系統會依目前課表推測興趣，並檢查課程的所有上課節次。</span></div>
        {/* `selectionMode="single"` makes React Aria emit `radiogroup`/`radio` +
            `aria-checked` instead of the old `group` + `aria-pressed`. That is the
            APG pattern for a mutually exclusive segmented control and is why the
            workspace test now queries by those roles. */}
        <ToggleButtonGroup aria-label="課表顯示範圍" className="segmented-control" disallowEmptySelection selectedKeys={[viewMode]} selectionMode="single" onSelectionChange={(keys) => { const next = [...keys][0]; if (next) setViewMode(next as typeof viewMode); }}>
          <ToggleButton id="auto">智慧</ToggleButton>
          <ToggleButton id="core">核心時段{viewMode === "core" && hiddenSourceIds.size > 0 ? `（隱藏 ${hiddenSourceIds.size} 門）` : ""}</ToggleButton>
          <ToggleButton id="full">完整課表</ToggleButton>
        </ToggleButtonGroup></Toolbar>
      {viewMode === "core" && hiddenSourceIds.size > 0 && <StateAlert action={<Button className="mt-2 min-h-11" variant="secondary" onPress={() => setViewMode("auto")}>顯示有課時段</Button>} className="schedule-hidden-notice" tone="info">目前折疊範圍內有 {hiddenSourceIds.size} 門課。</StateAlert>}
      <div className="mobile-day-picker"><strong id="mobile-day-picker-label">查看星期</strong><ToggleButtonGroup aria-labelledby="mobile-day-picker-label" disallowEmptySelection fullWidth selectedKeys={[String(mobileDay)]} selectionMode="single" onSelectionChange={(keys) => { const next = [...keys][0]; if (next) setMobileDay(Number(next)); }}>{visibleDays.map((day) => <ToggleButton aria-label={`星期${weekdayLabels[day - 1]}`} id={String(day)} key={day}>{weekdayLabels[day - 1]}</ToggleButton>)}</ToggleButtonGroup></div>
      {/* `aria-rowcount`/`aria-colcount` count the header row and the section-label
          column, so the indices below are 1-based over the whole grid. They sit on
          the four `grid`-family roles only; the class blocks are absolutely placed
          siblings rather than gridcells, and `aria-rowindex` is not valid on a
          `button`. */}
      <div className="timetable" aria-label={`${active.name}課表`}><div className="schedule-grid" style={gridStyle} role="grid" aria-colcount={visibleDays.length + 1} aria-rowcount={visibleSections.length + 1}><div className="schedule-corner" role="columnheader" aria-colindex={1} aria-rowindex={1}>節次</div>{visibleDays.map((day, dayIndex) => <div className="schedule-day-header" role="columnheader" aria-colindex={dayIndex + 2} aria-rowindex={1} key={day} style={{ gridColumn: dayIndex + 2, gridRow: 1 }}>星期{weekdayLabels[day - 1]}</div>)}{visibleSections.map((section, sectionIndex) => <div className={`schedule-section-label ${EXTENDED_SCHEDULE_SECTIONS.includes(section as typeof EXTENDED_SCHEDULE_SECTIONS[number]) ? "extended" : ""}`} role="rowheader" aria-colindex={1} aria-rowindex={sectionIndex + 2} key={section} style={{ gridColumn: 1, gridRow: sectionIndex + 2 }}>{section}</div>)}{visibleSections.flatMap((section, sectionIndex) => visibleDays.map((day, dayIndex) => {
        const key = `${day}-${section}`;
        const occupied = occupiedSlotKeys.has(key);
        return <div className={`schedule-cell ${occupied ? "occupied" : ""}`} role="gridcell" aria-colindex={dayIndex + 2} aria-label={`星期${weekdayLabels[day - 1]} ${section}`} aria-rowindex={sectionIndex + 2} key={key} style={{ gridColumn: dayIndex + 2, gridRow: sectionIndex + 2 }}>{!occupied && <button ref={(element) => { if (element) slotButtonRefs.current.set(key, element); else slotButtonRefs.current.delete(key); }} type="button" className="schedule-slot-button" tabIndex={resolvedActiveSlotKey === key ? 0 : -1} aria-label={`推薦星期${weekdayLabels[day - 1]} ${section} 可以排入的課程`} onFocus={() => setActiveSlotKey(key)} onKeyDown={(event) => onSlotKeyDown(event, dayIndex, sectionIndex)} onClick={() => void loadSlotRecommendations({ weekday: day, section })}><Sparkle aria-hidden="true" /><span>找課</span></button>}</div>;
      }))}{blocks.map((block) => {
        const dayIndex = visibleDays.indexOf(block.weekday); const span = sectionGridSpan(block, visibleSections); if (dayIndex === -1 || !span) return null;
        const blockStyle = { gridColumn: dayIndex + 2, gridRow: `${span.start + 2} / span ${span.span}`, width: `calc(${100 / block.laneCount}% - 6px)`, marginLeft: `calc(${block.lane * 100 / block.laneCount}% + 3px)` } as CSSProperties;
        return <ClassBlock block={block} key={block.id} style={blockStyle} variant="grid" onSelect={openDetails} />;
      })}</div><div className="mobile-schedule-list">{!mobileBlocks.length && <p className="muted">星期{weekdayLabels[mobileDay - 1]}目前沒有課程。</p>}{mobileBlocks.map((block) => <ClassBlock block={block} key={block.id} variant="list" onSelect={openDetails} />)}<div className="mobile-open-slots"><strong>點空堂找課</strong><div>{mobileOpenSections.map((section) => <button type="button" key={section} onClick={() => void loadSlotRecommendations({ weekday: mobileDay, section })}><Sparkle aria-hidden="true" />{section}</button>)}</div></div></div></div>
      {unplacedCourses.length > 0 && <section className="unplaced-courses"><h2>時間未定／待安排</h2><StateAlert live="polite" tone="warning">{unplacedCourses.length} 門課的上課時間未定。它們不會被誤放進星期一，指定時間後才會出現在格狀課表。</StateAlert>{unplacedCourses.map((course) => <button key={course.course_id} onClick={(event) => openDetails(unplacedBlock(course), event.currentTarget)}><strong>{course.name_zh}</strong><span>{formatMeetings(course)}</span></button>)}</section>}
      <div className="schedule-list">{fixedEntries.map((entry) => <div key={entry.id} className="fixed-schedule-entry"><span><strong>{entry.name}</strong><small>{formatMeetings(entry)} · {entry.teacher ?? "固定時段"}</small></span><span>固定時段</span></div>)}{courses.map((course) => { const entry = active.entries.find((item) => item.courseId === course.course_id)!; return <div key={course.course_id}><span><strong>{course.name_zh}{entry.meetingsOverride && <em className="manual-time-tag">手動時間</em>}</strong><small>{formatMeetings(course)}</small></span><button onClick={() => void toggleLock(course.course_id)}>{entry.locked ? <><Lock aria-hidden="true" />已鎖定</> : "鎖定"}</button><button onClick={() => void removeEntry(course.course_id)}>移除</button></div>; })}</div>
      {selectedBlock && <CourseDetails block={selectedBlock} catalog={catalog} scheduledCourses={courses} plan={active} onClose={closeDetails} />}
      <SlotRecommendationContext.Provider value={slotRecommendationValue}><SlotRecommendationDialog /></SlotRecommendationContext.Provider>
      </Tabs.Panel>
    </Tabs>}
    <Modal open={Boolean(planDialog)} title={planDialog === "create" ? "建立課表方案" : "重新命名課表方案"} onClose={() => setPlanDialog("")} initialFocusRef={planNameRef}>
      <label htmlFor="plan-name"><strong>方案名稱</strong></label>
      <input ref={planNameRef} id="plan-name" value={planName} maxLength={80} onChange={(event) => setPlanName(event.target.value)} />
      <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setPlanDialog("")}>取消</button><button type="button" disabled={!planName.trim()} onClick={() => void savePlanName()}>儲存</button></div>
    </Modal>
  </section>;
}
