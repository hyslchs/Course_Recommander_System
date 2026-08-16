import { describe, expect, it } from "vitest";
import { classifyRecommendationCategory, rankCourses, reciprocalRankFusion } from "./recommendation";
import type { Course, Profile } from "./types";

const profile: Profile = {
  id: "current",
  division: "日間部",
  department: "資工",
  grade: 2,
  admissionYear: 114,
  interests: "機器學習",
  preferredWeekdays: [],
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

describe("query-only recommendation ranking", () => {
  it("classifies courses using the student's official department", () => {
    expect(courses.map((item) => classifyRecommendationCategory(item, profile))).toEqual([
      "home_required",
      "home_elective",
      "general_education",
      "external_department",
    ]);
  });

  it("matches a local abbreviation with the official full department name", () => {
    const libraryCourse = course("library", "圖書資訊學系", "選修", "資訊組織");
    expect(classifyRecommendationCategory(libraryCourse, { ...profile, department: "圖資" })).toBe("home_elective");
  });

  it("uses query relevance above department category", () => {
    const results = rankCourses({
      catalog: courses,
      courseIds: courses.map((item) => item.course_id),
      // The external course has the highest semantic score and exact title match.
      vectors: new Float32Array([0.1, 0.99, 0.3, 0.95, 0.5, 0.86, 1, 0]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      queryText: "機器學習",
      profile,
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results[0].course.course_id).toBe("X");
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
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results.map((item) => item.category)).toEqual([
      "home_required",
      "home_elective",
      "general_education",
    ]);
  });

  it("only keeps courses held on the selected weekdays", () => {
    const monday = {
      ...course("mon", "資工", "選修", "星期一課程"),
      meetings: [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }],
    };
    const saturday = {
      ...course("sat", "資工", "選修", "星期六課程"),
      meetings: [{ weekday: 6, sections: ["D1"], room: null, week_pattern: "A" }],
    };
    const results = rankCourses({
      catalog: [monday, saturday],
      courseIds: [monday.course_id, saturday.course_id],
      vectors: new Float32Array([1, 0, 1, 0]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      profile: { ...profile, preferredWeekdays: [1] },
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results.map((item) => item.course.course_id)).toEqual(["mon"]);
  });

  it("shows non-preferred weekdays when the override is enabled", () => {
    const monday = {
      ...course("mon-override", "資工", "選修", "星期一課程"),
      meetings: [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }],
    };
    const saturday = {
      ...course("sat-override", "資工", "選修", "星期六課程"),
      meetings: [{ weekday: 6, sections: ["D1"], room: null, week_pattern: "A" }],
    };
    const input = {
      catalog: [monday, saturday],
      courseIds: [monday.course_id, saturday.course_id],
      vectors: new Float32Array([1, 0, 1, 0]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      profile: { ...profile, preferredWeekdays: [1] },
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    };
    expect(rankCourses(input).map((item) => item.course.course_id)).toEqual(["mon-override"]);
    expect(rankCourses({ ...input, includeNonPreferredWeekdays: true }).map((item) => item.course.course_id)).toEqual([
      "mon-override",
      "sat-override",
    ]);
  });

  it("filters recommendations by selected credit values", () => {
    const oneCredit = { ...course("one-credit", "資工", "選修", "一學分課程"), credits: 1 };
    const twoCredits = { ...course("two-credit", "資工", "選修", "二學分課程"), credits: 2 };
    const results = rankCourses({
      catalog: [oneCredit, twoCredits],
      courseIds: [oneCredit.course_id, twoCredits.course_id],
      vectors: new Float32Array([1, 0, 1, 0]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      profile,
      creditFilters: [1],
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results.map((item) => item.course.course_id)).toEqual(["one-credit"]);
  });

  it("filters a candidate that conflicts with any scheduled course", () => {
    const scheduled = {
      ...course("scheduled", "資工", "選修", "已加入課表"),
      meetings: [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }],
    };
    const candidate = {
      ...course("candidate", "資工", "選修", "候選課程"),
      meetings: [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }],
    };
    const results = rankCourses({
      catalog: [candidate],
      courseIds: [candidate.course_id],
      vectors: new Float32Array([1, 0]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      profile: { ...profile, preferredWeekdays: [1] },
      completed: [],
      dismissedIds: [],
      scheduledCourses: [scheduled],
    });
    expect(results).toHaveLength(0);
  });

  it("supports multiple category filters without changing query ranking", () => {
    const results = rankCourses({
      catalog: courses,
      courseIds: courses.map((item) => item.course_id),
      vectors: new Float32Array([0.1, 0.99, 0.3, 0.95, 0.5, 0.86, 1, 0]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      queryText: "機器學習",
      profile,
      categoryFilters: ["home_required", "home_elective"],
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results).toHaveLength(2);
    expect(new Set(results.map((item) => item.category))).toEqual(new Set(["home_required", "home_elective"]));
  });

  it("filters graduate courses when the student's study level does not match", () => {
    const graduate = {
      ...course("graduate", "資工", "選修", "研究所機器學習"),
      raw_department: "資工碩一",
      division: "研究所",
    };
    const results = rankCourses({
      catalog: [graduate],
      courseIds: [graduate.course_id],
      vectors: new Float32Array([1]),
      dimension: 1,
      query: new Float32Array([1]),
      profile: { ...profile, studyLevel: "undergraduate" },
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results).toHaveLength(0);
  });

  it("gives an exact Python title match the best query-only rank", () => {
    const pythonProfile: Profile = { ...profile, department: "圖資", grade: 3 };
    const pythonCourses = [
      course("reader", "圖資", "必修", "讀者服務"),
      course("computer", "圖資", "必修", "計算機概論"),
      course("ai", "圖資", "必修", "人工智慧應用概論"),
      course("python", "圖資", "選修", "Python程式設計實務"),
    ];
    const results = rankCourses({
      catalog: pythonCourses,
      courseIds: pythonCourses.map((item) => item.course_id),
      vectors: new Float32Array([0.8, 0.84, 0.82, 0.89]),
      dimension: 1,
      query: new Float32Array([1]),
      queryText: "Python",
      profile: pythonProfile,
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results[0].course.course_id).toBe("python");
    expect(results[0].reasons.some((reason) => reason.includes("Python"))).toBe(true);
  });

  it("fuses dense and sparse rankings without score-scale weights", () => {
    const scores = reciprocalRankFusion(["reader", "ai", "python"], ["ai", "python", "reader"]);
    expect([...scores.keys()]).toEqual(["reader", "ai", "python"]);
    expect(scores.get("ai")).toBeGreaterThan(scores.get("reader")!);
    expect(scores.get("ai")).toBeGreaterThan(scores.get("python")!);
  });
});
