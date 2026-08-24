import { useCallback, useEffect, useMemo, useState, type Key } from "react";
import { Badge, Button, Card, Chip, Description, Label, Tag, TagGroup, TextArea } from "@heroui/react";
import { FunnelSimple } from "@phosphor-icons/react";
import { useFacets, useRecommendationSources, type FacetMap } from "@/data/queries";
import { putRecord } from "@/data/db";
import { getHighCreditOptions } from "@/domain/creditFilter";
import { inferProfileStudyLevel } from "@/domain/eligibility";
import { defaultPreferredWeekdays } from "@/domain/profileDefaults";
import { rankCourses } from "@/domain/recommendation";
import { coursesInPlan, meetingsInPlan } from "@/domain/scheduleUtils";
import { buildSearchIndex } from "@/domain/search";
import { sanitizeSubjectQuery, type DetectedFilterPhrase } from "@/domain/subjectQuery";
import { useLocalRecords, useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { CourseCard } from "@/components/CourseCard";
import { EmptyState, LoadingSkeleton, SideDrawer, StateAlert } from "@/components/ui";
import { FilterPanel } from "./FilterPanel";
import {
  activeFilterCount,
  appliedFilterTags,
  clearFilters,
  createFilters,
  removeAppliedFilters,
  type RecommendFilters,
} from "./filterState";
import type { CompletedCourse, Course, Recommendation } from "@/domain/types";

/** Stable identity so the `useMemo`s below do not rerun while facets are loading. */
const emptyFacets: FacetMap = {};

type RecommendationEmbedding = {
  query: Float32Array;
  queryText: string;
  rawQuery: string;
  detectedFilterPhrases: DetectedFilterPhrase[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
};

export function RecommendPage() {
  const profile = useProfile();
  const [catalog, setCatalog] = useState<Course[]>([]);
  const searchIndex = useMemo(() => buildSearchIndex(catalog), [catalog]);
  // Same cache entry as ExplorePage's — the facet list is fetched once per session.
  const facets = useFacets().data ?? emptyFacets;
  const completed = useLocalRecords<CompletedCourse & { id: string }>("completedCourses");
  const dismissed = useLocalRecords<{ id: string }>("dismissedCourses");
  const { activePlan } = useSchedulePlans();
  const [interest, setInterest] = useState(profile?.interests ?? "");
  const [filters, setFilters] = useState<RecommendFilters>(() =>
    createFilters(profile?.preferredWeekdays?.length ? profile.preferredWeekdays : defaultPreferredWeekdays));
  // The sheet edits a copy. Plan §5.2-5: re-ranking on every tap inside a
  // bottom sheet reflows a list the user cannot see, so the draft is committed
  // in one go — by 套用 and by nothing else. Every dismissal throws it away.
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<RecommendFilters>(filters);
  const [lastEmbedding, setLastEmbedding] = useState<RecommendationEmbedding>();
  const [results, setResults] = useState<Recommendation[]>([]);
  // A mutation, so only the newest run drives `loading`/`error` and a superseded
  // response can no longer overwrite fresher results.
  const sources = useRecommendationSources();
  const loading = sources.isPending;
  const error = sources.error ? (sources.error as Error).message : "";
  const [validationError, setValidationError] = useState("");
  useEffect(() => setInterest(profile?.interests ?? ""), [profile?.interests]);
  useEffect(() => {
    const preferredWeekdays = profile?.preferredWeekdays?.length ? profile.preferredWeekdays : defaultPreferredWeekdays;
    setFilters((current) => ({ ...current, preferredWeekdays }));
  }, [profile?.preferredWeekdays]);

  const creditOptions = useMemo(() => (facets.credits ?? [])
    .map((item) => Number(item.value))
    .filter((value) => Number.isFinite(value)), [facets]);
  const highCreditOptions = useMemo(() => getHighCreditOptions(creditOptions), [creditOptions]);
  const individualCreditOptions = useMemo(() => creditOptions.filter((credits) => !highCreditOptions.includes(credits)), [creditOptions, highCreditOptions]);
  const courseTagOptions = useMemo(() => (facets.course_tags ?? [])
    .map((item) => ({ code: item.value, label_zh: item.label })), [facets]);
  const sanitizedPreview = useMemo(() => sanitizeSubjectQuery(interest), [interest]);

  const filterCount = activeFilterCount(filters);
  const draftFilterCount = activeFilterCount(draftFilters);
  const tags = appliedFilterTags(filters, highCreditOptions);
  const includesUnknown = filters.includeUnknownPrerequisite || filters.includeUnknownCourseLevel;

  const rerank = useCallback((embedding: RecommendationEmbedding, applied: RecommendFilters) => {
    const scheduledCourses = coursesInPlan(catalog, activePlan);
    const scheduledMeetings = meetingsInPlan(catalog, activePlan);
    setResults(rankCourses({
      catalog,
      courseIds: embedding.courseIds,
      vectors: embedding.vectors,
      dimension: embedding.dimension,
      query: embedding.query,
      queryText: embedding.queryText,
      searchIndex,
      profile,
      categoryFilters: applied.categoryFilters,
      courseTagFilters: applied.courseTagFilters,
      creditFilters: applied.creditFilters,
      completed,
      dismissedIds: dismissed.map((item) => item.id),
      preferredWeekdays: applied.preferredWeekdays,
      includeNonPreferredWeekdays: applied.showOtherWeekdays,
      timeOfDayFilter: applied.timeOfDayFilter,
      includeUnknownSchedule: applied.includeUnknownSchedule,
      prerequisiteFilter: applied.prerequisiteFilter,
      includeUnknownPrerequisite: applied.includeUnknownPrerequisite,
      courseLevelFilter: applied.courseLevelFilter,
      includeUnknownCourseLevel: applied.includeUnknownCourseLevel,
      scheduledCourses: applied.includeScheduleInfo ? scheduledCourses : [],
      scheduledMeetings: applied.includeScheduleInfo ? scheduledMeetings : [],
    }));
  }, [activePlan, catalog, completed, dismissed, profile, searchIndex]);
  useEffect(() => {
    if (lastEmbedding) rerank(lastEmbedding, filters);
  }, [filters, lastEmbedding, rerank]);

  const applyFilters = (next: RecommendFilters) => {
    setFilters(next);
    if (next.preferredWeekdays.length) setValidationError("");
  };
  const openFilterSheet = () => {
    setDraftFilters(filters);
    setFilterSheetOpen(true);
  };
  /**
   * Dismissal discards (FIX54). The sheet already carries an explicit 套用 N 項,
   * and a surface with a commit button that *also* commits when you back out of
   * it has no way to say "no" — the ✕ and the button would do the same thing,
   * and Escape would silently apply conditions the student never confirmed.
   *
   * Nothing is reset here: `openFilterSheet` re-seeds the draft from the
   * committed filters, so an abandoned draft can never leak into the next open.
   *
   * No "discard your changes?" prompt on a dirty draft: a confirm inside a
   * bottom sheet is a dialog over a dialog (two stacked focus traps on a phone),
   * and the thing being protected is a few taps in a panel that is one tap away
   * — the cost of re-doing it is far below the cost of the interruption.
   */
  const dismissFilterSheet = () => setFilterSheetOpen(false);
  /** The sheet's only commit path. */
  const commitFilterSheet = () => {
    setFilterSheetOpen(false);
    applyFilters(draftFilters);
  };

  const recommend = async () => {
    if (!interest.trim()) {
      setValidationError("請先輸入想學什麼，才能產生推薦。");
      return;
    }
    if (!sanitizedPreview.subjectQuery) {
      setValidationError("請只輸入想學的主題或技能；星期、學分與先修條件請使用下方篩選器。");
      return;
    }
    if (!filters.preferredWeekdays.length) {
      setValidationError("請至少勾選一個偏好的上課星期，才能產生推薦。");
      return;
    }
    setValidationError("");
    if (profile) {
      await putRecord("profile", {
        ...profile,
        interests: interest.trim(),
        preferredWeekdays: filters.preferredWeekdays,
        studyLevel: inferProfileStudyLevel(profile),
        updatedAt: new Date().toISOString(),
      });
    }
    sources.mutate(sanitizedPreview.subjectQuery, {
      onSuccess: (loaded) => {
        setCatalog(loaded.catalog);
        setLastEmbedding({
          query: loaded.query,
          queryText: sanitizedPreview.subjectQuery,
          rawQuery: sanitizedPreview.rawQuery,
          detectedFilterPhrases: sanitizedPreview.detectedFilterPhrases,
          courseIds: loaded.courseIds,
          vectors: loaded.vectors,
          dimension: loaded.dimension,
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
          <Chip className="recommend-privacy-chip" color="success" variant="soft">
            <Chip.Label>● Local-first</Chip.Label>
          </Chip>
        </div>
        <p>115-1 個人化推薦在你的裝置上完成；已修課、收藏和課表不會送到後端。</p>
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
            搜尋文字只決定課程內容的相關性；上課星期、學分與先修條件請使用篩選器。課程學制會標示在結果卡片上。
          </Description>
          {subjectInvalid && <small className="field-error" id="recommend-subject-error">{validationError}</small>}
        </Card.Content>
        <Card.Footer className="recommend-query-actions">
          <Button className="min-h-11 w-full sm:w-auto" isPending={loading} onPress={() => void recommend()}>
            {loading ? "正在分析…" : "產生推薦"}
          </Button>
        </Card.Footer>
      </Card>

      {validationError && <StateAlert className="error-summary" title="請修正後再產生推薦" tone="danger">{validationError}</StateAlert>}

      <div className="recommend-layout">
        {/* `lg` and up only: 320px of filters beside the results (plan §5.1). */}
        <aside aria-labelledby="recommendation-filter-heading" className="recommend-sidebar">
          <h2 className="recommend-sidebar-heading" id="recommendation-filter-heading">硬條件篩選</h2>
          <FilterPanel {...panelProps} mode="sidebar" value={filters} onChange={applyFilters} />
        </aside>

        <div className="recommend-results">
          {/* Never inside the drawer: a student has to be able to see and drop a
              condition without opening anything (plan §5.2-3). */}
          <section aria-label="已套用的篩選條件" className="applied-filters" aria-live="polite">
            <TagGroup
              className="applied-filter-tags"
              selectionMode="none"
              onRemove={(keys: Set<Key>) => applyFilters(removeAppliedFilters(filters, highCreditOptions, [...keys].map(String)))}
            >
              <Label>已套用 {filterCount} 項條件</Label>
              <TagGroup.List
                items={tags}
                renderEmptyState={() => <span className="applied-filter-note">目前沒有額外的硬條件</span>}
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
            {includesUnknown && <span className="applied-filter-note">已包含部分資料不明課程</span>}
            <Button
              className="min-h-11"
              isDisabled={filterCount === 0}
              size="sm"
              variant="tertiary"
              onPress={() => applyFilters(clearFilters(filters))}
            >
              清除全部
            </Button>
          </section>

          {lastEmbedding && (
            <section aria-label="本次搜尋內容" className="search-execution-summary">
              <span><strong>本次學科主題</strong>{lastEmbedding.queryText}</span>
              <span><strong>硬條件來源</strong>篩選器設定</span>
              <span><strong>目前結果</strong>{results.length ? `顯示前 ${results.length} 門` : "尚未找到符合條件的課程"}</span>
            </section>
          )}

          {error && <StateAlert action={<Button className="mt-2 min-h-11" variant="secondary" onPress={() => void recommend()}>重試</Button>} title="推薦失敗" tone="danger">{error}</StateAlert>}
          {loading && <LoadingSkeleton count={4} label="正在產生推薦，正在比對課程內容與你設定的修課條件。" variant="card-grid" />}
          {!lastEmbedding && !loading && !error && <EmptyState headingLevel={2} title="輸入主題，開始找適合的課" variant="first-run"><div className="feature-grid"><span>明確篩選</span><span>語意檢索</span><span>關鍵字檢索</span><span>RRF 融合排名</span></div></EmptyState>}
          {lastEmbedding && !results.length && !loading && !error && <EmptyState action="清除全部條件" body="可以放寬條件，或換一個更廣泛的主題。" headingLevel={2} live title="沒有符合全部條件的課程" variant="over-filtered" onAction={() => applyFilters(clearFilters(filters))}><div className="empty-actions"><button type="button" onClick={() => document.getElementById("subject-query")?.focus()}>修改主題</button></div></EmptyState>}
          <div className="course-grid">{results.map((item, index) => <CourseCard key={item.course.course_id} course={item.course} alternatives={item.alternatives} rank={index + 1} reasons={item.reasons} recommendationCategory={item.category} />)}</div>
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

      <SideDrawer
        className="recommend-filter-sheet"
        footer={(
          <>
            {/* Clears the *draft* only. Inside the sheet nothing reaches the
                results until 套用, so this has to stay reversible by walking
                out — unlike the identically-named button on the page, which is
                already outside the draft and therefore commits at once. */}
            <Button className="min-h-11" variant="tertiary" onPress={() => setDraftFilters(clearFilters(draftFilters))}>清除全部</Button>
            <Button className="min-h-11 flex-1" onPress={commitFilterSheet}>套用 {draftFilterCount} 項</Button>
          </>
        )}
        open={filterSheetOpen}
        title="硬條件篩選"
        onClose={dismissFilterSheet}
      >
        <FilterPanel {...panelProps} mode="drawer" value={draftFilters} onChange={setDraftFilters} />
      </SideDrawer>
    </section>
  );
}
