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
import { courseConflicts, evaluateEligibility } from "./eligibility";
import { rankCourses, recommendationCategoryLabels } from "./recommendation";
import type {
  CompletedCourse,
  Course,
  EligibilityStatus,
  Profile,
  Recommendation,
  SchedulePlan,
} from "./types";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const statusLabels: Record<EligibilityStatus, string> = {
  no_known_restriction: "未發現限制",
  eligible_confirmed: "條件已符合",
  blocked_confirmed: "目前不可修",
  needs_confirmation: "需要確認",
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
          <Route path="/recommend" element={<RecommendPage catalog={catalog} profile={profile} />} />
          <Route path="/explore" element={<ExplorePage catalog={catalog} profile={profile} />} />
          <Route path="/schedule" element={<SchedulePage catalog={catalog} profile={profile} />} />
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
  const departments = useMemo(() => [...new Set(catalog.map((item) => item.department).filter(Boolean))].sort(), [catalog]);
  const [form, setForm] = useState<Profile>(profile ?? {
    id: "current", division: "日間部", department: "", grade: 1,
    admissionYear: 115, interests: "", preferredWeekdays: [], targetCredits: 18,
    allowCrossDepartment: true, updatedAt: new Date().toISOString(),
  });
  useEffect(() => { if (profile) setForm(profile); }, [profile]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.department || !form.interests.trim()) return;
    await putRecord("profile", { ...form, interests: form.interests.trim(), updatedAt: new Date().toISOString() });
    navigate("/recommend");
  };
  return (
    <section className="narrow-page">
      <div className="eyebrow">只存在這台裝置</div>
      <h1>先告訴我們你的學習方向</h1>
      <p className="lead">系級、偏好與修課紀錄會保存在瀏覽器，不會建立帳號或上傳到伺服器。</p>
      <form className="card form-grid" onSubmit={save}>
        <label>部別<select value={form.division} onChange={(e) => setForm({ ...form, division: e.target.value })}>{divisions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>系所<select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} required><option value="">請選擇系所</option>{form.department && !departments.includes(form.department) && <option value={form.department}>{form.department}（舊設定）</option>}{departments.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>年級<select value={form.grade} onChange={(e) => setForm({ ...form, grade: Number(e.target.value) })}>{[1,2,3,4,5,6,7].map((value) => <option key={value} value={value}>{value} 年級</option>)}</select></label>
        <label>入學年度<input type="number" min="100" max="130" value={form.admissionYear} onChange={(e) => setForm({ ...form, admissionYear: Number(e.target.value) })} /></label>
        <label className="wide">想學什麼？<textarea rows={5} maxLength={500} value={form.interests} onChange={(e) => setForm({ ...form, interests: e.target.value })} placeholder="例如：我想深入資料分析、機器學習，也希望有實作專題…" required /><small>{form.interests.length} / 500；只有按下推薦時，這段文字會暫時送到後端轉成向量。</small></label>
        <fieldset className="wide"><legend>偏好的上課星期（可複選）</legend><div className="choice-row">{weekdays.map((label, index) => { const day = index + 1; return <label className="chip" key={day}><input type="checkbox" checked={form.preferredWeekdays.includes(day)} onChange={() => setForm({ ...form, preferredWeekdays: form.preferredWeekdays.includes(day) ? form.preferredWeekdays.filter((item) => item !== day) : [...form.preferredWeekdays, day] })} />星期{label}</label>; })}</div></fieldset>
        <label>預計學分<input type="number" min="1" max="40" value={form.targetCredits} onChange={(e) => setForm({ ...form, targetCredits: Number(e.target.value) })} /></label>
        <label className="check"><input type="checkbox" checked={form.allowCrossDepartment} onChange={(e) => setForm({ ...form, allowCrossDepartment: e.target.checked })} />接受跨系課程推薦</label>
        <button className="primary wide" type="submit">儲存並查看推薦</button>
      </form>
    </section>
  );
}

function RecommendPage({ catalog, profile }: { catalog: Course[]; profile?: Profile }) {
  const [completed] = useStore<CompletedCourse & { id: string }>("completedCourses");
  const [favorites] = useStore<{ id: string }>("favorites");
  const [dismissed] = useStore<{ id: string }>("dismissedCourses");
  const [plans] = useStore<SchedulePlan>("schedulePlans");
  const [interest, setInterest] = useState(profile?.interests ?? "");
  const [results, setResults] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setInterest(profile?.interests ?? ""), [profile?.interests]);
  const recommend = async () => {
    if (!interest.trim()) return;
    setLoading(true); setError("");
    try {
      const [query, bundle] = await Promise.all([embedQuery(interest.trim()), getEmbeddingBundle()]);
      const activePlan = plans[0];
      const lockedIds = new Set(activePlan?.entries.filter((item) => item.locked).map((item) => item.courseId));
      setResults(rankCourses({
        catalog, courseIds: bundle.index.course_ids, vectors: bundle.vectors,
        dimension: bundle.index.dimension, query, queryText: interest.trim(), profile,
        completed, favoriteIds: favorites.map((item) => item.id),
        dismissedIds: dismissed.map((item) => item.id),
        lockedCourses: catalog.filter((item) => lockedIds.has(item.course_id)),
      }));
    } catch (caught) { setError((caught as Error).message); }
    finally { setLoading(false); }
  };
  if (!profile) return <EmptyState title="先完成個人設定" body="設定系所、年級與興趣後，才能判斷課程限制並產生推薦。" action="開始設定" href="/onboarding" />;
  return (
    <section className="page">
      <div className="hero"><div><div className="eyebrow">115-1 個人化推薦</div><h1>找到真正適合你的下一門課</h1><p>推薦在你的裝置上完成；已修課、收藏和課表不會送到後端。</p></div><div className="privacy-pill">● Local-first</div></div>
      <div className="recommend-box"><textarea maxLength={500} value={interest} onChange={(e) => setInterest(e.target.value)} /><button className="primary" onClick={recommend} disabled={loading || !catalog.length}>{loading ? "正在分析…" : "產生推薦"}</button></div>
      {error && <div className="notice danger">{error}</div>}
      {!results.length && !loading && <div className="empty-panel"><h2>推薦會綜合三種訊號</h2><div className="feature-grid"><span>你的興趣描述</span><span>收藏的課程</span><span>想繼續深入的已修課程</span></div></div>}
      {!!results.length && <div className="priority-legend"><strong>推薦優先順序</strong><span>1 本系必修</span><span>2 本系選修</span><span>3 通識課程</span><span>4 外系課程</span></div>}
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
  const departments = useMemo(() => [...new Set(catalog.map((item) => item.department).filter(Boolean))].sort(), [catalog]);
  const load = useCallback(async () => {
    const params = new URLSearchParams({ q: query, department, weekday, page: String(page), page_size: "25" });
    const result = await getCourses(params); setCourses(result.items); setTotal(result.total);
  }, [query, department, weekday, page]);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="page"><div className="page-heading"><div><div className="eyebrow">探索全部課程</div><h1>課程資料庫</h1></div><strong>{total.toLocaleString()} 門結果</strong></div>
      <div className="filters-bar"><input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="課名、教師、課號或系所" /><select value={department} onChange={(e) => { setDepartment(e.target.value); setPage(1); }}><option value="">所有系所</option>{departments.map((value) => <option key={value}>{value}</option>)}</select><select value={weekday} onChange={(e) => { setWeekday(e.target.value); setPage(1); }}><option value="">所有星期</option>{weekdays.map((label, index) => <option key={label} value={index + 1}>星期{label}</option>)}</select></div>
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
      <div className="meta"><span>{course.department}</span><span>{course.teacher || "教師未定"}</span><span>{course.credits} 學分</span><span>{course.required_elective_name}</span></div>
      <p className="meeting">{formatMeetings(course)}</p>
      {reasons?.length && <ul className="reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      <details><summary>查看課綱與判斷依據</summary><div className="details"><h3>課程目標</h3><p>{course.sections.objective || "未提供"}</p>{course.prerequisite && <><h3>先備知識</h3><p>{course.prerequisite}</p></>}{course.eligibility_rules.map((rule, index) => <div className="evidence" key={`${rule.kind}-${index}`}><strong>{rule.message}</strong><q>{rule.evidence}</q></div>)}<a href={course.source_url} target="_blank" rel="noreferrer">開啟官方課綱 ↗</a></div></details>
      <div className="card-actions"><button onClick={addSchedule}>＋ 課表</button><button onClick={toggleCompleted}>{isCompleted ? "取消已修" : "標記已修"}</button><button className="quiet" onClick={dismiss}>不感興趣</button></div>
    </article>
  );
}

function SchedulePage({ catalog, profile }: { catalog: Course[]; profile?: Profile }) {
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
      {!active ? <EmptyState title="還沒有課表方案" body="從探索或推薦頁將課程加入課表，或建立一個空白方案。" action="探索課程" href="/explore" /> : <><div className="schedule-summary"><strong>{courses.length} 門課</strong><span>{credits} 學分</span><span>目標 {profile?.targetCredits ?? "—"} 學分</span></div><div className="timetable"><table><thead><tr><th>節次</th>{weekdays.slice(0,5).map((day) => <th key={day}>星期{day}</th>)}</tr></thead><tbody>{sections.map((section) => <tr key={section}><th>{section}</th>{[1,2,3,4,5].map((day) => <td key={day}>{courses.filter((course) => course.meetings.some((meeting) => meeting.weekday === day && meeting.sections.includes(section))).map((course) => <div className="class-block" key={course.course_id}>{course.name_zh}<small>{course.teacher}</small></div>)}</td>)}</tr>)}</tbody></table></div><div className="schedule-list">{courses.map((course) => { const entry = active.entries.find((item) => item.courseId === course.course_id)!; return <div key={course.course_id}><span><strong>{course.name_zh}</strong><small>{formatMeetings(course)}</small></span><button onClick={() => updateEntry(course.course_id, "lock")}>{entry.locked ? "🔒 已鎖定" : "鎖定"}</button><button onClick={() => updateEntry(course.course_id, "remove")}>移除</button></div>; })}</div></>}
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
