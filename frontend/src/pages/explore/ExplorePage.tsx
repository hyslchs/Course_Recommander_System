import { useEffect, useMemo, useState } from "react";
import { getCourses, getFacets } from "@/data/api";
import { weekdayLabels } from "@/domain/schedule";
import { CourseCard } from "@/components/CourseCard";
import type { Course, Profile } from "@/domain/types";

export function ExplorePage({ profile }: { profile?: Profile }) {
  const [facets, setFacets] = useState<Record<string, { value: string; label: string }[]>>({});
  useEffect(() => { void getFacets().then(setFacets).catch(() => undefined); }, []);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [department, setDepartment] = useState("");
  const [weekday, setWeekday] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const departments = useMemo(() => [...(facets.departments ?? [])]
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hant")), [facets]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedQuery(query); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const params = new URLSearchParams({ page: String(page), page_size: "25" });
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (department) params.set("department", department);
      if (weekday) params.set("weekday", weekday);
      setLoading(true); setError("");
      try {
        const result = await getCourses(params, controller.signal);
        setCourses(result.items); setTotal(result.total); setHasLoaded(true);
      } catch (caught) {
        if ((caught as Error).name === "AbortError") return;
        setError((caught as Error).message); setHasLoaded(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [debouncedQuery, department, page, retryKey, weekday]);
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
      {loading && !hasLoaded && <div className="course-grid skeleton-grid" role="status" aria-label="正在載入課程">{[1, 2, 3, 4].map((item) => <div className="course-skeleton" key={item}><span></span><span></span><span></span></div>)}</div>}
      {error && <div className="notice danger" role="alert">無法載入課程：{error}<button type="button" onClick={() => setRetryKey((value) => value + 1)}>重試</button></div>}
      {hasLoaded && !error && !courses.length && !loading && <div className="empty-panel"><h2>找不到符合條件的課程</h2><p>請嘗試較短的關鍵字，或清除目前篩選。</p><button type="button" onClick={clearExploreFilters}>清除篩選</button></div>}
      {hasLoaded && !error && <div className="results-region" aria-busy={loading}>{loading && <div className="updating-indicator" role="status">正在更新結果…</div>}<div className="course-grid">{courses.map((item) => <CourseCard key={item.course_id} course={item} profile={profile} />)}</div></div>}
      {hasLoaded && !error && courses.length > 0 && <div className="pager"><button disabled={loading || page === 1} onClick={() => setPage((value) => value - 1)}>上一頁</button><span>第 {page} 頁</span><button disabled={loading || page * 25 >= total} onClick={() => setPage((value) => value + 1)}>下一頁</button></div>}
    </section>
  );
}
