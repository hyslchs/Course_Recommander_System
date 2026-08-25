import { describe, expect, it } from "vitest";
import { getClassGroupOptions, selectRequiredCourses } from "./requiredCourses";
import type { Course, Profile } from "./types";

const profile: Profile = {
  id: "current",
  division: "日間部",
  department: "資訊工程學系",
  department_identity: "D:51:department",
  department_code: "51",
  official_department_name_zh: "資訊工程學系",
  official_department_type: "department",
  grade: 1,
  studyLevel: "undergraduate",
  admissionYear: 115,
  interests: "",
  preferredWeekdays: [],

  updatedAt: "now",
};

function course(id: string, overrides: Partial<Course> = {}): Course {
  return {
    course_id: id,
    ava_no: id,
    name_zh: "資料結構",
    name_en: "Data Structures",
    credits: 3,
    required_elective_name: "必修",
    academic_year: 115,
    semester: 1,
    department: "資工",
    raw_department: "資工一",
    department_identity: "D:51:department",
    department_code: "51",
    official_department_name_zh: "資訊工程學系",
    official_department_type: "department",
    grade: 1,
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
    source_url: "",
    ...overrides,
  };
}

describe("required course selection", () => {
  it("filters department requirements by grade and selected class", () => {
    const result = selectRequiredCourses([
      course("a", { class_group: "甲班" }),
      course("b", { class_group: "乙班" }),
      course("c", { grade: 2, class_group: "甲班" }),
      course("d", { required_elective_name: "選修", class_group: "甲班" }),
    ], { ...profile, classGroup: "甲班" });

    expect(result.map((item) => item.course_id)).toEqual(["a"]);
  });

  it("keeps department-scoped core courses while deferring Chinese and English", () => {
    const result = selectRequiredCourses([
      course("intro", { name_zh: "大學入門", department: "資工系入門", raw_department: "資工系入門", grade: null, department_identity: null, department_code: null, official_department_name_zh: null }),
      course("chinese", { name_zh: "國文", department: "CT-理工學院", raw_department: "CT-理工學院", grade: null, department_identity: null, department_code: null, official_department_name_zh: null }),
      course("english", { name_zh: "外國語文(初級英文)", department: "FT-理工學院", raw_department: "FT-理工學院", grade: null, department_identity: null, department_code: null, official_department_name_zh: null }),
      course("other-language", { name_zh: "外國語文(基礎日文)", department: "FT-非英文", raw_department: "FT-非英文", grade: null, department_identity: null, department_code: null, official_department_name_zh: null }),
    ], profile);

    expect(result.map((item) => item.course_id)).toEqual(["intro"]);
  });

  it("limits department core courses with missing catalog grades to their configured year", () => {
    const courses = [
      course("intro", { name_zh: "大學入門", department: "資工系入門", raw_department: "資工系入門", grade: null, department_identity: null, department_code: null, official_department_name_zh: null }),
      course("life", { name_zh: "人生哲學", department: "資工系人哲", raw_department: "資工系人哲", grade: null, department_identity: null, department_code: null, official_department_name_zh: null }),
    ];

    expect(selectRequiredCourses(courses, { ...profile, grade: 1 }).map((item) => item.course_id)).toEqual(["intro"]);
    expect(selectRequiredCourses(courses, { ...profile, grade: 2 }).map((item) => item.course_id)).toEqual(["life"]);
    expect(selectRequiredCourses(courses, { ...profile, grade: 4 })).toEqual([]);
  });

  it("does not add class-specific courses until a class is selected", () => {
    const result = selectRequiredCourses([
      course("a", { class_group: "甲班" }),
      course("b", { class_group: "乙班" }),
    ], profile);

    expect(result).toEqual([]);
  });

  it("reports class groups from the selected department", () => {
    expect(getClassGroupOptions([
      course("a", { class_group: "甲班" }),
      course("b", { class_group: "乙班" }),
      course("other", { department: "資管", department_identity: "D:74:department", department_code: "74", official_department_name_zh: "資訊管理學系", raw_department: "資管一" }),
    ], profile)).toEqual(["乙班", "甲班"].sort((left, right) => left.localeCompare(right, "zh-Hant")));
  });
});
