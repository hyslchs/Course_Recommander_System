import type { CourseSummary, WeightedCourseOption } from "./types";

export const OFFICIAL_SECTIONS = [
  "D0", "D1", "D2", "D3", "D4", "DN", "D5", "D6", "D7", "D8",
  "E0", "E1", "E2", "E3", "E4",
] as const;

export type BroadTimeFilter = "daytime" | "evening" | "weekday_evening_or_saturday";
export type ClassTimeFilter =
  | { mode: "all" }
  | { mode: "broad"; value: BroadTimeFilter }
  | { mode: "sections"; sections: string[] };

export type PercentageCriterion =
  | { mode: "dominant" }
  | { mode: "minimum"; minPercent: number };

export type AssessmentStyle = "all" | "no_exams" | "exam" | "writing" | "presentation" | "practical" | "participation";
export type OnlineTeachingFilter =
  | { mode: "all" }
  | { mode: "physical_only" }
  | { mode: "has_online"; kind: "any" | "sync" | "async" | "both" };

export interface RelationFilters {
  literacy: string[];
  coreCompetencies: string[];
  specialIssues: string[];
  includeIndirect: boolean;
}

export interface AdvancedCourseFilters {
  classTime: ClassTimeFilter;
  onlineTeaching: OnlineTeachingFilter;
  relations: RelationFilters;
  teachingMethodIds: string[];
  teachingMethodCriterion: PercentageCriterion;
  assessmentStyle: AssessmentStyle;
  assessmentMethodIds: string[];
  assessmentMethodCriterion: PercentageCriterion;
  teachingLanguages: string[];
  materialLanguages: string[];
  divisions: string[];
  departmentIdentities: string[];
  instructorIds: string[];
}

const ASSESSMENT_FAMILIES: Record<Exclude<AssessmentStyle, "all" | "no_exams">, string[]> = {
  exam: ["1", "6", "7", "8", "9", "14"],
  writing: ["2", "3", "10", "12", "18"],
  presentation: ["4", "13", "15"],
  practical: ["5", "16", "17"],
  participation: ["11"],
};
const EXAM_IDS = new Set(ASSESSMENT_FAMILIES.exam);

function intersects(actual: Iterable<string>, selected: string[]): boolean {
  const wanted = new Set(selected);
  for (const value of actual) if (wanted.has(value)) return true;
  return false;
}

function matchesWeighted(rows: WeightedCourseOption[] | undefined, selectedIds: string[], criterion: PercentageCriterion): boolean {
  if (!selectedIds.length) return true;
  const values = rows ?? [];
  if (!values.length) return false;
  const selected = new Set(selectedIds);
  if (criterion.mode === "minimum") return values.some((item) => selected.has(item.id) && item.percent >= criterion.minPercent);
  const maximum = Math.max(...values.map((item) => item.percent));
  return values.some((item) => selected.has(item.id) && item.percent === maximum);
}

function matchesAssessmentStyle(course: CourseSummary, style: AssessmentStyle): boolean {
  if (style === "all") return true;
  const values = new Map((course.assessments ?? []).map((item) => [item.id, item.percent]));
  const sum = (ids: Iterable<string>) => [...ids].reduce((total, id) => total + (values.get(id) ?? 0), 0);
  if (style === "no_exams") return sum(EXAM_IDS) === 0;
  const totals = Object.fromEntries(Object.entries(ASSESSMENT_FAMILIES).map(([family, ids]) => [family, sum(ids)])) as Record<Exclude<AssessmentStyle, "all" | "no_exams">, number>;
  const maximum = Math.max(...Object.values(totals));
  return maximum > 0 && totals[style] === maximum;
}

function matchesRelations(course: CourseSummary, filters: RelationFilters): boolean {
  const available = (course.relations ?? []).filter((item) => filters.includeIndirect || item.strength === "direct");
  const matchesGroup = (selected: string[], groups: string[]) => !selected.length || available.some((item) => selected.includes(item.id) && groups.includes(item.group));
  return matchesGroup(filters.literacy, ["literacy"])
    && matchesGroup(filters.coreCompetencies, ["core_knowledge", "core_skills_attitudes"])
    && matchesGroup(filters.specialIssues, ["special_issues"]);
}

function matchesOnline(course: CourseSummary, filter: OnlineTeachingFilter): boolean {
  if (filter.mode === "all") return true;
  const value = course.online_teaching;
  if (!value) return false;
  if (filter.mode === "physical_only") return !value.sync && !value.async;
  if (filter.kind === "sync") return value.sync;
  if (filter.kind === "async") return value.async;
  if (filter.kind === "both") return value.sync && value.async;
  return value.sync || value.async;
}

export function matchesAdvancedCourseFilters(course: CourseSummary, filters: AdvancedCourseFilters): boolean {
  if (filters.classTime.mode === "sections") {
    const actual = course.meetings.flatMap((meeting) => meeting.sections);
    if (!intersects(actual, filters.classTime.sections)) return false;
  }
  if (!matchesOnline(course, filters.onlineTeaching)) return false;
  if (!matchesRelations(course, filters.relations)) return false;
  if (!matchesWeighted(course.teaching_methods, filters.teachingMethodIds, filters.teachingMethodCriterion)) return false;
  if (!matchesAssessmentStyle(course, filters.assessmentStyle)) return false;
  if (!matchesWeighted(course.assessments, filters.assessmentMethodIds, filters.assessmentMethodCriterion)) return false;
  if (filters.teachingLanguages.length && !filters.teachingLanguages.includes(course.teaching_language ?? "")) return false;
  if (filters.materialLanguages.length && !filters.materialLanguages.includes(course.material_language ?? "")) return false;
  if (filters.divisions.length && !filters.divisions.includes(course.division)) return false;
  if (filters.departmentIdentities.length && !filters.departmentIdentities.includes(course.department_identity ?? "")) return false;
  if (filters.instructorIds.length && !intersects((course.instructors ?? []).map((item) => item.id), filters.instructorIds)) return false;
  return true;
}
