import { useEffect, useMemo, useState } from "react";
import { useCourses, useFacets } from "@/data/queries";
import { weekdayLabels } from "@/domain/schedule";
import { CourseCard } from "@/components/CourseCard";

export function ExplorePage() {
  const facetsQuery = useFacets();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [department, setDepartment] = useState("");
  const [weekday, setWeekday] = useState("");
  const [page, setPage] = useState(1);
  const departments = useMemo(() => [...(facetsQuery.data?.departments ?? [])]
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hant")), [facetsQuery.data]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedQuery(query); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  // Query owns the request lifecycle: superseded filter changes are aborted via
  // the `signal` it hands `getCourses`, and `keepPreviousData` holds the last
  // successful page on screen instead of a hand-rolled `hasLoaded` flag.
  const coursesQuery = useCourses({ q: debouncedQuery, department, weekday, page, pageSize: 25 });
  const courses = coursesQuery.data?.items ?? [];
  const total = coursesQuery.data?.total ?? 0;
  const error = coursesQuery.error ? (coursesQuery.error as Error).message : "";
  const clearExploreFilters = () => {
    setQuery(""); setDebouncedQuery(""); setDepartment(""); setWeekday(""); setPage(1);
  };
  return (
    <section className="page">
      <div className="page-heading"><div><div className="eyebrow">探索全部課程</div><h1>課程資料庫</h1></div><strong>{total.toLocaleString()} 門結果</strong></div>
      <div className="filters-bar">
        <label><span>搜尋課程</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="課名、教師、課號或系所" /></label>
        <label><span>開課系所</span><select value={department} onChange={(event) => { setDepartment(event.target.value); setPage(1); }}><option value="">所有系所</option>{departments.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>上課星期</span><select value={weekday} onChange={(event) => { setWeekday(event.target.value); setPage(1); }}><option value="">所有星期</option>{weekdayLabels.map((label, index) => <option key={label} value={index + 1}>星期{label}</option>)}</select></label>
      </div>
      {coursesQuery.isPending && <div className="course-grid skeleton-grid" role="status" aria-label="正在載入課程">{[1, 2, 3, 4].map((item) => <div className="course-skeleton" key={item}><span></span><span></span><span></span></div>)}</div>}
      {error && <div className="notice danger" role="alert">無法載入課程：{error}<button type="button" onClick={() => void coursesQuery.refetch()}>重試</button></div>}
      {!coursesQuery.isPending && !error && !courses.length && !coursesQuery.isFetching && <div className="empty-panel"><h2>找不到符合條件的課程</h2><p>請嘗試較短的關鍵字，或清除目前篩選。</p><button type="button" onClick={clearExploreFilters}>清除篩選</button></div>}
      {!coursesQuery.isPending && !error && <div className="results-region" aria-busy={coursesQuery.isFetching}>{coursesQuery.isFetching && <div className="updating-indicator" role="status">正在更新結果…</div>}<div className="course-grid">{courses.map((item) => <CourseCard key={item.course_id} course={item} />)}</div></div>}
      {!coursesQuery.isPending && !error && courses.length > 0 && <div className="pager"><button disabled={coursesQuery.isFetching || page === 1} onClick={() => setPage((value) => value - 1)}>上一頁</button><span>第 {page} 頁</span><button disabled={coursesQuery.isFetching || page * 25 >= total} onClick={() => setPage((value) => value + 1)}>下一頁</button></div>}
    </section>
  );
}
