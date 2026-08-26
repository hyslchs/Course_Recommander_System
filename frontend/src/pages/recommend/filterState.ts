import { formatCreditFilterSummary } from "@/domain/creditFilter";
import type { AdvancedCourseFilters } from "@/domain/courseFilters";
import type { BroadTimeFilter } from "@/domain/courseFilters";
import { recommendationCategoryLabels } from "@/domain/recommendation";
import { weekdayLabels } from "@/domain/schedule";
import type { RecommendationCategoryFilters } from "@/domain/types";

export interface RecommendFilters extends AdvancedCourseFilters {
  /** Legacy test/import compatibility; new UI writes classTime exclusively. */
  timeOfDayFilter?: "all" | BroadTimeFilter;
  preferredWeekdays: number[];
  showOtherWeekdays: boolean;
  creditFilters: number[];
  includeUnknownSchedule: boolean;
  includeScheduleInfo: boolean;
  categoryFilters: RecommendationCategoryFilters;
  courseTagFilters: string[];
}

export function createFilters(preferredWeekdays: number[]): RecommendFilters {
  return {
    assessmentMethodCriterion: { mode: "dominant" },
    assessmentMethodIds: [],
    assessmentStyle: "all",
    // Everyone starts out looking at their own department's required + elective
    // courses; every other quick filter starts off.
    categoryFilters: ["home_required", "home_elective"],
    classTime: { mode: "all" },
    courseTagFilters: [],
    creditFilters: [],
    departmentIdentities: [],
    divisions: [],
    includeScheduleInfo: false,
    includeUnknownSchedule: true,
    instructorIds: [],
    materialLanguages: [],
    onlineTeaching: { mode: "all" },
    preferredWeekdays,
    relations: { literacy: [], coreCompetencies: [], specialIssues: [], includeIndirect: false },
    showOtherWeekdays: false,
    teachingLanguages: [],
    teachingMethodCriterion: { mode: "dominant" },
    teachingMethodIds: [],
    timeOfDayFilter: "all",
  };
}

export function activeFilterCount(filters: RecommendFilters): number {
  const relationCount = [filters.relations.literacy.length, filters.relations.coreCompetencies.length, filters.relations.specialIssues.length].filter(Boolean).length;
  return [
    !filters.showOtherWeekdays,
    filters.classTime.mode !== "all" || (filters.timeOfDayFilter ?? "all") !== "all",
    filters.creditFilters.length > 0,
    filters.includeScheduleInfo,
    filters.categoryFilters.length > 0,
    filters.courseTagFilters.length > 0,
    filters.onlineTeaching.mode !== "all",
    ...Array(relationCount).fill(true),
    filters.teachingMethodIds.length > 0,
    filters.assessmentStyle !== "all",
    filters.assessmentMethodIds.length > 0,
    filters.teachingLanguages.length > 0,
    filters.materialLanguages.length > 0,
    filters.divisions.length > 0,
    filters.departmentIdentities.length > 0,
    filters.instructorIds.length > 0,
  ].filter(Boolean).length;
}

export function clearFilters(filters: RecommendFilters): RecommendFilters {
  return {
    ...createFilters(filters.preferredWeekdays),
    // 清除全部 means none, not "back to the page's defaults" — unlike createFilters.
    categoryFilters: [],
    includeScheduleInfo: false,
    showOtherWeekdays: true,
  };
}

export interface FilterLabelMaps {
  relation?: Record<string, string>;
  teachingMethod?: Record<string, string>;
  assessment?: Record<string, string>;
  department?: Record<string, string>;
  instructor?: Record<string, string>;
}

export interface AppliedFilterTag {
  id: string;
  label: string;
  clear: (filters: RecommendFilters) => RecommendFilters;
}

function summarized(prefix: string, values: string[], labels?: Record<string, string>): string {
  const first = labels?.[values[0]] ?? values[0];
  return `${prefix}：${first}${values.length > 1 ? `＋${values.length - 1}` : ""}`;
}

const assessmentStyleLabels = { no_exams: "無考試", exam: "考試為主", writing: "寫作為主", presentation: "發表合作為主", practical: "實作展演為主", participation: "課堂參與為主" } as const;

export function appliedFilterTags(filters: RecommendFilters, highCreditOptions: number[], maps: FilterLabelMaps = {}): AppliedFilterTag[] {
  const tags: AppliedFilterTag[] = [];
  if (!filters.showOtherWeekdays) tags.push({ id: "weekdays", label: `星期${filters.preferredWeekdays.map((day) => weekdayLabels[day - 1]).join("、")}`, clear: (f) => ({ ...f, showOtherWeekdays: true }) });
  if (filters.classTime.mode === "broad") {
    const labels = { daytime: "日間 D 節", evening: "晚間 E 節", weekday_evening_or_saturday: "平日晚間＋週六" };
    tags.push({ id: "class-time", label: labels[filters.classTime.value], clear: (f) => ({ ...f, classTime: { mode: "all" } }) });
  } else if (filters.classTime.mode === "sections") {
    tags.push({ id: "class-time", label: summarized("節次", filters.classTime.sections), clear: (f) => ({ ...f, classTime: { mode: "all" } }) });
  } else if ((filters.timeOfDayFilter ?? "all") !== "all") {
    const labels = { daytime: "日間 D 節", evening: "晚間 E 節", weekday_evening_or_saturday: "平日晚間＋週六" };
    tags.push({ id: "time-of-day", label: labels[filters.timeOfDayFilter as BroadTimeFilter], clear: (f) => ({ ...f, timeOfDayFilter: "all", includeUnknownSchedule: true }) });
  }
  if (filters.creditFilters.length) tags.push({ id: "credits", label: formatCreditFilterSummary(filters.creditFilters, highCreditOptions), clear: (f) => ({ ...f, creditFilters: [] }) });
  if (filters.includeScheduleInfo) tags.push({ id: "schedule-conflicts", label: "避開衝堂", clear: (f) => ({ ...f, includeScheduleInfo: false }) });
  if (filters.categoryFilters.length) tags.push({ id: "categories", label: summarized("課程類別", filters.categoryFilters, recommendationCategoryLabels), clear: (f) => ({ ...f, categoryFilters: [] }) });
  if (filters.courseTagFilters.length) tags.push({ id: "course-tags", label: `官方標籤 ${filters.courseTagFilters.length}`, clear: (f) => ({ ...f, courseTagFilters: [] }) });
  if (filters.onlineTeaching.mode !== "all") tags.push({ id: "online", label: filters.onlineTeaching.mode === "physical_only" ? "純實體" : "含線上教學", clear: (f) => ({ ...f, onlineTeaching: { mode: "all" } }) });
  const relationTags: Array<[keyof Pick<RecommendFilters["relations"], "literacy" | "coreCompetencies" | "specialIssues">, string]> = [["literacy", "基本素養"], ["coreCompetencies", "核心能力"], ["specialIssues", "專門議題"]];
  for (const [key, label] of relationTags) if (filters.relations[key].length) tags.push({ id: `relation-${key}`, label: summarized(label, filters.relations[key], maps.relation), clear: (f) => ({ ...f, relations: { ...f.relations, [key]: [] } }) });
  if (filters.teachingMethodIds.length) tags.push({ id: "teaching-methods", label: summarized("教學", filters.teachingMethodIds, maps.teachingMethod), clear: (f) => ({ ...f, teachingMethodIds: [] }) });
  if (filters.assessmentStyle !== "all") tags.push({ id: "assessment-style", label: assessmentStyleLabels[filters.assessmentStyle], clear: (f) => ({ ...f, assessmentStyle: "all" }) });
  if (filters.assessmentMethodIds.length) tags.push({ id: "assessment-methods", label: summarized("評量", filters.assessmentMethodIds, maps.assessment), clear: (f) => ({ ...f, assessmentMethodIds: [] }) });
  if (filters.teachingLanguages.length) tags.push({ id: "teaching-languages", label: summarized("授課語言", filters.teachingLanguages), clear: (f) => ({ ...f, teachingLanguages: [] }) });
  if (filters.materialLanguages.length) tags.push({ id: "material-languages", label: summarized("教材語言", filters.materialLanguages), clear: (f) => ({ ...f, materialLanguages: [] }) });
  if (filters.divisions.length) tags.push({ id: "divisions", label: summarized("學制", filters.divisions), clear: (f) => ({ ...f, divisions: [] }) });
  if (filters.departmentIdentities.length) tags.push({ id: "departments", label: summarized("開課單位", filters.departmentIdentities, maps.department), clear: (f) => ({ ...f, departmentIdentities: [] }) });
  if (filters.instructorIds.length) tags.push({ id: "instructors", label: summarized("教師", filters.instructorIds, maps.instructor), clear: (f) => ({ ...f, instructorIds: [] }) });
  return tags;
}

export function removeAppliedFilters(filters: RecommendFilters, highCreditOptions: number[], keys: Iterable<string>, maps: FilterLabelMaps = {}): RecommendFilters {
  const wanted = new Set(keys);
  return appliedFilterTags(filters, highCreditOptions, maps).filter((tag) => wanted.has(tag.id)).reduce((current, tag) => tag.clear(current), filters);
}
