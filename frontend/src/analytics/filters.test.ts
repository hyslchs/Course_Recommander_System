import { describe, expect, it } from "vitest";
import { changedFilters } from "./filters";
import { createFilters, type RecommendFilters } from "@/pages/recommend/filterState";

const base = (): RecommendFilters => createFilters([1, 2, 3, 4, 5]);

describe("changedFilters", () => {
  it("reports nothing when nothing changed", () => {
    expect(changedFilters(base(), base())).toEqual([]);
  });

  it("names a closed-set filter and the option that was chosen", () => {
    const next = { ...base(), preferredWeekdays: [1, 2, 3, 4, 5, 6] };
    expect(changedFilters(base(), next)).toEqual([{ filter: "weekday", value: "sat" }]);
  });

  it("names an open-set filter without its value", () => {
    // A department identity would say more about who is filtering than about
    // which filters are useful, so only the filter's name is recorded.
    const next = { ...base(), departmentIdentities: ["dept:07:0700"] };
    expect(changedFilters(base(), next)).toEqual([{ filter: "department" }]);
  });

  it("never carries an instructor or a course-tag id", () => {
    const previous = base();
    const next = { ...previous, instructorIds: ["T12345"], courseTagFilters: ["A7"] };
    const uses = changedFilters(previous, next);
    expect(uses).toEqual([{ filter: "course_tag" }, { filter: "instructor" }]);
    expect(JSON.stringify(uses)).not.toContain("T12345");
    expect(JSON.stringify(uses)).not.toContain("A7");
  });

  it("records a removal as filter use, without a value", () => {
    const previous = { ...base(), creditFilters: [2, 3] };
    const next = { ...previous, creditFilters: [3] };
    expect(changedFilters(previous, next)).toEqual([{ filter: "credits" }]);
  });

  it("maps the conflict toggle and the broad time filter to their tokens", () => {
    const previous = base();
    const next: RecommendFilters = {
      ...previous,
      includeScheduleInfo: true,
      classTime: { mode: "broad", value: "evening" },
    };
    expect(changedFilters(previous, next)).toEqual([
      { filter: "conflict_filter", value: "on" },
      { filter: "class_time", value: "evening" },
    ]);
  });

  it("caps a bulk change so one reset cannot flood the queue", () => {
    const previous = base();
    const next: RecommendFilters = {
      ...previous,
      assessmentMethodIds: ["1"],
      assessmentStyle: "no_exams",
      categoryFilters: [],
      courseTagFilters: ["A"],
      creditFilters: [1, 2, 3],
      departmentIdentities: ["a"],
      divisions: ["日間部"],
      instructorIds: ["b"],
      materialLanguages: ["zh"],
      preferredWeekdays: [1, 2, 3, 4, 5, 6, 7],
      relations: { literacy: ["1"], coreCompetencies: ["2"], specialIssues: ["3"], includeIndirect: false },
      teachingLanguages: ["zh"],
      teachingMethodIds: ["1"],
    };
    expect(changedFilters(previous, next).length).toBeLessThanOrEqual(8);
  });

  it("only produces filter names the event schema declares", () => {
    // Guards against a filter being added here but not to the server allowlist,
    // where the event would then be silently dropped.
    const allowed = new Set([
      "assessment_method", "assessment_style", "class_time", "conflict_filter", "core_competency",
      "course_category", "course_tag", "credits", "department", "division", "include_unknown_schedule",
      "instructor", "literacy", "material_language", "online_teaching", "show_other_weekdays",
      "special_issue", "teaching_language", "teaching_method", "weekday",
    ]);
    const previous = base();
    const next: RecommendFilters = {
      ...previous,
      classTime: { mode: "broad", value: "daytime" },
      includeUnknownSchedule: false,
      onlineTeaching: { mode: "physical_only" },
      showOtherWeekdays: true,
    };
    for (const use of changedFilters(previous, next)) expect(allowed.has(use.filter)).toBe(true);
  });
});
