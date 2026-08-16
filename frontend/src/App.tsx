import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { embedQuery, getCatalog, getCourses, getEmbeddingBundle } from "./api";
import {
  clearPersonalData,
  createBackup,
  deleteRecord,
  getAllRecords,
  getRecord,
  importBackup,
  putRecord,
  validateBackup,
  type StoreName,
} from "./db";
import { courseConflicts, evaluateEligibility, getEligibilityRules, inferAudienceDepartment, inferProfileStudyLevel } from "./eligibility";
import { rankCourses, recommendationCategoryLabels } from "./recommendation";
import { buildSearchIndex, type SearchIndex } from "./search";
import type {
  CompletedCourse,
  Course,
  EligibilityStatus,
  Profile,
  Recommendation,
  RecommendationCategory,
  RecommendationCategoryFilters,
  SchedulePlan,
  StudyLevel,
} from "./types";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const defaultPreferredWeekdays = [1, 2, 3, 4, 5];
const statusLabels: Record<EligibilityStatus, string> = {
  no_known_restriction: "尚未判定出明確限制",
  eligible_confirmed: "條件已符合",
  blocked_confirmed: "目前不可修",
  needs_confirmation: "需要確認",
};

type RecommendationEmbedding = {
  query: Float32Array;
  queryText: string;
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
};

function useStore<T>(store: StoreName): [T[], () => Promise<void>] {
  const [rows, setRows] = useState<T[]>([]);
  const reload = useCallback(async () => setRows(await getAllRecords<T>(store)), [store]);
  useEffect(() => {
    void reload();
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail === store || detail === "all") void reload();
    };
    window.addEventListener("fju-local-data", listener);
    return () => window.removeEventListener("fju-local-data", listener);
  }, [reload, store]);
  return [rows, reload];
}

function App() {
  const [catalog, setCatalog] = useState<Course[]>([]);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    getCatalog().then(setCatalog).catch((error: Error) => setCatalogError(error.message));
  }, []);
  const searchIndex = useMemo(() => buildSearchIndex(catalog), [catalog]);
  const [profiles] = useStore<Profile>("profile");
  const profile = profiles.find((item) => item.id === "current");

  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink to="/recommend" className="brand"><span>FJU</span><strong>選課指南</strong></NavLink>
        <nav>
          <NavLink to="/recommend">為你推薦</NavLink>
          <NavLink to="/explore">探索課程</NavLink>
          <NavLink to="/schedule">我的課表</NavLink>
          <NavLink to="/data">資料管理</NavLink>
        </nav>
        <NavLink className="profile-link" to="/onboarding">{profile ? `${profile.department} ${profile.grade} 年級` : "開始設定"}</NavLink>
      </header>
      {catalogError && <div className="error-banner">課程資料尚未就緒：{catalogError}</div>}
      <main>
        <Routes>
          <Route path="/" element={<Navigate to={profile ? "/recommend" : "/onboarding"} replace />} />
          <Route path="/onboarding" element={<Onboarding catalog={catalog} profile={profile} />} />
          <Route path="/recommend" element={<RecommendPage catalog={catalog} profile={profile} searchIndex={searchIndex} />} />
          <Route path="/explore" element={<ExplorePage catalog={catalog} profile={profile} />} />
          <Route path="/schedule" element={<SchedulePage catalog={catalog} />} />
          <Route path="/data" element={<DataPage catalog={catalog} />} />
        </Routes>
      </main>
      <footer>MVP 1.0 · 推薦結果僅供規劃參考，實際資格、名額與開課資訊以校方選課系統為準。</footer>
    </div>
  );
}

function Onboarding({ catalog, profile }: { catalog: Course[]; profile?: Profile }) {
  const navigate = useNavigate();
  const divisions = useMemo(() => [...new Set(catalog.map((item) => item.division).filter(Boolean))].sort(), [catalog]);
  const departmentOptions = useMemo(() => {
    type DepartmentOption = { key: string; value: string; identity: string | null; divisionCode: string | null; code: string | null; officialName: string | null; departmentType: string | null };
    const byKey = new Map<string, DepartmentOption>();
    const addOption = (option: DepartmentOption) => {
      if (!byKey.has(option.key)) byKey.set(option.key, option);
    };
    for (const item of catalog) {
      if (item.department_code || item.official_department_name_zh) {
        addOption({
          key: item.department_identity ?? `${item.division_code ?? item.division ?? "unknown"}:${item.department_code ?? item.official_department_label ?? item.official_department_name_zh ?? item.department}:${item.official_department_type ?? "unknown"}`,
          value: item.official_department_name_zh ?? item.department,
          identity: item.department_identity ?? null,
          divisionCode: item.division_code ?? null,
          code: item.department_code ?? null,
          officialName: item.official_department_name_zh ?? null,
          departmentType: item.official_department_type ?? null,
        });
      }
      for (const candidate of item.department_match?.candidate_details ?? []) {
        addOption({
          key: `${candidate.division_code ?? item.division_code ?? item.division ?? "unknown"}:${candidate.code ?? candidate.label ?? candidate.name_zh}:${candidate.department_type ?? "unknown"}`,
          value: candidate.name_zh ?? item.department,
          identity: candidate.code ? `${candidate.division_code ?? item.division_code ?? item.division ?? "unknown"}:${candidate.code}:${candidate.department_type || "unknown"}` : null,
          divisionCode: candidate.division_code ?? item.division_code ?? null,
          code: candidate.code,
          officialName: candidate.name_zh,
          departmentType: candidate.department_type,
        });
      }
      if (!item.department_code && !item.official_department_name_zh && !item.department_match?.candidate_details?.length && item.department) {
        addOption({ key: `legacy:${item.department}`, value: item.department, identity: null, divisionCode: item.division_code ?? null, code: null, officialName: null, departmentType: null });
      }
    }
    return [...byKey.values()].sort((left, right) => (left.officialName ?? left.value).localeCompare(right.officialName ?? right.value, "zh-Hant"));
  }, [catalog]);
  const profileDepartmentOption = (value: Profile) => departmentOptions.find((item) => (
    (value.department_identity && item.identity === value.department_identity)
    || (!value.department_identity && value.department_code && item.code === value.department_code)
    || (value.official_department_name_zh && item.officialName === value.official_department_name_zh)
    || (!value.department_code && !value.official_department_name_zh && item.value === value.department
      && departmentOptions.filter((candidate) => candidate.value === value.department).length === 1)
  ));
  const [form, setForm] = useState<Profile>(profile ? {
    ...profile,
    department_code: profile.department_code ?? profileDepartmentOption(profile)?.code,
    department_identity: profile.department_identity ?? profileDepartmentOption(profile)?.identity,
    division_code: profile.division_code ?? profileDepartmentOption(profile)?.divisionCode,
    official_department_name_zh: profile.official_department_name_zh ?? profileDepartmentOption(profile)?.officialName,
    official_department_type: profile.official_department_type ?? profileDepartmentOption(profile)?.departmentType,
    studyLevel: inferProfileStudyLevel(profile),
  } : {
    id: "current", division: "日間部", department: "", grade: 1,
    admissionYear: 115, interests: "", preferredWeekdays: defaultPreferredWeekdays,
    allowCrossDepartment: true, studyLevel: "undergraduate", updatedAt: new Date().toISOString(),
  });
  useEffect(() => {
    if (profile) {
      const option = profileDepartmentOption(profile);
      setForm({
        ...profile,
        department_code: profile.department_code ?? option?.code,
        department_identity: profile.department_identity ?? option?.identity,
        division_code: profile.division_code ?? option?.divisionCode,
        official_department_name_zh: profile.official_department_name_zh ?? option?.officialName,
        official_department_type: profile.official_department_type ?? option?.departmentType,
        studyLevel: inferProfileStudyLevel(profile),
      });
    }
  }, [profile, departmentOptions]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.department) return;
    const option = profileDepartmentOption(form);
    await putRecord("profile", {
      ...form,
      department_code: form.department_code ?? option?.code,
      department_identity: form.department_identity ?? option?.identity,
      division_code: form.division_code ?? option?.divisionCode,
      official_department_name_zh: form.official_department_name_zh ?? option?.officialName,
      updatedAt: new Date().toISOString(),
    });
    navigate("/recommend");
  };
  const selectedDepartmentOption = profileDepartmentOption(form);
  const selectedDepartmentKey = selectedDepartmentOption?.key ?? (form.department ? `legacy:${form.department}` : "");
  return (
    <section className="narrow-page">
      <div className="eyebrow">只存在這台裝置</div>
      <h1>先設定你的基本資料</h1>
      <p className="lead">系級與修課紀錄會保存在瀏覽器，不會建立帳號或上傳到伺服器。</p>
      <form className="card form-grid" onSubmit={save}>
        <label>部別<select value={form.division} onChange={(e) => setForm({ ...form, division: e.target.value })}>{divisions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>系所<select value={selectedDepartmentKey} onChange={(e) => { const option = departmentOptions.find((item) => item.key === e.target.value); if (option) setForm({ ...form, department: option.value, department_identity: option.identity, division_code: option.divisionCode, department_code: option.code, official_department_name_zh: option.officialName, official_department_type: option.departmentType ?? undefined }); }} required><option value="">請選擇系所</option>{form.department && !selectedDepartmentOption && <option value={`legacy:${form.department}`}>{form.department}（舊設定，請重新選擇官方系所）</option>}{departmentOptions.map((option) => <option key={option.key} value={option.key}>{option.code ? `${option.code}-${option.officialName ?? option.value}` : option.value}</option>)}</select></label>
        <label>年級<select value={form.grade} onChange={(e) => setForm({ ...form, grade: Number(e.target.value) })}>{[1,2,3,4,5,6,7].map((value) => <option key={value} value={value}>{value} 年級</option>)}</select></label>
        <label>學制<select value={form.studyLevel ?? "undergraduate"} onChange={(e) => setForm({ ...form, studyLevel: e.target.value as StudyLevel })}><option value="undergraduate">大學部</option><option value="master">碩士班</option><option value="doctoral">博士班</option><option value="unknown">尚未確認</option></select></label>
        <label>入學年度<input type="number" min="100" max="130" value={form.admissionYear} onChange={(e) => setForm({ ...form, admissionYear: Number(e.target.value) })} /></label>
        <label className="check"><input type="checkbox" checked={form.allowCrossDepartment} onChange={(e) => setForm({ ...form, allowCrossDepartment: e.target.checked })} />接受跨系課程推薦</label>
        <button className="primary wide" type="submit">儲存並前往推薦</button>
      </form>
    </section>
  );
}

function RecommendPage({ catalog, profile, searchIndex }: { catalog: Course[]; profile?: Profile; searchIndex: SearchIndex }) {
  const [completed] = useStore<CompletedCourse & { id: string }>("completedCourses");
  const [dismissed] = useStore<{ id: string }>("dismissedCourses");
  const [plans] = useStore<SchedulePlan>("schedulePlans");
  const [interest, setInterest] = useState(profile?.interests ?? "");
  const [preferredWeekdays, setPreferredWeekdays] = useState<number[]>(
    profile?.preferredWeekdays?.length ? profile.preferredWeekdays : defaultPreferredWeekdays,
  );
  const [showOtherWeekdays, setShowOtherWeekdays] = useState(false);
  const [creditFilters, setCreditFilters] = useState<number[]>([]);
  const [includeScheduleInfo, setIncludeScheduleInfo] = useState(true);
  const [categoryFilters, setCategoryFilters] = useState<RecommendationCategoryFilters>([]);
  const [lastEmbedding, setLastEmbedding] = useState<RecommendationEmbedding>();
  const [results, setResults] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [validationError, setValidationError] = useState("");
  useEffect(() => setInterest(profile?.interests ?? ""), [profile?.interests]);
  useEffect(() => {
    setPreferredWeekdays(profile?.preferredWeekdays?.length ? profile.preferredWeekdays : defaultPreferredWeekdays);
  }, [profile?.preferredWeekdays]);
  const creditOptions = useMemo(() => [...new Set(
    catalog
      .map((course) => course.credits)
      .filter((credits): credits is number => typeof credits === "number"),
  )].sort((left, right) => left - right), [catalog]);
  const rerank = useCallback((embedding: RecommendationEmbedding, filters: RecommendationCategoryFilters) => {
    const activePlan = plans[0];
    const scheduledIds = new Set(activePlan?.entries.map((item) => item.courseId));
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
      creditFilters,
      completed,
      dismissedIds: dismissed.map((item) => item.id),
      preferredWeekdays,
      includeNonPreferredWeekdays: showOtherWeekdays,
      scheduledCourses: includeScheduleInfo ? catalog.filter((item) => scheduledIds.has(item.course_id)) : [],
    }));
  }, [catalog, completed, creditFilters, dismissed, includeScheduleInfo, plans, preferredWeekdays, profile, searchIndex, showOtherWeekdays]);
  useEffect(() => {
    if (lastEmbedding) rerank(lastEmbedding, categoryFilters);
  }, [categoryFilters, lastEmbedding, rerank]);
  const toggleCategoryFilter = (category: RecommendationCategory) => {
    setCategoryFilters((current) => current.includes(category)
      ? current.filter((item) => item !== category)
      : [...current, category]);
  };
  const recommend = async () => {
    if (!interest.trim()) {
      setValidationError("請先輸入想學什麼，才能產生推薦。");
      return;
    }
    if (!preferredWeekdays.length) {
      setValidationError("請至少勾選一個偏好的上課星期，才能產生推薦。");
      return;
    }
    setValidationError("");
    setLoading(true); setError("");
    try {
      if (profile) {
        await putRecord("profile", {
          ...profile,
          interests: interest.trim(),
          preferredWeekdays,
          studyLevel: inferProfileStudyLevel(profile),
          updatedAt: new Date().toISOString(),
        });
      }
      const [query, bundle] = await Promise.all([embedQuery(interest.trim()), getEmbeddingBundle()]);
      setLastEmbedding({ query, queryText: interest.trim(), courseIds: bundle.index.course_ids, vectors: bundle.vectors, dimension: bundle.index.dimension });
    } catch (caught) { setError((caught as Error).message); }
    finally { setLoading(false); }
  };
  const togglePreferredWeekday = (day: number) => {
    setPreferredWeekdays((current) => {
      const next = current.includes(day) ? current.filter((item) => item !== day) : [...current, day];
      if (next.length) setValidationError("");
      return next;
    });
  };
  if (!profile) return <EmptyState title="先完成個人設定" body="設定系所與年級後，才能判斷課程限制並產生推薦。" action="開始設定" href="/onboarding" />;
  return (
    <section className="page">
      <div className="hero"><div><div className="eyebrow">115-1 個人化推薦</div><h1>找到真正適合你的下一門課</h1><p>推薦在你的裝置上完成；已修課、收藏和課表不會送到後端。</p></div><div className="privacy-pill">● Local-first</div></div>
      <div className="recommend-box"><textarea aria-label="想學什麼？" maxLength={500} value={interest} onChange={(e) => setInterest(e.target.value)} placeholder="例如：我想深入資料分析、機器學習，也希望有實作專題…" /><button className="primary" onClick={recommend} disabled={loading || !catalog.length}>{loading ? "正在分析…" : "產生推薦"}</button></div>
      <fieldset className="priority-legend recommendation-preferences"><legend>上課星期篩選</legend><div className="choice-row">{weekdays.map((label, index) => { const day = index + 1; return <label className="chip" key={day}><input type="checkbox" checked={preferredWeekdays.includes(day)} onChange={() => togglePreferredWeekday(day)} />星期{label}</label>; })}</div><label className="check"><input type="checkbox" checked={showOtherWeekdays} onChange={(event) => setShowOtherWeekdays(event.target.checked)} />顯示未勾選星期的課程</label><span>{showOtherWeekdays ? "目前顯示所有星期；未勾選星期的課程也會列入結果。" : "只顯示勾選星期的課程；請至少選擇一天。"}</span></fieldset>
      <fieldset className="priority-legend recommendation-preferences"><legend>學分數篩選</legend><div className="category-options"><label className="filter-option"><input type="checkbox" checked={creditFilters.length === 0} onChange={() => setCreditFilters([])} />不限學分</label>{creditOptions.map((credits) => <label className="filter-option" key={credits}><input type="checkbox" checked={creditFilters.includes(credits)} onChange={() => setCreditFilters((current) => current.includes(credits) ? current.filter((item) => item !== credits) : [...current, credits])} />{credits} 學分</label>)}</div><span>{creditFilters.length ? `只顯示 ${creditFilters.join("、")} 學分課程。` : "未限制課程學分數。"}</span></fieldset>
      <fieldset className="priority-legend recommendation-preferences"><legend>課表資訊</legend><label className="check"><input type="checkbox" checked={includeScheduleInfo} onChange={(event) => setIncludeScheduleInfo(event.target.checked)} />納入完整課表檢查衝堂</label><span>{includeScheduleInfo ? "已納入目前方案中的所有課程；可能衝堂的課程不會列入推薦。" : "不納入目前課表；推薦結果不進行衝堂排除。"}</span></fieldset>
      <fieldset className="priority-legend category-filter"><legend>課程類別篩選</legend><div className="category-options"><label className="filter-option"><input type="checkbox" checked={categoryFilters.length === 0} onChange={() => setCategoryFilters([])} />全部課程</label>{Object.entries(recommendationCategoryLabels).map(([value, label]) => { const category = value as RecommendationCategory; return <label className="filter-option" key={category}><input type="checkbox" checked={categoryFilters.includes(category)} onChange={() => toggleCategoryFilter(category)} />{label}</label>; })}</div><span>{categoryFilters.length > 0 ? `已選 ${categoryFilters.length} 類；排名完全依照輸入文字` : "未選類別時顯示全部課程；排名完全依照輸入文字"}</span></fieldset>
      {validationError && <div className="notice danger">{validationError}</div>}
      {error && <div className="notice danger">{error}</div>}
      {!results.length && !loading && <div className="empty-panel"><h2>推薦只依照你的輸入文字排序</h2><div className="feature-grid"><span>語意檢索</span><span>關鍵字檢索</span><span>RRF 融合排名</span></div></div>}
      <div className="course-grid">{results.map((item, index) => <CourseCard key={item.course.course_id} course={item.course} profile={profile} catalog={catalog} rank={index + 1} reasons={item.reasons} recommendationCategory={item.category} />)}</div>
    </section>
  );
}

function ExplorePage({ catalog, profile }: { catalog: Course[]; profile?: Profile }) {
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState("");
  const [weekday, setWeekday] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const departments = useMemo(() => {
    const options = new Map<string, { value: string; label: string }>();
    for (const item of catalog) {
      if (!item.department) continue;
      const value = item.department_identity ?? `legacy:${item.department}`;
      options.set(value, {
        value,
        label: item.official_department_label ?? item.department_display ?? item.department,
      });
    }
    return [...options.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-Hant"));
  }, [catalog]);
  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), page_size: "25" });
    if (query) params.set("q", query);
    if (department) params.set("department", department);
    if (weekday) params.set("weekday", weekday);
    try {
      setError("");
      const result = await getCourses(params); setCourses(result.items); setTotal(result.total);
    } catch (caught) {
      setCourses([]); setTotal(0); setError((caught as Error).message);
    }
  }, [query, department, weekday, page]);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="page"><div className="page-heading"><div><div className="eyebrow">探索全部課程</div><h1>課程資料庫</h1></div><strong>{total.toLocaleString()} 門結果</strong></div>
      <div className="filters-bar"><input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="課名、教師、課號或系所" /><select value={department} onChange={(e) => { setDepartment(e.target.value); setPage(1); }}><option value="">所有系所</option>{departments.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><select value={weekday} onChange={(e) => { setWeekday(e.target.value); setPage(1); }}><option value="">所有星期</option>{weekdays.map((label, index) => <option key={label} value={index + 1}>星期{label}</option>)}</select></div>
      {error && <div className="notice danger">無法載入課程：{error}</div>}
      <div className="course-grid">{courses.map((course) => <CourseCard key={course.course_id} course={course} profile={profile} catalog={catalog} />)}</div>
      <div className="pager"><button disabled={page === 1} onClick={() => setPage(page - 1)}>上一頁</button><span>第 {page} 頁</span><button disabled={page * 25 >= total} onClick={() => setPage(page + 1)}>下一頁</button></div>
    </section>
  );
}

function CourseCard({ course, profile, catalog, rank, reasons, recommendationCategory }: { course: Course; profile?: Profile; catalog: Course[]; rank?: number; reasons?: string[]; recommendationCategory?: Recommendation["category"] }) {
  const [completed] = useStore<CompletedCourse & { id: string }>("completedCourses");
  const [favorites] = useStore<{ id: string }>("favorites");
  const [plans] = useStore<SchedulePlan>("schedulePlans");
  const completedNames = new Set(completed.map((item) => item.courseName));
  const eligibility = evaluateEligibility(course, profile, completedNames);
  const favorite = favorites.some((item) => item.id === course.course_id);
  const isCompleted = completed.some((item) => item.id === course.course_id);
  const toggleFavorite = async () => favorite ? deleteRecord("favorites", course.course_id) : putRecord("favorites", { id: course.course_id, addedAt: new Date().toISOString() });
  const toggleCompleted = async () => isCompleted ? deleteRecord("completedCourses", course.course_id) : putRecord("completedCourses", { id: course.course_id, courseId: course.course_id, courseName: course.name_zh, continueLearning: false, addedAt: new Date().toISOString() });
  const dismiss = () => putRecord("dismissedCourses", { id: course.course_id, addedAt: new Date().toISOString() });
  const addSchedule = async () => {
    let plan = plans[0];
    if (!plan) plan = { id: crypto.randomUUID(), name: "我的課表", entries: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (plan.entries.some((item) => item.courseId === course.course_id)) return;
    const scheduled = catalog.filter((item) => plan.entries.some((entry) => entry.courseId === item.course_id));
    const conflict = courseConflicts(course, scheduled);
    if (conflict.conflict && !window.confirm("這門課與目前課表衝堂。仍要加入嗎？")) return;
    if (conflict.uncertain && !window.confirm("週次資料不完整，可能衝堂。仍要加入嗎？")) return;
    await putRecord("schedulePlans", { ...plan, entries: [...plan.entries, { courseId: course.course_id, locked: false }], updatedAt: new Date().toISOString() });
  };
  return (
    <article className="course-card">
      <div className="course-top">{rank && <span className="rank">#{rank}</span>}{recommendationCategory && <span className={`category-tag ${recommendationCategory}`}>{recommendationCategoryLabels[recommendationCategory]}</span>}<span className={`status ${eligibility.status}`}>{statusLabels[eligibility.status]}</span><button className={`heart ${favorite ? "active" : ""}`} onClick={toggleFavorite} aria-label="收藏">♥</button></div>
      <h2>{course.name_zh}</h2><p className="muted">{course.name_en}</p>
      <div className="meta"><span>{course.official_department_label ?? course.department_display ?? inferAudienceDepartment(course)}</span><span>{course.teacher || "教師未定"}</span><span>{course.credits} 學分</span><span>{course.required_elective_name}</span></div>
      <p className="meeting">{formatMeetings(course)}</p>
      {reasons?.length && <ul className="reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      <details><summary>查看課綱與判斷依據</summary><div className="details"><h3>課程目標</h3><p>{course.sections.objective || "未提供"}</p>{course.prerequisite && <><h3>先備知識</h3><p>{course.prerequisite}</p></>}{getEligibilityRules(course).map((rule, index) => <div className="evidence" key={`${rule.kind}-${index}`}><strong>{rule.message}</strong><q>{rule.evidence}</q></div>)}<a href={course.source_url} target="_blank" rel="noreferrer">開啟官方課綱 ↗</a></div></details>
      <div className="card-actions"><button onClick={addSchedule}>＋ 課表</button><button onClick={toggleCompleted}>{isCompleted ? "取消已修" : "標記已修"}</button><button className="quiet" onClick={dismiss}>不感興趣</button></div>
    </article>
  );
}

function SchedulePage({ catalog }: { catalog: Course[] }) {
  const [plans] = useStore<SchedulePlan>("schedulePlans");
  const [activeId, setActiveId] = useState("");
  const active = plans.find((item) => item.id === activeId) ?? plans[0];
  useEffect(() => { if (!activeId && plans[0]) setActiveId(plans[0].id); }, [activeId, plans]);
  const courses = catalog.filter((course) => active?.entries.some((entry) => entry.courseId === course.course_id));
  const createPlan = async () => { const name = window.prompt("課表方案名稱", `方案 ${plans.length + 1}`); if (!name) return; const now = new Date().toISOString(); const plan = { id: crypto.randomUUID(), name, entries: [], createdAt: now, updatedAt: now }; await putRecord("schedulePlans", plan); setActiveId(plan.id); };
  const updateEntry = async (courseId: string, action: "remove" | "lock") => { if (!active) return; const entries = action === "remove" ? active.entries.filter((item) => item.courseId !== courseId) : active.entries.map((item) => item.courseId === courseId ? { ...item, locked: !item.locked } : item); await putRecord("schedulePlans", { ...active, entries, updatedAt: new Date().toISOString() }); };
  const sections = [...new Set(courses.flatMap((course) => course.meetings.flatMap((meeting) => meeting.sections)))].sort();
  const credits = courses.reduce((sum, course) => sum + (course.credits ?? 0), 0);
  return (
    <section className="page"><div className="page-heading"><div><div className="eyebrow">安排多個選課方案</div><h1>我的課表</h1></div><button className="primary" onClick={createPlan}>＋ 新增方案</button></div>
      <div className="plan-tabs">{plans.map((plan) => <button className={plan.id === active?.id ? "active" : ""} onClick={() => setActiveId(plan.id)} key={plan.id}>{plan.name}</button>)}</div>
      {!active ? <EmptyState title="還沒有課表方案" body="從探索或推薦頁將課程加入課表，或建立一個空白方案。" action="探索課程" href="/explore" /> : <><div className="schedule-summary"><strong>{courses.length} 門課</strong><span>{credits} 學分</span></div><div className="timetable"><table><thead><tr><th>節次</th>{weekdays.slice(0,5).map((day) => <th key={day}>星期{day}</th>)}</tr></thead><tbody>{sections.map((section) => <tr key={section}><th>{section}</th>{[1,2,3,4,5].map((day) => <td key={day}>{courses.filter((course) => course.meetings.some((meeting) => meeting.weekday === day && meeting.sections.includes(section))).map((course) => <div className="class-block" key={course.course_id}>{course.name_zh}<small>{course.teacher}</small></div>)}</td>)}</tr>)}</tbody></table></div><div className="schedule-list">{courses.map((course) => { const entry = active.entries.find((item) => item.courseId === course.course_id)!; return <div key={course.course_id}><span><strong>{course.name_zh}</strong><small>{formatMeetings(course)}</small></span><button onClick={() => updateEntry(course.course_id, "lock")}>{entry.locked ? "🔒 已鎖定" : "鎖定"}</button><button onClick={() => updateEntry(course.course_id, "remove")}>移除</button></div>; })}</div></>}
    </section>
  );
}

function DataPage({ catalog }: { catalog: Course[] }) {
  const [completed] = useStore<CompletedCourse & { id: string }>("completedCourses");
  const [favorites] = useStore<{ id: string }>("favorites");
  const [plans] = useStore<SchedulePlan>("schedulePlans");
  const [codes, setCodes] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const addCodes = async () => {
    const values = codes.split(/[\s,，;；]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
    const matches = catalog.filter((course) => values.includes(course.ava_no?.toLowerCase()) || values.includes(course.name_zh.toLowerCase()));
    for (const course of matches) await putRecord("completedCourses", { id: course.course_id, courseId: course.course_id, courseName: course.name_zh, continueLearning: false, addedAt: new Date().toISOString() });
    setCodes(""); window.alert(`已加入 ${matches.length} 門，${values.length - matches.length} 筆未找到。`);
  };
  const exportData = async () => { const backup = await createBackup(); const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `fju-course-backup-${new Date().toISOString().slice(0,10)}.json`; anchor.click(); URL.revokeObjectURL(url); };
  const importData = async (file: File) => { try { const backup = validateBackup(JSON.parse(await file.text())); const summary = `備份日期：${backup.exportedAt}\n已修：${backup.data.completedCourses.length}\n收藏：${backup.data.favorites.length}\n課表：${backup.data.schedulePlans.length}`; if (!window.confirm(`${summary}\n\n要匯入並合併嗎？`)) return; const overwrite = window.confirm("是否用備份中的個人設定覆蓋目前設定？"); await importBackup(backup, overwrite); window.alert("匯入完成"); } catch (error) { window.alert(`無法匯入：${(error as Error).message}`); } };
  const clear = async () => { if (window.confirm("確定清除這台裝置上的個人設定、已修課、收藏與課表？此操作無法復原。")) await clearPersonalData(); };
  return (
    <section className="page"><div className="page-heading"><div><div className="eyebrow">你的資料由你掌控</div><h1>資料管理</h1></div></div>
      <div className="data-grid"><section className="card"><h2>批次加入已修課程</h2><p>貼上課號或完整課名，以空白、逗號或換行分隔。</p><textarea rows={6} value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="D030201234&#10;資料結構"/><button className="primary" onClick={addCodes}>辨識並加入</button></section><section className="card"><h2>本機資料摘要</h2><div className="big-stats"><span><strong>{completed.length}</strong>已修課程</span><span><strong>{favorites.length}</strong>收藏</span><span><strong>{plans.length}</strong>課表方案</span></div><button onClick={exportData}>匯出 JSON 備份</button><button onClick={() => fileRef.current?.click()}>匯入 JSON 備份</button><input ref={fileRef} hidden type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && void importData(e.target.files[0])}/><button className="danger-button" onClick={clear}>清除所有個人資料</button></section></div>
      <section className="card list-card"><h2>已修課程</h2>{completed.map((item) => <div key={item.id}><span>{item.courseName}</span><label className="check"><input type="checkbox" checked={item.continueLearning} onChange={() => putRecord("completedCourses", { ...item, continueLearning: !item.continueLearning })}/>想繼續深入</label><button onClick={() => deleteRecord("completedCourses", item.id)}>移除</button></div>)}</section>
    </section>
  );
}

function EmptyState({ title, body, action, href }: { title: string; body: string; action: string; href: string }) { return <section className="empty-state"><h1>{title}</h1><p>{body}</p><NavLink className="primary button-link" to={href}>{action}</NavLink></section>; }
function formatMeetings(course: Course) { if (!course.meetings.length) return "時間未定"; return course.meetings.map((meeting) => `星期${weekdays[(meeting.weekday ?? 1)-1]} ${meeting.sections.join("、")} ${meeting.room ?? ""}`).join("；"); }

export default App;
