import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { CaretDown } from "@phosphor-icons/react";
import { getCatalog } from "@/data/api";
import { useClassGroups, useDepartmentCatalog } from "@/data/queries";
import { getAllRecords, putRecord } from "@/data/db";
import { courseConflicts, inferProfileStudyLevel, meetingsConflict } from "@/domain/eligibility";
import {
  buildDepartmentOptions,
  buildDivisionOptions,
  departmentTypeOrder,
  filterDepartmentOptions,
  getDepartmentContextLabel,
  getDepartmentTypeLabel,
  type DepartmentOption,
} from "@/domain/departmentOptions";
import { getFixedScheduleEntries, MENTOR_TIME_ENTRY_ID } from "@/domain/fixedSchedule";
import { defaultPreferredWeekdays } from "@/domain/profileDefaults";
import { selectRequiredCourses } from "@/domain/requiredCourses";
import { coursesInPlan } from "@/domain/scheduleUtils";
import { useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { StateAlert, useFeedback } from "@/components/ui";
import type { CompletedCourse, Course, Profile } from "@/domain/types";

export function OnboardingPage() {
  const profile = useProfile();
  const departmentCatalogQuery = useDepartmentCatalog();
  const departmentCatalog = departmentCatalogQuery.data;
  const departmentCatalogError = departmentCatalogQuery.error ? (departmentCatalogQuery.error as Error).message : "";
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
  const classGroupsQuery = useClassGroups(selectedDepartmentOption ? {
    department: selectedDepartmentOption.identity ?? selectedDepartmentOption.value,
    division: form.division,
    grade: form.grade,
  } : null);
  const classGroupOptions = selectedDepartmentOption ? (classGroupsQuery.data ?? []) : [];
  // Existing defect kept verbatim: a class-group failure still surfaces as
  // "儲存失敗：…". T32 owns the copy fix; T21 only moves where the error comes from.
  useEffect(() => {
    if (classGroupsQuery.error) setSaveError((classGroupsQuery.error as Error).message);
  }, [classGroupsQuery.error]);
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
      {departmentCatalogError && <StateAlert title="無法載入系所選項" tone="danger">{departmentCatalogError}</StateAlert>}
      {!departmentCatalog && !departmentCatalogError && <StateAlert tone="info">正在載入系所選項…</StateAlert>}
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
        {saveError && <StateAlert className="wide" title="儲存失敗" tone="danger">{saveError}</StateAlert>}
        <button className="primary wide" type="submit" aria-busy={saving}>{saving ? "儲存中…" : "儲存並前往推薦"}</button>
      </fieldset></form>
    </section>
  );
}
