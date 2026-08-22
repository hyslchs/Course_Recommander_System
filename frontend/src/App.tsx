import { FormEvent, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { askCourseAssistant, embedQuery, getCatalog, getCourses, getDepartmentCatalog, getEmbeddingBundle, getFeatures } from "./api";
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
import { courseConflicts, evaluateEligibility, getEligibilityRules, inferAudienceDepartment, inferProfileStudyLevel, meetingsConflict } from "./eligibility";
import { getFixedScheduleEntries, MENTOR_TIME_ENTRY_ID } from "./fixedSchedule";
import {
  buildDepartmentOptions,
  buildDivisionOptions,
  departmentTypeOrder,
  filterDepartmentOptions,
  getDepartmentContextLabel,
  getDepartmentTypeLabel,
  type DepartmentOption,
} from "./departmentOptions";
import {
  classifyRecommendationCategory,
  getSafetyFilterStats,
  rankCourses,
  recommendationCategoryLabels,
  type CourseLevelFilter,
  type PrerequisiteFilter,
  type TimeOfDayFilter,
} from "./recommendation";
import { getClassGroupOptions, selectRequiredCourses } from "./requiredCourses";
import { coursesInPlan, meetingsInPlan, resolveActiveSchedulePlan } from "./scheduleUtils";
import { buildSearchIndex, type SearchIndex } from "./search";
import { formatMeetings, ScheduleWorkspace } from "./ScheduleWorkspace";
import { analyzeQuery } from "./queryAnalysis";
import { detectedFilterLabels, sanitizeSubjectQuery, type DetectedFilterPhrase } from "./subjectQuery";
import type {
  CompletedCourse,
  Course,
  DepartmentCatalog,
  AIAnswer,
  AIHistoryTurn,
  EligibilityStatus,
  Profile,
  Recommendation,
  RecommendationCategory,
  RecommendationCategoryFilters,
  SchedulePlan,
  HardConstraints,
} from "./types";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const ACTIVE_SCHEDULE_PREFERENCE_ID = "active-schedule-plan-v1";
const assistantFieldLabels: Record<string, string> = {
  title: "課名／課號",
  skills: "技能與學習成果",
  objective: "課程目標",
  weekly_progress: "每週進度",
  prerequisite: "先修／加選備註",
  materials: "教材",
  history: "最近對話課程",
};

type FilterSuggestion = "prerequisite" | "introductory" | "study_level" | "working_schedule";

function getFilterSuggestion(item: DetectedFilterPhrase): { kind: FilterSuggestion; label: string } | null {
  if (/先修/.test(item.text)) return { kind: "prerequisite", label: "套用：排除未滿足或不明先修" };
  if (/入門|初級|初階|基礎|概論|導論/.test(item.text)) return { kind: "introductory", label: "套用：排除入門與程度不明" };
  if (/(?:大學部?|碩士班?|博士班?|研究所)/.test(item.text)) return { kind: "study_level", label: "套用：依我的學制嚴格篩選" };
  if (/(?:平日|週間).*?(?:晚間|晚上|夜間).*?(?:星期六|週六|周六)|(?:星期六|週六|周六).*?(?:平日|週間).*?(?:晚間|晚上|夜間)/.test(item.text)) {
    return { kind: "working_schedule", label: "套用：平日晚間＋星期六" };
  }
  return null;
}
const defaultPreferredWeekdays = [1, 2, 3, 4, 5];
function profileStudyLevelLabel(profile?: Pick<Profile, "division" | "studyLevel">): string {
  const level = inferProfileStudyLevel(profile);
  if (level === "master" || level === "doctoral") return "研究所";
  if (level === "undergraduate") return "大學部";
  return "尚未確認";
}
const statusLabels: Record<EligibilityStatus, string> = {
  no_known_restriction: "尚未判定出明確限制",
  eligible_confirmed: "條件已符合",
  blocked_confirmed: "目前不可修",
  needs_confirmation: "需要確認",
};

type RecommendationEmbedding = {
  query: Float32Array;
  queryText: string;
  rawQuery: string;
  detectedFilterPhrases: DetectedFilterPhrase[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
};

interface ActiveSchedulePreference {
  id: typeof ACTIVE_SCHEDULE_PREFERENCE_ID;
  planId: string;
  updatedAt: string;
}

interface SchedulePlanContextValue {
  plans: SchedulePlan[];
  activePlan?: SchedulePlan;
  selectPlan: (planId: string) => Promise<void>;
}

const SchedulePlanContext = createContext<SchedulePlanContextValue>({
  plans: [],
  selectPlan: async () => undefined,
});

function useSchedulePlans(): SchedulePlanContextValue {
  return useContext(SchedulePlanContext);
}

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
  const [departmentCatalog, setDepartmentCatalog] = useState<DepartmentCatalog>();
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    Promise.all([getCatalog(), getDepartmentCatalog()])
      .then(([courseCatalog, officialDepartments]) => {
        setCatalog(courseCatalog);
        setDepartmentCatalog(officialDepartments);
      })
      .catch((error: Error) => setCatalogError(error.message));
  }, []);
  const searchIndex = useMemo(() => buildSearchIndex(catalog), [catalog]);
  const [profiles] = useStore<Profile>("profile");
  const profile = profiles.find((item) => item.id === "current");
  const [plans] = useStore<SchedulePlan>("schedulePlans");
  const [schedulePreferences] = useStore<ActiveSchedulePreference>("recommendationPreferences");
  const activePreference = schedulePreferences.find((item) => item.id === ACTIVE_SCHEDULE_PREFERENCE_ID);
  const activePlan = resolveActiveSchedulePlan(plans, activePreference?.planId);
  const selectPlan = useCallback(async (planId: string) => {
    await putRecord("recommendationPreferences", {
      id: ACTIVE_SCHEDULE_PREFERENCE_ID,
      planId,
      updatedAt: new Date().toISOString(),
    } satisfies ActiveSchedulePreference);
  }, []);
  useEffect(() => {
    if (activePlan && activePreference?.planId !== activePlan.id) void selectPlan(activePlan.id);
  }, [activePlan, activePreference?.planId, selectPlan]);

  return (
    <SchedulePlanContext.Provider value={{ plans, activePlan, selectPlan }}><div className="app-shell">
      <header className="topbar">
        <NavLink to="/recommend" className="brand"><span>FJU</span><strong>選課指南</strong></NavLink>
        <nav>
          <NavLink to="/recommend">為你推薦</NavLink>
          <NavLink to="/assistant">AI 小幫手</NavLink>
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
          <Route path="/onboarding" element={<Onboarding catalog={catalog} departmentCatalog={departmentCatalog} profile={profile} />} />
          <Route path="/recommend" element={<RecommendPage catalog={catalog} profile={profile} searchIndex={searchIndex} />} />
          <Route path="/assistant" element={<AssistantPage catalog={catalog} profile={profile} />} />
          <Route path="/explore" element={<ExplorePage catalog={catalog} profile={profile} />} />
          <Route path="/schedule" element={<ScheduleWorkspace catalog={catalog} plans={plans} active={activePlan} selectPlan={selectPlan} />} />
          <Route path="/data" element={<DataPage catalog={catalog} />} />
        </Routes>
      </main>
      <footer>MVP 1.0 · 推薦結果僅供規劃參考，實際資格、名額與開課資訊以校方選課系統為準。</footer>
    </div></SchedulePlanContext.Provider>
  );
}

function Onboarding({ catalog, departmentCatalog, profile }: { catalog: Course[]; departmentCatalog?: DepartmentCatalog; profile?: Profile }) {
  const navigate = useNavigate();
  const { plans, activePlan, selectPlan } = useSchedulePlans();
  const divisions = useMemo(() => buildDivisionOptions(catalog, departmentCatalog), [catalog, departmentCatalog]);
  const departmentOptions = useMemo(() => buildDepartmentOptions(catalog, departmentCatalog), [catalog, departmentCatalog]);
  const profileDepartmentOption = (value: Profile) => departmentOptions.find((item) => {
    const sameDivision = item.division === value.division
      && (!value.division_code || item.divisionCode === value.division_code);
    return sameDivision && (
      (value.department_identity && item.identity === value.department_identity)
      || (!value.department_identity && value.department_code && item.code === value.department_code)
      || (value.official_department_name_zh && item.officialName === value.official_department_name_zh)
      || (!value.department_code && !value.official_department_name_zh && item.value === value.department
        && departmentOptions.filter((candidate) => candidate.division === value.division && candidate.value === value.department).length === 1)
    );
  });
  const [form, setForm] = useState<Profile>(profile ? {
    ...profile,
    admissionYear: 115,
    classGroup: profile.classGroup ?? "",
    department_code: profile.department_code ?? profileDepartmentOption(profile)?.code,
    department_identity: profile.department_identity ?? profileDepartmentOption(profile)?.identity,
    division_code: profile.division_code ?? profileDepartmentOption(profile)?.divisionCode,
    official_department_name_zh: profile.official_department_name_zh ?? profileDepartmentOption(profile)?.officialName,
    official_department_type: profile.official_department_type ?? profileDepartmentOption(profile)?.departmentType,
    studyLevel: inferProfileStudyLevel(profile),
  } : {
    id: "current", division: "日間部", department: "", classGroup: "", grade: 1,
    admissionYear: 115, interests: "", preferredWeekdays: defaultPreferredWeekdays,
    studyLevel: "undergraduate", updatedAt: new Date().toISOString(),
  });
  const [autoAddRequiredCourses, setAutoAddRequiredCourses] = useState(false);
  const selectedDepartmentOption = profileDepartmentOption(form);
  const formatDepartmentOption = (option: DepartmentOption) => `${option.officialName ?? option.value}${option.code ? `（${option.code}）` : ""}`;
  const [departmentInput, setDepartmentInput] = useState("");
  const [departmentMenuOpen, setDepartmentMenuOpen] = useState(false);
  const [activeDepartmentIndex, setActiveDepartmentIndex] = useState(0);
  const [departmentError, setDepartmentError] = useState("");
  const departmentPickerRef = useRef<HTMLDivElement>(null);
  const departmentInputRef = useRef<HTMLInputElement>(null);
  const departmentSearchTerm = selectedDepartmentOption
    && departmentInput === formatDepartmentOption(selectedDepartmentOption) ? "" : departmentInput;
  const visibleDepartmentOptions = useMemo(
    () => filterDepartmentOptions(departmentOptions, form.division, departmentSearchTerm),
    [departmentOptions, departmentSearchTerm, form.division],
  );
  const departmentOptionGroups = useMemo(() => departmentTypeOrder.map((type) => ({
    type,
    label: getDepartmentTypeLabel(type),
    options: visibleDepartmentOptions.filter((option) => (option.departmentType ?? "unknown") === type),
  })).filter((group) => group.options.length), [visibleDepartmentOptions]);
  const classGroupOptions = useMemo(() => form.department ? getClassGroupOptions(catalog, form) : [], [catalog, form]);
  useEffect(() => {
    if (!departmentMenuOpen) {
      setDepartmentInput(selectedDepartmentOption ? formatDepartmentOption(selectedDepartmentOption) : form.department);
    }
  }, [departmentMenuOpen, form.department, selectedDepartmentOption?.key]);
  useEffect(() => {
    if (!departmentMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!departmentPickerRef.current?.contains(event.target as Node)) setDepartmentMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [departmentMenuOpen]);
  useEffect(() => {
    setActiveDepartmentIndex((current) => Math.min(current, Math.max(visibleDepartmentOptions.length - 1, 0)));
  }, [visibleDepartmentOptions.length]);
  useEffect(() => {
    if (profile) {
      const option = profileDepartmentOption(profile);
      setForm({
        ...profile,
        admissionYear: 115,
        classGroup: profile.classGroup ?? "",
        department_code: profile.department_code ?? option?.code,
        department_identity: profile.department_identity ?? option?.identity,
        division_code: profile.division_code ?? option?.divisionCode,
        official_department_name_zh: profile.official_department_name_zh ?? option?.officialName,
        official_department_type: profile.official_department_type ?? option?.departmentType,
        studyLevel: inferProfileStudyLevel(profile),
      });
    }
  }, [profile, departmentOptions]);
  const selectDepartment = (option: DepartmentOption) => {
    setDepartmentInput(formatDepartmentOption(option));
    setDepartmentMenuOpen(false);
    setDepartmentError("");
    setForm({
      ...form,
      department: option.value,
      classGroup: "",
      department_identity: option.identity,
      division_code: option.divisionCode,
      department_code: option.code,
      official_department_name_zh: option.officialName,
      official_department_type: option.departmentType ?? undefined,
    });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.department || !selectedDepartmentOption) {
      setDepartmentError("請從下拉清單選擇一個正式的主修系所。");
      setDepartmentMenuOpen(true);
      departmentInputRef.current?.focus();
      return;
    }
    const option = profileDepartmentOption(form);
    const savedProfile: Profile = {
      ...form,
      admissionYear: 115,
      classGroup: form.classGroup ?? "",
      department_code: form.department_code ?? option?.code,
      department_identity: form.department_identity ?? option?.identity,
      division_code: form.division_code ?? option?.divisionCode,
      official_department_name_zh: form.official_department_name_zh ?? option?.officialName,
      studyLevel: inferProfileStudyLevel(form),
      updatedAt: new Date().toISOString(),
    };
    await putRecord("profile", savedProfile);
    if (autoAddRequiredCourses && catalog.length) {
      const requiredCourses = selectRequiredCourses(catalog, savedProfile);
      const completed = await getAllRecords<CompletedCourse & { id: string }>("completedCourses");
      const completedIds = new Set(completed.map((item) => item.courseId));
      const existingPlan = activePlan ?? plans[0];
      const now = new Date().toISOString();
      const plan = existingPlan ?? {
        id: crypto.randomUUID(),
        name: "我的課表",
        entries: [],
        createdAt: now,
        updatedAt: now,
      };
      const existingIds = new Set(plan.entries.map((item) => item.courseId));
      const scheduled = coursesInPlan(catalog, plan);
      const existingFixedEntries = plan.fixedEntries ?? [];
      const applicableFixedEntries = getFixedScheduleEntries(savedProfile);
      const applicableFixedIds = new Set(applicableFixedEntries.map((entry) => entry.id));
      const retainedFixedEntries = existingFixedEntries.filter((entry) => (
        entry.id !== MENTOR_TIME_ENTRY_ID || applicableFixedIds.has(entry.id)
      ));
      const fixedAdditions = applicableFixedEntries.filter((entry) => (
        !retainedFixedEntries.some((existing) => existing.id === entry.id)
      ));
      const nextFixedEntries = [...retainedFixedEntries, ...fixedAdditions];
      const fixedMeetings = nextFixedEntries.flatMap((entry) => entry.meetings);
      const additions: Course[] = [];
      for (const course of requiredCourses) {
        if (existingIds.has(course.course_id) || completedIds.has(course.course_id)) continue;
        const courseConflict = courseConflicts(course, [...scheduled, ...additions]);
        const fixedConflict = meetingsConflict(course.meetings, fixedMeetings);
        if (courseConflict.conflict || fixedConflict.conflict) continue;
        additions.push(course);
      }
      if (additions.length || fixedAdditions.length || nextFixedEntries.length !== existingFixedEntries.length) {
        await putRecord("schedulePlans", {
          ...plan,
          entries: [...plan.entries, ...additions.map((course) => ({ courseId: course.course_id, locked: false }))],
          fixedEntries: nextFixedEntries,
          updatedAt: now,
        });
        if (!existingPlan) await selectPlan(plan.id);
      }
      const skipped = requiredCourses.length - additions.length;
      const summaryParts = [
        additions.length ? `已將 ${additions.length} 門符合條件的必修課加入「${plan.name}」` : "",
        fixedAdditions.length ? `已將 ${fixedAdditions.length} 個固定時段加入課表` : "",
      ].filter(Boolean);
      const summary = summaryParts.length ? `${summaryParts.join("；")}。` : "目前沒有可直接加入課表的必修課或固定時段。";
      const detail = skipped > 0 ? `\n${skipped} 門課因已在課表、已修、或與現有課表衝堂而略過。` : "";
      window.alert(`${summary}${detail}\n共同必修中的英文／國文課程仍請依校方分發結果確認。`);
    }
    navigate("/recommend");
  };
  return (
    <section className="narrow-page">
      <div className="eyebrow">只存在這台裝置</div>
      <h1>先設定你的基本資料</h1>
      <p className="lead">目前使用 115-1 課程大綱資料；系級與修課紀錄會保存在瀏覽器，不會建立帳號或上傳到伺服器。</p>
      <form className="card form-grid" onSubmit={save}>
        <label>部別<select value={form.division} onChange={(e) => { const division = e.target.value; setDepartmentInput(""); setDepartmentMenuOpen(false); setDepartmentError(""); setForm({ ...form, division, studyLevel: inferProfileStudyLevel({ division }), department: "", classGroup: "", department_identity: null, division_code: null, department_code: null, official_department_name_zh: null, official_department_type: null }); }}>{divisions.map((value) => <option key={value}>{value}</option>)}</select><small>部別與系所選項依輔大官方課程大綱查詢系統。</small></label>
        <div className="department-field wide">
          <label htmlFor="department-combobox">主修系所／學位學程</label>
          <div className="department-combobox" ref={departmentPickerRef}>
            <input
              id="department-combobox"
              ref={departmentInputRef}
              type="search"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={departmentMenuOpen}
              aria-controls="department-options"
              aria-activedescendant={departmentMenuOpen && visibleDepartmentOptions.length ? `department-option-${activeDepartmentIndex}` : undefined}
              aria-invalid={Boolean(departmentError)}
              value={departmentInput}
              placeholder="輸入系名、簡稱或代碼，例如：圖資、資工、10"
              autoComplete="off"
              required
              onFocus={() => { setDepartmentMenuOpen(true); setActiveDepartmentIndex(0); }}
              onBlur={() => { window.setTimeout(() => { if (!departmentPickerRef.current?.contains(document.activeElement)) setDepartmentMenuOpen(false); }, 0); }}
              onChange={(e) => {
                setDepartmentInput(e.target.value);
                setDepartmentMenuOpen(true);
                setActiveDepartmentIndex(0);
                setDepartmentError("");
                setForm({ ...form, department: "", classGroup: "", department_identity: null, division_code: null, department_code: null, official_department_name_zh: null, official_department_type: null });
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setDepartmentMenuOpen(true);
                  setActiveDepartmentIndex((current) => Math.min(current + 1, Math.max(visibleDepartmentOptions.length - 1, 0)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setDepartmentMenuOpen(true);
                  setActiveDepartmentIndex((current) => Math.max(current - 1, 0));
                } else if (e.key === "Enter" && departmentMenuOpen && visibleDepartmentOptions[activeDepartmentIndex]) {
                  e.preventDefault();
                  selectDepartment(visibleDepartmentOptions[activeDepartmentIndex]);
                } else if (e.key === "Escape") {
                  setDepartmentMenuOpen(false);
                }
              }}
            />
            <button className="department-combobox-toggle" type="button" aria-label={departmentMenuOpen ? "收合系所清單" : "展開系所清單"} onClick={() => { setDepartmentMenuOpen((open) => !open); departmentInputRef.current?.focus(); }}>⌄</button>
            {departmentMenuOpen && <div className="department-options" id="department-options" role="listbox">
              <div className="department-result-count">{visibleDepartmentOptions.length ? `${form.division} · ${visibleDepartmentOptions.length} 個符合單位` : "找不到符合的主修系所"}</div>
              {departmentOptionGroups.map((group) => <div className="department-option-group" key={group.type}>
                <div className="department-option-group-label">{group.label}（{group.options.length}）</div>
                {group.options.map((option) => {
                  const optionIndex = visibleDepartmentOptions.indexOf(option);
                  return <button
                    id={`department-option-${optionIndex}`}
                    key={option.key}
                    type="button"
                    role="option"
                    aria-selected={selectedDepartmentOption?.key === option.key}
                    className={optionIndex === activeDepartmentIndex ? "active" : ""}
                    onMouseEnter={() => setActiveDepartmentIndex(optionIndex)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectDepartment(option)}
                  ><span>{option.officialName ?? option.value}</span><small title={getDepartmentContextLabel(option)}>{[option.code, getDepartmentContextLabel(option)].filter(Boolean).join(" · ")}</small></button>;
                })}
              </div>)}
            </div>}
          </div>
          {selectedDepartmentOption && <div className="department-selection-summary" role="status">
            <strong>已選：{selectedDepartmentOption.officialName ?? selectedDepartmentOption.value}</strong>
            <span>{[selectedDepartmentOption.code, getDepartmentContextLabel(selectedDepartmentOption)].filter(Boolean).join(" · ")}</span>
            <small>儲存前請確認這是正確的部別及一般／在職／學士後身分。</small>
          </div>}
          {departmentError && <small className="field-error" role="alert">{departmentError}</small>}
          <small>點擊展開清單，或直接輸入正式名稱、常用簡稱或代碼搜尋；只列正式主修單位。</small>
        </div>
        <label>班別<select value={form.classGroup ?? ""} onChange={(e) => setForm({ ...form, classGroup: e.target.value })} required={classGroupOptions.length > 0}><option value="">{classGroupOptions.length ? "請選擇班別" : "不分班／未指定"}</option>{classGroupOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select><small>{classGroupOptions.length ? "有分班課程時，只會自動帶入選定班別。" : "目前課程資料沒有偵測到甲、乙等班別。"}</small></label>
        <label>年級<select value={form.grade} onChange={(e) => setForm({ ...form, grade: Number(e.target.value) })}>{[1,2,3,4].map((value) => <option key={value} value={value}>{value} 年級</option>)}</select></label>

        <label className="check wide"><input type="checkbox" checked={autoAddRequiredCourses} onChange={(e) => setAutoAddRequiredCourses(e.target.checked)} />儲存後自動將本系／共同必修加入「{activePlan?.name ?? "我的課表"}」</label>
        <small className="wide">只會加入目前 115-1 課程資料中符合部別、年級與班別的課程；英文、國文等共同課程仍須依學校分發或免修結果確認。</small>
        <button className="primary wide" type="submit">儲存並前往推薦</button>
      </form>
    </section>
  );
}

function RecommendPage({ catalog, profile, searchIndex }: { catalog: Course[]; profile?: Profile; searchIndex: SearchIndex }) {
  const [completed] = useStore<CompletedCourse & { id: string }>("completedCourses");
  const [dismissed] = useStore<{ id: string }>("dismissedCourses");
  const { activePlan } = useSchedulePlans();
  const [interest, setInterest] = useState(profile?.interests ?? "");
  const [preferredWeekdays, setPreferredWeekdays] = useState<number[]>(
    profile?.preferredWeekdays?.length ? profile.preferredWeekdays : defaultPreferredWeekdays,
  );
  const [showOtherWeekdays, setShowOtherWeekdays] = useState(false);
  const [creditFilters, setCreditFilters] = useState<number[]>([]);
  const [timeOfDayFilter, setTimeOfDayFilter] = useState<TimeOfDayFilter>("all");
  const [includeUnknownSchedule, setIncludeUnknownSchedule] = useState(false);
  const [prerequisiteFilter, setPrerequisiteFilter] = useState<PrerequisiteFilter>("exclude_unmet");
  const [includeUnknownPrerequisite, setIncludeUnknownPrerequisite] = useState(false);
  const [studyLevelOnly, setStudyLevelOnly] = useState(true);
  const [includeUnknownStudyLevel, setIncludeUnknownStudyLevel] = useState(false);
  const [courseLevelFilter, setCourseLevelFilter] = useState<CourseLevelFilter>("all");
  const [includeUnknownCourseLevel, setIncludeUnknownCourseLevel] = useState(false);
  const [includeScheduleInfo, setIncludeScheduleInfo] = useState(true);
  const [categoryFilters, setCategoryFilters] = useState<RecommendationCategoryFilters>([]);
  const [courseTagFilters, setCourseTagFilters] = useState<string[]>([]);
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
  const courseTagOptions = useMemo(() => {
    const tags = new Map<string, NonNullable<Course["course_tags"]>[number]>();
    for (const course of catalog) for (const tag of course.course_tags ?? []) tags.set(tag.code, tag);
    return [...tags.values()].sort((left, right) => (
      (left.display_order ?? Number.MAX_SAFE_INTEGER) - (right.display_order ?? Number.MAX_SAFE_INTEGER)
      || left.label_zh.localeCompare(right.label_zh, "zh-Hant")
    ));
  }, [catalog]);
  const sanitizedPreview = useMemo(() => sanitizeSubjectQuery(interest), [interest]);
  const safetyStats = useMemo(() => getSafetyFilterStats({
    catalog,
    profile,
    completed,
    studyLevelFilter: studyLevelOnly ? inferProfileStudyLevel(profile) : undefined,
    includeUnknownStudyLevel,
    courseLevelFilter,
    includeUnknownCourseLevel,
    prerequisiteFilter,
    includeUnknownPrerequisite,
  }), [catalog, completed, courseLevelFilter, includeUnknownCourseLevel, includeUnknownPrerequisite, includeUnknownStudyLevel, prerequisiteFilter, profile, studyLevelOnly]);
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
      studyLevelFilter: studyLevelOnly ? inferProfileStudyLevel(profile) : undefined,
      includeUnknownStudyLevel,
      courseLevelFilter,
      includeUnknownCourseLevel,
      scheduledCourses: includeScheduleInfo ? scheduledCourses : [],
      scheduledMeetings: includeScheduleInfo ? scheduledMeetings : [],
    }));
  }, [activePlan, catalog, completed, courseLevelFilter, courseTagFilters, creditFilters, dismissed, includeScheduleInfo, includeUnknownCourseLevel, includeUnknownPrerequisite, includeUnknownSchedule, includeUnknownStudyLevel, prerequisiteFilter, preferredWeekdays, profile, searchIndex, showOtherWeekdays, studyLevelOnly, timeOfDayFilter]);
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
  const recommend = async () => {
    if (!interest.trim()) {
      setValidationError("請先輸入想學什麼，才能產生推薦。");
      return;
    }
    if (!sanitizedPreview.subjectQuery) {
      setValidationError("請只輸入想學的主題或技能；星期、學分、學制與先修條件請使用下方篩選器。");
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
      const [bundle, query] = await Promise.all([
        getEmbeddingBundle(),
        embedQuery(sanitizedPreview.subjectQuery),
      ]);
      setLastEmbedding({
        query,
        queryText: sanitizedPreview.subjectQuery,
        rawQuery: sanitizedPreview.rawQuery,
        detectedFilterPhrases: sanitizedPreview.detectedFilterPhrases,
        courseIds: bundle.index.course_ids,
        vectors: bundle.vectors,
        dimension: bundle.index.dimension,
      });
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
  const applyFilterSuggestion = (suggestion: FilterSuggestion) => {
    if (suggestion === "prerequisite") {
      setPrerequisiteFilter("exclude_unmet");
      setIncludeUnknownPrerequisite(false);
    } else if (suggestion === "introductory") {
      setCourseLevelFilter("exclude_introductory");
      setIncludeUnknownCourseLevel(false);
      setStudyLevelOnly(true);
      setIncludeUnknownStudyLevel(false);
    } else if (suggestion === "study_level") {
      setStudyLevelOnly(true);
      setIncludeUnknownStudyLevel(false);
    } else {
      setPreferredWeekdays([1, 2, 3, 4, 5, 6]);
      setShowOtherWeekdays(false);
      setTimeOfDayFilter("weekday_evening_or_saturday");
      setIncludeUnknownSchedule(false);
    }
  };
  if (!profile) return <EmptyState title="先完成個人設定" body="設定系所與年級後，才能判斷課程限制並產生推薦。" action="開始設定" href="/onboarding" />;
  return (
    <section className="page">
      <div className="hero"><div><div className="eyebrow">115-1 個人化推薦</div><h1>找到真正適合你的下一門課</h1><p>推薦在你的裝置上完成；已修課、收藏和課表不會送到後端。</p></div><div className="privacy-pill">● Local-first</div></div>
      <div className="recommend-box"><div className="subject-query-field"><label htmlFor="subject-query">想學的主題或技能</label><textarea id="subject-query" aria-label="想學的主題或技能" maxLength={500} value={interest} onChange={(e) => setInterest(e.target.value)} placeholder="例如：電子商務、社群行銷、零售數據分析與業界案例" /><small>搜尋文字只決定課程內容的相關性；上課時間、學分、學制與先修條件請使用下方篩選器。</small></div><button className="primary" onClick={recommend} disabled={loading || !catalog.length}>{loading ? "正在分析…" : "產生推薦"}</button></div>
      {sanitizedPreview.detectedFilterPhrases.length > 0 && <section className="card filter-language-notice" role="status"><strong>偵測到可能的篩選說明</strong><p>以下文字不會進入學科主題向量，也不會在未確認時自動套用。你可以使用建議按鈕，或在下方自行調整。</p><div className="detected-filter-list">{sanitizedPreview.detectedFilterPhrases.map((item, index) => { const suggestion = getFilterSuggestion(item); return <span key={`${item.kind}-${item.text}-${index}`}><span className="detected-filter-text"><b>{detectedFilterLabels[item.kind]}</b>{item.text}</span>{suggestion && <button type="button" onClick={() => applyFilterSuggestion(suggestion.kind)}>{suggestion.label}</button>}</span>; })}</div><p><strong>實際搜尋主題：</strong>{sanitizedPreview.subjectQuery || "尚未輸入學科主題"}</p></section>}
      {lastEmbedding && <section className="search-execution-summary" aria-label="本次搜尋內容"><span><strong>本次學科主題</strong>{lastEmbedding.queryText}</span><span><strong>已忽略的限制文字</strong>{lastEmbedding.detectedFilterPhrases.length ? `${lastEmbedding.detectedFilterPhrases.length} 段（未送入主題向量）` : "沒有"}</span><span><strong>硬條件來源</strong>下方明確篩選器</span><span><strong>目前結果</strong>{results.length ? `顯示前 ${results.length} 門` : "尚未找到符合條件的課程"}</span></section>}
      <div className="filter-section-heading"><div><span>硬條件篩選</span><h2>哪些課程可以出現在結果中</h2></div><p>這些條件會在語意排名前直接排除不符合的課程。</p></div>
      <fieldset id="weekday-filters" className="priority-legend recommendation-preferences"><legend>1. 上課星期</legend><div className="choice-row">{weekdays.map((label, index) => { const day = index + 1; return <label className="chip" key={day}><input type="checkbox" checked={preferredWeekdays.includes(day)} onChange={() => togglePreferredWeekday(day)} />星期{label}</label>; })}</div><label className="check"><input type="checkbox" checked={showOtherWeekdays} onChange={(event) => setShowOtherWeekdays(event.target.checked)} />暫時忽略星期限制</label><span>{showOtherWeekdays ? "目前不依星期排除課程。" : "課程的所有已知上課日都必須在勾選範圍內。"}</span></fieldset>
      <fieldset id="time-filters" className="priority-legend recommendation-preferences"><legend>2. 上課時段</legend><div className="category-options"><label className="filter-option"><input type="radio" name="time-of-day" checked={timeOfDayFilter === "all"} onChange={() => setTimeOfDayFilter("all")} />不限時段</label><label className="filter-option"><input type="radio" name="time-of-day" checked={timeOfDayFilter === "daytime"} onChange={() => setTimeOfDayFilter("daytime")} />只要日間 D 節</label><label className="filter-option"><input type="radio" name="time-of-day" checked={timeOfDayFilter === "evening"} onChange={() => setTimeOfDayFilter("evening")} />只要晚間 E 節</label><label className="filter-option"><input type="radio" name="time-of-day" checked={timeOfDayFilter === "weekday_evening_or_saturday"} onChange={() => setTimeOfDayFilter("weekday_evening_or_saturday")} />平日晚間＋星期六不限時段</label></div><label className="check"><input type="checkbox" checked={includeUnknownSchedule} onChange={(event) => setIncludeUnknownSchedule(event.target.checked)} />另外顯示時間未定的課程</label><span>{includeUnknownSchedule ? "時間未定課程可能不符合星期或時段，請自行確認。" : "時間未定課程不會混入主要推薦。"}</span></fieldset>
      <fieldset className="priority-legend recommendation-preferences"><legend>3. 學分數</legend><div className="category-options"><label className="filter-option"><input type="checkbox" checked={creditFilters.length === 0} onChange={() => setCreditFilters([])} />不限學分</label>{creditOptions.map((credits) => <label className="filter-option" key={credits}><input type="checkbox" checked={creditFilters.includes(credits)} onChange={() => setCreditFilters((current) => current.includes(credits) ? current.filter((item) => item !== credits) : [...current, credits])} />{credits} 學分</label>)}</div><span>{creditFilters.length ? `只顯示 ${creditFilters.join("、")} 學分課程。` : "未限制課程學分數。"}</span></fieldset>
      <fieldset id="eligibility-filters" className="priority-legend recommendation-preferences"><legend>4. 學制與先修</legend><label className="check"><input type="checkbox" checked={studyLevelOnly} onChange={(event) => setStudyLevelOnly(event.target.checked)} />只顯示符合「{profileStudyLevelLabel(profile)}」層級的課程</label>{studyLevelOnly && <label className="check"><input type="checkbox" checked={includeUnknownStudyLevel} onChange={(event) => setIncludeUnknownStudyLevel(event.target.checked)} />另外顯示學制資料不明的課程</label>}<div className="category-options"><label className="filter-option"><input type="radio" name="prerequisite-filter" checked={prerequisiteFilter === "exclude_unmet"} onChange={() => setPrerequisiteFilter("exclude_unmet")} />排除確定未滿足先修（建議）</label><label className="filter-option"><input type="radio" name="prerequisite-filter" checked={prerequisiteFilter === "show_with_warning"} onChange={() => setPrerequisiteFilter("show_with_warning")} />保留未滿足先修並警告</label></div><label className="check"><input type="checkbox" checked={includeUnknownPrerequisite} onChange={(event) => setIncludeUnknownPrerequisite(event.target.checked)} />另外顯示先修說明尚未結構化的課程</label><span>研究所層級包含碩士班、碩士在職專班與博士班；先修判斷依據你在「資料管理」中標記的已修課程。</span></fieldset>
      <fieldset id="course-level-filters" className="priority-legend recommendation-preferences"><legend>5. 課程程度</legend><div className="category-options"><label className="filter-option"><input type="radio" name="course-level-filter" checked={courseLevelFilter === "all"} onChange={() => setCourseLevelFilter("all")} />不限程度</label><label className="filter-option"><input type="radio" name="course-level-filter" checked={courseLevelFilter === "exclude_introductory"} onChange={() => setCourseLevelFilter("exclude_introductory")} />排除入門</label><label className="filter-option"><input type="radio" name="course-level-filter" checked={courseLevelFilter === "introductory"} onChange={() => setCourseLevelFilter("introductory")} />只要入門</label><label className="filter-option"><input type="radio" name="course-level-filter" checked={courseLevelFilter === "intermediate"} onChange={() => setCourseLevelFilter("intermediate")} />只要中階</label><label className="filter-option"><input type="radio" name="course-level-filter" checked={courseLevelFilter === "advanced"} onChange={() => setCourseLevelFilter("advanced")} />只要進階</label></div>{courseLevelFilter !== "all" && <label className="check"><input type="checkbox" checked={includeUnknownCourseLevel} onChange={(event) => setIncludeUnknownCourseLevel(event.target.checked)} />另外顯示程度資料不明的課程</label>}<span>程度只依課名中的「入門、導論、概論、基礎、中階、進階、高等」等明確字樣保守判定。</span></fieldset>
      <fieldset className="priority-legend recommendation-preferences"><legend>課表資訊</legend><label className="check"><input type="checkbox" checked={includeScheduleInfo} onChange={(event) => setIncludeScheduleInfo(event.target.checked)} />納入完整課表檢查衝堂</label><span>{includeScheduleInfo ? `已納入「${activePlan?.name ?? "目前課表"}」中的課程、手動指定時間及固定時段；可能衝堂的課程不會列入推薦。` : "不納入目前課表；推薦結果不進行衝堂排除。"}</span></fieldset>
      <fieldset className="priority-legend category-filter"><legend>6. 課程類別</legend><div className="category-options"><label className="filter-option"><input type="checkbox" checked={categoryFilters.length === 0} onChange={() => setCategoryFilters([])} />全部課程</label>{Object.entries(recommendationCategoryLabels).map(([value, label]) => { const category = value as RecommendationCategory; return <label className="filter-option" key={category}><input type="checkbox" checked={categoryFilters.includes(category)} onChange={() => toggleCategoryFilter(category)} />{label}</label>; })}</div><span>{categoryFilters.length > 0 ? `先保留已選的 ${categoryFilters.length} 類，再依學科主題排名。` : "先套用其他硬條件，再依學科主題排名。"}</span></fieldset>
      <fieldset className="priority-legend category-filter"><legend>7. 官方課程標籤</legend><div className="category-options"><label className="filter-option"><input type="checkbox" checked={courseTagFilters.length === 0} onChange={() => setCourseTagFilters([])} />不限官方標籤</label>{courseTagOptions.map((tag) => <label className="filter-option" key={tag.code}><input type="checkbox" checked={courseTagFilters.includes(tag.code)} onChange={() => toggleCourseTagFilter(tag.code)} />{tag.label_zh}</label>)}</div><span>{courseTagFilters.length ? "只保留具任一已選官方標籤的課程；未標示者不會混入結果。" : "標籤由輔大官方課程大綱提供；未標示不代表不屬於該類型。"}</span></fieldset>
      <section className="card safety-filter-summary" aria-label="安全篩選統計"><strong>目前安全條件會先排除</strong><div><span><b>{safetyStats.studyLevelMismatch}</b> 門學制不符</span><span><b>{safetyStats.studyLevelUnknown}</b> 門學制不明</span><span><b>{safetyStats.courseLevelMismatch}</b> 門程度不符</span><span><b>{safetyStats.courseLevelUnknown}</b> 門程度不明</span><span><b>{safetyStats.unmetPrerequisite}</b> 門確定未滿足先修</span><span><b>{safetyStats.ambiguousPrerequisite}</b> 門先修說明未結構化</span></div><small>各數字可能重複計入同一門課；推薦結果會再套用時間、學分、課表與課程類別條件。</small></section>
      {validationError && <div className="notice danger">{validationError}</div>}
      {error && <div className="notice danger">{error}</div>}
      {!results.length && !loading && <div className="empty-panel"><h2>先設定硬條件，再依學科主題排序</h2><div className="feature-grid"><span>明確篩選</span><span>語意檢索</span><span>關鍵字檢索</span><span>RRF 融合排名</span></div></div>}
      <div className="course-grid">{results.map((item, index) => <CourseCard key={item.course.course_id} course={item.course} alternatives={item.alternatives} profile={profile} catalog={catalog} rank={index + 1} reasons={item.reasons} recommendationCategory={item.category} />)}</div>
    </section>
  );
}

type AssistantTurn = { question: string; answer: AIAnswer };

function AssistantPage({ catalog, profile }: { catalog: Course[]; profile?: Profile }) {
  const [completed] = useStore<CompletedCourse & { id: string }>("completedCourses");
  const { activePlan } = useSchedulePlans();
  const [preferences] = useStore<Record<string, unknown>>("recommendationPreferences");
  const consent = preferences.find((item) => item.id === "ai-assistant-consent-v1");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState(0);
  const [error, setError] = useState("");
  const [lastFailedQuestion, setLastFailedQuestion] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [maxChars, setMaxChars] = useState(500);
  const [copied, setCopied] = useState(false);
  const phases = ["正在搜尋相關課綱", "正在檢查修課條件", "正在整理推薦理由"];
  const examples = [
    "想學 Python 實作，避開星期三",
    "推薦適合資工二年級的機器學習課",
    "有哪些兩學分且沒有先修要求的課？",
  ];

  useEffect(() => {
    void getFeatures().then((features) => {
      setEnabled(features.ai_assistant_enabled !== false);
      if (features.ai_max_question_chars) setMaxChars(features.ai_max_question_chars);
    }).catch(() => setEnabled(false));
  }, []);
  useEffect(() => {
    if (!loading) return undefined;
    const timer = window.setInterval(() => setLoadingPhase((current) => (current + 1) % phases.length), 1600);
    return () => window.clearInterval(timer);
  }, [loading, phases.length]);

  const ask = async (event?: FormEvent, questionOverride?: string) => {
    event?.preventDefault();
    const cleaned = (questionOverride ?? question).trim();
    if (!cleaned || loading) return;
    if (!profile) return;
    if (!consent) return;
    setLoading(true); setLoadingPhase(0); setError(""); setLastFailedQuestion(""); setCopied(false);
    try {
      const analysis = analyzeQuery(cleaned, { catalog });
      const response = await askCourseAssistant({
        request_id: crypto.randomUUID(),
        question: cleaned,
        history: turns.slice(-2).map<AIHistoryTurn>((turn) => ({
          question: turn.question,
          recommended_course_ids: turn.answer.recommendations.map((item) => item.course.course_id),
        })),
        context: {
          division: profile.division,
          department: profile.department,
          department_identity: profile.department_identity,
          grade: profile.grade,
          study_level: inferProfileStudyLevel(profile),

          preferred_weekdays: profile.preferredWeekdays,
          completed_course_ids: completed.map((item) => item.courseId),
          schedule_course_ids: activePlan?.entries.map((item) => item.courseId) ?? [],
        },
        hard_constraints: analysis.hardConstraints as HardConstraints,
      });
      setTurns((current) => [...current, { question: cleaned, answer: response }].slice(-6));
      setQuestion("");
    } catch (caught) {
      setLastFailedQuestion(cleaned);
      setError((caught as Error).message || "AI 小幫手暫時無法回應，請稍後再試。");
    } finally {
      setLoading(false);
    }
  };

  const agree = async () => {
    await putRecord("recommendationPreferences", {
      id: "ai-assistant-consent-v1",
      acceptedAt: new Date().toISOString(),
      version: 1,
    });
  };
  const copyLatest = async () => {
    const latest = turns.at(-1)?.answer.answer;
    if (!latest || !navigator.clipboard) return;
    await navigator.clipboard.writeText(latest);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  const retry = () => {
    const retryQuestion = lastFailedQuestion || turns.at(-1)?.question;
    if (!retryQuestion) return;
    void ask(undefined, retryQuestion);
  };

  if (!profile) return <EmptyState title="先完成個人設定" body="設定系所與年級後，AI 才能避開不適合你的課程。" action="開始設定" href="/onboarding" />;
  return (
    <section className="page assistant-page">
      <div className="hero assistant-hero"><div><div className="eyebrow">RAG 課程問答</div><h1>跟課程資料聊聊</h1><p>我會從目前課程目錄與課綱找資料，再說明推薦理由與選課注意事項。</p></div><div className="privacy-pill">● 不使用向量查詢</div></div>
      {!consent ? <section className="card assistant-consent"><h2>使用前先確認資料範圍</h2><p>這個功能會把你的問題、學制／系級、偏好星期，以及已修與課表中的課程 ID 傳到伺服器和 OpenAI 產生回答；資料會離開本機，並受 OpenAI API 資料控制政策約束。</p><p>不會傳送姓名、帳號、收藏、完整 IndexedDB 或 API key；資料只用於這次課程問答。</p><button className="primary" onClick={() => void agree()}>同意並開始使用</button></section> : <>
        {enabled === false && <div className="notice danger">AI 小幫手尚未設定 API key；其他課程功能仍可正常使用。</div>}
        <form className="assistant-composer card" onSubmit={(event) => void ask(event)}>
          <label htmlFor="assistant-question"><strong>想問什麼課程問題？</strong></label>
          <textarea id="assistant-question" aria-label="AI 課程問題" maxLength={maxChars} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder="例如：我想學資料分析，也希望不要和星期一的課衝堂…" />
          <div className="assistant-input-meta"><span>{question.length}/{maxChars}</span><button className="primary" type="submit" disabled={loading || enabled === false || !question.trim()}>{loading ? "正在整理…" : "詢問小幫手"}</button></div>
          <div className="assistant-examples" aria-label="問題範例">{examples.map((example) => <button type="button" key={example} onClick={() => setQuestion(example)}>{example}</button>)}</div>
        </form>
        {loading && <div className="assistant-thinking" role="status" aria-live="polite"><span className="thinking-dots"><i></i><i></i><i></i></span><strong>{phases[loadingPhase]}</strong><span>請稍候，正在依課程資料整理答案</span></div>}
        {error && <div className="notice danger assistant-error">{error}<button type="button" onClick={retry}>重試上一題</button></div>}
        {turns.length > 0 && <div className="assistant-toolbar"><span>本次對話保留最近兩輪上下文</span><div><button type="button" onClick={() => void copyLatest()}>{copied ? "已複製" : "複製最新答案"}</button><button type="button" onClick={() => setTurns([])}>清除對話</button></div></div>}
        <div className="assistant-thread">
          {turns.map((turn, turnIndex) => <article className="assistant-turn" key={`${turn.answer.request_id}-${turnIndex}`}>
            <div className="assistant-user-message"><span>你</span><p>{turn.question}</p></div>
            <div className="assistant-answer card"><div className="assistant-answer-label">AI 課程小幫手</div><p className="assistant-summary">{turn.answer.answer || "目前沒有足夠資料可以補充。"}</p>
              {turn.answer.recommendations.length > 0 && <><h2>推薦課程</h2><div className="course-grid">{turn.answer.recommendations.map((item, index) => <CourseCard key={`${turn.answer.request_id}-${item.course.course_id}`} course={item.course} profile={profile} catalog={catalog} rank={index + 1} reasons={[item.reason]} cautions={item.cautions} matchedFields={item.matched_fields} />)}</div></>}
              {turn.answer.follow_up_suggestions.length > 0 && <div className="assistant-followups"><strong>你也可以問：</strong>{turn.answer.follow_up_suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => setQuestion(suggestion)}>{suggestion}</button>)}</div>}
              {turn.answer.limitations.length > 0 && <div className="assistant-limitations">{turn.answer.limitations.map((limitation) => <p key={limitation}>ⓘ {limitation}</p>)}<NavLink to="/explore">前往探索課程 →</NavLink></div>}
            </div>
          </article>)}
        </div>
      </>}
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

function CourseCard({ course, alternatives, profile, catalog, rank, reasons, cautions, matchedFields, recommendationCategory }: { course: Course; alternatives?: Course[]; profile?: Profile; catalog: Course[]; rank?: number; reasons?: string[]; cautions?: string[]; matchedFields?: string[]; recommendationCategory?: Recommendation["category"] }) {
  const [completed] = useStore<CompletedCourse & { id: string }>("completedCourses");
  const [favorites] = useStore<{ id: string }>("favorites");
  const { activePlan, selectPlan } = useSchedulePlans();
  const variants = [course, ...(alternatives ?? [])].filter((item, index, values) => (
    values.findIndex((candidate) => candidate.course_id === item.course_id) === index
  ));
  const [selectedCourseId, setSelectedCourseId] = useState(course.course_id);
  useEffect(() => setSelectedCourseId(course.course_id), [course.course_id]);
  const selectedCourse = variants.find((item) => item.course_id === selectedCourseId) ?? course;
  const selectedRecommendationCategory = recommendationCategory
    ? classifyRecommendationCategory(selectedCourse, profile)
    : undefined;
  const completedNames = new Set(completed.map((item) => item.courseName));
  const eligibility = evaluateEligibility(selectedCourse, profile, completedNames);
  const favorite = favorites.some((item) => item.id === selectedCourse.course_id);
  const isCompleted = completed.some((item) => item.id === selectedCourse.course_id);
  const toggleFavorite = async () => favorite ? deleteRecord("favorites", selectedCourse.course_id) : putRecord("favorites", { id: selectedCourse.course_id, addedAt: new Date().toISOString() });
  const toggleCompleted = async () => isCompleted ? deleteRecord("completedCourses", selectedCourse.course_id) : putRecord("completedCourses", { id: selectedCourse.course_id, courseId: selectedCourse.course_id, courseName: selectedCourse.name_zh, continueLearning: false, addedAt: new Date().toISOString() });
  const dismiss = async () => {
    const addedAt = new Date().toISOString();
    await Promise.all(variants.map((item) => putRecord("dismissedCourses", { id: item.course_id, addedAt })));
  };
  const addSchedule = async () => {
    let plan = activePlan;
    if (!plan) plan = { id: crypto.randomUUID(), name: "我的課表", entries: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (plan.entries.some((item) => item.courseId === selectedCourse.course_id)) return;
    const scheduled = coursesInPlan(catalog, plan);
    const courseConflict = courseConflicts(selectedCourse, scheduled);
    const fixedConflict = meetingsConflict(selectedCourse.meetings, (plan.fixedEntries ?? []).flatMap((entry) => entry.meetings));
    const conflict = {
      conflict: courseConflict.conflict || fixedConflict.conflict,
      uncertain: courseConflict.uncertain || fixedConflict.uncertain,
    };
    if (conflict.conflict && !window.confirm("這門課與目前課表衝堂。仍要加入嗎？")) return;
    if (conflict.uncertain && !window.confirm("週次資料不完整，可能衝堂。仍要加入嗎？")) return;
    await putRecord("schedulePlans", { ...plan, entries: [...plan.entries, { courseId: selectedCourse.course_id, locked: false }], updatedAt: new Date().toISOString() });
    if (!activePlan) await selectPlan(plan.id);
  };
  return (
    <article className="course-card">
      <div className="course-top">{rank && <span className="rank">#{rank}</span>}{selectedRecommendationCategory && <span className={`category-tag ${selectedRecommendationCategory}`}>{recommendationCategoryLabels[selectedRecommendationCategory]}</span>}<span className={`status ${eligibility.status}`}>{eligibility.blocked.some((rule) => rule.kind === "course_prerequisite") ? "有擋修條件" : statusLabels[eligibility.status]}</span><button className={`heart ${favorite ? "active" : ""}`} onClick={toggleFavorite} aria-label="收藏">♥</button></div>
      <h2>{selectedCourse.name_zh}</h2><p className="muted">{selectedCourse.name_en}</p>
      <div className="meta"><span>{selectedCourse.official_department_label ?? selectedCourse.department_display ?? inferAudienceDepartment(selectedCourse)}</span><span>{selectedCourse.teacher || "教師未定"}</span><span>{selectedCourse.credits} 學分</span><span>{selectedCourse.required_elective_name}</span></div>{selectedCourse.course_tags?.length ? <div className="official-course-tags" aria-label="官方課程標籤">{selectedCourse.course_tags.map((tag) => <span key={tag.code}>{tag.label_zh}</span>)}</div> : null}
      <p className="meeting">{formatMeetings(selectedCourse)}</p>
      {variants.length > 1 && <details className="course-variants"><summary>{variants.length} 個班別／共同開課選項</summary><div className="variant-list">{variants.map((variant) => {
        const variantEligibility = evaluateEligibility(variant, profile, completedNames);
        return <button type="button" className={variant.course_id === selectedCourse.course_id ? "active" : ""} aria-pressed={variant.course_id === selectedCourse.course_id} onClick={() => setSelectedCourseId(variant.course_id)} key={variant.course_id}><strong>{variant.official_department_label ?? variant.department_display ?? inferAudienceDepartment(variant)}</strong><span>{variant.teacher || "教師未定"} · {formatMeetings(variant)}</span><small>{variantEligibility.blocked.some((rule) => rule.kind === "course_prerequisite") ? "有擋修條件" : statusLabels[variantEligibility.status]}</small></button>;
      })}</div></details>}
      {reasons?.length ? <div className="recommendation-reasons"><strong>推薦理由</strong><ul className="reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div> : null}
      {matchedFields?.length ? <p className="matched-fields">資料依據：{matchedFields.map((field) => assistantFieldLabels[field] ?? field).join("、")}</p> : null}
      {cautions?.length ? <div className="cautions"><strong>選課注意</strong><ul>{cautions.map((caution) => <li key={caution}>{caution}</li>)}</ul></div> : null}
      <details><summary>查看課綱與判斷依據</summary><div className="details"><h3>課程目標</h3><p>{selectedCourse.sections.objective || "未提供"}</p>{selectedCourse.prerequisite && <><h3>先備知識</h3><p>{selectedCourse.prerequisite}</p></>}{getEligibilityRules(selectedCourse).map((rule, index) => <div className="evidence" key={`${rule.kind}-${index}`}><strong>{rule.message}</strong><q>{rule.evidence}</q></div>)}<a href={selectedCourse.source_url} target="_blank" rel="noreferrer">開啟官方課綱 ↗</a></div></details>
      <div className="card-actions"><button onClick={addSchedule}>＋ {activePlan?.name ?? "我的課表"}</button><button onClick={toggleCompleted}>{isCompleted ? "取消已修" : "標記已修"}</button><button className="quiet" onClick={dismiss}>不感興趣</button></div>
    </article>
  );
}

function DataPage({ catalog }: { catalog: Course[] }) {
  const [completed] = useStore<CompletedCourse & { id: string }>("completedCourses");
  const [favorites] = useStore<{ id: string }>("favorites");
  const { plans } = useSchedulePlans();
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

export default App;
