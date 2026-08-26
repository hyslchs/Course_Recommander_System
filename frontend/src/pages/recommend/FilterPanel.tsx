import { useDeferredValue, useState, type Key, type ReactNode } from "react";
import { Accordion, Description, Disclosure, Label, Radio, RadioGroup, Switch, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Check } from "@phosphor-icons/react";
import { formatCreditFilterSummary, isHighCreditFilterSelected, toggleHighCreditFilter } from "@/domain/creditFilter";
import type { AssessmentStyle, BroadTimeFilter, PercentageCriterion } from "@/domain/courseFilters";
import { OFFICIAL_SECTIONS } from "@/domain/courseFilters";
import { recommendationCategoryLabels } from "@/domain/recommendation";
import { weekdayLabels } from "@/domain/schedule";
import type { RecommendationCategory, RecommendationCategoryFilters } from "@/domain/types";
import type { RecommendFilters } from "./filterState";
export interface FacetOption {
    value: string;
    label: string;
    label_en?: string;
    count?: number;
    direct_count?: number;
    group?: string;
}
export interface FilterPanelProps {
    value: RecommendFilters;
    onChange: (next: RecommendFilters) => void;
    highCreditOptions: number[];
    individualCreditOptions: number[];
    courseTagOptions: FacetOption[];
    relationOptions: FacetOption[];
    teachingMethodOptions: FacetOption[];
    assessmentOptions: FacetOption[];
    teachingLanguageOptions: FacetOption[];
    materialLanguageOptions: FacetOption[];
    divisionOptions: FacetOption[];
    departmentOptions: FacetOption[];
    instructorOptions: FacetOption[];
    sectionOptions: FacetOption[];
    activePlanName?: string;
    profileDepartmentIdentity?: string | null;
    mode: "sidebar" | "drawer" | "modal";
    weekdayError?: ReactNode;
}
const keysToNumbers = (keys: Set<Key>) => [...keys].map(Number).filter(Number.isFinite);
const keysToStrings = (keys: Set<Key>) => [...keys].map(String);
function ControlHeading({ title, summary }: {
    title: string;
    summary: string;
}) {
    return <div className="filter-control-head"><strong>{title}</strong><span>{summary}</span></div>;
}
function GroupTrigger({ title, summary }: {
    title: string;
    summary: string;
}) {
    return <Accordion.Trigger className="filter-accordion-trigger"><span className="filter-accordion-label"><b>{title}</b><small>{summary}</small></span><Accordion.Indicator /></Accordion.Trigger>;
}
function AdvancedDisclosure({ summary, children }: {
    summary: string;
    children: ReactNode;
}) {
    return <Disclosure className="filter-advanced-disclosure"><Disclosure.Heading><Disclosure.Trigger className="filter-advanced-trigger">進階設定<small>{summary}</small><Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading><Disclosure.Content><Disclosure.Body className="filter-advanced-body">{children}</Disclosure.Body></Disclosure.Content></Disclosure>;
}
function SearchableMultiSelect({ label, options, selected, onChange, suggestedValue }: {
    label: string;
    options: FacetOption[];
    selected: string[];
    onChange: (values: string[]) => void;
    suggestedValue?: string | null;
}) {
    const [query, setQuery] = useState("");
    const deferred = useDeferredValue(query.trim().toLocaleLowerCase("zh-Hant"));
    const sorted = [...options].sort((a, b) => Number(b.value === suggestedValue) - Number(a.value === suggestedValue) || Number(selected.includes(b.value)) - Number(selected.includes(a.value)) || a.label.localeCompare(b.label, "zh-Hant"));
    const visible = sorted.filter((option) => !deferred || `${option.label} ${option.label_en ?? ""}`.toLocaleLowerCase("zh-Hant").includes(deferred));
    const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
    return <div className="filter-search-select"><label><span>{label}</span><input type="search" value={query} placeholder={`搜尋${label}`} onChange={(event) => setQuery(event.target.value)}/></label><div className="filter-option-list" role="group" aria-label={label}>{visible.length ? visible.map((option) => <label className="filter-option-row" key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={() => toggle(option.value)}/><span>{option.label}{option.value === suggestedValue ? <small>你的系所</small> : null}</span>{option.count !== undefined ? <small>{option.count.toLocaleString()} 門</small> : null}</label>) : <p className="filter-no-options">找不到符合選項</p>}</div>{selected.length > 0 ? <button type="button" className="filter-inline-clear" onClick={() => onChange([])}>清除這一項的 {selected.length} 個選擇</button> : null}</div>;
}
function PercentagePicker({ value, onChange }: {
    value: PercentageCriterion;
    onChange: (value: PercentageCriterion) => void;
}) {
    const preset = value.mode === "dominant" ? "dominant" : value.minPercent === 25 ? "25" : value.minPercent === 50 ? "50" : "custom";
    return <div className="percentage-picker"><ToggleButtonGroup aria-label="比例條件" className="filter-chips" isDetached selectedKeys={[preset]} selectionMode="single" onSelectionChange={(keys) => { const selected = [...keys][0]; if (selected === "dominant")
        onChange({ mode: "dominant" });
    else if (selected === "25" || selected === "50")
        onChange({ mode: "minimum", minPercent: Number(selected) });
    else if (selected === "custom")
        onChange({ mode: "minimum", minPercent: value.mode === "minimum" && ![25, 50].includes(value.minPercent) ? value.minPercent : 30 }); }}><ToggleButton id="dominant">占比最高</ToggleButton><ToggleButton id="25">至少 25%</ToggleButton><ToggleButton id="50">至少 50%</ToggleButton><ToggleButton id="custom">自訂</ToggleButton></ToggleButtonGroup>{preset === "custom" && value.mode === "minimum" ? <label className="percentage-slider"><span>最低比例 <output>{value.minPercent}%</output></span><input aria-label="自訂最低比例" type="range" min="5" max="100" step="5" value={value.minPercent} onChange={(event) => onChange({ mode: "minimum", minPercent: Number(event.target.value) })}/></label> : null}</div>;
}
const assessmentChoices: [
    AssessmentStyle,
    string
][] = [["all", "不限"], ["no_exams", "無考試"], ["exam", "考試為主"], ["writing", "作業寫作為主"], ["presentation", "發表合作為主"], ["practical", "實作展演為主"], ["participation", "課堂參與為主"]];
export function FilterPanel(props: FilterPanelProps) {
    const { value, onChange, highCreditOptions, individualCreditOptions, courseTagOptions, relationOptions, teachingMethodOptions, assessmentOptions, teachingLanguageOptions, materialLanguageOptions, divisionOptions, departmentOptions, instructorOptions, sectionOptions, activePlanName, profileDepartmentIdentity, mode, weekdayError } = props;
    const patch = (next: Partial<RecommendFilters>) => onChange({ ...value, ...next });
    const highCreditSelected = isHighCreditFilterSelected(value.creditFilters, highCreditOptions);
    const classTimeValue = value.classTime.mode === "broad" ? value.classTime.value : value.classTime.mode === "all" ? "all" : "";
    const scheduleSummary = value.classTime.mode === "sections" ? `節次 ${value.classTime.sections.join("、")}` : value.classTime.mode === "broad" ? ({ daytime: "日間", evening: "晚間", weekday_evening_or_saturday: "平日晚間＋週六" }[value.classTime.value]) : "不限時段";
    const relationCount = value.relations.literacy.length + value.relations.coreCompetencies.length + value.relations.specialIssues.length;
    const courseCount = value.creditFilters.length + value.categoryFilters.length + value.divisions.length + value.departmentIdentities.length + value.instructorIds.length;
    const teachingCount = value.teachingMethodIds.length + value.teachingLanguages.length + value.materialLanguages.length + Number(value.onlineTeaching.mode !== "all");
    const assessmentCount = value.assessmentMethodIds.length + Number(value.assessmentStyle !== "all");
    const advancedCount = value.courseTagFilters.length + relationCount;
    const relationBy = (groups: string[]) => relationOptions.filter((option) => groups.includes(option.group ?? "") && (value.relations.includeIndirect ? (option.count ?? 0) : (option.direct_count ?? 0)) > 0).map((option) => ({ ...option, count: value.relations.includeIndirect ? option.count : option.direct_count }));
    const weekdayControl = <div className="filter-control"><ControlHeading title="上課星期" summary={value.showOtherWeekdays ? "不限星期" : "只顯示可上的星期"}/><ToggleButtonGroup aria-label="偏好的上課星期" className="filter-chips" isDetached selectedKeys={value.preferredWeekdays.map(String)} selectionMode="multiple" onSelectionChange={(keys) => patch({ preferredWeekdays: keysToNumbers(keys).sort((a, b) => a - b) })}>{weekdayLabels.map((label, index) => <ToggleButton id={String(index + 1)} key={label}>星期{label}</ToggleButton>)}</ToggleButtonGroup>{weekdayError}<Switch className="filter-switch" isSelected={value.showOtherWeekdays} onChange={(selected) => patch({ showOtherWeekdays: selected })} size="sm"><Switch.Content className="min-h-11 items-center"><Switch.Control><Switch.Thumb /></Switch.Control><Label>暫時忽略星期限制</Label></Switch.Content></Switch></div>;
    const timeControl = <div className="filter-control"><ControlHeading title="上課時段" summary={scheduleSummary}/><RadioGroup value={classTimeValue} onChange={(next) => patch({ classTime: next === "all" ? { mode: "all" } : { mode: "broad", value: next as BroadTimeFilter } })}><Label>上課時段</Label>{[["all", "不限"], ["daytime", "日間 D 節"], ["evening", "晚間 E 節"], ["weekday_evening_or_saturday", "平日晚間＋週六"]].map(([id, label]) => <Radio key={id} value={id}><Radio.Content className="min-h-11"><Radio.Control><Radio.Indicator /></Radio.Control>{label}</Radio.Content></Radio>)}</RadioGroup></div>;
    const exactSectionsControl = <div className="filter-control"><ControlHeading title="精確選擇節次" summary={value.classTime.mode === "sections" ? value.classTime.sections.join("、") : "未指定"}/><Description>只要課程包含任一所選節次就符合；精確節次會取代概略時段。</Description><ToggleButtonGroup aria-label="精確上課節次" className="filter-chips section-chips" isDetached selectedKeys={value.classTime.mode === "sections" ? value.classTime.sections : []} selectionMode="multiple" onSelectionChange={(keys) => { const sections = OFFICIAL_SECTIONS.filter((section) => keys.has(section)); patch({ classTime: sections.length ? { mode: "sections", sections } : { mode: "all" } }); }}>{OFFICIAL_SECTIONS.map((section) => { const option = sectionOptions.find((item) => item.value === section); return <ToggleButton id={section} key={section} isDisabled={(option?.count ?? 0) === 0}>{section}<small>{option?.count ?? 0}</small></ToggleButton>; })}</ToggleButtonGroup></div>;
    const creditControl = <div className="filter-control"><ControlHeading title="學分數" summary={value.creditFilters.length ? formatCreditFilterSummary(value.creditFilters, highCreditOptions) : "不限學分"}/><ToggleButtonGroup aria-label="學分數" className="filter-chips" isDetached selectedKeys={[...value.creditFilters.filter((credits) => !highCreditOptions.includes(credits)).map(String), ...(highCreditSelected ? ["high"] : [])]} selectionMode="multiple" onSelectionChange={(keys) => { const picked = keysToNumbers(keys); patch({ creditFilters: keys.has("high") ? toggleHighCreditFilter(picked, highCreditOptions) : picked }); }}>{individualCreditOptions.map((credits) => <ToggleButton id={String(credits)} key={credits}>{credits} 學分</ToggleButton>)}{highCreditOptions.length ? <ToggleButton id="high">4 學分以上</ToggleButton> : null}</ToggleButtonGroup></div>;
    const categoryControl = <div className="filter-control"><ControlHeading title="課程類別" summary={value.categoryFilters.length ? `已選 ${value.categoryFilters.length} 類` : "全部課程"}/><ToggleButtonGroup aria-label="課程類別" className="filter-chips" isDetached selectedKeys={value.categoryFilters} selectionMode="multiple" onSelectionChange={(keys) => patch({ categoryFilters: keysToStrings(keys) as RecommendationCategoryFilters })}>{Object.entries(recommendationCategoryLabels).map(([id, label]) => <ToggleButton id={id as RecommendationCategory} key={id}>{label}</ToggleButton>)}</ToggleButtonGroup></div>;
    const conflictControl = <div className="filter-control filter-conflict-control"><ControlHeading title="避開衝堂" summary={value.includeScheduleInfo ? `排除與「${activePlanName ?? "目前課表"}」衝堂的課程` : "允許顯示時間重疊的課程"}/><ToggleButton className="filter-conflict-toggle min-h-11" isSelected={value.includeScheduleInfo} onChange={(selected) => patch({ includeScheduleInfo: selected })}>{value.includeScheduleInfo ? <><Check aria-hidden="true"/>避開衝堂</> : "允許衝堂"}</ToggleButton>{!value.includeScheduleInfo ? <Description className="filter-conflict-note">已允許顯示與目前課表衝堂的課程，加入課表後仍會標示衝堂。</Description> : null}</div>;
    if (mode === "sidebar")
        return <div className="quick-filter-panel" aria-label="快速篩選"><section className="quick-filter-group" aria-labelledby="quick-filter-time"><h3 id="quick-filter-time">上課時間</h3>{weekdayControl}{timeControl}</section><section className="quick-filter-group" aria-labelledby="quick-filter-category"><h3 id="quick-filter-category">課程類別</h3>{categoryControl}</section><section className="quick-filter-group" aria-labelledby="quick-filter-credits"><h3 id="quick-filter-credits">學分數</h3>{creditControl}</section><section className="quick-filter-group" aria-labelledby="quick-filter-conflict"><h3 className="sr-only" id="quick-filter-conflict">避開衝堂</h3>{conflictControl}</section></div>;
    return <Accordion className="filter-accordion" allowsMultipleExpanded={mode !== "drawer"} defaultExpandedKeys={mode === "modal" ? ["time", "course", "delivery", "assessment"] : ["time"]} variant="surface">
    <Accordion.Item id="time"><Accordion.Heading><GroupTrigger title="時間與課表" summary={`${scheduleSummary} · ${value.includeScheduleInfo ? "避開衝堂" : "允許衝堂"}`}/></Accordion.Heading><Accordion.Panel><Accordion.Body className="filter-group-body">{weekdayControl}{timeControl}{exactSectionsControl}{conflictControl}</Accordion.Body></Accordion.Panel></Accordion.Item>

    <Accordion.Item id="course"><Accordion.Heading><GroupTrigger title="課程條件" summary={courseCount ? `已選 ${courseCount} 個條件` : "不限學分、類別、單位、教師與學制"}/></Accordion.Heading><Accordion.Panel><Accordion.Body className="filter-group-body">{creditControl}{categoryControl}<SearchableMultiSelect label="開課單位" options={departmentOptions} selected={value.departmentIdentities} suggestedValue={profileDepartmentIdentity} onChange={(departmentIdentities) => patch({ departmentIdentities })}/><SearchableMultiSelect label="授課教師" options={instructorOptions} selected={value.instructorIds} onChange={(instructorIds) => patch({ instructorIds })}/><div className="filter-control"><ControlHeading title="學制" summary={value.divisions.length ? value.divisions.join("、") : "不限"}/><ToggleButtonGroup aria-label="學制" className="filter-chips" isDetached selectedKeys={value.divisions} selectionMode="multiple" onSelectionChange={(keys) => patch({ divisions: keysToStrings(keys) })}>{divisionOptions.map((option) => <ToggleButton id={option.value} key={option.value}>{option.label}</ToggleButton>)}</ToggleButtonGroup></div></Accordion.Body></Accordion.Panel></Accordion.Item>

    <Accordion.Item id="delivery"><Accordion.Heading><GroupTrigger title="上課方式" summary={teachingCount ? `已套用 ${teachingCount} 個條件` : "不限形式、語言與教學方法"}/></Accordion.Heading><Accordion.Panel><Accordion.Body className="filter-group-body"><div className="filter-control"><ControlHeading title="授課形式" summary={value.onlineTeaching.mode === "all" ? "不限" : value.onlineTeaching.mode === "physical_only" ? "純實體" : "含線上"}/><RadioGroup value={value.onlineTeaching.mode} onChange={(next) => patch({ onlineTeaching: next === "all" ? { mode: "all" } : next === "physical_only" ? { mode: "physical_only" } : { mode: "has_online", kind: "any" } })}><Label>授課形式</Label>{[["all", "不限"], ["physical_only", "純實體"], ["has_online", "含線上教學"]].map(([id, label]) => <Radio key={id} value={id}><Radio.Content className="min-h-11"><Radio.Control><Radio.Indicator /></Radio.Control>{label}</Radio.Content></Radio>)}</RadioGroup>{value.onlineTeaching.mode === "has_online" ? <AdvancedDisclosure summary="同步／非同步"><RadioGroup value={value.onlineTeaching.kind} onChange={(kind) => patch({ onlineTeaching: { mode: "has_online", kind: kind as "any" | "sync" | "async" | "both" } })}><Label>線上型態</Label>{[["any", "任何線上"], ["sync", "含同步"], ["async", "含非同步"], ["both", "同步與非同步皆有"]].map(([id, label]) => <Radio key={id} value={id}><Radio.Content className="min-h-11"><Radio.Control><Radio.Indicator /></Radio.Control>{label}</Radio.Content></Radio>)}</RadioGroup></AdvancedDisclosure> : null}</div><SearchableMultiSelect label="授課語言" options={teachingLanguageOptions} selected={value.teachingLanguages} onChange={(teachingLanguages) => patch({ teachingLanguages })}/><SearchableMultiSelect label="教材語言" options={materialLanguageOptions} selected={value.materialLanguages} onChange={(materialLanguages) => patch({ materialLanguages })}/><SearchableMultiSelect label="教學方法" options={teachingMethodOptions} selected={value.teachingMethodIds} onChange={(teachingMethodIds) => patch({ teachingMethodIds })}/>{value.teachingMethodIds.length ? <PercentagePicker value={value.teachingMethodCriterion} onChange={(teachingMethodCriterion) => patch({ teachingMethodCriterion })}/> : null}</Accordion.Body></Accordion.Panel></Accordion.Item>

    <Accordion.Item id="assessment"><Accordion.Heading><GroupTrigger title="評量方式" summary={assessmentCount ? `已套用 ${assessmentCount} 個條件` : "不限評量偏好與官方項目"}/></Accordion.Heading><Accordion.Panel><Accordion.Body className="filter-group-body"><RadioGroup value={value.assessmentStyle} onChange={(assessmentStyle) => patch({ assessmentStyle: assessmentStyle as AssessmentStyle })}><Label>主要評量偏好</Label><Description>「為主」代表該類評量合計占比最高。</Description>{assessmentChoices.map(([id, label]) => <Radio key={id} value={id}><Radio.Content className="min-h-11"><Radio.Control><Radio.Indicator /></Radio.Control>{label}</Radio.Content></Radio>)}</RadioGroup><SearchableMultiSelect label="官方評量項目" options={assessmentOptions} selected={value.assessmentMethodIds} onChange={(assessmentMethodIds) => patch({ assessmentMethodIds })}/>{value.assessmentMethodIds.length ? <PercentagePicker value={value.assessmentMethodCriterion} onChange={(assessmentMethodCriterion) => patch({ assessmentMethodCriterion })}/> : null}</Accordion.Body></Accordion.Panel></Accordion.Item>

    <Accordion.Item id="advanced"><Accordion.Heading><GroupTrigger title="進階條件" summary={advancedCount ? `已選 ${advancedCount} 個標籤／metadata` : "官方標籤、素養、能力與議題"}/></Accordion.Heading><Accordion.Panel><Accordion.Body className="filter-group-body"><SearchableMultiSelect label="官方課程標籤" options={courseTagOptions} selected={value.courseTagFilters} onChange={(courseTagFilters) => patch({ courseTagFilters })}/><SearchableMultiSelect label="基本素養" options={relationBy(["literacy"])} selected={value.relations.literacy} onChange={(literacy) => patch({ relations: { ...value.relations, literacy } })}/><SearchableMultiSelect label="核心能力" options={relationBy(["core_knowledge", "core_skills_attitudes"])} selected={value.relations.coreCompetencies} onChange={(coreCompetencies) => patch({ relations: { ...value.relations, coreCompetencies } })}/><SearchableMultiSelect label="專門議題" options={relationBy(["special_issues"])} selected={value.relations.specialIssues} onChange={(specialIssues) => patch({ relations: { ...value.relations, specialIssues } })}/><Switch className="filter-switch" isSelected={value.relations.includeIndirect} onChange={(includeIndirect) => patch({ relations: { ...value.relations, includeIndirect } })} size="sm"><Switch.Content className="min-h-11 items-center"><Switch.Control><Switch.Thumb /></Switch.Control><Label>也包含間接相關</Label></Switch.Content></Switch></Accordion.Body></Accordion.Panel></Accordion.Item>
  </Accordion>;
}
