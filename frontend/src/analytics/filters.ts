/**
 * Turns "the filter state changed" into `filter_used` events.
 *
 * The question this answers is "which filters do students actually reach for?",
 * so what gets recorded is the filter's *identifier* — a constant written in
 * this file — plus, for closed option sets only, which option was chosen.
 *
 * WHAT IS DELIBERATELY NOT RECORDED. Open sets (department, instructor, course
 * tag, teaching method, assessment method, language) send the filter name and
 * no value. A chosen department identity is at best marginal for filter
 * ergonomics and at worst a hint at who is filtering; the same reasoning applies
 * to an instructor id, which is a *third party's* identity. And under no
 * circumstances does a filter event carry the student's own 系所, 年級, 輔系,
 * 雙主修 or timetable — none of those are inputs to this function.
 */

import { FILTERS_WITH_VALUE, type AnalyticsFilter } from "./events";
import type { RecommendFilters } from "@/pages/recommend/filterState";

export interface FilterUse {
  filter: AnalyticsFilter;
  value?: string;
}

/** Emitting one event per toggled option is fine; emitting forty is a flood. */
const MAX_EVENTS_PER_CHANGE = 8;

const WEEKDAY_TOKENS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function weekdayToken(day: number): string | undefined {
  return WEEKDAY_TOKENS[day - 1];
}

/** Every option added to `next` that was not in `previous`. */
function added<T>(previous: readonly T[], next: readonly T[]): T[] {
  const before = new Set(previous);
  return next.filter((value) => !before.has(value));
}

function sameSet<T>(previous: readonly T[], next: readonly T[]): boolean {
  return previous.length === next.length && added(previous, next).length === 0;
}

/**
 * A closed-set list filter: one event per newly selected option, or a single
 * value-less event when the change was only a removal (still filter use).
 */
function listUses<T>(
  filter: AnalyticsFilter,
  previous: readonly T[],
  next: readonly T[],
  token: (value: T) => string | undefined,
): FilterUse[] {
  if (sameSet(previous, next)) return [];
  const gained = added(previous, next);
  if (!gained.length) return [{ filter }];
  const withValue = FILTERS_WITH_VALUE.has(filter);
  return gained.map((value) => {
    const label = withValue ? token(value) : undefined;
    return label ? { filter, value: label } : { filter };
  });
}

/** An open-set list filter: the name only. */
function openListUses<T>(filter: AnalyticsFilter, previous: readonly T[], next: readonly T[]): FilterUse[] {
  return sameSet(previous, next) ? [] : [{ filter }];
}

function toggleUse(filter: AnalyticsFilter, previous: boolean, next: boolean): FilterUse[] {
  return previous === next ? [] : [{ filter, value: next ? "on" : "off" }];
}

function classTimeToken(classTime: RecommendFilters["classTime"]): string {
  if (classTime.mode === "broad") return classTime.value;
  return classTime.mode;
}

/**
 * The diff. Pure, so the mapping is testable without rendering the filter panel.
 */
export function changedFilters(previous: RecommendFilters, next: RecommendFilters): FilterUse[] {
  const uses: FilterUse[] = [
    ...listUses("weekday", previous.preferredWeekdays, next.preferredWeekdays, weekdayToken),
    ...toggleUse("show_other_weekdays", previous.showOtherWeekdays, next.showOtherWeekdays),
    ...listUses("credits", previous.creditFilters, next.creditFilters, (value) => String(value)),
    ...listUses("course_category", previous.categoryFilters, next.categoryFilters, (value) => value),
    ...toggleUse("conflict_filter", previous.includeScheduleInfo, next.includeScheduleInfo),
    ...toggleUse("include_unknown_schedule", previous.includeUnknownSchedule, next.includeUnknownSchedule),
    ...openListUses("course_tag", previous.courseTagFilters, next.courseTagFilters),
    ...openListUses("teaching_method", previous.teachingMethodIds, next.teachingMethodIds),
    ...openListUses("assessment_method", previous.assessmentMethodIds, next.assessmentMethodIds),
    ...openListUses("teaching_language", previous.teachingLanguages, next.teachingLanguages),
    ...openListUses("material_language", previous.materialLanguages, next.materialLanguages),
    ...openListUses("division", previous.divisions, next.divisions),
    ...openListUses("department", previous.departmentIdentities, next.departmentIdentities),
    ...openListUses("instructor", previous.instructorIds, next.instructorIds),
    ...openListUses("literacy", previous.relations.literacy, next.relations.literacy),
    ...openListUses("core_competency", previous.relations.coreCompetencies, next.relations.coreCompetencies),
    ...openListUses("special_issue", previous.relations.specialIssues, next.relations.specialIssues),
  ];
  if (classTimeToken(previous.classTime) !== classTimeToken(next.classTime)) {
    uses.push({ filter: "class_time", value: classTimeToken(next.classTime) });
  }
  if (previous.onlineTeaching.mode !== next.onlineTeaching.mode) {
    uses.push({ filter: "online_teaching", value: next.onlineTeaching.mode });
  }
  if (previous.assessmentStyle !== next.assessmentStyle) {
    uses.push({ filter: "assessment_style", value: next.assessmentStyle });
  }
  return uses.slice(0, MAX_EVENTS_PER_CHANGE);
}
