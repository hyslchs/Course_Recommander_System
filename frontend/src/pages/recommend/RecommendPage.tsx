import { useCallback, useEffect, useMemo, useRef, useState, type Key } from "react";
import { Badge, Button, Card, Description, Label, Tag, TagGroup, TextArea } from "@heroui/react";
import { FunnelSimple } from "@phosphor-icons/react";
import { useFacets, useRecommendationSources, type FacetMap } from "@/data/queries";
import { preloadRecommendationAssets } from "@/data/api";
import { putRecord } from "@/data/db";
import { track } from "@/analytics/client";
import { changedFilters } from "@/analytics/filters";
import {
  RecommendationSurface,
  useRecommendationImpression,
  useRecommendationRun,
} from "@/analytics/recommendation";
import { nextSearchStep, type SearchFlowState } from "@/analytics/searchFlow";
import { getHighCreditOptions } from "@/domain/creditFilter";
import { inferProfileStudyLevel } from "@/domain/eligibility";
import { defaultPreferredWeekdays } from "@/domain/profileDefaults";
import { rankCoursesWithDiagnostics } from "@/domain/recommendation";
import { coursesInPlan, meetingsInPlan } from "@/domain/scheduleUtils";
import type { SearchIndex } from "@/domain/search";
import { sanitizeSubjectQuery, type DetectedFilterPhrase } from "@/domain/subjectQuery";
import { useLocalDataState, useLocalRecords, useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { CourseCard } from "@/components/CourseCard";
import { BlurFade } from "@/components/motion/BlurFade";
import { EmptyState, LoadingSkeleton, Modal, SideDrawer, StateAlert } from "@/components/ui";
import { FilterPanel, type FacetOption } from "./FilterPanel";
import {
  activeFilterCount,
  appliedFilterTags,
  clearFilters,
  createFilters,
  removeAppliedFilters,
  type RecommendFilters,
} from "./filterState";
import type { CompletedCourse, CourseSummary, Recommendation } from "@/domain/types";

/** Stable identity so the `useMemo`s below do not rerun while facets are loading. */
const emptyFacets: FacetMap = {};

const topicExamples = [
  "我想學 Python 和資料分析",
  "想找行銷、社群經營與品牌案例",
  "對永續、氣候變遷與企業責任有興趣",
  "想了解心理學與人際溝通",
  "想學網頁設計和使用者體驗",
] as const;

type RecommendationEmbedding = {
  query: Float32Array;
  queryText: string;
  rawQuery: string;
  detectedFilterPhrases: DetectedFilterPhrase[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
  searchIndex: SearchIndex;
};

/**
 * What analytics needs to know about a run that has been requested but whose
 * results have not been ranked yet.
 *
 * `queryLength` — the number of characters, never the characters. The subject
 * query is free text a student typed; §7's first-phase answer is that it is not
 * stored anywhere, so only its length survives this line.
 */
interface PendingSearch {
  interactionId: string;
  flow: SearchFlowState;
  queryLength: number;
  startedAt: number;
}

/**
 * One result card, with its impression observer.
 *
 * A component rather than an inline `map` body because `useRecommendationImpression`
 * is a hook and needs one instance per card. The observer is attached to the
 * `BlurFade` wrapper, which is the grid item — so the box measured is exactly
 * the box the student sees.
 */
function RecommendationResult({ item, index }: { item: Recommendation; index: number }) {
  const impressionRef = useRecommendationImpression(item.course.course_id, index + 1);
  return (
    <BlurFade className="result-reveal" index={index} ref={impressionRef}>
      <CourseCard
        course={item.course}
        alternatives={item.alternatives}
        rank={index + 1}
        reasons={item.reasons}
        recommendationCategory={item.category}
      />
    </BlurFade>
  );
}

export function RecommendPage() {
  const { writable } = useLocalDataState();
  const profile = useProfile();
  const [catalog, setCatalog] = useState<CourseSummary[]>([]);
  // Same cache entry as ExplorePage's — the facet list is fetched once per session.
  const facets = useFacets().data ?? emptyFacets;
  const completed = useLocalRecords<CompletedCourse & { id: string }>("completedCourses");
  const dismissed = useLocalRecords<{ id: string }>("dismissedCourses");
  const { activePlan } = useSchedulePlans();
  const [interest, setInterest] = useState(profile?.interests ?? "");
  const [showAllExamples, setShowAllExamples] = useState(false);
  const [filters, setFilters] = useState<RecommendFilters>(() =>
    createFilters(profile?.preferredWeekdays?.length ? profile.preferredWeekdays : defaultPreferredWeekdays));
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  // Desktop keeps applying immediately, just like the persistent sidebar. The
  // dialog is a roomier view of the same committed state, not a second draft.
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const fullFilterReturnFocus = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (filterDialogOpen) return;
    const target = fullFilterReturnFocus.current;
    if (!target) return;
    const timer = window.setTimeout(() => {
      if (target.isConnected) target.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [filterDialogOpen]);
  const [lastEmbedding, setLastEmbedding] = useState<RecommendationEmbedding>();
  const [results, setResults] = useState<Recommendation[]>([]);
  const [candidateCount, setCandidateCount] = useState(0);
  // A mutation, so only the newest run drives `loading`/`error` and a superseded
  // response can no longer overwrite fresher results.
  const sources = useRecommendationSources();
  const loading = sources.isPending;
  const error = sources.error ? (sources.error as Error).message : "";
  const [validationError, setValidationError] = useState("");
  // Analytics only; none of these hold anything the student typed.
  const recommendationRun = useRecommendationRun("semantic");
  const searchFlow = useRef<SearchFlowState>(undefined);
  /** In flight: the clock and the flow position, before there is a run to stamp. */
  const activeRequest = useRef<Omit<PendingSearch, "interactionId">>(undefined);
  /** Results are back; the next re-rank emits the `search` event and clears this. */
  const pendingSearch = useRef<PendingSearch>(undefined);
  useEffect(() => setInterest(profile?.interests ?? ""), [profile?.interests]);
  useEffect(() => {
    const preferredWeekdays = profile?.preferredWeekdays?.length ? profile.preferredWeekdays : defaultPreferredWeekdays;
    setFilters((current) => ({ ...current, preferredWeekdays }));
  }, [profile?.preferredWeekdays]);
  useEffect(() => {
    if (!profile) return;
    // Profile completion is the intent signal for this route. The promise is
    // shared with the button-triggered request, so a click never downloads a
    // second copy of the catalog or vectors.
    void preloadRecommendationAssets().catch(() => undefined);
  }, [profile]);

  const creditOptions = useMemo(() => (facets.credits ?? [])
    .map((item) => Number(item.value))
    .filter((value) => Number.isFinite(value)), [facets]);
  const highCreditOptions = useMemo(() => getHighCreditOptions(creditOptions), [creditOptions]);
  const individualCreditOptions = useMemo(() => creditOptions.filter((credits) => !highCreditOptions.includes(credits)), [creditOptions, highCreditOptions]);
  const courseTagOptions = useMemo(() => (facets.course_tags ?? [])
    .map((item) => ({ value: item.value, label: item.label })), [facets]);
  const facetOptions = (key: string) => (facets[key] ?? []) as FacetOption[];
  const labelMaps = useMemo(() => ({
    relation: Object.fromEntries(facetOptions("relations").map((item) => [item.value, item.label])),
    teachingMethod: Object.fromEntries(facetOptions("teaching_methods").map((item) => [item.value, item.label])),
    assessment: Object.fromEntries(facetOptions("assessments").map((item) => [item.value, item.label])),
    department: Object.fromEntries(facetOptions("departments").map((item) => [item.value, item.label])),
    instructor: Object.fromEntries(facetOptions("teachers").map((item) => [item.value, item.label])),
  // Facets are semester-static; this memo only changes when that single response changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [facets]);
  const sanitizedPreview = useMemo(() => sanitizeSubjectQuery(interest), [interest]);

  const filterCount = activeFilterCount(filters);
  const fullFilterLabel = filterCount ? `完整篩選條件 · 已套用 ${filterCount} 項` : "完整篩選條件";
  const tags = appliedFilterTags(filters, highCreditOptions, labelMaps);
  const buildRankingInput = useCallback((embedding: RecommendationEmbedding, applied: RecommendFilters) => {
    const scheduledCourses = coursesInPlan(catalog, activePlan);
    const scheduledMeetings = meetingsInPlan(catalog, activePlan);
    return {
      catalog,
      courseIds: embedding.courseIds,
      vectors: embedding.vectors,
      dimension: embedding.dimension,
      query: embedding.query,
      queryText: embedding.queryText,
      searchIndex: embedding.searchIndex,
      profile,
      categoryFilters: applied.categoryFilters,
      courseTagFilters: applied.courseTagFilters,
      creditFilters: applied.creditFilters,
      completed,
      dismissedIds: dismissed.map((item) => item.id),
      preferredWeekdays: applied.preferredWeekdays,
      includeNonPreferredWeekdays: applied.showOtherWeekdays,
      advancedFilters: applied,
      filterEvidenceLabels: labelMaps,
      includeUnknownSchedule: applied.includeUnknownSchedule,
      scheduledCourses: applied.includeScheduleInfo ? scheduledCourses : [],
      scheduledMeetings: applied.includeScheduleInfo ? scheduledMeetings : [],
    };
  }, [activePlan, catalog, completed, dismissed, labelMaps, profile]);
  const rerank = useCallback((embedding: RecommendationEmbedding, applied: RecommendFilters) => {
    const diagnostic = rankCoursesWithDiagnostics(buildRankingInput(embedding, applied));
    setResults(diagnostic.recommendations);
    setCandidateCount(diagnostic.candidateCount);
    recommendationRun.settle(diagnostic.recommendations.length);

    // The `search` event is emitted here rather than in `onSuccess` because
    // "how many results" only exists once ranking has run — the API returns the
    // whole catalogue and the browser does the ranking. `pendingSearch` is
    // cleared immediately, so the re-ranks that follow a filter change update
    // the run's result count without logging another search.
    const pending = pendingSearch.current;
    if (!pending) return;
    pendingSearch.current = undefined;
    const resultCount = diagnostic.recommendations.length;
    track("search", {
      search_mode: "semantic",
      query_length: pending.queryLength,
      result_count: resultCount,
      latency_ms: Math.round(performance.now() - pending.startedAt),
    }, { interactionId: pending.interactionId });
    if (resultCount === 0) {
      // Derivable from `result_count = 0`, kept as its own event so the
      // zero-result rate stays a single row lookup on the dashboard (§6.5).
      track("zero_result", { search_mode: "semantic" }, { interactionId: pending.interactionId });
    }
    if (pending.flow.refinementIndex > 0) {
      track("search_refined", { refinement_index: pending.flow.refinementIndex }, { interactionId: pending.flow.flowId });
    }
  }, [buildRankingInput, recommendationRun]);
  useEffect(() => {
    if (lastEmbedding) rerank(lastEmbedding, filters);
  }, [filters, lastEmbedding, rerank]);

  /**
   * @param silent suppresses `filter_used` for programmatic resets. 「清除全部」
   * already reports itself as one `feature_clicked`; also emitting a dozen
   * `filter_used` events for the fields it happened to touch would make the
   * usage ranking a measure of the reset button.
   */
  const applyFilters = (next: RecommendFilters, { silent = false } = {}) => {
    if (!silent) {
      for (const use of changedFilters(filters, next)) {
        track("filter_used", use);
        if (use.filter === "conflict_filter") {
          track("schedule_conflict_action", {
            action: use.value === "on" ? "enable_conflict_filter" : "disable_conflict_filter",
          });
        }
      }
    }
    setFilters(next);
    if (next.preferredWeekdays.length) setValidationError("");
  };
  const clearAllFilters = () => {
    track("feature_clicked", { feature: "clear_filters" });
    applyFilters(clearFilters(filters), { silent: true });
  };
  const openFullFilters = () => {
    const activeElement = document.activeElement;
    fullFilterReturnFocus.current = activeElement instanceof HTMLButtonElement ? activeElement : null;
    track("feature_clicked", { feature: "open_full_filter" });
    setFilterDialogOpen(true);
  };
  const closeFullFilters = () => {
    const target = fullFilterReturnFocus.current;
    setFilterDialogOpen(false);
    if (target?.isConnected) target.focus();
  };
  const openFilterSheet = () => {
    track("feature_clicked", { feature: "open_filter_drawer" });
    setFilterSheetOpen(true);
  };
  const dismissFilterSheet = () => setFilterSheetOpen(false);

  const recommend = async () => {
    if (!interest.trim()) {
      setValidationError("請先輸入想學什麼，才能產生推薦。");
      return;
    }
    if (!sanitizedPreview.subjectQuery) {
      setValidationError("請只輸入想學的主題或技能；上課時間與學分請使用下方篩選器。");
      return;
    }
    if (!filters.preferredWeekdays.length) {
      setValidationError("請至少勾選一個偏好的上課星期，才能產生推薦。");
      return;
    }
    setValidationError("");
    if (profile) {
      try {
        await putRecord("profile", {
          ...profile,
          interests: interest.trim(),
          preferredWeekdays: filters.preferredWeekdays,
          studyLevel: inferProfileStudyLevel(profile),
          updatedAt: new Date().toISOString(),
        });
      } catch {
        setValidationError("無法儲存推薦條件，請重新連線瀏覽器儲存空間後再試。");
        return;
      }
    }
    // The clock starts now (that is the latency the student feels), but the run
    // itself is only opened once results exist — see `onSuccess`.
    const flow = nextSearchStep(searchFlow.current, Date.now());
    searchFlow.current = flow;
    activeRequest.current = { flow, queryLength: sanitizedPreview.subjectQuery.length, startedAt: performance.now() };

    sources.mutate(sanitizedPreview.subjectQuery, {
      onError: () => {
        activeRequest.current = undefined;
        track("error", { component: "recommendation", error_code: "EMBEDDING_REQUEST_FAILED" });
      },
      onSuccess: (loaded) => {
        // `start()` and `setLastEmbedding` in the same handler, in this order,
        // and load-bearing. Opening the run re-renders, and the re-rank effect
        // depends on it — so opening it at *request* time would run the effect
        // against the results still on screen and log a `search` carrying the
        // previous run's result count and a near-zero latency. Both state
        // updates are batched here, so the effect next runs with the new
        // embedding and the pending search together.
        const request = activeRequest.current;
        activeRequest.current = undefined;
        if (request) pendingSearch.current = { interactionId: recommendationRun.start(), ...request };
        setCatalog(loaded.catalog);
        setLastEmbedding({
          query: loaded.query,
          queryText: sanitizedPreview.subjectQuery,
          rawQuery: sanitizedPreview.rawQuery,
          detectedFilterPhrases: sanitizedPreview.detectedFilterPhrases,
          courseIds: loaded.courseIds,
          vectors: loaded.vectors,
          dimension: loaded.dimension,
          searchIndex: loaded.searchIndex,
        });
      },
    });
  };

  if (!profile) return <EmptyState action="開始設定" body="設定系所與年級後，才能判斷課程限制並產生推薦。" href="/onboarding" title="先完成個人設定" variant="missing-prerequisite" />;

  const subjectInvalid = Boolean(validationError && !sanitizedPreview.subjectQuery);
  const weekdayError = filters.preferredWeekdays.length ? undefined : <small className="field-error">請至少選擇一個星期</small>;
  const panelProps = {
    activePlanName: activePlan?.name,
    courseTagOptions,
    relationOptions: facetOptions("relations"),
    teachingMethodOptions: facetOptions("teaching_methods"),
    assessmentOptions: facetOptions("assessments"),
    teachingLanguageOptions: facetOptions("teaching_languages"),
    materialLanguageOptions: facetOptions("material_languages"),
    divisionOptions: facetOptions("divisions"),
    departmentOptions: facetOptions("departments"),
    instructorOptions: facetOptions("teachers"),
    sectionOptions: facetOptions("sections"),
    profileDepartmentIdentity: profile.department_identity,
    highCreditOptions,
    individualCreditOptions,
    weekdayError,
  };

  return (
    <section className="page recommend-page" data-page="recommend">
      {/* Was a `clamp(2rem,5vw,4rem)`-padded green slab. Two lines and a chip
          now, which is ~180px of first screen handed back to the query box. */}
      <header className="recommend-intro">
        <div className="recommend-intro-title">
          <h1>找到真正適合你的下一門課</h1>
        </div>
        <p>推薦會依你的設定整理；已修課、收藏和課表只會留在這台裝置。</p>
      </header>

      <Card className="recommend-query" variant="default">
        <Card.Content className="recommend-query-body">
          <Label htmlFor="subject-query">想學的主題或技能</Label>
          <TextArea
            aria-describedby={subjectInvalid ? "recommend-subject-error" : "recommend-subject-help"}
            aria-invalid={subjectInvalid || undefined}
            fullWidth
            id="subject-query"
            maxLength={500}
            placeholder="例如：電子商務、社群行銷、零售數據分析與業界案例"
            rows={3}
            value={interest}
            variant="secondary"
            onChange={(event) => setInterest(event.target.value)}
          />
          <Description id="recommend-subject-help">
            輸入你想學的內容；上課時間、學分等條件可用下方篩選。課程資訊會標示在結果卡片上。
          </Description>
          <div aria-label="主題範例" className="topic-examples">
            {(showAllExamples ? topicExamples : topicExamples.slice(0, 3)).map((example) => (
              <Button className="topic-example min-h-11" key={example} size="sm" variant="secondary" onPress={() => { track("feature_clicked", { feature: "use_topic_example" }); setInterest(example); setValidationError(""); }}>
                {example}
              </Button>
            ))}
            <Button aria-expanded={showAllExamples} className="topic-examples-toggle min-h-11" size="sm" variant="ghost" onPress={() => setShowAllExamples((current) => !current)}>
              {showAllExamples ? "收起範例" : `更多範例（${topicExamples.length - 3}）`}
            </Button>
          </div>
          {subjectInvalid && <small className="field-error" id="recommend-subject-error">{validationError}</small>}
        </Card.Content>
        <Card.Footer className="recommend-query-actions">
          <Button className="min-h-11 w-full sm:w-auto" isDisabled={!writable} isPending={loading} onPress={() => void recommend()}>
            {loading ? "正在分析…" : "產生推薦"}
          </Button>
        </Card.Footer>
      </Card>

      {validationError && <StateAlert className="error-summary" title="請修正後再產生推薦" tone="danger">{validationError}</StateAlert>}

      <div className="recommend-layout">
        {/* `lg` and up only: 320px of filters beside the results (plan §5.1). */}
        <aside aria-labelledby="recommendation-filter-heading" className="recommend-sidebar">
          <h2 className="recommend-sidebar-heading" id="recommendation-filter-heading">篩選條件</h2>
          <Button
            className="recommend-sidebar-full-filter-button min-h-11"
            variant="secondary"
            onPress={openFullFilters}
          >
            <FunnelSimple aria-hidden="true" />
            {fullFilterLabel}
          </Button>
          <FilterPanel {...panelProps} mode="sidebar" value={filters} onChange={applyFilters} />
        </aside>

        <div className="recommend-results">
          {/* Never inside the drawer: a student has to be able to see and drop a
              condition without opening anything (plan §5.2-3). */}
          <section aria-label="已套用的篩選條件" className="applied-filters" aria-live="polite">
            <TagGroup
              className="applied-filter-tags"
              selectionMode="none"
              onRemove={(keys: Set<Key>) => applyFilters(removeAppliedFilters(filters, highCreditOptions, [...keys].map(String), labelMaps))}
            >
              <Label>已套用 {filterCount} 項條件</Label>
              <TagGroup.List
                items={tags}
                renderEmptyState={() => <span className="applied-filter-note">目前沒有其他篩選條件</span>}
              >
                {(tag) => (
                  <Tag id={tag.id} textValue={tag.label}>
                    {tag.label}
                    {/* Explicit: React Aria's auto-rendered button is labelled
                        "Remove tag" in English on an otherwise zh-Hant page. */}
                    <Tag.RemoveButton aria-label={`移除條件：${tag.label}`} />
                  </Tag>
                )}
              </TagGroup.List>
            </TagGroup>
            <div className="applied-filter-actions">
              <Button
                className="recommend-full-filter-button min-h-11"
                size="sm"
                variant="secondary"
                onPress={openFullFilters}
              >
                <FunnelSimple aria-hidden="true" />
                {fullFilterLabel}
              </Button>
              <Button
                className="min-h-11"
                isDisabled={filterCount === 0}
                size="sm"
                variant="tertiary"
                onPress={clearAllFilters}
              >
                清除全部
              </Button>
            </div>
          </section>

          {lastEmbedding && (
            <section aria-label="本次搜尋內容" className="search-execution-summary">
              <span><strong>本次學科主題</strong>{lastEmbedding.queryText}</span>
              <span><strong>篩選條件來源</strong>你的設定</span>
              <span><strong>目前結果</strong>{candidateCount ? `符合篩選條件 ${candidateCount} 門 · 顯示前 ${results.length} 門` : "尚未找到符合條件的課程"}</span>
            </section>
          )}

          {error && <StateAlert action={<Button className="mt-2 min-h-11" variant="secondary" onPress={() => void recommend()}>重試</Button>} title="推薦失敗" tone="danger">{error}</StateAlert>}
          {loading && <LoadingSkeleton count={4} label="正在產生推薦，正在比對課程內容與你設定的修課條件。" variant="card-grid" />}
          {!lastEmbedding && !loading && !error && <EmptyState headingLevel={2} title="輸入主題，開始找適合的課" variant="first-run" />}
          {lastEmbedding && !results.length && !loading && !error && <EmptyState action="清除全部條件" body="可以放寬條件，或換一個更廣泛的主題。" headingLevel={2} live title="沒有符合全部條件的課程" variant="over-filtered" onAction={clearAllFilters}><div className="empty-actions"><button type="button" onClick={() => document.getElementById("subject-query")?.focus()}>修改主題</button></div></EmptyState>}
          {/* The only place §4.6 allows `blur-fade`. `index` is the stagger
              step and BlurFade clamps it at 6, so the grid finishes inside
              ~460ms however many results came back. */}
          {/* The provider is the analytics boundary: inside it a card is a
              recommendation with a run and a position, outside it (探索課程) the
              same component is just a catalogue row and reports no funnel
              events at all. */}
          <RecommendationSurface value={recommendationRun.surface}>
            <div className="course-grid">{results.map((item, index) => <RecommendationResult index={index} item={item} key={item.course.course_id} />)}</div>
          </RecommendationSurface>
        </div>
      </div>

      {/* Sub-`lg` entry point into the same panel. Sticky rather than inline so
          it stays reachable however far down the result list the user is. */}
      <div className="recommend-filter-launcher">
        <Badge.Anchor>
          <Button className="min-h-11" onPress={openFilterSheet}>
            <FunnelSimple aria-hidden="true" />
            篩選
          </Button>
          {filterCount > 0 && <Badge color="danger" size="sm">{filterCount}</Badge>}
        </Badge.Anchor>
      </div>

      <Modal
        className="recommend-filter-modal"
        closeLabel="關閉完整篩選"
        open={filterDialogOpen}
        title="完整篩選條件"
        onClose={closeFullFilters}
      >
        <div className="recommend-filter-modal-summary">
          <span><strong>{filterCount}</strong> 項條件已即時套用</span>
          <Button
            className="min-h-11"
            isDisabled={filterCount === 0}
            size="sm"
            variant="tertiary"
            onPress={clearAllFilters}
          >
            清除全部
          </Button>
        </div>
        <FilterPanel {...panelProps} mode="modal" value={filters} onChange={applyFilters} />
      </Modal>

      <SideDrawer
        className="recommend-filter-sheet"
        open={filterSheetOpen}
        title="完整篩選條件"
        onClose={dismissFilterSheet}
      >
        <div className="recommend-filter-modal-summary">
          <span><strong>{filterCount}</strong> 項條件已即時套用</span>
          <Button className="min-h-11" isDisabled={filterCount === 0} size="sm" variant="tertiary" onPress={clearAllFilters}>清除全部</Button>
        </div>
        <FilterPanel {...panelProps} mode="drawer" value={filters} onChange={applyFilters} />
      </SideDrawer>
    </section>
  );
}
