import { useCallback, useEffect, useMemo, useRef, useState, type Key } from "react";
import {
  Button,
  ComboBox,
  Description,
  Input,
  Label,
  ListBox,
  Pagination,
  SearchField,
  Select,
  type SortDescriptor,
} from "@heroui/react";
import { FunnelSimple } from "@phosphor-icons/react";
import { useCourses, useFacets } from "@/data/queries";
import { newInteractionId, track } from "@/analytics/client";
import { nextSearchStep, type SearchFlowState } from "@/analytics/searchFlow";
import { getHighCreditOptions } from "@/domain/creditFilter";
import { evaluateEligibility } from "@/domain/eligibility";
import { filterDepartmentOptions, type DepartmentOption } from "@/domain/departmentOptions";
import { weekdayLabels } from "@/domain/schedule";
import { useLocalRecords, useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { CourseCard } from "@/components/CourseCard";
import { NumberTicker } from "@/components/motion/NumberTicker";
import { EmptyState, LoadingSkeleton, Modal, StateAlert } from "@/components/ui";
import { FilterPanel, type FacetOption } from "@/pages/recommend/FilterPanel";
import { activeFilterCount, clearFilters, createFilters, type RecommendFilters } from "@/pages/recommend/filterState";
import { CourseTable, CourseTableSkeleton, type CourseRow } from "./CourseTable";
import { useLayoutSwitchFocus } from "./useLayoutSwitchFocus";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import type { CompletedCourse } from "@/domain/types";

const PAGE_SIZE = 25;

const WEEKDAY_TOKENS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** A keyword search that has been issued but whose result count is not in yet. */
interface PendingKeywordSearch {
  interactionId: string;
  flow: SearchFlowState;
  /** Characters typed, never the characters themselves. */
  queryLength: number;
  startedAt: number;
}

/**
 * `/api/v1/facets` returns more per department than `FacetMap` advertises —
 * `code`, `name_zh` and `department_type` are all written by `_department_options`
 * (web.py:822). They are declared optional here rather than widened in
 * `data/queries.ts` so this page can rank search hits on the real department code
 * without touching a module three other pages import.
 */
interface DepartmentFacet {
  value: string;
  label: string;
  code?: string | null;
  name_zh?: string | null;
  department_type?: string | null;
}

/**
 * Adapts a facet row onto the option model `filterDepartmentOptions` speaks, so
 * the explore picker matches queries exactly the way onboarding's does — same
 * NFKC-ish normalisation, same whitespace tokenising, same code/name/alias
 * haystack, same "plain department before 在職／學士後" ranking. `division` is
 * empty because the catalogue is browsed across every division at once.
 */
function toDepartmentOption(facet: DepartmentFacet): DepartmentOption {
  return {
    key: facet.value,
    value: facet.name_zh ?? facet.label,
    identity: facet.value,
    division: "",
    divisionCode: null,
    code: facet.code ?? null,
    officialName: facet.name_zh ?? null,
    departmentType: facet.department_type ?? null,
    // The facet label is 「10-圖書資訊學系」 — code and name in one string, and
    // the only searchable text a legacy (unmatched) department has at all.
    aliases: [facet.label],
  };
}

export function ExplorePage() {
  const facetsQuery = useFacets();
  const profile = useProfile();
  const { activePlan } = useSchedulePlans();
  const completed = useLocalRecords<CompletedCourse & { id: string }>("completedCourses");
  const isDesktop = useIsDesktop();
  const { announcement, regionRef } = useLayoutSwitchFocus(isDesktop);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [department, setDepartment] = useState<string | null>(null);
  const [weekday, setWeekday] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<RecommendFilters>(() => ({
    ...createFilters([]),
    categoryFilters: [],
    showOtherWeekdays: true,
  }));
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const fullFilterReturnFocus = useRef<HTMLButtonElement | null>(null);
  /*
    Owned here, not in `CourseTable`, because `CourseTable` does not survive the
    breakpoint — see `CourseTableProps.sortDescriptor`. The page does, so the
    order a student chose is still theirs after a resize or a text-size change.
    It is deliberately *not* reset when the page or the filters change: the
    descriptor names a column and a direction, both of which stay meaningful over
    a different set of 25 rows, and silently reverting to server order on every
    keystroke would be the same disappearance in a different costume.
  */
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>();

  /*
    300ms after the last keystroke, and back to page 1 because the old page's
    results no longer exist.

    The `settledQuery` guard is the fix for a real race, not ceremony. This effect
    also runs on mount, so the original version fired `setPage(1)` 300ms after the
    page first rendered even though nobody had typed anything — silently throwing
    away any page the student picked inside that window. It is reachable by hand
    (load /explore, click 第 2 頁 immediately) and it is what made the pagination
    boundary test flaky: under a loaded test run the click landed before the timer
    and the page snapped back to 1. Resetting only when the query actually changed
    leaves the keystroke behaviour identical and closes the mount window.
  */
  const settledQuery = useRef(query);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (settledQuery.current !== query) {
        settledQuery.current = query;
        setPage(1);
      }
      setDebouncedQuery(query);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const departmentOptions = useMemo(() => {
    const facets = (facetsQuery.data?.departments ?? []) as DepartmentFacet[];
    return facets
      .map(toDepartmentOption)
      .sort((left, right) => left.aliases[0].localeCompare(right.aliases[0], "zh-Hant"));
  }, [facetsQuery.data]);

  const facets = facetsQuery.data ?? {};
  const facetOptions = (key: string) => (facets[key] ?? []) as FacetOption[];
  const creditOptions = useMemo(() => (facets.credits ?? [])
    .map((item) => Number(item.value))
    .filter((value) => Number.isFinite(value)), [facets]);
  const highCreditOptions = useMemo(() => getHighCreditOptions(creditOptions), [creditOptions]);
  const individualCreditOptions = useMemo(
    () => creditOptions.filter((credits) => !highCreditOptions.includes(credits)),
    [creditOptions, highCreditOptions],
  );
  const courseTagOptions = useMemo(
    () => (facets.course_tags ?? []).map((item) => ({ value: item.value, label: item.label })),
    [facets],
  );
  const filterPanelProps = {
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
    profileDepartmentIdentity: profile?.department_identity,
    highCreditOptions,
    individualCreditOptions,
  };

  /**
   * `defaultFilter` is per-item and receives that item's `textValue`, so — as on
   * the onboarding page — the domain helper is applied to a one-element list
   * instead of being reimplemented. Two departments can share a label (same name
   * under two identities), hence the many-to-one map and `.some`.
   */
  const optionsByTextValue = useMemo(() => {
    const map = new Map<string, DepartmentOption[]>();
    for (const option of departmentOptions) {
      map.set(option.aliases[0], [...(map.get(option.aliases[0]) ?? []), option]);
    }
    return map;
  }, [departmentOptions]);
  const departmentFilter = useCallback((text: string, inputValue: string) => (
    (optionsByTextValue.get(text) ?? []).some(
      (option) => filterDepartmentOptions([option], "", inputValue).length === 1,
    )
  ), [optionsByTextValue]);

  const coursesQuery = useCourses({
    q: debouncedQuery,
    department: department ?? "",
    weekday: weekday ?? "",
    page,
    pageSize: PAGE_SIZE,
  });
  const courses = useMemo(() => coursesQuery.data?.items ?? [], [coursesQuery.data]);
  const total = coursesQuery.data?.total ?? 0;
  const totalPages = Math.max(1, coursesQuery.data?.total_pages ?? 1);
  const error = coursesQuery.error ? (coursesQuery.error as Error).message : "";

  /**
   * Computed once for the whole page instead of once per `CourseCard`, because
   * the table needs the same verdict for its 資格 column and cards are not
   * mounted at `lg`. `CourseCard` still evaluates its own — it owns the variant
   * picker, so its selected course is not always the row's course.
   */
  const rows = useMemo<CourseRow[]>(() => {
    const completedNames = new Set(completed.map((item) => item.courseName));
    return courses.map((course) => ({
      course,
      status: evaluateEligibility(course, profile, completedNames).status,
    }));
  }, [courses, profile, completed]);

  /*
    Search analytics for the keyword field.

    Opened when the debounced query settles and closed when the matching
    response lands, which is what makes `latency_ms` the time the student
    actually waited. Only a *keyword* change opens one: paging and the two
    dropdown filters refetch the same query and are reported as `filter_used`,
    not as fresh searches.

    Nothing here holds the query. `queryLength` is a number; the text stays in
    component state and goes no further — see the privacy page.
  */
  const searchFlow = useRef<SearchFlowState>(undefined);
  const pendingSearch = useRef<PendingKeywordSearch>(undefined);
  useEffect(() => {
    const settled = debouncedQuery.trim();
    if (!settled) { pendingSearch.current = undefined; return; }
    const flow = nextSearchStep(searchFlow.current, Date.now());
    searchFlow.current = flow;
    pendingSearch.current = {
      interactionId: newInteractionId("search"),
      flow,
      queryLength: settled.length,
      startedAt: performance.now(),
    };
  }, [debouncedQuery]);

  const { data: coursesData, error: coursesError, isFetching, isPending } = coursesQuery;
  useEffect(() => {
    const pending = pendingSearch.current;
    if (!pending || isFetching || isPending) return;
    if (coursesError) {
      pendingSearch.current = undefined;
      track("error", { component: "course_search", error_code: "COURSE_QUERY_FAILED" });
      return;
    }
    if (!coursesData) return;
    pendingSearch.current = undefined;
    const resultCount = coursesData.total;
    track("search", {
      search_mode: "keyword",
      query_length: pending.queryLength,
      result_count: resultCount,
      latency_ms: Math.round(performance.now() - pending.startedAt),
    }, { interactionId: pending.interactionId });
    if (resultCount === 0) {
      track("zero_result", { search_mode: "keyword" }, { interactionId: pending.interactionId });
    }
    if (pending.flow.refinementIndex > 0) {
      track("search_refined", { refinement_index: pending.flow.refinementIndex }, { interactionId: pending.flow.flowId });
    }
  }, [coursesData, coursesError, isFetching, isPending]);

  const selectPage = (value: number) => setPage(Math.min(Math.max(1, value), totalPages));
  const filterCount = activeFilterCount(filters);
  const fullFilterLabel = filterCount
    ? "完整篩選條件 · 已套用 " + filterCount + " 項"
    : "完整篩選條件";
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
  const applyFilters = (next: RecommendFilters) => {
    setFilters(next);
    setPage(1);
  };
  const clearExploreFilters = () => {
    track("feature_clicked", { feature: "clear_filters" });
    setQuery(""); setDebouncedQuery(""); setDepartment(null); setWeekday(null); setFilters(clearFilters(filters)); setPage(1);
  };

  const firstItem = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastItem = Math.min(page * PAGE_SIZE, total);
  const showResults = !coursesQuery.isPending && !error;
  const showEmpty = showResults && !courses.length && !coursesQuery.isFetching;

  return (
    <section className="page" data-page="explore">
      <div className="page-heading">
        <div>
          {/*
            Not `.eyebrow`, for the reason T32 gave on onboarding: that legacy
            class is 12.5px with `letter-spacing:.13em` and a hard-coded green,
            all three of which plan §4.4 rules out for a CJK line.
          */}
          <p className="text-[0.9375rem] font-semibold text-muted">探索全部課程</p>
          <h1>探索課程</h1>
        </div>
        {/* One of the two places §4.6 allows a ticker: a total that settles
            after a fetch, not a live filter count that would re-run on every
            keystroke. */}
        <div className="explore-heading-actions">
          <strong><NumberTicker value={total} /> 門結果</strong>
          <Button
            aria-expanded={filterDialogOpen}
            aria-haspopup="dialog"
            className="explore-full-filter-button min-h-11"
            variant="secondary"
            onPress={openFullFilters}
          >
            <FunnelSimple aria-hidden="true" />
            {fullFilterLabel}
          </Button>
        </div>
      </div>

      {/*
        One column at 375px so the three controls never share a row — a 2fr/1fr/1fr
        grid put 開課系所 and 上課星期 in ~90px each. Two columns from `sm`, three
        only from `lg`, where the search field can still be wide enough to read a
        typed course name back.
      */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SearchField
          className="min-w-0"
          fullWidth
          name="q"
          value={query}
          onChange={setQuery}
        >
          <Label>搜尋課程</Label>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input className="min-h-11" placeholder="課名、教師、課號或系所" />
            {/* HeroUI's clear button is a 20px glyph. Measured at 375px it was
                20x20, less than half the §5.3 floor, on the one control a
                student uses to get back to the full catalogue. */}
            <SearchField.ClearButton className="min-h-11 min-w-11" />
          </SearchField.Group>
        </SearchField>

        {/*
          A ComboBox, not a Select: the facet list is the whole university. Same
          shape as onboarding's picker — `items` is deliberately not passed, since
          React Aria disables `defaultFilter` and show-all-on-focus as soon as the
          collection is controlled.
        */}
        <ComboBox
          allowsCustomValue={false}
          allowsEmptyCollection
          className="min-w-0"
          defaultFilter={departmentFilter}
          fullWidth
          menuTrigger="focus"
          name="department"
          selectedKey={department}
          onSelectionChange={(key: Key | null) => {
            // The filter's *name* only. Which department was picked is an open
            // set and is not recorded — see `analytics/filters.ts`.
            track("filter_used", { filter: "department" });
            setDepartment(key === null ? null : String(key));
            setPage(1);
          }}
        >
          <Label>開課系所</Label>
          <ComboBox.InputGroup>
            <Input className="min-h-11" placeholder="所有系所" />
            {/* Measured 24x44 at 375px. It is the only way to see the full list
                without typing, so it gets the §5.3 floor on both axes. */}
            <ComboBox.Trigger className="min-h-11 min-w-11" />
          </ComboBox.InputGroup>
          <ComboBox.Popover className="max-h-[min(60svh,22rem)]">
            <ListBox
              aria-label="開課系所"
              renderEmptyState={() => <p className="px-3 py-4 text-sm text-muted">找不到符合的開課系所。</p>}
            >
              {departmentOptions.map((option) => (
                <ListBox.Item key={option.key} id={option.key} textValue={option.aliases[0]}>
                  {option.aliases[0]}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </ComboBox.Popover>
        </ComboBox>

        {/* Seven fixed options: a Select, where a ComboBox's text input would be
            an empty affordance. */}
        <Select
          className="min-w-0"
          fullWidth
          name="weekday"
          placeholder="所有星期"
          selectedKey={weekday}
          onSelectionChange={(key) => {
            const token = key === null ? undefined : WEEKDAY_TOKENS[Number(key) - 1];
            track("filter_used", token ? { filter: "weekday", value: token } : { filter: "weekday" });
            setWeekday(key === null ? null : String(key));
            setPage(1);
          }}
        >
          <Label>上課星期</Label>
          <Select.Trigger className="min-h-11">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label="上課星期">
              {weekdayLabels.map((label, index) => (
                <ListBox.Item key={label} id={String(index + 1)} textValue={`星期${label}`}>
                  星期{label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      {coursesQuery.isPending && (isDesktop
        ? <CourseTableSkeleton label="正在載入課程" />
        : <LoadingSkeleton count={4} label="正在載入課程" variant="card-grid" />)}

      {error && (
        <StateAlert
          action={<Button className="mt-2 min-h-11" variant="secondary" onPress={() => void coursesQuery.refetch()}>重試</Button>}
          title="無法載入課程"
          tone="danger"
        >
          {error}
        </StateAlert>
      )}

      {showEmpty && (
        <EmptyState
          action="清除篩選"
          body="請嘗試較短的關鍵字，或清除目前篩選。"
          headingLevel={2}
          live
          title="找不到符合條件的課程"
          variant="over-filtered"
          onAction={clearExploreFilters}
        />
      )}

      {/*
        Mounted unconditionally and outside the `showResults` branch, because a
        live region only announces text that changes *while it is already in the
        a11y tree* — one that appears carrying its message is usually read as
        nothing at all. Empty until the first layout switch.
      */}
      <div aria-live="polite" className="sr-only" role="status">{announcement}</div>

      {showResults && (
        /*
          `tabIndex={-1}` so `useLayoutSwitchFocus` has somewhere to put focus
          when the breakpoint takes the focused widget away, and `role="region"`
          plus a name so landing here says where "here" is instead of announcing
          an anonymous group. The global `[tabindex]:focus-visible` rule in
          `styles.css` already draws the ring, so no new style is needed.
        */
        <div
          aria-busy={coursesQuery.isFetching}
          aria-label="課程結果"
          className="results-region"
          ref={regionRef}
          role="region"
          tabIndex={-1}
        >
          {coursesQuery.isFetching && <div className="updating-indicator" role="status">正在更新結果…</div>}
          {isDesktop
            ? <CourseTable onSortChange={setSortDescriptor} rows={rows} sortDescriptor={sortDescriptor} />
            : <div className="course-grid">{courses.map((item) => <CourseCard key={item.course_id} course={item} />)}</div>}
        </div>
      )}

      {showResults && courses.length > 0 && (
        <>
          {/*
            Says what the sort actually does. `/api/v1/courses` sorts server-side
            but only ascending (`web.py:203`), so a truthful descending page
            cannot be requested — see `sortCourseRows`. Page-local in both
            directions is at least consistent, and this line stops it being a
            surprise. Rendered only where the sortable table is.
          */}
          {isDesktop && (
            <Description className="mt-3 block">
              點欄位標題可排序，排序套用於目前這一頁的 {courses.length} 筆結果。
            </Description>
          )}
          <Pagination className="mt-4 flex-wrap justify-between gap-3">
            <Pagination.Summary>
              第 {firstItem.toLocaleString()}–{lastItem.toLocaleString()} 筆，共 {total.toLocaleString()} 筆
            </Pagination.Summary>
            {/*
              `flex-wrap`: measured at 375px, six 44px controls plus two worded
              nav buttons came to 408px against a 375px viewport — the only
              horizontal overflow on the page. The words are dropped below `sm`
              (the `aria-label` carries them for anyone who cannot see the
              chevron) and wrapping is the backstop for a 170-page catalogue.
            */}
            <Pagination.Content className="flex-wrap">
              <Pagination.Item>
                {/* `.pagination__link` is 36px and shrinks to 32px from `md` up,
                    so every target here is pinned to the 44px §5.3 floor. */}
                <Pagination.Previous
                  aria-label="上一頁"
                  className="min-h-11 min-w-11"
                  isDisabled={page === 1}
                  onPress={() => selectPage(page - 1)}
                >
                  <Pagination.PreviousIcon />
                  <span className="hidden sm:inline">上一頁</span>
                </Pagination.Previous>
              </Pagination.Item>
              {pageNumbers(page, totalPages).map((value, index) => (value === "ellipsis"
                ? (
                  <Pagination.Item key={`ellipsis-${index}`}>
                    <Pagination.Ellipsis />
                  </Pagination.Item>
                )
                : (
                  <Pagination.Item key={value}>
                    <Pagination.Link
                      aria-label={`第 ${value} 頁`}
                      className="min-h-11 min-w-11 tabular-nums"
                      isActive={value === page}
                      onPress={() => selectPage(value)}
                    >
                      {value}
                    </Pagination.Link>
                  </Pagination.Item>
                )))}
              <Pagination.Item>
                <Pagination.Next
                  aria-label="下一頁"
                  className="min-h-11 min-w-11"
                  isDisabled={page >= totalPages}
                  onPress={() => selectPage(page + 1)}
                >
                  <span className="hidden sm:inline">下一頁</span>
                  <Pagination.NextIcon />
                </Pagination.Next>
              </Pagination.Item>
            </Pagination.Content>
          </Pagination>
        </>
      )}

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
            onPress={() => applyFilters(clearFilters(filters))}
          >
            清除全部
          </Button>
        </div>
        <FilterPanel {...filterPanelProps} mode="modal" value={filters} onChange={applyFilters} />
      </Modal>
    </section>
  );
}

/**
 * First, last, and the current page with a neighbour on each side. Capped at
 * seven items so the row still fits a 375px screen once every target is 44px.
 */
export function pageNumbers(page: number, totalPages: number): (number | "ellipsis")[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages: (number | "ellipsis")[] = [1];
  if (page > 3) pages.push("ellipsis");
  for (let value = Math.max(2, page - 1); value <= Math.min(totalPages - 1, page + 1); value += 1) {
    pages.push(value);
  }
  if (page < totalPages - 2) pages.push("ellipsis");
  pages.push(totalPages);
  return pages;
}
