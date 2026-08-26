import { describe, expect, it } from "vitest";
import { matchesAdvancedCourseFilters, type AdvancedCourseFilters } from "./courseFilters";
import type { Course } from "./types";

const course = {
  course_id: "C1",
  division: "日間部",
  department_identity: "D-001",
  meetings: [
    { weekday: 1, sections: ["D1", "D2"], room: null, week_pattern: null },
    { weekday: 3, sections: ["D5"], room: null, week_pattern: null },
  ],
  relations: [
    { id: "1:1", group: "literacy", label: "批判思考", strength: "direct" },
    { id: "8:2", group: "special_issues", label: "永續", strength: "indirect" },
  ],
  teaching_methods: [
    { id: "1", label: "講述", percent: 40 },
    { id: "3", label: "實作", percent: 40 },
    { id: "2", label: "討論", percent: 20 },
  ],
  assessments: [
    { id: "7", label: "期中", percent: 30 },
    { id: "2", label: "作業心得", percent: 30 },
    { id: "11", label: "課堂參與", percent: 10 },
  ],
  teaching_language: "中文",
  material_language: "英文",
  online_teaching: { sync: true, async: true },
  instructors: [{ id: "T1", name_zh: "王老師" }, { id: "T2", name_zh: "李老師" }],
} as Course;

function filters(patch: Partial<AdvancedCourseFilters> = {}): AdvancedCourseFilters {
  return {
    classTime: { mode: "all" },
    onlineTeaching: { mode: "all" },
    relations: { literacy: [], coreCompetencies: [], specialIssues: [], includeIndirect: false },
    teachingMethodIds: [],
    teachingMethodCriterion: { mode: "dominant" },
    assessmentStyle: "all",
    assessmentMethodIds: [],
    assessmentMethodCriterion: { mode: "dominant" },
    teachingLanguages: [],
    materialLanguages: [],
    divisions: [],
    departmentIdentities: [],
    instructorIds: [],
    ...patch,
  };
}

describe("advanced hard course filters", () => {
  it("matches any selected exact section across every meeting", () => {
    expect(matchesAdvancedCourseFilters(course, filters({ classTime: { mode: "sections", sections: ["D1"] } }))).toBe(true);
    expect(matchesAdvancedCourseFilters(course, filters({ classTime: { mode: "sections", sections: ["D4", "D5"] } }))).toBe(true);
    expect(matchesAdvancedCourseFilters(course, filters({ classTime: { mode: "sections", sections: ["D3", "D4"] } }))).toBe(false);
    expect(matchesAdvancedCourseFilters({ ...course, meetings: [] }, filters({ classTime: { mode: "sections", sections: ["D1"] } }))).toBe(false);
  });

  it("accepts every method tied for the highest percentage and minimum boundaries", () => {
    expect(matchesAdvancedCourseFilters(course, filters({ teachingMethodIds: ["1"] }))).toBe(true);
    expect(matchesAdvancedCourseFilters(course, filters({ teachingMethodIds: ["3"] }))).toBe(true);
    expect(matchesAdvancedCourseFilters(course, filters({ teachingMethodIds: ["2"], teachingMethodCriterion: { mode: "minimum", minPercent: 20 } }))).toBe(true);
    expect(matchesAdvancedCourseFilters(course, filters({ teachingMethodIds: ["2"], teachingMethodCriterion: { mode: "minimum", minPercent: 25 } }))).toBe(false);
  });

  it("uses OR inside relation groups, AND across groups, and defaults to direct", () => {
    expect(matchesAdvancedCourseFilters(course, filters({ relations: { literacy: ["missing", "1:1"], coreCompetencies: [], specialIssues: [], includeIndirect: false } }))).toBe(true);
    expect(matchesAdvancedCourseFilters(course, filters({ relations: { literacy: ["1:1"], coreCompetencies: [], specialIssues: ["8:2"], includeIndirect: false } }))).toBe(false);
    expect(matchesAdvancedCourseFilters(course, filters({ relations: { literacy: ["1:1"], coreCompetencies: [], specialIssues: ["8:2"], includeIndirect: true } }))).toBe(true);
  });

  it("keeps tied assessment styles and combines shortcut and exact criteria with AND", () => {
    expect(matchesAdvancedCourseFilters(course, filters({ assessmentStyle: "exam" }))).toBe(true);
    expect(matchesAdvancedCourseFilters(course, filters({ assessmentStyle: "writing" }))).toBe(true);
    expect(matchesAdvancedCourseFilters(course, filters({ assessmentStyle: "no_exams" }))).toBe(false);
    expect(matchesAdvancedCourseFilters(course, filters({ assessmentStyle: "writing", assessmentMethodIds: ["7"], assessmentMethodCriterion: { mode: "minimum", minPercent: 30 } }))).toBe(true);
  });

  it("matches both online kinds, either teacher, and rejects missing new data safely", () => {
    expect(matchesAdvancedCourseFilters(course, filters({ onlineTeaching: { mode: "has_online", kind: "both" }, instructorIds: ["missing", "T2"] }))).toBe(true);
    expect(matchesAdvancedCourseFilters(course, filters({ onlineTeaching: { mode: "physical_only" } }))).toBe(false);
    expect(matchesAdvancedCourseFilters({ ...course, instructors: undefined }, filters({ instructorIds: ["T1"] }))).toBe(false);
  });
});
