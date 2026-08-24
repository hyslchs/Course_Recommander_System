import { formatCreditFilterSummary } from "@/domain/creditFilter";
import { weekdayLabels } from "@/domain/schedule";
import type { CourseLevelFilter, PrerequisiteFilter, TimeOfDayFilter } from "@/domain/recommendation";
import type { RecommendationCategoryFilters } from "@/domain/types";

/**
 * Every hard filter the recommendation ranker reads, as ONE value.
 *
 * It used to be eleven separate `useState`s in `RecommendPage`. They are folded
 * into a single object because the mobile drawer has to hold a *draft* copy and
 * commit it on close (plan §5.2-5, "關閉時才套用"): with eleven setters that
 * means eleven more drafts and eleven more commits, and the draft would drift
 * out of sync the first time a filter is added. One object, one draft, one
 * commit.
 */
export interface RecommendFilters {
  /** Never cleared by 清除全部 — it is a profile preference, not a filter. */
  preferredWeekdays: number[];
  showOtherWeekdays: boolean;
  creditFilters: number[];
  timeOfDayFilter: TimeOfDayFilter;
  includeUnknownSchedule: boolean;
  prerequisiteFilter: PrerequisiteFilter;
  includeUnknownPrerequisite: boolean;
  courseLevelFilter: CourseLevelFilter;
  includeUnknownCourseLevel: boolean;
  includeScheduleInfo: boolean;
  categoryFilters: RecommendationCategoryFilters;
  courseTagFilters: string[];
}

export function createFilters(preferredWeekdays: number[]): RecommendFilters {
  return {
    categoryFilters: [],
    courseLevelFilter: "all",
    courseTagFilters: [],
    creditFilters: [],
    includeScheduleInfo: true,
    includeUnknownCourseLevel: false,
    includeUnknownPrerequisite: false,
    includeUnknownSchedule: true,
    preferredWeekdays,
    prerequisiteFilter: "exclude_unmet",
    showOtherWeekdays: false,
    timeOfDayFilter: "all",
  };
}

/**
 * The ten conditions that count as "a filter is narrowing my results".
 *
 * Deliberately unchanged from the pre-HeroUI page, including the two that have
 * no pill of their own (`includeUnknownPrerequisite` /
 * `includeUnknownCourseLevel` — they widen rather than narrow, and are surfaced
 * as a note next to the tags instead). The number is what the mobile `Badge`
 * and the drawer's 套用 button show, so drifting it would silently change what
 * the trigger promises.
 */
export function activeFilterCount(filters: RecommendFilters): number {
  return [
    !filters.showOtherWeekdays,
    filters.timeOfDayFilter !== "all",
    filters.creditFilters.length > 0,
    filters.prerequisiteFilter === "exclude_unmet",
    filters.includeUnknownPrerequisite,
    filters.courseLevelFilter !== "all",
    filters.includeUnknownCourseLevel,
    filters.includeScheduleInfo,
    filters.categoryFilters.length > 0,
    filters.courseTagFilters.length > 0,
  ].filter(Boolean).length;
}

/** 清除全部. `preferredWeekdays` survives: it comes from the saved profile. */
export function clearFilters(filters: RecommendFilters): RecommendFilters {
  return {
    ...filters,
    categoryFilters: [],
    courseLevelFilter: "all",
    courseTagFilters: [],
    creditFilters: [],
    includeScheduleInfo: false,
    includeUnknownCourseLevel: false,
    includeUnknownPrerequisite: false,
    includeUnknownSchedule: true,
    prerequisiteFilter: "show_with_warning",
    showOtherWeekdays: true,
    timeOfDayFilter: "all",
  };
}

const timeOfDayLabels: Record<Exclude<TimeOfDayFilter, "all">, string> = {
  daytime: "日間 D 節",
  evening: "晚間 E 節",
  weekday_evening_or_saturday: "平日晚間＋週六",
};

const courseLevelTagLabels: Record<Exclude<CourseLevelFilter, "all">, string> = {
  advanced: "只要進階",
  exclude_introductory: "排除入門",
  intermediate: "只要中階",
  introductory: "只要入門",
};

/**
 * One removable chip. `clear` is carried with the label rather than looked up
 * by a `switch` at the removal site so that `TagGroup`'s `onRemove(keys)` can
 * stay a one-liner and so the mapping is testable without rendering anything.
 */
export interface AppliedFilterTag {
  id: string;
  label: string;
  clear: (filters: RecommendFilters) => RecommendFilters;
}

/**
 * The eight pills the old markup hand-rolled as `<button>` + a decorative
 * `<span aria-hidden>×</span>`. Same eight, same wording, same clear-actions —
 * `TagGroup` + `Tag.RemoveButton` now supplies the remove affordance, the
 * accessible name for it and arrow-key navigation between the chips.
 */
export function appliedFilterTags(filters: RecommendFilters, highCreditOptions: number[]): AppliedFilterTag[] {
  const tags: AppliedFilterTag[] = [];
  if (!filters.showOtherWeekdays) {
    tags.push({
      clear: (current) => ({ ...current, showOtherWeekdays: true }),
      id: "weekdays",
      label: `星期${filters.preferredWeekdays.map((day) => weekdayLabels[day - 1]).join("、")}`,
    });
  }
  if (filters.timeOfDayFilter !== "all") {
    tags.push({
      clear: (current) => ({ ...current, includeUnknownSchedule: true, timeOfDayFilter: "all" }),
      id: "time-of-day",
      label: timeOfDayLabels[filters.timeOfDayFilter],
    });
  }
  if (filters.creditFilters.length > 0) {
    tags.push({
      clear: (current) => ({ ...current, creditFilters: [] }),
      id: "credits",
      label: formatCreditFilterSummary(filters.creditFilters, highCreditOptions),
    });
  }
  if (filters.prerequisiteFilter === "exclude_unmet") {
    tags.push({
      clear: (current) => ({ ...current, prerequisiteFilter: "show_with_warning" }),
      id: "prerequisite",
      label: "排除未滿足先修",
    });
  }
  if (filters.courseLevelFilter !== "all") {
    tags.push({
      clear: (current) => ({ ...current, courseLevelFilter: "all" }),
      id: "course-level",
      label: courseLevelTagLabels[filters.courseLevelFilter],
    });
  }
  if (filters.includeScheduleInfo) {
    tags.push({
      clear: (current) => ({ ...current, includeScheduleInfo: false }),
      id: "schedule-conflicts",
      label: "檢查衝堂",
    });
  }
  if (filters.categoryFilters.length > 0) {
    tags.push({
      clear: (current) => ({ ...current, categoryFilters: [] }),
      id: "categories",
      label: `課程類別 ${filters.categoryFilters.length}`,
    });
  }
  if (filters.courseTagFilters.length > 0) {
    tags.push({
      clear: (current) => ({ ...current, courseTagFilters: [] }),
      id: "course-tags",
      label: `官方標籤 ${filters.courseTagFilters.length}`,
    });
  }
  return tags;
}

/** Removes every tag named in `keys` in one pass, so `onRemove` stays atomic. */
export function removeAppliedFilters(filters: RecommendFilters, highCreditOptions: number[], keys: Iterable<string>): RecommendFilters {
  const wanted = new Set(keys);
  return appliedFilterTags(filters, highCreditOptions)
    .filter((tag) => wanted.has(tag.id))
    .reduce((current, tag) => tag.clear(current), filters);
}
