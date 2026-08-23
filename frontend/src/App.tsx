import { FormEvent, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { CaretDown, Heart, Info, List, Warning } from "@phosphor-icons/react";
import { askCourseAssistant, embedQuery, getCatalog, getClassGroups, getCourses, getCoursesByIds, getDepartmentCatalog, getEmbeddingBundle, getFacets, getFeatures, lookupCourses } from "./api";
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
import { courseConflicts, evaluateEligibility, formatCourseStudyLevelLabel, getEligibilityRules, inferAudienceDepartment, inferProfileStudyLevel, meetingsConflict } from "./eligibility";
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
  rankCourses,
  recommendationCategoryLabels,
  type CourseLevelFilter,
  type PrerequisiteFilter,
  type TimeOfDayFilter,
} from "./recommendation";
import { selectRequiredCourses } from "./requiredCourses";
import { coursesInPlan, meetingsInPlan, resolveActiveSchedulePlan } from "./scheduleUtils";
import { buildSearchIndex } from "./search";
import { formatMeetings, ScheduleWorkspace } from "./ScheduleWorkspace";
import { analyzeQuery } from "./queryAnalysis";
import { ConfirmDialog, Modal, useFeedback } from "./ui";
import { sanitizeSubjectQuery, type DetectedFilterPhrase } from "./subjectQuery";
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
const HIGH_CREDIT_THRESHOLD = 4;
const AI_ASSISTANT_VISIBLE = false;

function getHighCreditOptions(creditOptions: number[]): number[] {
  return creditOptions.filter((credits) => credits >= HIGH_CREDIT_THRESHOLD);
}

function isHighCreditFilterSelected(selectedCredits: number[], highCreditOptions: number[]): boolean {
  return highCreditOptions.length > 0 && highCreditOptions.every((credits) => selectedCredits.includes(credits));
}

function toggleHighCreditFilter(selectedCredits: number[], highCreditOptions: number[]): number[] {
  if (isHighCreditFilterSelected(selectedCredits, highCreditOptions)) {
    return selectedCredits.filter((credits) => !highCreditOptions.includes(credits));
  }
  return [...new Set([...selectedCredits, ...highCreditOptions])];
}

function formatCreditFilterSummary(selectedCredits: number[], highCreditOptions: number[]): string {
  const highCreditSelected = isHighCreditFilterSelected(selectedCredits, highCreditOptions);
  const highCreditSet = new Set(highCreditOptions);
  const individualCredits = selectedCredits
    .filter((credits) => !highCreditSelected || !highCreditSet.has(credits))
    .sort((left, right) => left - right);
  const labels = individualCredits.map((credits) => `${credits} 學分`);
  if (highCreditSelected) labels.push(`${HIGH_CREDIT_THRESHOLD} 學分以上`);
  return labels.join("、");
}

const assistantFieldLabels: Record<string, string> = {
  title: "課名／課號",
  skills: "技能與學習成果",
  objective: "課程目標",
  weekly_progress: "每週進度",
  prerequisite: "先修／加選備註",
  materials: "教材",
  history: "最近對話課程",
};

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

const navigationItems = [
  { to: "/recommend", label: "為你推薦" },
  ...(AI_ASSISTANT_VISIBLE ? [{ to: "/assistant", label: "AI 小幫手" }] : []),
  { to: "/explore", label: "探索課程" },
  { to: "/schedule", label: "我的課表" },
  { to: "/data", label: "資料管理" },
];

function RouteFocusManager() {
  const location = useLocation();
  useEffect(() => {
    window.requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>("#main-content h1");
      if (!heading) return;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: "start" });
    });
  }, [location.pathname]);
  return null;
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuFirstRef = useRef<HTMLAnchorElement>(null);
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

  const profileLabel = profile ? profile.department + " " + profile.grade + " 年級" : "開始設定";
  return (
    <SchedulePlanContext.Provider value={{ plans, activePlan, selectPlan }}>
      <a className="skip-link" href="#main-content">跳到主要內容</a>
      <div className="app-shell">
        <header className="topbar">
          <NavLink to="/recommend" className="brand"><span>FJU</span><strong>選課指南</strong></NavLink>
          <nav className="desktop-nav" aria-label="主要導覽">
            {navigationItems.map((item) => <NavLink key={item.to} to={item.to}>{item.label}</NavLink>)}
          </nav>
          <NavLink className="profile-link desktop-profile" to="/onboarding">
            <span className="profile-full">{profileLabel}</span>
            <span className="profile-compact">{profile ? "個人設定 · " + profile.grade + " 年級" : "開始設定"}</span>
          </NavLink>
          <button type="button" className="icon-button menu-button" aria-label="開啟選單" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <List aria-hidden="true" />
          </button>
        </header>
        <main id="main-content">
          <RouteFocusManager />
          <Routes>
            <Route path="/" element={<Navigate to={profile ? "/recommend" : "/onboarding"} replace />} />
            <Route path="/onboarding" element={<Onboarding profile={profile} />} />
            <Route path="/recommend" element={<RecommendPage profile={profile} />} />
            <Route path="/assistant" element={AI_ASSISTANT_VISIBLE ? <AssistantPage profile={profile} /> : <Navigate to="/recommend" replace />} />
            <Route path="/explore" element={<ExplorePage profile={profile} />} />
            <Route path="/schedule" element={<SchedulePage plans={plans} active={activePlan} profile={profile} selectPlan={selectPlan} />} />
            <Route path="/data" element={<DataPage />} />
          </Routes>
        </main>
        <footer>MVP 1.0 · 推薦結果僅供規劃參考，實際資格、名額與開課資訊以校方選課系統為準。</footer>
      </div>
      <Modal open={menuOpen} title="前往功能" onClose={() => setMenuOpen(false)} initialFocusRef={menuFirstRef} className="navigation-drawer">
        <nav aria-label="行動版主要導覽" onClick={() => setMenuOpen(false)}>
          {navigationItems.map((item, index) => <NavLink ref={index === 0 ? menuFirstRef : undefined} key={item.to} to={item.to}>{item.label}</NavLink>)}
          <NavLink to="/onboarding">個人設定<span>{profileLabel}</span></NavLink>
        </nav>
      </Modal>
    </SchedulePlanContext.Provider>
  );
}

function SchedulePage({ plans, active, profile, selectPlan }: { plans: SchedulePlan[]; active?: SchedulePlan; profile?: Profile; selectPlan: (planId: string) => Promise<void> }) {
  const courseIds = useMemo(() => active?.entries.map((entry) => entry.courseId) ?? [], [active?.entries]);
  const courseIdsKey = courseIds.join("\u0000");
  const [catalog, setCatalog] = useState<Course[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(Boolean(courseIds.length));
    setError("");
    void getCoursesByIds(courseIds).then((courses) => {
      if (!cancelled) setCatalog(courses);
    }).catch((caught) => {
      if (!cancelled) setError((caught as Error).message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [courseIdsKey]);
  if (loading) return <section className="page"><div className="empty-panel" role="status"><h1>正在載入課表</h1><p>只讀取目前方案中的課程。</p></div></section>;
  if (error) return <section className="page"><div className="notice danger" role="alert"><h1>無法載入課表</h1><p>{error}</p></div></section>;
  return <ScheduleWorkspace catalog={catalog} plans={plans} active={active} profile={profile} selectPlan={selectPlan} />;
}

function Onboarding({ profile }: { profile?: Profile }) {
  const [departmentCatalog, setDepartmentCatalog] = useState<DepartmentCatalog>();
  const [departmentCatalogError, setDepartmentCatalogError] = useState("");
  useEffect(() => {
    void getDepartmentCatalog().then(setDepartmentCatalog).catch((error) => setDepartmentCatalogError((error as Error).message));
  }, []);
  const navigate = useNavigate();
  const { notify } = useFeedback();
  const { plans, activePlan, selectPlan } = useSchedulePlans();
  const divisions = useMemo(() => buildDivisionOptions([], departmentCatalog), [departmentCatalog]);
  const departmentOptions = useMemo(() => buildDepartmentOptions([], departmentCatalog), [departmentCatalog]);
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
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
  const [classGroupOptions, setClassGroupOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!selectedDepartmentOption) {
      setClassGroupOptions([]);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      department: selectedDepartmentOption.identity ?? selectedDepartmentOption.value,
      division: form.division,
      grade: String(form.grade),
    });
    void getClassGroups(params, controller.signal).then(setClassGroupOptions).catch((error) => {
      if ((error as Error).name !== "AbortError") setSaveError((error as Error).message);
    });
    return () => controller.abort();
  }, [form.division, form.grade, selectedDepartmentOption?.identity]);
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
    setSaving(true);
    setSaveError("");
    try {
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
    if (autoAddRequiredCourses) {
      const catalog = await getCatalog();
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
      notify(summary + detail.replace("\n", " ") + " 共同必修中的英文／國文課程仍請依校方分發結果確認。");
    }
    navigate("/recommend");
    } catch (error) {
      setSaveError((error as Error).message || "無法儲存個人設定，請稍後重試。");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="narrow-page">
      <div className="eyebrow">只存在這台裝置</div>
      <h1>先設定你的基本資料</h1>
      <p className="lead">一般推薦所需的系級與修課紀錄只保存在這個瀏覽器，不會建立帳號。</p>
      {departmentCatalogError && <div className="notice danger" role="alert">無法載入系所選項：{departmentCatalogError}</div>}
      {!departmentCatalog && !departmentCatalogError && <div className="notice" role="status">正在載入系所選項…</div>}
      <form className="card form-grid profile-form" onSubmit={save} aria-busy={saving}><fieldset className="contents-fieldset" disabled={saving}>
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
            <button className="department-combobox-toggle" type="button" aria-label={departmentMenuOpen ? "收合系所清單" : "展開系所清單"} onClick={() => { setDepartmentMenuOpen((open) => !open); departmentInputRef.current?.focus(); }}><CaretDown aria-hidden="true" /></button>
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
        {saveError && <div className="notice danger wide" role="alert">儲存失敗：{saveError}</div>}
        <button className="primary wide" type="submit" aria-busy={saving}>{saving ? "儲存中…" : "儲存並前往推薦"}</button>
      </fieldset></form>
    </section>
  );
}

function RecommendPage({ profile }: { profile?: Profile }) {
  const [catalog, setCatalog] = useState<Course[]>([]);
  const searchIndex = useMemo(() => buildSearchIndex(catalog), [catalog]);
  const [facets, setFacets] = useState<Record<string, { value: string; label: string }[]>>({});
  useEffect(() => { void getFacets().then(setFacets).catch(() => undefined); }, []);
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [validationError, setValidationError] = useState("");
  const validationSummaryRef = useRef<HTMLDivElement>(null);
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
      const [courseCatalog, bundle, query] = await Promise.all([
        getCatalog(),
        getEmbeddingBundle(),
        embedQuery(sanitizedPreview.subjectQuery),
      ]);
      setCatalog(courseCatalog);
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
  if (!profile) return <EmptyState title="先完成個人設定" body="設定系所與年級後，才能判斷課程限制並產生推薦。" action="開始設定" href="/onboarding" />;
  return (
    <section className="page">
      <div className="hero"><div><div className="eyebrow">115-1 個人化推薦</div><h1>找到真正適合你的下一門課</h1><p>推薦在你的裝置上完成；已修課、收藏和課表不會送到後端。</p></div><div className="privacy-pill">● Local-first</div></div>
      <div className="recommend-box"><div className="subject-query-field"><label htmlFor="subject-query">想學的主題或技能</label><textarea id="subject-query" aria-label="想學的主題或技能" aria-invalid={Boolean(validationError && !sanitizedPreview.subjectQuery)} aria-describedby={validationError && !sanitizedPreview.subjectQuery ? "recommend-subject-error" : undefined} maxLength={500} value={interest} onChange={(e) => setInterest(e.target.value)} placeholder="例如：電子商務、社群行銷、零售數據分析與業界案例" /><small>搜尋文字只決定課程內容的相關性；上課星期、學分與先修條件請使用下方篩選器。課程學制會標示在結果卡片上。</small>{validationError && !sanitizedPreview.subjectQuery && <small id="recommend-subject-error" className="field-error">{validationError}</small>}</div><button className="primary" onClick={recommend} disabled={loading}>{loading ? "正在分析…" : "產生推薦"}</button></div>
      {validationError && <div ref={validationSummaryRef} className="notice danger error-summary" role="alert" tabIndex={-1}><strong>請修正後再產生推薦</strong><p>{validationError}</p></div>}
      {lastEmbedding && <section className="search-execution-summary" aria-label="本次搜尋內容"><span><strong>本次學科主題</strong>{lastEmbedding.queryText}</span><span><strong>硬條件來源</strong>下方明確篩選器</span><span><strong>目前結果</strong>{results.length ? `顯示前 ${results.length} 門` : "尚未找到符合條件的課程"}</span></section>}
      <section className="filter-workspace" aria-labelledby="recommendation-filter-heading">
        <div className="filter-section-heading"><div><span>硬條件篩選</span><h2 id="recommendation-filter-heading">選出真正可修的課</h2></div><p>先設定重要條件，再依學科主題排序；不常用的選項會收在進階設定。</p></div>
        <div className="applied-filters" aria-live="polite"><div><strong>已套用 {activeFilterCount} 項條件</strong><div className="applied-filter-list">
          {!showOtherWeekdays && <button type="button" onClick={() => setShowOtherWeekdays(true)}>星期{preferredWeekdays.map((day) => weekdays[day - 1]).join("、")}<span aria-hidden="true">×</span></button>}
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
          <summary><span><b>上課安排</b><small>{showOtherWeekdays ? "不限星期" : `星期${preferredWeekdays.map((day) => weekdays[day - 1]).join("、")}`}{timeOfDayFilter !== "all" && " · 已限制時段"}{creditFilters.length > 0 && ` · ${creditFilterSummary}`}</small></span><span className="filter-group-count">常用</span></summary>
          <div className="filter-group-content">
            <div className="filter-control"><div className="filter-control-heading"><strong>上課星期</strong><span>{showOtherWeekdays ? "目前不依星期排除" : "只顯示可上的星期"}</span></div><div className="choice-row" aria-label="偏好的上課星期" aria-describedby={!preferredWeekdays.length ? "weekday-error" : undefined}>{weekdays.map((label, index) => { const day = index + 1; return <button type="button" className={`choice-chip ${preferredWeekdays.includes(day) ? "selected" : ""}`} aria-pressed={preferredWeekdays.includes(day)} key={day} onClick={() => togglePreferredWeekday(day)}>星期{label}</button>; })}</div>{!preferredWeekdays.length && <small id="weekday-error" className="field-error">請至少選擇一個星期</small>}<button type="button" className={`filter-toggle ${showOtherWeekdays ? "active" : ""}`} aria-pressed={showOtherWeekdays} onClick={() => setShowOtherWeekdays((current) => !current)}>暫時忽略星期限制</button></div>
            
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
      {validationError && <div className="notice danger">{validationError}</div>}
      {error && <div className="notice danger" role="alert">推薦失敗：{error}<button type="button" onClick={() => void recommend()}>重試</button></div>}
      {loading && <div className="empty-panel" role="status"><h2>正在產生推薦…</h2><p>正在比對課程內容與你設定的修課條件。</p></div>}
      {!lastEmbedding && !loading && !error && <div className="empty-panel"><h2>輸入主題，開始找適合的課</h2><div className="feature-grid"><span>明確篩選</span><span>語意檢索</span><span>關鍵字檢索</span><span>RRF 融合排名</span></div></div>}
      {lastEmbedding && !results.length && !loading && !error && <div className="empty-panel"><h2>沒有符合全部條件的課程</h2><p>可以放寬條件，或換一個更廣泛的主題。</p><div className="empty-actions"><button type="button" onClick={clearFilters}>清除全部條件</button><button type="button" onClick={() => document.getElementById("subject-query")?.focus()}>修改主題</button></div></div>}
      <div className="course-grid">{results.map((item, index) => <CourseCard key={item.course.course_id} course={item.course} alternatives={item.alternatives} profile={profile} rank={index + 1} reasons={item.reasons} recommendationCategory={item.category} />)}</div>
    </section>
  );
}

type AssistantTurn = { question: string; answer: AIAnswer };

function AssistantPage({ profile }: { profile?: Profile }) {
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
  const [copyError, setCopyError] = useState("");
  const [completionAnnouncement, setCompletionAnnouncement] = useState("");
  const questionRef = useRef<HTMLTextAreaElement>(null);
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
      const catalog = await getCatalog();
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
    if (!latest) return;
    setCopyError("");
    try {
      if (!navigator.clipboard) throw new Error("這個瀏覽器不支援剪貼簿");
      await navigator.clipboard.writeText(latest);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (caught) {
      setCopyError("複製失敗：" + (caught as Error).message);
    }
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
          <textarea ref={questionRef} id="assistant-question" aria-label="AI 課程問題" maxLength={maxChars} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} placeholder="例如：我想學資料分析，也希望不要和星期一的課衝堂…" />
          <div className="assistant-input-meta"><span>{question.length}/{maxChars}</span><button className="primary" type="submit" disabled={loading || enabled === false || !question.trim()} aria-busy={loading}>{loading ? "正在整理…" : "詢問小幫手"}</button></div>
          <div className="assistant-examples" aria-label="問題範例">{examples.map((example) => <button type="button" key={example} onClick={() => setQuestion(example)}>{example}</button>)}</div>
        </form>
        {loading && <div className="assistant-thinking"><span className="sr-only" role="status">正在整理回答</span><span className="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><strong aria-hidden="true">{phases[loadingPhase]}</strong><span aria-hidden="true">請稍候，正在依課程資料整理答案</span></div>}
        <div className="sr-only" role="status" aria-live="polite">{completionAnnouncement}</div>
        {copyError && <div className="notice danger" role="alert">{copyError}</div>}
        {error && <div className="notice danger assistant-error" role="alert">{error}<button type="button" onClick={retry}>重試上一題</button></div>}
        {turns.length > 0 && <div className="assistant-toolbar"><span>本次對話保留最近兩輪上下文</span><div><button type="button" onClick={() => void copyLatest()}>{copied ? "已複製" : "複製最新答案"}</button><button type="button" onClick={() => setTurns([])}>清除對話</button></div></div>}
        <div className="assistant-thread">
          {turns.map((turn, turnIndex) => <article className="assistant-turn" key={`${turn.answer.request_id}-${turnIndex}`}>
            <div className="assistant-user-message"><span>你</span><p>{turn.question}</p></div>
            <div className="assistant-answer card"><div className="assistant-answer-label">AI 課程小幫手</div><p className="assistant-summary">{turn.answer.answer || "目前沒有足夠資料可以補充。"}</p>
              {turn.answer.recommendations.length > 0 && <><h2>推薦課程</h2><div className="course-grid">{turn.answer.recommendations.map((item, index) => <CourseCard key={`${turn.answer.request_id}-${item.course.course_id}`} course={item.course} profile={profile} rank={index + 1} reasons={[item.reason]} cautions={item.cautions} matchedFields={item.matched_fields} />)}</div></>}
              {turn.answer.follow_up_suggestions.length > 0 && <div className="assistant-followups"><strong>你也可以問：</strong>{turn.answer.follow_up_suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => { setQuestion(suggestion); window.requestAnimationFrame(() => questionRef.current?.focus()); }}>{suggestion}</button>)}</div>}
              {turn.answer.limitations.length > 0 && <div className="assistant-limitations">{turn.answer.limitations.map((limitation) => <p key={limitation}><Info aria-hidden="true" />{limitation}</p>)}<NavLink to="/explore">前往探索課程 →</NavLink></div>}
            </div>
          </article>)}
        </div>
      </>}
    </section>
  );
}

function ExplorePage({ profile }: { profile?: Profile }) {
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
        <label><span>上課星期</span><select value={weekday} onChange={(event) => { setWeekday(event.target.value); setPage(1); }}><option value="">所有星期</option>{weekdays.map((label, index) => <option key={label} value={index + 1}>星期{label}</option>)}</select></label>
      </div>
      {loading && !hasLoaded && <div className="course-grid skeleton-grid" role="status" aria-label="正在載入課程">{[1, 2, 3, 4].map((item) => <div className="course-skeleton" key={item}><span></span><span></span><span></span></div>)}</div>}
      {error && <div className="notice danger" role="alert">無法載入課程：{error}<button type="button" onClick={() => setRetryKey((value) => value + 1)}>重試</button></div>}
      {hasLoaded && !error && !courses.length && !loading && <div className="empty-panel"><h2>找不到符合條件的課程</h2><p>請嘗試較短的關鍵字，或清除目前篩選。</p><button type="button" onClick={clearExploreFilters}>清除篩選</button></div>}
      {hasLoaded && !error && <div className="results-region" aria-busy={loading}>{loading && <div className="updating-indicator" role="status">正在更新結果…</div>}<div className="course-grid">{courses.map((item) => <CourseCard key={item.course_id} course={item} profile={profile} />)}</div></div>}
      {hasLoaded && !error && courses.length > 0 && <div className="pager"><button disabled={loading || page === 1} onClick={() => setPage((value) => value - 1)}>上一頁</button><span>第 {page} 頁</span><button disabled={loading || page * 25 >= total} onClick={() => setPage((value) => value + 1)}>下一頁</button></div>}
    </section>
  );
}

function CourseCard({ course, alternatives, profile, rank, reasons, cautions, matchedFields, recommendationCategory }: { course: Course; alternatives?: Course[]; profile?: Profile; rank?: number; reasons?: string[]; cautions?: string[]; matchedFields?: string[]; recommendationCategory?: Recommendation["category"] }) {
  const [completed] = useStore<CompletedCourse & { id: string }>("completedCourses");
  const [favorites] = useStore<{ id: string }>("favorites");
  const { activePlan, selectPlan } = useSchedulePlans();
  const { notify } = useFeedback();
  const [pending, setPending] = useState<"favorite" | "completed" | "schedule" | "dismiss" | "">("");
  const [conflictRequest, setConflictRequest] = useState<{ plan: SchedulePlan; message: string }>();
  const variants = [course, ...(alternatives ?? [])].filter((item, index, values) => values.findIndex((candidate) => candidate.course_id === item.course_id) === index);
  const [selectedCourseId, setSelectedCourseId] = useState(course.course_id);
  useEffect(() => setSelectedCourseId(course.course_id), [course.course_id]);
  const selectedCourse = variants.find((item) => item.course_id === selectedCourseId) ?? course;
  const selectedRecommendationCategory = recommendationCategory ? classifyRecommendationCategory(selectedCourse, profile) : undefined;
  const completedNames = new Set(completed.map((item) => item.courseName));
  const eligibility = evaluateEligibility(selectedCourse, profile, completedNames);
  const eligibilityCautions = eligibility.blocked.some((rule) => rule.kind === "course_prerequisite")
    ? ["本課程設有先修條件，請確認你是否已修畢。"]
    : eligibility.status === "blocked_confirmed"
      ? ["目前可能不符合修課資格，請展開查看規定。"]
      : eligibility.status === "needs_confirmation"
        ? ["修課資格尚未能確認，建議先查看課綱或選課系統。"]
        : [];
  const courseCautions = [...new Set([...eligibilityCautions, ...(cautions ?? [])])];
  const favorite = favorites.some((item) => item.id === selectedCourse.course_id);
  const isCompleted = completed.some((item) => item.id === selectedCourse.course_id);
  const scheduled = Boolean(activePlan?.entries.some((item) => item.courseId === selectedCourse.course_id));

  const toggleFavorite = async () => {
    if (pending) return;
    setPending("favorite");
    try {
      if (favorite) await deleteRecord("favorites", selectedCourse.course_id);
      else await putRecord("favorites", { id: selectedCourse.course_id, addedAt: new Date().toISOString() });
    } catch (error) { notify("收藏操作失敗：" + (error as Error).message, "error"); }
    finally { setPending(""); }
  };
  const toggleCompleted = async () => {
    if (pending) return;
    setPending("completed");
    try {
      if (isCompleted) await deleteRecord("completedCourses", selectedCourse.course_id);
      else await putRecord("completedCourses", { id: selectedCourse.course_id, courseId: selectedCourse.course_id, courseName: selectedCourse.name_zh, continueLearning: false, addedAt: new Date().toISOString() });
    } catch (error) { notify("更新已修狀態失敗：" + (error as Error).message, "error"); }
    finally { setPending(""); }
  };
  const dismiss = async () => {
    if (pending) return;
    setPending("dismiss");
    const id = selectedCourse.course_id;
    try {
      const addedAt = new Date().toISOString();
      await putRecord("dismissedCourses", { id, addedAt });
      notify("已從推薦中排除此課程", "success", { label: "復原", onAction: () => deleteRecord("dismissedCourses", id) });
    } catch (error) { notify("無法更新推薦偏好：" + (error as Error).message, "error"); }
    finally { setPending(""); }
  };
  const commitSchedule = async (plan: SchedulePlan) => {
    setPending("schedule");
    try {
      await putRecord("schedulePlans", { ...plan, entries: [...plan.entries, { courseId: selectedCourse.course_id, locked: false }], updatedAt: new Date().toISOString() });
      if (!activePlan) await selectPlan(plan.id);
      notify("已加入「" + plan.name + "」");
    } catch (error) { notify("加入課表失敗：" + (error as Error).message, "error"); }
    finally { setPending(""); setConflictRequest(undefined); }
  };
  const addSchedule = async () => {
    if (pending || scheduled) return;
    let plan = activePlan;
    if (!plan) plan = { id: crypto.randomUUID(), name: "我的課表", entries: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    let scheduledCourses: Course[];
    try {
      scheduledCourses = await getCoursesByIds(plan.entries.map((entry) => entry.courseId));
    } catch (error) {
      notify("無法檢查目前課表：" + (error as Error).message, "error");
      return;
    }
    const courseConflict = courseConflicts(selectedCourse, scheduledCourses);
    const fixedConflict = meetingsConflict(selectedCourse.meetings, (plan.fixedEntries ?? []).flatMap((entry) => entry.meetings));
    if (courseConflict.conflict || fixedConflict.conflict) {
      setConflictRequest({ plan, message: "這門課與目前課表衝堂。仍要加入嗎？" }); return;
    }
    if (courseConflict.uncertain || fixedConflict.uncertain) {
      setConflictRequest({ plan, message: "週次資料不完整，可能衝堂。仍要加入嗎？" }); return;
    }
    await commitSchedule(plan);
  };
  return (
    <article className="course-card">
      <div className="course-top">{rank && <span className="rank">#{rank}</span>}{selectedRecommendationCategory && <span className={"category-tag " + selectedRecommendationCategory}>{recommendationCategoryLabels[selectedRecommendationCategory]}</span>}<span className={"status " + eligibility.status}>{eligibility.blocked.some((rule) => rule.kind === "course_prerequisite") ? "有擋修條件" : statusLabels[eligibility.status]}</span><button type="button" className={"heart icon-button " + (favorite ? "active" : "")} onClick={() => void toggleFavorite()} disabled={pending === "favorite"} aria-busy={pending === "favorite"} aria-pressed={favorite} aria-label={favorite ? "取消收藏課程" : "收藏課程"}><Heart weight={favorite ? "fill" : "regular"} aria-hidden="true" /></button></div>
      <h2>{selectedCourse.name_zh}</h2><p className="muted">{selectedCourse.name_en}</p>
      <div className="meta"><span className="study-level-badge">{formatCourseStudyLevelLabel(selectedCourse)}</span><span>{selectedCourse.official_department_label ?? selectedCourse.department_display ?? inferAudienceDepartment(selectedCourse)}</span><span>{selectedCourse.teacher || "教師未定"}</span><span>{selectedCourse.credits} 學分</span><span>{selectedCourse.required_elective_name}</span></div>{selectedCourse.course_tags?.length ? <div className="official-course-tags" aria-label="官方課程標籤">{selectedCourse.course_tags.map((tag) => <span key={tag.code}>{tag.label_zh}</span>)}</div> : null}
      <p className="meeting">{formatMeetings(selectedCourse)}</p>
      {variants.length > 1 && <details className="course-variants"><summary>可選的班別／共同開課項目（{variants.length} 個）</summary><div className="variant-list">{variants.map((variant) => { const variantEligibility = evaluateEligibility(variant, profile, completedNames); return <button type="button" className={variant.course_id === selectedCourse.course_id ? "active" : ""} aria-pressed={variant.course_id === selectedCourse.course_id} onClick={() => setSelectedCourseId(variant.course_id)} key={variant.course_id}><strong>{variant.official_department_label ?? variant.department_display ?? inferAudienceDepartment(variant)}</strong><span>{variant.teacher || "教師未定"} · {formatMeetings(variant)}</span><small>{variantEligibility.blocked.some((rule) => rule.kind === "course_prerequisite") ? "有擋修條件" : statusLabels[variantEligibility.status]}</small></button>; })}</div></details>}
      {reasons?.length ? <div className="recommendation-reasons"><strong>為什麼推薦這堂？</strong><ul className="reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div> : null}
      {matchedFields?.length ? <p className="matched-fields">參考課綱：{matchedFields.map((field) => assistantFieldLabels[field] ?? field).join("、")}</p> : null}
      {courseCautions.length ? <div className="cautions" role="note"><strong>修課前請確認</strong><ul>{courseCautions.map((caution) => <li key={caution}>{caution}</li>)}</ul></div> : null}
      <details><summary>查看課綱與判斷依據</summary><div className="details"><h3>課程目標</h3><p>{selectedCourse.sections.objective || "未提供"}</p>{selectedCourse.prerequisite && <><h3>先備知識</h3><p>{selectedCourse.prerequisite}</p></>}{getEligibilityRules(selectedCourse).map((rule, index) => <div className="evidence" key={rule.kind + "-" + index}><strong>{rule.message}</strong><q>{rule.evidence}</q></div>)}<a href={selectedCourse.source_url} target="_blank" rel="noreferrer">開啟官方課綱</a></div></details>
      <div className="card-actions"><button type="button" onClick={() => void addSchedule()} disabled={scheduled || pending === "schedule"} aria-busy={pending === "schedule"}>{scheduled ? "已加入課表" : pending === "schedule" ? "加入中…" : "加入 " + (activePlan?.name ?? "我的課表")}</button><button type="button" onClick={() => void toggleCompleted()} disabled={pending === "completed"} aria-busy={pending === "completed"}>{pending === "completed" ? "更新中…" : isCompleted ? "取消已修" : "標記已修"}</button><button type="button" className="quiet" onClick={() => void dismiss()} disabled={pending === "dismiss"} aria-busy={pending === "dismiss"}>{pending === "dismiss" ? "處理中…" : "不感興趣"}</button></div>
      <ConfirmDialog open={Boolean(conflictRequest)} title="確認加入課表" description={<p>{conflictRequest?.message}</p>} confirmLabel="仍要加入" onCancel={() => setConflictRequest(undefined)} onConfirm={() => conflictRequest && commitSchedule(conflictRequest.plan)} busy={pending === "schedule"} />
    </article>
  );
}

function DataPage() {
  const [completed] = useStore<CompletedCourse & { id: string }>("completedCourses");
  const [favorites] = useStore<{ id: string }>("favorites");
  const { plans } = useSchedulePlans();
  const { notify } = useFeedback();
  const [codes, setCodes] = useState("");
  const [busy, setBusy] = useState<"recognize" | "export" | "import" | "clear" | "">("");
  const [importPreview, setImportPreview] = useState<ReturnType<typeof validateBackup>>();
  const [overwriteProfile, setOverwriteProfile] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const codesRef = useRef<HTMLTextAreaElement>(null);

  const addCodes = async () => {
    if (!codes.trim() || busy) return;
    setBusy("recognize");
    try {
      const values = codes.split(/[\s,，;；]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
      const result = await lookupCourses(values);
      for (const course of result.items) await putRecord("completedCourses", { id: course.course_id, courseId: course.course_id, courseName: course.name_zh, continueLearning: false, addedAt: new Date().toISOString() });
      setCodes("");
      notify("已加入 " + result.items.length + " 門；" + result.unmatched_values.length + " 筆未找到");
    } catch (error) { notify("辨識課程失敗：" + (error as Error).message, "error"); }
    finally { setBusy(""); }
  };
  const exportData = async () => {
    if (busy) return;
    setBusy("export");
    try {
      const backup = await createBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "fju-course-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      anchor.click();
      URL.revokeObjectURL(url);
      notify("備份已匯出");
    } catch (error) { notify("匯出失敗：" + (error as Error).message, "error"); }
    finally { setBusy(""); }
  };
  const readImport = async (file: File) => {
    setBusy("import");
    try {
      setImportPreview(validateBackup(JSON.parse(await file.text())));
      setOverwriteProfile(false);
    } catch (error) {
      notify("無法匯入：" + (error as Error).message, "error");
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const confirmImport = async () => {
    if (!importPreview) return;
    setBusy("import");
    try {
      await importBackup(importPreview, overwriteProfile);
      notify("匯入完成");
      setImportPreview(undefined);
    } catch (error) { notify("匯入失敗：" + (error as Error).message, "error"); }
    finally { setBusy(""); }
  };
  const clearAll = async () => {
    setBusy("clear");
    try { await clearPersonalData(); notify("這台裝置上的個人資料已清除"); setClearOpen(false); }
    catch (error) { notify("清除失敗：" + (error as Error).message, "error"); }
    finally { setBusy(""); }
  };
  const removeCompleted = async (item: CompletedCourse & { id: string }) => {
    await deleteRecord("completedCourses", item.id);
    notify("已移除「" + item.courseName + "」", "success", { label: "復原", onAction: () => putRecord("completedCourses", item) });
  };

  return (
    <section className="page">
      <div className="page-heading"><div><div className="eyebrow">你的資料由你掌控</div><h1>資料管理</h1></div></div>
      <div className="data-grid">
        <section className="card">
          <h2>批次加入已修課程</h2>
          <label htmlFor="completed-course-codes"><strong>課號或完整課名</strong></label>
          <p id="completed-course-helper">以空白、逗號或換行分隔，例如課號 D030201234 或完整課名。</p>
          <textarea ref={codesRef} id="completed-course-codes" aria-describedby="completed-course-helper" rows={6} value={codes} onChange={(event) => setCodes(event.target.value)} placeholder={"D030201234\n資料結構"} disabled={busy === "recognize"} />
          <button className="primary" type="button" onClick={() => void addCodes()} disabled={!codes.trim() || busy === "recognize"} aria-busy={busy === "recognize"}>{busy === "recognize" ? "辨識中…" : "辨識並加入"}</button>
        </section>
        <section className="card">
          <h2>本機資料摘要</h2>
          <div className="big-stats"><span><strong>{completed.length}</strong>已修課程</span><span><strong>{favorites.length}</strong>收藏</span><span><strong>{plans.length}</strong>課表方案</span></div>
          <button type="button" onClick={() => void exportData()} disabled={busy === "export"} aria-busy={busy === "export"}>{busy === "export" ? "匯出中…" : "匯出 JSON 備份"}</button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy === "import"} aria-busy={busy === "import"}>{busy === "import" ? "讀取中…" : "匯入 JSON 備份"}</button>
          <input ref={fileRef} hidden type="file" accept="application/json" onChange={(event) => event.target.files?.[0] && void readImport(event.target.files[0])}/>
          <button type="button" className="danger-button" onClick={() => setClearOpen(true)}>清除所有個人資料</button>
        </section>
      </div>
      <section className="card list-card">
        <h2>已修課程</h2>
        {!completed.length && <div className="inline-empty"><p>尚未加入已修課程。加入後可讓推薦避開重複修課。</p><button type="button" onClick={() => codesRef.current?.focus()}>前往批次加入</button></div>}
        {completed.map((item) => <div className="completed-row" key={item.id}><span className="completed-name">{item.courseName}</span><div className="completed-actions"><label className="check"><input type="checkbox" checked={item.continueLearning} onChange={() => void putRecord("completedCourses", { ...item, continueLearning: !item.continueLearning })}/>想繼續深入</label><button type="button" onClick={() => void removeCompleted(item)}>移除</button></div></div>)}
      </section>
      <Modal open={Boolean(importPreview)} title="確認匯入備份" onClose={() => setImportPreview(undefined)}>
        {importPreview && <div className="dialog-content"><p>備份日期：{importPreview.exportedAt}</p><ul><li>已修：{importPreview.data.completedCourses.length}</li><li>收藏：{importPreview.data.favorites.length}</li><li>課表：{importPreview.data.schedulePlans.length}</li></ul><label className="check"><input type="checkbox" checked={overwriteProfile} onChange={(event) => setOverwriteProfile(event.target.checked)} />用備份中的個人設定覆蓋目前設定</label></div>}
        <div className="dialog-actions"><button type="button" className="secondary" disabled={busy === "import"} onClick={() => setImportPreview(undefined)}>取消</button><button type="button" disabled={busy === "import"} aria-busy={busy === "import"} onClick={() => void confirmImport()}>{busy === "import" ? "匯入中…" : "匯入並合併"}</button></div>
      </Modal>
      <ConfirmDialog open={clearOpen} title="清除所有個人資料？" description={<p>將清除這台裝置上的個人設定、已修課、收藏與課表。此操作無法復原。</p>} confirmLabel="清除所有資料" destructive busy={busy === "clear"} onCancel={() => setClearOpen(false)} onConfirm={clearAll} />
    </section>
  );
}

function EmptyState({ title, body, action, href }: { title: string; body: string; action: string; href: string }) { return <section className="empty-state"><h1>{title}</h1><p>{body}</p><NavLink className="primary button-link" to={href}>{action}</NavLink></section>; }

export default App;
