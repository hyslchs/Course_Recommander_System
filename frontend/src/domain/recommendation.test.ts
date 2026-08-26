import { describe, expect, it } from "vitest";
import {
  classifyRecommendationCategory,
  rankCourses,
  reciprocalRankFusion,
  sameCourseFamily,
} from "./recommendation";
import type { Course, Profile } from "./types";

const profile: Profile = {
  id: "current",
  division: "日間部",
  department: "資工",
  grade: 2,
  admissionYear: 114,
  interests: "機器學習",
  preferredWeekdays: [],

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

  it("uses selected categories as the department-scope filter", () => {
    const results = rankCourses({
      catalog: courses,
      courseIds: courses.map((item) => item.course_id),
      vectors: new Float32Array([1, 0, 1, 0, 1, 0, 1, 0]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      profile,
      categoryFilters: ["external_department"],
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results.map((item) => item.course.course_id)).toEqual(["X"]);
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

  it("keeps graduate courses visible when no explicit study-level filter is applied", () => {
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
    expect(results).toHaveLength(1);
  });

  it("does not let an unknown schedule pass strict weekday filters", () => {
    const unknown = {
      ...course("unknown-time", "資工", "選修", "時間未定課程"),
      meetings: [{ weekday: null, sections: [], room: null, week_pattern: null }],
    };
    const input = {
      catalog: [unknown],
      courseIds: [unknown.course_id],
      vectors: new Float32Array([1]),
      dimension: 1,
      query: new Float32Array([1]),
      profile: { ...profile, preferredWeekdays: [6] },
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
      includeUnknownSchedule: false,
    };
    expect(rankCourses(input)).toHaveLength(0);
    expect(rankCourses({ ...input, includeUnknownSchedule: true })).toHaveLength(1);
  });

  it("applies explicit daytime and evening section filters before ranking", () => {
    const daytime = {
      ...course("daytime", "資工", "選修", "日間課程"),
      meetings: [{ weekday: 1, sections: ["D3", "D4"], room: null, week_pattern: "A" }],
    };
    const evening = {
      ...course("evening", "資工", "選修", "晚間課程"),
      meetings: [{ weekday: 1, sections: ["E1", "E2"], room: null, week_pattern: "A" }],
    };
    const input = {
      catalog: [daytime, evening],
      courseIds: [daytime.course_id, evening.course_id],
      vectors: new Float32Array([1, 1]),
      dimension: 1,
      query: new Float32Array([1]),
      profile: { ...profile, preferredWeekdays: [1] },
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
      includeUnknownSchedule: false,
    };
    expect(rankCourses({ ...input, timeOfDayFilter: "daytime" }).map((item) => item.course.course_id)).toEqual(["daytime"]);
    expect(rankCourses({ ...input, timeOfDayFilter: "evening" }).map((item) => item.course.course_id)).toEqual(["evening"]);
  });

  it("supports the explicit working-student window of weekday evenings or any Saturday section", () => {
    const weekdayDay = { ...course("weekday-day", "資工", "選修", "平日白天"), meetings: [{ weekday: 2, sections: ["D3"], room: null, week_pattern: "A" }] };
    const weekdayEvening = { ...course("weekday-evening", "資工", "選修", "平日晚間"), meetings: [{ weekday: 2, sections: ["E2"], room: null, week_pattern: "A" }] };
    const saturdayDay = { ...course("saturday-day", "資工", "選修", "星期六白天"), meetings: [{ weekday: 6, sections: ["D3"], room: null, week_pattern: "A" }] };
    const catalog = [weekdayDay, weekdayEvening, saturdayDay];
    const results = rankCourses({
      catalog,
      courseIds: catalog.map((item) => item.course_id),
      vectors: new Float32Array([1, 1, 1]),
      dimension: 1,
      query: new Float32Array([1]),
      profile: { ...profile, preferredWeekdays: [1, 2, 3, 4, 5, 6] },
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
      includeUnknownSchedule: false,
      timeOfDayFilter: "weekday_evening_or_saturday",
    });
    expect(results.map((item) => item.course.course_id)).toEqual(["weekday-evening", "saturday-day"]);
  });

  it("filters a candidate that conflicts with a fixed timetable entry", () => {
    const candidate = {
      ...course("mentor-conflict", "資工", "選修", "導師時間衝堂課程"),
      meetings: [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }],
    };
    const results = rankCourses({
      catalog: [candidate],
      courseIds: [candidate.course_id],
      vectors: new Float32Array([1, 0]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      profile: { ...profile, preferredWeekdays: [3] },
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
      scheduledMeetings: [{ weekday: 3, sections: ["D5", "D6"], room: null, week_pattern: "A" }],
    });
    expect(results).toHaveLength(0);
  });

  it("keeps courses with an unverified formal prerequisite", () => {
    const prerequisiteCourse = {
      ...course("prerequisite", "資工", "必修", "資料庫系統概論"),
      eligibility_rules: [{
        kind: "course_prerequisite",
        reason_code: "formal_prerequisite",
        message: "須先修畢「計算機概論」",
        source_field: "outline.basic_info.rejList",
        evidence: "計算機概論(6.00)",
        value: { course_name: "計算機概論", credits: 6 },
      }],
    };
    const results = rankCourses({
      catalog: [prerequisiteCourse],
      courseIds: [prerequisiteCourse.course_id],
      vectors: new Float32Array([1]),
      dimension: 1,
      query: new Float32Array([1]),
      queryText: "資料庫",
      profile,
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results).toHaveLength(1);
    expect(results[0].eligibility).toBe("blocked_confirmed");
    expect(results[0].reasons).not.toContain("有擋修條件，請展開查看原始依據");
  });

  it("keeps unmet formal prerequisites visible for card-level review", () => {
    const prerequisiteCourse = {
      ...course("prerequisite-strict", "資工", "必修", "進階資料庫"),
      eligibility_rules: [{
        kind: "course_prerequisite",
        reason_code: "formal_prerequisite",
        message: "須先修畢「資料庫系統概論」",
        source_field: "outline.basic_info.rejList",
        evidence: "資料庫系統概論(3.00)",
        value: { course_name: "資料庫系統概論", credits: 3 },
      }],
    };
    const results = rankCourses({
      catalog: [prerequisiteCourse],
      courseIds: [prerequisiteCourse.course_id],
      vectors: new Float32Array([1]),
      dimension: 1,
      query: new Float32Array([1]),
      queryText: "資料庫",
      profile,
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results).toHaveLength(1);
    expect(results[0].eligibility).toBe("blocked_confirmed");
  });

  it("groups master's and doctoral courses under the official graduate division", () => {
    const undergraduate = course("undergraduate-only", "心理", "必修", "大學入門");
    const master = {
      ...course("master-only", "心理碩", "選修", "研究方法"),
      division: "研究所",
      raw_department: "心理碩士班",
      study_level: "master" as const,
    };
    const doctoral = {
      ...course("doctoral-only", "心理博", "選修", "博士研究專題"),
      division: "研究所",
      raw_department: "心理博士班",
      study_level: "doctoral" as const,
    };
    const results = rankCourses({
      catalog: [undergraduate, master, doctoral],
      courseIds: [undergraduate.course_id, master.course_id, doctoral.course_id],
      vectors: new Float32Array([1, 1, 1]),
      dimension: 1,
      query: new Float32Array([1]),
      profile: { ...profile, division: "研究所", studyLevel: "master" },
      studyLevelFilter: "master",
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results.map((item) => item.course.course_id).sort()).toEqual(["doctoral-only", "master-only"]);
  });

  it("strict study-level filtering excludes courses whose study level is unknown", () => {
    const unknown = { ...course("unknown-level", "心理", "選修", "研究方法"), division: "", raw_department: "" };
    const doctoral = {
      ...course("doctoral-level", "心理博", "選修", "博士研究專題"),
      division: "研究所",
      raw_department: "心理博士班",
      study_level: "doctoral" as const,
    };
    const input = {
      catalog: [unknown, doctoral],
      courseIds: [unknown.course_id, doctoral.course_id],
      vectors: new Float32Array([1, 1]),
      dimension: 1,
      query: new Float32Array([1]),
      profile: { ...profile, division: "研究所", studyLevel: "master" as const },
      studyLevelFilter: "master" as const,
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    };
    expect(rankCourses(input).map((item) => item.course.course_id)).toEqual(["doctoral-level"]);
    expect(rankCourses({ ...input, includeUnknownStudyLevel: true })).toHaveLength(2);
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

  it("groups sections of the same course and exposes the other sections as alternatives", () => {
    const monday = {
      ...course("food-mon", "食科", "必修", "食品分析實驗"),
      teacher: "王老師",
      sections: { objective: "以實驗操作學習食品成分分析方法與儀器使用，並完成分析結果報告。" },
      meetings: [{ weekday: 1, sections: ["D2", "D3"], room: "HE101", week_pattern: "A" }],
    };
    const tuesday = {
      ...course("food-tue", "食科", "必修", "食品分析實驗"),
      teacher: "王老師",
      sections: { objective: "以實驗操作學習食品成分分析方法與儀器使用，並完成分析結果報告。" },
      meetings: [{ weekday: 2, sections: ["D2", "D3"], room: "HE101", week_pattern: "A" }],
    };
    const results = rankCourses({
      catalog: [monday, tuesday],
      courseIds: [monday.course_id, tuesday.course_id],
      vectors: new Float32Array([1, 0, 0.99, 0.1]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      queryText: "食品分析實驗",
      profile,
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results).toHaveLength(1);
    expect(results[0].alternatives?.map((item) => item.course_id)).toEqual(["food-tue"]);
    expect(results[0].reasons).not.toContain("已合併 2 個相同課程班別／共同開課項目");
  });

  it("keeps another section recommendable when only one section is dismissed", () => {
    const monday = {
      ...course("food-mon-dismissed", "食科", "必修", "食品分析實驗"),
      teacher: "王老師",
      sections: { objective: "以實驗操作學習食品成分分析方法與儀器使用，並完成分析結果報告。" },
      meetings: [{ weekday: 1, sections: ["D2", "D3"], room: "HE101", week_pattern: "A" }],
    };
    const tuesday = {
      ...course("food-tue-kept", "食科", "必修", "食品分析實驗"),
      teacher: "李老師",
      sections: { objective: "以實驗操作學習食品成分分析方法與儀器使用，並完成分析結果報告。" },
      meetings: [{ weekday: 2, sections: ["D2", "D3"], room: "HE101", week_pattern: "A" }],
    };
    const results = rankCourses({
      catalog: [monday, tuesday],
      courseIds: [monday.course_id, tuesday.course_id],
      vectors: new Float32Array([1, 0, 0.99, 0.1]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      queryText: "食品分析實驗",
      profile,
      completed: [],
      dismissedIds: [monday.course_id],
      scheduledCourses: [],
    });
    expect(results.map((item) => item.course.course_id)).toEqual([tuesday.course_id]);
    expect(results[0].alternatives).toEqual([]);
  });

  it("prefers the student's home-department offering inside a cross-listed family", () => {
    const external = {
      ...course("cross-external", "AI微程", "選修", "AI語言模型系統整合"),
      teacher: "陳老師",
      department_identity: "C:AI:program",
    };
    const home = {
      ...course("cross-home", "資工", "選修", "AI語言模型系統整合"),
      teacher: "陳老師",
      department_identity: "C:51:department",
    };
    const results = rankCourses({
      catalog: [external, home],
      courseIds: [external.course_id, home.course_id],
      vectors: new Float32Array([1, 0, 0.98, 0.2]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      profile: { ...profile, department_identity: "C:51:department" },
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results).toHaveLength(1);
    expect(results[0].course.course_id).toBe("cross-home");
    expect(results[0].alternatives?.map((item) => item.course_id)).toEqual(["cross-external"]);
  });

  it("does not merge same-title courses when teacher, content, and department evidence differ", () => {
    const psychology = {
      ...course("seminar-psy", "心理", "選修", "專題（一）"),
      teacher: "林老師",
      department_identity: "C:39:department",
      sections: { objective: "心理研究設計與實驗方法專題。" },
    };
    const computerScience = {
      ...course("seminar-cs", "資工", "選修", "專題（一）"),
      teacher: "張老師",
      department_identity: "C:51:department",
      sections: { objective: "軟體系統設計與程式開發專題。" },
    };
    expect(sameCourseFamily(psychology, computerScience, new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(false);
    const results = rankCourses({
      catalog: [psychology, computerScience],
      courseIds: [psychology.course_id, computerScience.course_id],
      vectors: new Float32Array([1, 0, 0, 1]),
      dimension: 2,
      query: new Float32Array([1, 1]),
      profile,
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results).toHaveLength(2);
  });

  it("keeps generic independent-study titles separate even inside one department", () => {
    const firstProject = {
      ...course("project-one", "資工", "選修", "專題（一）"),
      teacher: "林老師",
      department_identity: "C:51:department",
      sections: { objective: "自然語言處理專題研究。" },
    };
    const secondProject = {
      ...course("project-two", "資工", "選修", "專題（一）"),
      teacher: "張老師",
      department_identity: "C:51:department",
      sections: { objective: "嵌入式系統專題研究。" },
    };
    expect(sameCourseFamily(firstProject, secondProject)).toBe(false);
  });

  it("groups ordinary same-title offerings using the first non-empty department label", () => {
    const morning = {
      ...course("bio-morning", "醫學", "必修", "生物化學實驗"),
      credits: 2,
      teacher: "王老師",
      official_department_name_zh: "",
      department_identity: "",
      department_display: "醫學",
    };
    const afternoon = {
      ...course("bio-afternoon", "醫學", "必修", "生物化學實驗"),
      credits: 2,
      teacher: "辜老師",
      official_department_name_zh: "",
      department_identity: "",
      department_display: "醫學",
    };
    expect(sameCourseFamily(morning, afternoon)).toBe(true);
  });

  it("uses MMR to place a relevant but different topic ahead of a near-duplicate topic", () => {
    const analysisLab = course("analysis-lab", "食科", "選修", "食品分析實驗");
    const instrumentalAnalysis = course("instrumental", "食科", "選修", "食品儀器分析");
    const foodSafety = course("food-safety", "食科", "選修", "食品安全管理");
    const results = rankCourses({
      catalog: [analysisLab, instrumentalAnalysis, foodSafety],
      courseIds: [analysisLab.course_id, instrumentalAnalysis.course_id, foodSafety.course_id],
      vectors: new Float32Array([
        1, 0,
        0.995, 0.1,
        0.7, 0.714,
      ]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      profile,
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
      diversityLambda: 0.78,
    });
    expect(results.map((item) => item.course.course_id)).toEqual([
      "analysis-lab",
      "food-safety",
      "instrumental",
    ]);
  });

  it("fuses dense and sparse rankings without score-scale weights", () => {
    const scores = reciprocalRankFusion(["reader", "ai", "python"], ["ai", "python", "reader"]);
    expect([...scores.keys()]).toEqual(["reader", "ai", "python"]);
    expect(scores.get("ai")).toBeGreaterThan(scores.get("reader")!);
    expect(scores.get("ai")).toBeGreaterThan(scores.get("python")!);
  });
});


describe("official course tag filtering", () => {
  it("keeps a course when it has any selected official tag", () => {
    const emi = { ...course("emi", "資工", "選修", "英文資料科學"), course_tags: [{ code: "302", label_zh: "全英-專業學科類" }] };
    const programming = { ...course("programming", "資工", "選修", "程式設計"), course_tags: [{ code: "100", label_zh: "程式設計類" }] };
    const results = rankCourses({
      catalog: [emi, programming],
      courseIds: [emi.course_id, programming.course_id],
      vectors: new Float32Array([1, 0, 0.9, 0.1]),
      dimension: 2,
      query: new Float32Array([1, 0]),
      courseTagFilters: ["302"],
      completed: [],
      dismissedIds: [],
      scheduledCourses: [],
    });
    expect(results.map((item) => item.course.course_id)).toEqual(["emi"]);
  });
});
