import { useCallback, useEffect, useMemo, useState } from "react";
import { useFacets, useRecommendationSources, type FacetMap } from "@/data/queries";
import { putRecord } from "@/data/db";
import { formatCreditFilterSummary, getHighCreditOptions, isHighCreditFilterSelected, toggleHighCreditFilter } from "@/domain/creditFilter";
import { inferProfileStudyLevel } from "@/domain/eligibility";
import { defaultPreferredWeekdays } from "@/domain/profileDefaults";
import {
  rankCourses,
  recommendationCategoryLabels,
  type CourseLevelFilter,
  type PrerequisiteFilter,
  type TimeOfDayFilter,
} from "@/domain/recommendation";
import { weekdayLabels } from "@/domain/schedule";
import { coursesInPlan, meetingsInPlan } from "@/domain/scheduleUtils";
import { buildSearchIndex } from "@/domain/search";
import { sanitizeSubjectQuery, type DetectedFilterPhrase } from "@/domain/subjectQuery";
import { useLocalRecords, useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { CourseCard } from "@/components/CourseCard";
import { EmptyState, LoadingSkeleton, StateAlert } from "@/components/ui";
import { Button } from "@heroui/react";
import type {
  CompletedCourse,
  Course,
  Recommendation,
  RecommendationCategory,
  RecommendationCategoryFilters,
} from "@/domain/types";

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
  const [preferredWeekdays, setPreferredWeekdays] = useState<number[]>(
    profile?.preferredWeekdays?.length ? profile.preferredWeekdays : defaultPreferredWeekdays,
  );
  const [showOtherWeekdays, setShowOtherWeekdays] = useState(false);
  const [creditFilters, setCreditFilters] = useState<number[]>([]);
  const [timeOfDayFilter, setTimeOfDayFilter] = useState<TimeOfDayFilter>("all");
  const [includeUnknownSchedule, setIncludeUnknownSchedule] = useState(true);
  const [prerequisiteFilter, setPrerequisiteFilter] = useState<PrerequisiteFilter>("exclude_unmet");
  const [includeUnknownPrerequisite, setIncludeUnknownPrerequisite] = useState(false);
  const [courseLevelFilter, setCourseLevelFilter] = useState<CourseLevelFilter>("all");
  const [includeUnknownCourseLevel, setIncludeUnknownCourseLevel] = useState(false);
  const [includeScheduleInfo, setIncludeScheduleInfo] = useState(true);
  const [categoryFilters, setCategoryFilters] = useState<RecommendationCategoryFilters>([]);
  const [courseTagFilters, setCourseTagFilters] = useState<string[]>([]);
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
    setPreferredWeekdays(profile?.preferredWeekdays?.length ? profile.preferredWeekdays : defaultPreferredWeekdays);
  }, [profile?.preferredWeekdays]);
  const creditOptions = useMemo(() => (facets.credits ?? [])
    .map((item) => Number(item.value))
    .filter((value) => Number.isFinite(value)), [facets]);
  const highCreditOptions = useMemo(() => getHighCreditOptions(creditOptions), [creditOptions]);
  const individualCreditOptions = useMemo(() => creditOptions.filter((credits) => !highCreditOptions.includes(credits)), [creditOptions, highCreditOptions]);
  const highCreditFilterSelected = isHighCreditFilterSelected(creditFilters, highCreditOptions);
  const creditFilterSummary = formatCreditFilterSummary(creditFilters, highCreditOptions);
  const courseTagOptions = useMemo(() => (facets.course_tags ?? [])
    .map((item) => ({ code: item.value, label_zh: item.label })), [facets]);
  const sanitizedPreview = useMemo(() => sanitizeSubjectQuery(interest), [interest]);
  const rerank = useCallback((embedding: RecommendationEmbedding, filters: RecommendationCategoryFilters) => {
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
      categoryFilters: filters,
      courseTagFilters,
      creditFilters,
      completed,
      dismissedIds: dismissed.map((item) => item.id),
      preferredWeekdays,
      includeNonPreferredWeekdays: showOtherWeekdays,
      timeOfDayFilter,
      includeUnknownSchedule,
      prerequisiteFilter,
      includeUnknownPrerequisite,
      courseLevelFilter,
      includeUnknownCourseLevel,
      scheduledCourses: includeScheduleInfo ? scheduledCourses : [],
      scheduledMeetings: includeScheduleInfo ? scheduledMeetings : [],
    }));
  }, [activePlan, catalog, completed, courseLevelFilter, courseTagFilters, creditFilters, dismissed, includeScheduleInfo, includeUnknownCourseLevel, includeUnknownPrerequisite, includeUnknownSchedule, prerequisiteFilter, preferredWeekdays, profile, searchIndex, showOtherWeekdays, timeOfDayFilter]);
  useEffect(() => {
    if (lastEmbedding) rerank(lastEmbedding, categoryFilters);
  }, [categoryFilters, courseTagFilters, lastEmbedding, rerank]);
  const toggleCategoryFilter = (category: RecommendationCategory) => {
    setCategoryFilters((current) => current.includes(category)
      ? current.filter((item) => item !== category)
      : [...current, category]);
  };
  const toggleCourseTagFilter = (code: string) => {
    setCourseTagFilters((current) => current.includes(code)
      ? current.filter((item) => item !== code)
      : [...current, code]);
  };
  const activeFilterCount = [
    !showOtherWeekdays,
    timeOfDayFilter !== "all",
    creditFilters.length > 0,
    prerequisiteFilter === "exclude_unmet",
    includeUnknownPrerequisite,
    courseLevelFilter !== "all",
    includeUnknownCourseLevel,
    includeScheduleInfo,
    categoryFilters.length > 0,
    courseTagFilters.length > 0,
  ].filter(Boolean).length;
  const clearFilters = () => {
    setShowOtherWeekdays(true);
    setCreditFilters([]);
    setTimeOfDayFilter("all");
    setIncludeUnknownSchedule(true);
    setPrerequisiteFilter("show_with_warning");
    setIncludeUnknownPrerequisite(false);
    setCourseLevelFilter("all");
    setIncludeUnknownCourseLevel(false);
    setIncludeScheduleInfo(false);
    setCategoryFilters([]);
    setCourseTagFilters([]);
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
    if (!preferredWeekdays.length) {
      setValidationError("請至少勾選一個偏好的上課星期，才能產生推薦。");
      return;
    }
    setValidationError("");
    if (profile) {
      await putRecord("profile", {
        ...profile,
        interests: interest.trim(),
        preferredWeekdays,
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
  const togglePreferredWeekday = (day: number) => {
    setPreferredWeekdays((current) => {
      const next = current.includes(day) ? current.filter((item) => item !== day) : [...current, day];
      if (next.length) setValidationError("");
      return next;
    });
  };
  if (!profile) return <EmptyState action="開始設定" body="設定系所與年級後，才能判斷課程限制並產生推薦。" href="/onboarding" title="先完成個人設定" variant="missing-prerequisite" />;
  return (
    <section className="page">
      <div className="hero"><div><div className="eyebrow">115-1 個人化推薦</div><h1>找到真正適合你的下一門課</h1><p>推薦在你的裝置上完成；已修課、收藏和課表不會送到後端。</p></div><div className="privacy-pill">● Local-first</div></div>
      <div className="recommend-box"><div className="subject-query-field"><label htmlFor="subject-query">想學的主題或技能</label><textarea id="subject-query" aria-label="想學的主題或技能" aria-invalid={Boolean(validationError && !sanitizedPreview.subjectQuery)} aria-describedby={validationError && !sanitizedPreview.subjectQuery ? "recommend-subject-error" : undefined} maxLength={500} value={interest} onChange={(e) => setInterest(e.target.value)} placeholder="例如：電子商務、社群行銷、零售數據分析與業界案例" /><small>搜尋文字只決定課程內容的相關性；上課星期、學分與先修條件請使用下方篩選器。課程學制會標示在結果卡片上。</small>{validationError && !sanitizedPreview.subjectQuery && <small id="recommend-subject-error" className="field-error">{validationError}</small>}</div><button className="primary" onClick={recommend} disabled={loading}>{loading ? "正在分析…" : "產生推薦"}</button></div>
      {validationError && <StateAlert className="error-summary" title="請修正後再產生推薦" tone="danger">{validationError}</StateAlert>}
      {lastEmbedding && <section className="search-execution-summary" aria-label="本次搜尋內容"><span><strong>本次學科主題</strong>{lastEmbedding.queryText}</span><span><strong>硬條件來源</strong>下方明確篩選器</span><span><strong>目前結果</strong>{results.length ? `顯示前 ${results.length} 門` : "尚未找到符合條件的課程"}</span></section>}
      <section className="filter-workspace" aria-labelledby="recommendation-filter-heading">
        <div className="filter-section-heading"><div><span>硬條件篩選</span><h2 id="recommendation-filter-heading">選出真正可修的課</h2></div><p>先設定重要條件，再依學科主題排序；不常用的選項會收在進階設定。</p></div>
        <div className="applied-filters" aria-live="polite"><div><strong>已套用 {activeFilterCount} 項條件</strong><div className="applied-filter-list">
          {!showOtherWeekdays && <button type="button" onClick={() => setShowOtherWeekdays(true)}>星期{preferredWeekdays.map((day) => weekdayLabels[day - 1]).join("、")}<span aria-hidden="true">×</span></button>}
          {timeOfDayFilter !== "all" && <button type="button" onClick={() => { setTimeOfDayFilter("all"); setIncludeUnknownSchedule(true); }}>{timeOfDayFilter === "daytime" ? "日間 D 節" : timeOfDayFilter === "evening" ? "晚間 E 節" : "平日晚間＋週六"}<span aria-hidden="true">×</span></button>}
          {creditFilters.length > 0 && <button type="button" onClick={() => setCreditFilters([])}>{creditFilterSummary}<span aria-hidden="true">×</span></button>}
          {prerequisiteFilter === "exclude_unmet" && <button type="button" onClick={() => setPrerequisiteFilter("show_with_warning")}>排除未滿足先修<span aria-hidden="true">×</span></button>}
          {courseLevelFilter !== "all" && <button type="button" onClick={() => setCourseLevelFilter("all")}>{courseLevelFilter === "exclude_introductory" ? "排除入門" : `只要${courseLevelFilter === "introductory" ? "入門" : courseLevelFilter === "intermediate" ? "中階" : "進階"}`}<span aria-hidden="true">×</span></button>}
          {includeScheduleInfo && <button type="button" onClick={() => setIncludeScheduleInfo(false)}>檢查衝堂<span aria-hidden="true">×</span></button>}
          {categoryFilters.length > 0 && <button type="button" onClick={() => setCategoryFilters([])}>課程類別 {categoryFilters.length}<span aria-hidden="true">×</span></button>}
          {courseTagFilters.length > 0 && <button type="button" onClick={() => setCourseTagFilters([])}>官方標籤 {courseTagFilters.length}<span aria-hidden="true">×</span></button>}
          {(includeUnknownPrerequisite || includeUnknownCourseLevel) && <span className="applied-filter-note">已包含部分資料不明課程</span>}
        </div></div><button type="button" className="clear-filters" onClick={clearFilters} disabled={activeFilterCount === 0}>清除全部</button></div>
        <details className="filter-group" open>
          <summary><span><b>上課安排</b><small>{showOtherWeekdays ? "不限星期" : `星期${preferredWeekdays.map((day) => weekdayLabels[day - 1]).join("、")}`}{timeOfDayFilter !== "all" && " · 已限制時段"}{creditFilters.length > 0 && ` · ${creditFilterSummary}`}</small></span><span className="filter-group-count">常用</span></summary>
          <div className="filter-group-content">
            <div className="filter-control"><div className="filter-control-heading"><strong>上課星期</strong><span>{showOtherWeekdays ? "目前不依星期排除" : "只顯示可上的星期"}</span></div><div className="choice-row" aria-label="偏好的上課星期" aria-describedby={!preferredWeekdays.length ? "weekday-error" : undefined}>{weekdayLabels.map((label, index) => { const day = index + 1; return <button type="button" className={`choice-chip ${preferredWeekdays.includes(day) ? "selected" : ""}`} aria-pressed={preferredWeekdays.includes(day)} key={day} onClick={() => togglePreferredWeekday(day)}>星期{label}</button>; })}</div>{!preferredWeekdays.length && <small id="weekday-error" className="field-error">請至少選擇一個星期</small>}<button type="button" className={`filter-toggle ${showOtherWeekdays ? "active" : ""}`} aria-pressed={showOtherWeekdays} onClick={() => setShowOtherWeekdays((current) => !current)}>暫時忽略星期限制</button></div>
            
            <div className="filter-control"><div className="filter-control-heading"><strong>學分數</strong><span>{creditFilters.length ? `只顯示 ${creditFilterSummary}` : "不限學分"}</span></div><div className="filter-chip-grid"><button type="button" className={`filter-choice ${creditFilters.length === 0 ? "selected" : ""}`} aria-pressed={creditFilters.length === 0} onClick={() => setCreditFilters([])}>不限學分</button>{individualCreditOptions.map((credits) => <button type="button" className={`filter-choice ${creditFilters.includes(credits) ? "selected" : ""}`} aria-pressed={creditFilters.includes(credits)} key={credits} onClick={() => setCreditFilters((current) => current.includes(credits) ? current.filter((item) => item !== credits) : [...current, credits])}>{credits} 學分</button>)}{highCreditOptions.length > 0 && <button type="button" className={`filter-choice ${highCreditFilterSelected ? "selected" : ""}`} aria-pressed={highCreditFilterSelected} onClick={() => setCreditFilters((current) => toggleHighCreditFilter(current, highCreditOptions))}>4 學分以上</button>}</div></div>
            <div className="filter-control filter-schedule-toggle"><div><strong>課表衝堂</strong><span>{includeScheduleInfo ? `已納入「${activePlan?.name ?? "目前課表"}」` : "不檢查目前課表"}</span></div><button type="button" className={`filter-toggle ${includeScheduleInfo ? "active" : ""}`} aria-pressed={includeScheduleInfo} onClick={() => setIncludeScheduleInfo((current) => !current)}>納入完整課表檢查衝堂</button></div>
          </div>
        </details>
        <details className="filter-group">
          <summary><span><b>修課資格</b><small>{prerequisiteFilter === "exclude_unmet" ? "排除未滿足先修" : "保留先修提醒"}</small></span><span className="filter-group-count">{[prerequisiteFilter === "exclude_unmet", courseLevelFilter !== "all"].filter(Boolean).length} 項</span></summary>
          <div className="filter-group-content">
            <div className="filter-control"><div className="filter-control-heading"><strong>先修條件</strong><span>根據你的已修課程判斷</span></div><div className="filter-chip-grid" role="radiogroup" aria-label="先修條件"><label className={`filter-choice radio-choice ${prerequisiteFilter === "exclude_unmet" ? "selected" : ""}`}><input type="radio" name="prerequisite" checked={prerequisiteFilter === "exclude_unmet"} onChange={() => setPrerequisiteFilter("exclude_unmet")} /><span>隱藏我尚未完成先修條件的課程</span></label><label className={`filter-choice radio-choice ${prerequisiteFilter === "show_with_warning" ? "selected" : ""}`}><input type="radio" name="prerequisite" checked={prerequisiteFilter === "show_with_warning"} onChange={() => setPrerequisiteFilter("show_with_warning")} /><span>仍顯示，但提醒我尚未完成先修條件</span></label></div><details className="filter-advanced"><summary>進階設定 <small>{includeUnknownPrerequisite ? "已包含資料不明課程" : "不含資料不明課程"}</small></summary><button type="button" className={`filter-toggle ${includeUnknownPrerequisite ? "active" : ""}`} aria-pressed={includeUnknownPrerequisite} onClick={() => setIncludeUnknownPrerequisite((current) => !current)}>也顯示無法自動判斷先修資格的課程</button></details></div>
            <div className="filter-control"><div className="filter-control-heading"><strong>課程程度</strong><span>只依課名中的明確字樣保守判定</span></div><div className="filter-chip-grid" role="radiogroup" aria-label="課程程度">{([['all', '不限程度'], ['exclude_introductory', '排除入門'], ['introductory', '只要入門'], ['intermediate', '只要中階'], ['advanced', '只要進階']] as const).map(([value, label]) => <label className={"filter-choice radio-choice " + (courseLevelFilter === value ? "selected" : "")} key={value}><input type="radio" name="course-level" value={value} checked={courseLevelFilter === value} onChange={() => setCourseLevelFilter(value)} /><span>{label}</span></label>)}</div>{courseLevelFilter !== "all" && <details className="filter-advanced"><summary>進階設定 <small>{includeUnknownCourseLevel ? "已顯示程度不明課程" : "不顯示程度不明課程"}</small></summary><button type="button" className={`filter-toggle ${includeUnknownCourseLevel ? "active" : ""}`} aria-pressed={includeUnknownCourseLevel} onClick={() => setIncludeUnknownCourseLevel((current) => !current)}>另外顯示程度資料不明的課程</button></details>}</div>
          </div>
        </details>
        <details className="filter-group">
          <summary><span><b>課程偏好</b><small>{categoryFilters.length || courseTagFilters.length ? `已選 ${categoryFilters.length + courseTagFilters.length} 個分類／標籤` : "不限類別與官方標籤"}</small></span><span className="filter-group-count">{categoryFilters.length + courseTagFilters.length} 項</span></summary>
          <div className="filter-group-content">
            <div className="filter-control"><div className="filter-control-heading"><strong>課程類別</strong><span>{categoryFilters.length ? `先保留已選的 ${categoryFilters.length} 類` : "全部課程"}</span></div><div className="filter-chip-grid"><button type="button" className={`filter-choice ${categoryFilters.length === 0 ? "selected" : ""}`} aria-pressed={categoryFilters.length === 0} onClick={() => setCategoryFilters([])}>全部課程</button>{Object.entries(recommendationCategoryLabels).map(([value, label]) => { const category = value as RecommendationCategory; return <button type="button" className={`filter-choice ${categoryFilters.includes(category) ? "selected" : ""}`} aria-pressed={categoryFilters.includes(category)} key={category} onClick={() => toggleCategoryFilter(category)}>{label}</button>; })}</div></div>
            <div className="filter-control"><div className="filter-control-heading"><strong>官方課程標籤</strong><span>{courseTagFilters.length ? "保留符合任一已選標籤的課程" : "不限官方標籤"}</span></div><div className="filter-chip-grid"><button type="button" className={`filter-choice ${courseTagFilters.length === 0 ? "selected" : ""}`} aria-pressed={courseTagFilters.length === 0} onClick={() => setCourseTagFilters([])}>不限官方標籤</button>{courseTagOptions.map((tag) => <button type="button" className={`filter-choice ${courseTagFilters.includes(tag.code) ? "selected" : ""}`} aria-pressed={courseTagFilters.includes(tag.code)} key={tag.code} onClick={() => toggleCourseTagFilter(tag.code)}>{tag.label_zh}</button>)}</div></div>
          </div>
        </details>
      </section>
      {validationError && <StateAlert live="off" tone="danger">{validationError}</StateAlert>}
      {error && <StateAlert action={<Button className="mt-2 min-h-11" variant="secondary" onPress={() => void recommend()}>重試</Button>} title="推薦失敗" tone="danger">{error}</StateAlert>}
      {loading && <LoadingSkeleton count={4} label="正在產生推薦，正在比對課程內容與你設定的修課條件。" variant="card-grid" />}
      {!lastEmbedding && !loading && !error && <EmptyState headingLevel={2} title="輸入主題，開始找適合的課" variant="first-run"><div className="feature-grid"><span>明確篩選</span><span>語意檢索</span><span>關鍵字檢索</span><span>RRF 融合排名</span></div></EmptyState>}
      {lastEmbedding && !results.length && !loading && !error && <EmptyState action="清除全部條件" body="可以放寬條件，或換一個更廣泛的主題。" headingLevel={2} live title="沒有符合全部條件的課程" variant="over-filtered" onAction={clearFilters}><div className="empty-actions"><button type="button" onClick={() => document.getElementById("subject-query")?.focus()}>修改主題</button></div></EmptyState>}
      <div className="course-grid">{results.map((item, index) => <CourseCard key={item.course.course_id} course={item.course} alternatives={item.alternatives} rank={index + 1} reasons={item.reasons} recommendationCategory={item.category} />)}</div>
    </section>
  );
}
