import { describe, expect, it } from "vitest";
import { classifyRecommendationCategory, rankCourses } from "./recommendation";
import type { Course, Profile } from "./types";

const profile: Profile = {
  id: "current",
  division: "日間部",
  department: "資工",
  grade: 2,
  admissionYear: 114,
  interests: "機器學習",
  preferredWeekdays: [],
  targetCredits: 18,
  allowCrossDepartment: true,
  updatedAt: "2026-08-02T00:00:00Z",
};

function course(id: string, department: string, type: string, name: string): Course {
  return {
    course_id: id,
    ava_no: id,
    name_zh: name,
    name_en: "",
    credits: 3,
    required_elective_name: type,
    academic_year: 115,
    semester: 1,
    department,
    raw_department: department,
    grade: 2,
    class_group: "",
    division: "日間部",
    teacher: "",
    teacher_en: "",
    meetings: [],
    sections: {},
    prerequisite: "",
    enrollment_note: "",
    eligibility_base_status: "no_known_restriction",
    eligibility_rules: [],
    source_url: "https://example.edu/course",
  };
}

const courses = [
  course("R", "資工", "必修", "程式設計"),
  course("E", "資工", "選修", "人工智慧"),
  course("G", "資訊科技", "通識", "數位生活"),
  course("X", "統資", "選修", "機器學習實務"),
];

describe("recommendation hierarchy", () => {
  it("classifies courses using the student's official department", () => {
    expect(courses.map((item) => classifyRecommendationCategory(item, profile))).toEqual([
      "home_required",
      "home_elective",
      "general_education",
      "external_department",
    ]);
  });

  it("keeps department priority above cosine similarity", () => {
    const results = rankCourses({
      catalog: courses,
      courseIds: courses.map((item) => item.course_id),
      // The external course has the highest cosine score, but belongs to the last tier.
      vectors: new Float32Array([0.1, 0.99, 0.3, 0.95, 0.5, 0.86, 1, 0]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      queryText: "機器學習",
      profile,
      completed: [],
      favoriteIds: [],
      dismissedIds: [],
      lockedCourses: [],
    });
    expect(results.map((item) => item.category)).toEqual([
      "home_required",
      "home_elective",
      "general_education",
      "external_department",
    ]);
  });

  it("keeps general education when cross-department recommendations are disabled", () => {
    const results = rankCourses({
      catalog: courses,
      courseIds: courses.map((item) => item.course_id),
      vectors: new Float32Array([1, 0, 1, 0, 1, 0, 1, 0]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      profile: { ...profile, allowCrossDepartment: false },
      completed: [],
      favoriteIds: [],
      dismissedIds: [],
      lockedCourses: [],
    });
    expect(results.map((item) => item.category)).toEqual([
      "home_required",
      "home_elective",
      "general_education",
    ]);
  });
});
