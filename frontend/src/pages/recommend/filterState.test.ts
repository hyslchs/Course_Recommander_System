import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  appliedFilterTags,
  clearFilters,
  createFilters,
  removeAppliedFilters,
} from "./filterState";

const HIGH_CREDITS = [4, 5];
const base = () => createFilters([1, 2, 3]);

describe("recommendation filter state", () => {
  it("counts the three conditions a fresh page already applies", () => {
    // 星期限制 + 排除未滿足先修 + 檢查衝堂. The mobile Badge and the drawer's
    // 套用 button both show this number, so it is pinned rather than derived.
    expect(activeFilterCount(base())).toBe(3);
  });

  it("counts the widening options too, even though they have no chip", () => {
    const filters = { ...base(), includeUnknownCourseLevel: true, includeUnknownPrerequisite: true };
    expect(activeFilterCount(filters)).toBe(5);
    expect(appliedFilterTags(filters, HIGH_CREDITS).map((tag) => tag.id)).toEqual(["weekdays", "prerequisite", "schedule-conflicts"]);
  });

  it("drops to zero after 清除全部 but keeps the profile's weekdays", () => {
    const filters = { ...base(), categoryFilters: ["home_required"] as never, creditFilters: [2], courseLevelFilter: "advanced" as const };
    const cleared = clearFilters(filters);
    expect(activeFilterCount(cleared)).toBe(0);
    expect(appliedFilterTags(cleared, HIGH_CREDITS)).toHaveLength(0);
    expect(cleared.preferredWeekdays).toEqual([1, 2, 3]);
  });

  it("labels every chip the old hand-rolled pills carried", () => {
    const filters = {
      ...base(),
      categoryFilters: ["home_required", "general_education"] as never,
      courseLevelFilter: "exclude_introductory" as const,
      courseTagFilters: ["EMI"],
      creditFilters: [2],
      timeOfDayFilter: "evening" as const,
    };
    expect(appliedFilterTags(filters, HIGH_CREDITS).map((tag) => tag.label)).toEqual([
      "星期一、二、三",
      "晚間 E 節",
      "2 學分",
      "排除未滿足先修",
      "排除入門",
      "檢查衝堂",
      "課程類別 2",
      "官方標籤 1",
    ]);
  });

  it("removes exactly the named chips and leaves the rest alone", () => {
    const filters = { ...base(), creditFilters: [2] };
    const next = removeAppliedFilters(filters, HIGH_CREDITS, ["credits", "schedule-conflicts"]);
    expect(next.creditFilters).toEqual([]);
    expect(next.includeScheduleInfo).toBe(false);
    // Untouched by either clear-action.
    expect(next.showOtherWeekdays).toBe(false);
    expect(next.prerequisiteFilter).toBe("exclude_unmet");
    expect(activeFilterCount(next)).toBe(2);
  });

  it("clearing the time-of-day chip also re-admits courses with no known schedule", () => {
    const filters = { ...base(), includeUnknownSchedule: false, timeOfDayFilter: "daytime" as const };
    const next = removeAppliedFilters(filters, HIGH_CREDITS, ["time-of-day"]);
    expect(next.timeOfDayFilter).toBe("all");
    expect(next.includeUnknownSchedule).toBe(true);
  });

  it("ignores keys that are not currently applied", () => {
    const filters = base();
    expect(removeAppliedFilters(filters, HIGH_CREDITS, ["credits", "nope"])).toBe(filters);
  });
});
