import { describe, expect, it } from "vitest";
import { rankScheduleSlotCourses } from "./scheduleRecommendation";
import type { Course, Meeting, Profile, RecommendationCategory } from "./types";

function course(id: string, name: string, meetings: Meeting[], requiredElective = "選修"): Course {
  return {
    course_id: id,
    ava_no: `NO-${id}`,
    name_zh: name,
    name_en: name,
    credits: 2,
    required_elective_name: requiredElective,
    academic_year: 115,
    semester: 1,
    department: "測試系",
    raw_department: "測試系一",
    grade: 1,
    class_group: "",
    division: "日間部",
    teacher: "測試教師",
    teacher_en: "",
    meetings,
    sections: { objective: `${name}課程目標` },
    prerequisite: "無",
    enrollment_note: "",
    eligibility_base_status: "no_known_restriction",
    eligibility_rules: [],
    source_url: `https://example.test/${id}`,
  };
}

const profile: Profile = {
  id: "current",
  division: "日間部",
  department: "測試系",
  grade: 1,
  admissionYear: 115,
  interests: "",
  preferredWeekdays: [1, 2, 3, 4, 5],
  updatedAt: "now",
};

function rank(input: {
  catalog: Course[];
  vectors: number[];
  scheduledCourses: Course[];
  weekday?: number;
  section?: string;
  fixedMeetings?: Meeting[];
  categoryFilters?: RecommendationCategory[];
}) {
  return rankScheduleSlotCourses({
    catalog: input.catalog,
    courseIds: input.catalog.map((item) => item.course_id),
    vectors: new Float32Array(input.vectors),
    dimension: 2,
    scheduledCourses: input.scheduledCourses,
    fixedMeetings: input.fixedMeetings,
    weekday: input.weekday ?? 3,
    section: input.section ?? "D5",
    profile,
    categoryFilters: input.categoryFilters,
  });
}

describe("schedule slot recommendation", () => {
  it("keeps distinct timetable interests instead of collapsing them into one average", () => {
    const programming = course("programming", "程式設計", [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }]);
    const japanese = course("japanese", "日文", [{ weekday: 2, sections: ["D1"], room: null, week_pattern: "A" }]);
    const algorithms = course("algorithms", "演算法", [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }]);
    const conversation = course("conversation", "日語會話", [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }]);
    const generic = course("generic", "跨域概論", [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }]);
    const result = rank({
      catalog: [programming, japanese, algorithms, conversation, generic],
      vectors: [1, 0, 0, 1, 0.99, 0.1, 0.1, 0.99, 0.7, 0.7],
      scheduledCourses: [programming, japanese],
    });
    const firstTwo = result.recommendations.slice(0, 2).map((item) => item.course.course_id);
    expect(firstTwo).toContain("algorithms");
    expect(firstTwo).toContain("conversation");
    expect(result.interestClusterCount).toBe(2);
  });

  it("requires the course to cover the clicked slot and fit every meeting", () => {
    const scheduled = course("scheduled", "既有課程", [{ weekday: 1, sections: ["D2"], room: null, week_pattern: "A" }]);
    const safe = course("safe", "可排課程", [{ weekday: 3, sections: ["D5", "D6"], room: null, week_pattern: "A" }]);
    const otherSlot = course("other", "其他時段", [{ weekday: 3, sections: ["D6"], room: null, week_pattern: "A" }]);
    const hiddenConflict = course("conflict", "另有衝堂", [
      { weekday: 3, sections: ["D5"], room: null, week_pattern: "A" },
      { weekday: 1, sections: ["D2"], room: null, week_pattern: "A" },
    ]);
    const fixedConflict = course("fixed", "撞固定時段", [
      { weekday: 3, sections: ["D5"], room: null, week_pattern: "A" },
      { weekday: 4, sections: ["D3"], room: null, week_pattern: "A" },
    ]);
    const result = rank({
      catalog: [scheduled, safe, otherSlot, hiddenConflict, fixedConflict],
      vectors: [1, 0, 0.9, 0.1, 0.8, 0.2, 0.95, 0.05, 0.9, 0.1],
      scheduledCourses: [scheduled],
      fixedMeetings: [{ weekday: 4, sections: ["D3"], room: null, week_pattern: "A" }],
    });
    expect(result.recommendations.map((item) => item.course.course_id)).toEqual(["safe"]);
  });

  it("downweights required courses when combining interest rankings", () => {
    const required = course("required", "共同必修", [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }], "必修");
    const elective = course("elective", "攝影選修", [{ weekday: 2, sections: ["D1"], room: null, week_pattern: "A" }]);
    const requiredLike = course("required-like", "共同必修延伸", [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }]);
    const electiveLike = course("elective-like", "進階攝影", [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }]);
    const result = rank({
      catalog: [required, elective, requiredLike, electiveLike],
      vectors: [1, 0, 0, 1, 0.99, 0.1, 0.1, 0.99],
      scheduledCourses: [required, elective],
    });
    expect(result.recommendations[0].course.course_id).toBe("elective-like");
    expect(result.lowConfidence).toBe(false);
  });

  it("classifies every recommendation with the shared home, general, or external rule", () => {
    const scheduled = course("scheduled", "課表依據", [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }]);
    const homeRequired = course("home-required", "本系必修候選", [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }], "必修");
    const homeElective = course("home-elective", "本系選修候選", [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }]);
    const general = { ...course("general", "通識候選", [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }], "通識"), department: "通識中心", raw_department: "通識中心" };
    const external = { ...course("external", "外系候選", [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }]), department: "其他系", raw_department: "其他系一" };
    const catalog = [scheduled, homeRequired, homeElective, general, external];
    const result = rank({
      catalog,
      vectors: [1, 0, 0.99, 0.01, 0.98, 0.02, 0.97, 0.03, 0.96, 0.04],
      scheduledCourses: [scheduled],
    });
    const categoryById = Object.fromEntries(result.recommendations.map((item) => [item.course.course_id, item.category]));
    expect(categoryById).toMatchObject({
      "home-required": "home_required",
      "home-elective": "home_elective",
      general: "general_education",
      external: "external_department",
    });
    const externalOnly = rank({
      catalog,
      vectors: [1, 0, 0.99, 0.01, 0.98, 0.02, 0.97, 0.03, 0.96, 0.04],
      scheduledCourses: [scheduled],
      categoryFilters: ["external_department"],
    });
    expect(externalOnly.recommendations.map((item) => item.course.course_id)).toEqual(["external"]);
  });

  it("returns a low-confidence empty result when no scheduled course has an embedding", () => {
    const scheduled = course("missing", "缺少向量", [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }]);
    const candidate = course("candidate", "候選課程", [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "A" }]);
    const result = rankScheduleSlotCourses({
      catalog: [candidate],
      courseIds: [candidate.course_id],
      vectors: new Float32Array([1, 0]),
      dimension: 2,
      scheduledCourses: [scheduled],
      weekday: 3,
      section: "D5",
      profile,
    });
    expect(result.recommendations).toEqual([]);
    expect(result.basisCourseCount).toBe(0);
    expect(result.lowConfidence).toBe(true);
  });
});
