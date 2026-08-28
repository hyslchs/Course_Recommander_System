import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Sparkle, Warning, X } from "@phosphor-icons/react";
import { Button, Tabs, ToggleButton, ToggleButtonGroup, Toolbar } from "@heroui/react";
import { getCatalog, getEmbeddingBundle } from "@/data/api";
import { deleteRecord, getAllRecords, putRecord } from "@/data/db";
import { track, trackWithLegacy, trackV3 } from "@/analytics/client";
import { RecommendationSurface, useRecommendationRun } from "@/analytics/recommendation";
import { courseConflicts, meetingsConflict } from "@/domain/eligibility";
import { departmentRelation } from "@/domain/department";
import {
  buildScheduleBlocks,
  EXTENDED_SCHEDULE_SECTIONS,
  FULL_SCHEDULE_SECTIONS,
  formatMeetings,
  getDefaultScheduleSections,
  hasUnscheduledMeeting,
  SCHEDULE_SECTION_TIMES,
  sectionGridSpan,
  unplacedBlock,
  weekdayLabels,
  type ScheduleBlock,
  type ScheduleSection,
} from "@/domain/schedule";
import { coursesInPlan } from "@/domain/scheduleUtils";
import { rankScheduleSlotCourses } from "@/domain/scheduleRecommendation";
import type { ScheduleSlotRecommendationResult } from "@/domain/scheduleRecommendation";
import { useLocalDataState, useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { ConfirmDialog, Modal, StateAlert, useFeedback } from "@/components/ui";
import type { CompletedCourse, Course, FixedScheduleEntry, RecommendationCategory, ScheduleEntry, SchedulePlan } from "@/domain/types";
import type { AgeBucket } from "@/analytics/events";
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

function scheduleAgeBucket(addedAt?: string): AgeBucket {
  if (!addedAt) return "unknown";
  const ageMs = Date.now() - Date.parse(addedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  if (ageMs < 10 * 60 * 1000) return "under_10m";
  if (ageMs < 60 * 60 * 1000) return "10m_to_1h";
  if (ageMs < 24 * 60 * 60 * 1000) return "1h_to_24h";
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return "1d_to_7d";
  return "over_7d";
}

interface LoadedSlotRecommendationData {
  catalog: Course[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
  completed: CompletedCourse[];
  dismissedIds: string[];
}

export interface ScheduleLoadWarning {
  message: string;
  retry: () => void;
  retrying: boolean;
}

export function ScheduleWorkspace({ catalog, loadWarning }: { catalog: Course[]; loadWarning?: ScheduleLoadWarning }) {
  // Plans and profile come from context, not props (plan §6.3-2). `catalog` stays
  // a prop: it is the schedule route's own fetch, not shared app state.
  const { plans, activePlan: active, selectPlan } = useSchedulePlans();
  const profile = useProfile();
  const { writable } = useLocalDataState();
  // The undo action now outlives the render that queued it (it lives in the
  // toast queue, not in component state), so it has to read the current plans
  // rather than the ones captured when the course was removed.
  const plansRef = useRef(plans);
  plansRef.current = plans;
  const [viewMode, setViewMode] = useState<"default" | "full">("default");
  const [selectedBlock, setSelectedBlock] = useState<ScheduleBlock>();
  const [removeRequest, setRemoveRequest] = useState<{ courseId: string; courseName: string; conflicting: boolean }>();
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
  const planTabsRef = useRef<HTMLDivElement>(null);
  const [planDialog, setPlanDialog] = useState<"create" | "rename" | "">("");
  const [planName, setPlanName] = useState("");
  const planNameRef = useRef<HTMLInputElement>(null);
  const [planDeleteRequest, setPlanDeleteRequest] = useState<SchedulePlan>();
  const [planDeleteBusy, setPlanDeleteBusy] = useState(false);
  const { notify } = useFeedback();
  // The empty-slot dialog is the schedule page's recommendation surface. Each
  // opening is one run, so its impressions, clicks and adds join up the same way
  // 為你推薦's do — and are told apart on the dashboard by `method`.
  const slotRun = useRecommendationRun("schedule_slot");
  const courses = coursesInPlan(catalog, active);
  const fixedEntries: FixedScheduleEntry[] = active?.fixedEntries ?? [];
  const blocks = buildScheduleBlocks(courses, fixedEntries);
  const lockedCourseIds = new Set(active?.entries.filter((entry) => entry.locked).map((entry) => entry.courseId));
  const defaultSections = getDefaultScheduleSections(profile?.division);
  const visibleDays = viewMode === "full" ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
  const visibleSections: readonly ScheduleSection[] = viewMode === "full" ? FULL_SCHEDULE_SECTIONS : defaultSections;
  const hiddenSourceIds = new Set(blocks.filter((block) => !visibleDays.includes(block.weekday) || block.sections.some((section) => !visibleSections.includes(section as ScheduleSection))).map((block) => block.sourceId));
  const conflictCount = new Set(blocks.filter((block) => block.conflict).map((block) => block.sourceId)).size;
  const unplacedCourses = courses.filter(hasUnscheduledMeeting);
  const credits = courses.reduce((sum, course) => sum + (course.credits ?? 0), 0);
  const mobileBlocks = blocks.filter((block) => block.weekday === mobileDay && sectionGridSpan(block, visibleSections));
  const occupiedSlotKeys = new Set(blocks.flatMap((block) => block.sections.map((section) => `${block.weekday}-${section}`)));
  const emptySlotKeys = visibleSections.flatMap((section) => visibleDays.map((day) => `${day}-${section}`)).filter((key) => !occupiedSlotKeys.has(key));
  const resolvedActiveSlotKey = emptySlotKeys.includes(activeSlotKey) ? activeSlotKey : (emptySlotKeys[0] ?? "");
  const mobileOpenSections = visibleSections.filter((section) => !occupiedSlotKeys.has(`${mobileDay}-${section}`));
  // The day-column floor is a custom property rather than a literal so that the
  // print sheet can drop it to 0 without knowing how many days are visible
  // (FIX51 P2-g). With `minmax(150px,1fr)` the seven tracks total 1122px against
  // a 778px print box and 星期六/日 fell off the page entirely — and
  // `.unplaced-courses` is print-hidden, so nothing caught the dropped courses.
  const gridStyle = { gridTemplateColumns: `96px repeat(${visibleDays.length}, minmax(var(--schedule-col-min, 150px), 1fr))`, gridTemplateRows: `44px repeat(${visibleSections.length}, 72px)` } satisfies CSSProperties;

  // FIX51 P3-h. `Tabs.ListContainer` hard-codes its two overflow chevrons'
  // accessible names as the English "Scroll tabs left"/"Scroll tabs right"
  // (@heroui/react 3.2.4, components/tabs/tabs.js:152,159) — string literals, not
  // `useLocalizedStringFormatter` lookups, so the app's `I18nProvider` cannot
  // reach them and there is no prop to override them. Relabelling the two nodes
  // after mount is the only route that does not fork the component. They are
  // `tabIndex={-1}` mouse affordances, so nothing here affects focus order.
  useEffect(() => {
    const container = planTabsRef.current;
    if (!container) return;
    container.querySelector(".tabs__list-container__scroll-prev")?.setAttribute("aria-label", "向左捲動方案標籤");
    container.querySelector(".tabs__list-container__scroll-next")?.setAttribute("aria-label", "向右捲動方案標籤");
  }, [plans.length]);
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
    track("feature_clicked", { feature: "open_slot_recommendation" });
    slotRun.start();
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
      const ranked = rankLoadedSlotRecommendations(slot, loadedData, categoryFilters);
      setSlotRecommendation(ranked);
      slotRun.settle(ranked.recommendations.length);
    } catch (error) {
      if (requestId === slotRequestRef.current) {
        setSlotRecommendationError((error as Error).message || "無法讀取課程資料");
        slotRun.complete("error");
        track("error", { component: "schedule", error_code: "CATALOG_LOAD_FAILED" });
      }
    } finally {
      if (requestId === slotRequestRef.current) setSlotRecommendationLoading(false);
    }
  };
  const closeSlotRecommendations = () => {
    slotRun.complete(slotRecommendationLoading ? "abandoned" : undefined);
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
      const ranked = rankLoadedSlotRecommendations(selectedSlot, loadedSlotRecommendationData, categoryFilters);
      setSlotRecommendation(ranked);
      // A category toggle re-ranks the same run; it does not start a new one.
      slotRun.settle(ranked.recommendations.length);
    }
  };
  const toggleSlotCategoryFilter = (category: RecommendationCategory) => {
    const categoryFilters = scheduleRecommendationCategories.filter((item) => (
      item === category ? !slotCategoryFilters.includes(item) : slotCategoryFilters.includes(item)
    ));
    applySlotCategoryFilters(categoryFilters);
  };
  const addRecommendedCourse = async (courseId: string) => {
    if (!writable) return;
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
      await putRecord("schedulePlans", { ...active, entries: [...active.entries, { courseId, locked: false, originalSource: "schedule_slot", addedAt: new Date().toISOString() }], updatedAt: new Date().toISOString() });
      const position = (slotRecommendation?.recommendations.findIndex((item) => item.course.course_id === courseId) ?? -1) + 1;
      slotRun.surface?.markEngaged();
      const elapsedMs = slotRun.surface?.elapsedSinceReady();
      trackWithLegacy(
        "course_added",
        { course_id: courseId, source: "schedule_slot", ...(position > 0 ? { position } : {}), department_relation: departmentRelation(course, profile), ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs, elapsed_origin: "schedule_slot_result" as const }) },
        { course_id: courseId, source: "schedule_slot", ...(position > 0 ? { position } : {}) },
        { interactionId: slotRun.surface?.interactionId },
      );
      slotRun.surface?.recordAdd();
      notify(`已將「${course.name_zh}」加入「${active.name}」`);
      closeSlotRecommendations();
    } catch (error) {
      track("error", { component: "schedule", error_code: "SCHEDULE_WRITE_FAILED" });
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
    if (!writable) return;
    setPlanName("方案 " + (plans.length + 1));
    setPlanDialog("create");
  };
  const renamePlan = () => {
    if (!active || !writable) return;
    setPlanName(active.name);
    setPlanDialog("rename");
  };
  const savePlanName = async () => {
    if (!writable) return;
    const name = planName.trim();
    if (!name) return;
    try {
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
    } catch (error) { notify("儲存課表方案失敗：" + (error as Error).message, "error"); }
  };
  const duplicatePlan = async () => {
    if (!active || !writable) return;
    const now = new Date().toISOString();
    const plan: SchedulePlan = { ...active, id: crypto.randomUUID(), name: `${active.name}（副本）`, entries: active.entries.map((entry) => ({ ...entry, meetingsOverride: entry.meetingsOverride?.map((meeting) => ({ ...meeting, sections: [...meeting.sections] })) })), fixedEntries: active.fixedEntries?.map((entry) => ({ ...entry, meetings: entry.meetings.map((meeting) => ({ ...meeting, sections: [...meeting.sections] })) })), createdAt: now, updatedAt: now };
    try {
      await putRecord("schedulePlans", plan);
      await selectPlan(plan.id);
    } catch (error) { notify("建立課表副本失敗：" + (error as Error).message, "error"); }
  };
  const requestDeletePlan = () => {
    if (!active || !writable || plans.length <= 1 || planDeleteBusy) return;
    setPlanDeleteRequest(active);
  };
  const deletePlan = async () => {
    const plan = planDeleteRequest;
    if (!plan || !writable || plans.length <= 1 || planDeleteBusy) return;
    const nextPlan = plans.find((item) => item.id !== plan.id);
    if (!nextPlan) return;
    setPlanDeleteBusy(true);
    try {
      await deleteRecord("schedulePlans", plan.id);
      await selectPlan(nextPlan.id);
      notify(`已刪除課表方案「${plan.name}」`);
      setPlanDeleteRequest(undefined);
    } catch (error) {
      notify("刪除課表方案失敗：" + (error as Error).message, "error");
    } finally {
      setPlanDeleteBusy(false);
    }
  };
  const printSchedule = () => {
    track("feature_clicked", { feature: "export_schedule" });
    setViewMode("full");
    window.setTimeout(() => window.print(), 0);
  };
  const toggleLock = async (courseId: string) => {
    if (!active || !writable) return;
    try { await putRecord("schedulePlans", { ...active, entries: active.entries.map((item) => item.courseId === courseId ? { ...item, locked: !item.locked } : item), updatedAt: new Date().toISOString() }); }
    catch (error) { notify("更新課程鎖定狀態失敗：" + (error as Error).message, "error"); }
  };
  const removeEntry = async (courseId: string, { resolvingConflict = false } = {}) => {
    if (!active || !writable) return;
    const entry = active.entries.find((item) => item.courseId === courseId);
    if (!entry) return;
    try {
      await putRecord("schedulePlans", { ...active, entries: active.entries.filter((item) => item.courseId !== courseId), updatedAt: new Date().toISOString() });
    } catch (error) {
      notify("移除課程失敗：" + (error as Error).message, "error");
      return;
    }
    // Course-level only, and deliberately *not* linked to whichever add it
    // undoes: there is no identifier that would survive long enough to do that,
    // which is the point. The dashboard labels it aggregate behaviour.
    trackWithLegacy(
      "course_removed",
      { course_id: courseId, ...(entry.originalSource ? { original_source: entry.originalSource } : {}), age_bucket: scheduleAgeBucket(entry.addedAt) },
      { course_id: courseId },
    );
    // Only when the block being removed was actually drawn as a clash — every
    // other removal is ordinary schedule editing, not conflict resolution.
    if (resolvingConflict) track("schedule_conflict_action", { action: "remove_course" });
    // Was a bespoke `.undo-toast` rendered next to the timetable. It is now the
    // one shared queue (plan §6.3-3), which also gets it the 6s timeout and the
    // politeness mapping for free.
    notify("已從課表移除課程。", "success", { label: "復原", onAction: () => undoRemove({ planId: active.id, entry }) });
    if (selectedBlock?.sourceId === courseId) {
      detailTriggerRef.current = null;
      setSelectedBlock(undefined);
    }
  };
  const requestRemove = (block: ScheduleBlock) => {
    if (block.source !== "course" || !writable) return;
    setRemoveRequest({ courseId: block.sourceId, courseName: block.name, conflicting: Boolean(block.conflict) });
  };
  const undoRemove = async (removed: { planId: string; entry: ScheduleEntry }) => {
    if (!writable) return;
    const plan = plansRef.current.find((item) => item.id === removed.planId);
    if (plan && !plan.entries.some((item) => item.courseId === removed.entry.courseId)) {
      try {
        await putRecord("schedulePlans", { ...plan, entries: [...plan.entries, removed.entry], updatedAt: new Date().toISOString() });
        if (removed.entry.originalSource) trackV3("course_readded", { course_id: removed.entry.courseId, source: removed.entry.originalSource });
      }
      catch (error) { notify("復原課程失敗：" + (error as Error).message, "error"); }
    }
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

  return <section className="page" data-page="schedule"><div className="page-heading"><div><div className="eyebrow">安排多個選課方案</div><h1>我的課表</h1></div><button className="primary" type="button" disabled={!writable} onClick={createPlan}>新增方案</button></div>
    {loadWarning ? <StateAlert action={<Button className="mt-2 min-h-11" isDisabled={loadWarning.retrying} isPending={loadWarning.retrying} variant="secondary" onPress={loadWarning.retry}>{loadWarning.retrying ? "重新載入中…" : "重新載入課表"}</Button>} live="polite" title="無法更新課表" tone="warning">{loadWarning.message}</StateAlert> : null}
    {/* `<h2>`, not `<h1>`: the page heading above already owns this route's single `<h1>` (plan R9). */}
    {!active ? <section className="empty-state"><h2 className="page-title">先建立一個課表方案</h2><p>建立課表後，你可以加入課程並檢查衝堂。</p><button className="primary" type="button" disabled={!writable} onClick={createPlan}>建立第一個方案</button></section> :
      /* The hand-rolled tablist (a `role="tablist"` div, manual `aria-selected`,
         manual `tabIndex` and an `onPlanTabKeyDown` that re-implemented
         Arrow/Home/End) is gone: React Aria's `Tabs` owns the roving tabindex,
         the tab/panel wiring and the automatic activation. Only the selected
         plan's panel is rendered, which is exactly what `Tabs.Panel` mounts. */
      <Tabs selectedKey={active.id} onSelectionChange={(key) => void selectPlan(String(key))}>
      <Tabs.ListContainer ref={planTabsRef}><Tabs.List aria-label="課表方案" className="schedule-plan-tabs">{plans.map((plan) => <Tabs.Tab id={plan.id} key={plan.id}>{plan.name}<Tabs.Indicator /></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer>
      <Tabs.Panel id={active.id}>
      <Toolbar aria-label="課表方案操作" className="schedule-plan-actions"><strong>目前方案：{active.name}</strong><Button isDisabled={!writable} variant="secondary" onPress={renamePlan}>重新命名</Button><Button isDisabled={!writable} variant="secondary" onPress={() => void duplicatePlan()}>建立副本</Button><Button variant="secondary" onPress={printSchedule}>列印／另存 PDF</Button><Button aria-describedby={plans.length <= 1 ? "schedule-plan-delete-hint" : undefined} aria-label={plans.length <= 1 ? "無法刪除課表方案，至少保留一個方案" : `刪除課表方案「${active.name}」`} isDisabled={!writable || plans.length <= 1 || planDeleteBusy} variant="danger" onPress={requestDeletePlan}>{planDeleteBusy ? "刪除中…" : plans.length <= 1 ? "無法刪除" : "刪除方案"}</Button>{plans.length <= 1 && <span className="schedule-plan-delete-hint" id="schedule-plan-delete-hint">至少保留一個課表方案，無法刪除。</span>}</Toolbar>
      <ManualCoursePanel catalog={catalog} plan={active} />
      <div className="schedule-summary"><strong>{courses.length} 門課</strong><span>{credits} 學分</span>{fixedEntries.length > 0 && <span>{fixedEntries.length} 個固定時段</span>}</div>
      {/* Was a `.schedule-conflict-summary` span wedged into the count strip, i.e.
          a warning that looked like a statistic and was announced as one. */}
      {conflictCount > 0 && <StateAlert className="schedule-conflict-alert" live="polite" title="課表有衝堂" tone="danger">{conflictCount} 門課的上課時間互相重疊，格線上以紅色斜線標示。</StateAlert>}
      <Toolbar aria-label="課表顯示設定" className="schedule-view-toolbar"><div><strong>點空白時段找適合的課</strong><span>預設範圍依你的部別顯示；完整課表可查看所有星期與時段。</span></div>
        {/* `selectionMode="single"` makes React Aria emit `radiogroup`/`radio` +
            `aria-checked` instead of the old `group` + `aria-pressed`. That is the
            APG pattern for a mutually exclusive segmented control and is why the
            workspace test now queries by those roles. */}
        <ToggleButtonGroup aria-label="課表顯示範圍" className="segmented-control" disallowEmptySelection selectedKeys={[viewMode]} selectionMode="single" onSelectionChange={(keys) => { const next = [...keys][0]; if (next) { track("feature_clicked", { feature: "switch_schedule_view" }); setViewMode(next as typeof viewMode); } }}>
          <ToggleButton id="default">預設</ToggleButton>
          <ToggleButton id="full">完整課表</ToggleButton>
        </ToggleButtonGroup></Toolbar>
      {viewMode === "default" && hiddenSourceIds.size > 0 && <StateAlert action={<Button className="mt-2 min-h-11" variant="secondary" onPress={() => setViewMode("full")}>顯示完整課表</Button>} className="schedule-hidden-notice" tone="info">目前預設範圍外有 {hiddenSourceIds.size} 門課。</StateAlert>}
      <div className="mobile-day-picker"><strong id="mobile-day-picker-label">查看星期</strong><ToggleButtonGroup aria-labelledby="mobile-day-picker-label" disallowEmptySelection fullWidth selectedKeys={[String(mobileDay)]} selectionMode="single" onSelectionChange={(keys) => { const next = [...keys][0]; if (next) setMobileDay(Number(next)); }}>{visibleDays.map((day) => <ToggleButton aria-label={`星期${weekdayLabels[day - 1]}`} id={String(day)} key={day}>{weekdayLabels[day - 1]}</ToggleButton>)}</ToggleButtonGroup></div>
      {/* `aria-rowcount`/`aria-colcount` count the header row and the section-label
          column, so the indices below are 1-based over the whole grid.

          FIX51 P1-c: `role="grid"` requires `role="row"` children, and T35 shipped
          the index counts without them — 54 cells hanging directly off the grid,
          which failed axe's `aria-required-children` *and* `aria-required-parent`
          and held /schedule desktop at Lighthouse 90 while every other route was
          100. The rows are `display:contents` (see the CSS fence), so every
          header/cell/block stays a direct grid item and the explicit `gridColumn`
          /`gridRow` placement — including `.class-block`'s multi-row span — is
          byte-for-byte what it was. axe reads the DOM, not the layout tree, so it
          sees the rows either way; Chrome has exposed semantic `display:contents`
          elements to AT since 89.

          The blocks moved *into* the row that holds their first section, each in
          a `role="gridcell"` wrapper (also `display:contents`), because a bare
          `button` child would fail the row's required-children just as it failed
          the grid's. Their DOM order relative to the cells now matches the visual
          reading order, which is also a better tab order.

          Two label changes come with FIX51 P2-d, which un-hides the 找課 text in
          every empty cell. axe's `label-content-name-mismatch` (WCAG 2.5.3)
          compares an element's on-screen text against its accessible name and,
          verified in the bundled source, evaluates visibility with
          `screenReader = false` — so `aria-hidden` does not exempt anything and
          the newly visible 找課 would have put 190 fresh findings on this page.
          So: the slot button's name now *starts* with the word a speech-input
          user can read, and `.schedule-cell` drops the `aria-label` that
          duplicated its own row/column headers — with `rowheader`,
          `columnheader` and the index counts all present, the cell's coordinates
          are what the grid structure is for, and the label was the only reason
          the cell had a name that could mismatch its content. Measured: 196
          findings -> 6. */}
      <p className="schedule-scroll-hint" id="schedule-scroll-hint" role="note">課表可左右、上下滑動查看完整內容；星期與節次標題會固定顯示。</p>
      <div className="timetable" role="region" tabIndex={0} aria-label={`${active.name}課表，可左右及上下捲動查看`} aria-describedby="schedule-scroll-hint"><div className="schedule-grid" style={gridStyle} role="grid" aria-colcount={visibleDays.length + 1} aria-rowcount={visibleSections.length + 1}>
        <div className="schedule-row" role="row" aria-rowindex={1}><div className="schedule-corner" role="columnheader" aria-colindex={1} aria-rowindex={1}>節次</div>{visibleDays.map((day, dayIndex) => <div className="schedule-day-header" role="columnheader" aria-colindex={dayIndex + 2} aria-rowindex={1} key={day} style={{ gridColumn: dayIndex + 2, gridRow: 1 }}>星期{weekdayLabels[day - 1]}</div>)}</div>
        {visibleSections.map((section, sectionIndex) => <div className="schedule-row" role="row" aria-rowindex={sectionIndex + 2} key={section}>
          <div className={`schedule-section-label ${EXTENDED_SCHEDULE_SECTIONS.includes(section as typeof EXTENDED_SCHEDULE_SECTIONS[number]) ? "extended" : ""}`} role="rowheader" aria-label={`${section} ${SCHEDULE_SECTION_TIMES[section]}`} aria-colindex={1} aria-rowindex={sectionIndex + 2} style={{ gridColumn: 1, gridRow: sectionIndex + 2 }}><strong>{section}</strong><time>{SCHEDULE_SECTION_TIMES[section]}</time></div>
          {visibleDays.map((day, dayIndex) => {
            const key = `${day}-${section}`;
            const occupied = occupiedSlotKeys.has(key);
            return <div className={`schedule-cell ${occupied ? "occupied" : ""}`} role="gridcell" aria-colindex={dayIndex + 2} aria-rowindex={sectionIndex + 2} key={key} style={{ gridColumn: dayIndex + 2, gridRow: sectionIndex + 2 }}>{!occupied && <button ref={(element) => { if (element) slotButtonRefs.current.set(key, element); else slotButtonRefs.current.delete(key); }} type="button" className="schedule-slot-button" tabIndex={resolvedActiveSlotKey === key ? 0 : -1} aria-label={`找課：星期${weekdayLabels[day - 1]} ${section} 可以排入的課程`} onFocus={() => setActiveSlotKey(key)} onKeyDown={(event) => onSlotKeyDown(event, dayIndex, sectionIndex)} onClick={() => void loadSlotRecommendations({ weekday: day, section })}><Sparkle aria-hidden="true" /><span>找課</span></button>}</div>;
          })}
          {blocks.map((block) => {
            const dayIndex = visibleDays.indexOf(block.weekday); const span = sectionGridSpan(block, visibleSections); if (dayIndex === -1 || !span || span.start !== sectionIndex) return null;
            const blockStyle = { gridColumn: dayIndex + 2, gridRow: `${span.start + 2} / span ${span.span}`, width: `calc(${100 / block.laneCount}% - 6px)`, marginLeft: `calc(${block.lane * 100 / block.laneCount}% + 3px)` } as CSSProperties;
            return <div className="schedule-block-cell" role="gridcell" aria-colindex={dayIndex + 2} key={block.id}><ClassBlock block={block} locked={lockedCourseIds.has(block.sourceId)} onRemove={() => requestRemove(block)} onSelect={openDetails} onToggleLock={() => void toggleLock(block.sourceId)} style={blockStyle} variant="grid" /></div>;
          })}
        </div>)}
      </div><div className="mobile-schedule-list">{!mobileBlocks.length && <p className="muted">星期{weekdayLabels[mobileDay - 1]}目前沒有課程。</p>}{mobileBlocks.map((block) => <ClassBlock block={block} key={block.id} locked={lockedCourseIds.has(block.sourceId)} onRemove={() => requestRemove(block)} onSelect={openDetails} onToggleLock={() => void toggleLock(block.sourceId)} variant="list" />)}<div className="mobile-open-slots"><strong>點空堂找課</strong><div>{mobileOpenSections.map((section) => <button type="button" key={section} aria-label={`找課：星期${weekdayLabels[mobileDay - 1]} ${section} ${SCHEDULE_SECTION_TIMES[section]} 可以排入的課程`} onClick={() => void loadSlotRecommendations({ weekday: mobileDay, section })}><Sparkle aria-hidden="true" /><span><strong>{section}</strong><time>{SCHEDULE_SECTION_TIMES[section]}</time></span></button>)}</div></div></div></div>
      {unplacedCourses.length > 0 && <section className="unplaced-courses"><h2>時間未定／待安排</h2><StateAlert live="polite" tone="warning">{unplacedCourses.length} 門課的上課時間未定。它們不會被誤放進星期一，指定時間後才會出現在格狀課表。</StateAlert>{unplacedCourses.map((course) => <div className="unplaced-course-row" key={course.course_id}><button onClick={(event) => openDetails(unplacedBlock(course), event.currentTarget)}><strong>{course.name_zh}</strong><span>{formatMeetings(course)}</span></button><button aria-label={`移除課程：${course.name_zh}`} className="unplaced-course-remove" disabled={!writable} type="button" onClick={(event) => { event.stopPropagation(); setRemoveRequest({ courseId: course.course_id, courseName: course.name_zh, conflicting: false }); }}><X aria-hidden="true" /></button></div>)}</section>}
      {selectedBlock && <CourseDetails block={selectedBlock} catalog={catalog} scheduledCourses={courses} plan={active} onClose={closeDetails} />}
      <RecommendationSurface value={slotRun.surface}><SlotRecommendationContext.Provider value={slotRecommendationValue}><SlotRecommendationDialog /></SlotRecommendationContext.Provider></RecommendationSurface>
      </Tabs.Panel>
    </Tabs>}
    <Modal open={Boolean(planDialog)} title={planDialog === "create" ? "建立課表方案" : "重新命名課表方案"} onClose={() => setPlanDialog("")} initialFocusRef={planNameRef}>
      <label htmlFor="plan-name"><strong>方案名稱</strong></label>
      <input ref={planNameRef} id="plan-name" value={planName} maxLength={80} onChange={(event) => setPlanName(event.target.value)} />
      <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setPlanDialog("")}>取消</button><button type="button" disabled={!writable || !planName.trim()} onClick={() => void savePlanName()}>儲存</button></div>
    </Modal>
    <ConfirmDialog
      busy={planDeleteBusy}
      confirmLabel="刪除方案"
      description={<p>確定要刪除課表方案「{planDeleteRequest?.name ?? ""}」嗎？此方案中的課程與固定時段也會一併移除，且無法復原。</p>}
      destructive
      onCancel={() => { if (!planDeleteBusy) setPlanDeleteRequest(undefined); }}
      onConfirm={() => void deletePlan()}
      open={Boolean(planDeleteRequest)}
      title="刪除課表方案？"
    />
    <ConfirmDialog
      busy={false}
      confirmLabel="移除課程"
      description={<p>確定要將「{removeRequest?.courseName ?? ""}」從目前課表移除嗎？</p>}
      onCancel={() => setRemoveRequest(undefined)}
      onConfirm={() => {
        if (!removeRequest) return;
        const request = removeRequest;
        setRemoveRequest(undefined);
        void removeEntry(request.courseId, { resolvingConflict: request.conflicting });
      }}
      open={Boolean(removeRequest)}
      title="從課表移除課程？"
    />
  </section>;
}
