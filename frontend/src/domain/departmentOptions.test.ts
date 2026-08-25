import { describe, expect, it } from "vitest";
import { buildDepartmentOptions, buildDivisionOptions, filterDepartmentOptions } from "./departmentOptions";
import type { Course, DepartmentCatalog } from "./types";

function course(overrides: Partial<Course>): Course {
  return {
    course_id: "1",
    ava_no: "D54000001",
    name_zh: "測試課程",
    name_en: "Test",
    credits: 3,
    required_elective_name: "選修",
    academic_year: 115,
    semester: 1,
    department: "資訊工程學系",
    raw_department: "資訊工程學系一",
    grade: 1,
    class_group: "",
    division: "日間部",
    teacher: "教師",
    teacher_en: "Teacher",
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

describe("department options", () => {
  const catalog = [
    course({
      course_id: "1",
      department: "資工",
      department_identity: "D:54:department",
      division_code: "D",
      department_code: "54",
      official_department_name_zh: "資訊工程學系",
      official_department_type: "department",
    }),
    course({
      course_id: "2",
      division: "研究所",
      department: "資訊工程學系碩士班",
      department_identity: "G:54:department",
      division_code: "G",
      department_code: "54",
      official_department_name_zh: "資訊工程學系碩士班",
      official_department_type: "graduate_institute",
    }),
    course({
      course_id: "3",
      department: "資訊工程學系",
      department_identity: "D:54:department",
      division_code: "D",
      department_code: "54",
      official_department_name_zh: "資訊工程學系",
      official_department_type: "department",
    }),
  ];

  it("deduplicates official units and filters them by division", () => {
    const options = buildDepartmentOptions(catalog);
    expect(options).toHaveLength(2);
    expect(filterDepartmentOptions(options, "日間部", "").map((item) => item.key)).toEqual(["D:54:department"]);
    expect(filterDepartmentOptions(options, "研究所", "").map((item) => item.key)).toEqual(["G:54:department"]);
  });

  it("uses the official FJU dropdown artifact as the authoritative option set", () => {
    const officialCatalog: DepartmentCatalog = {
      schema_version: "fju_department_catalog_v2",
      hy: 115,
      divisions: [
        { code: "C", label: "C-進修部", name_zh: "進修部", departments: [{ code: "0E", label: "0E-企業管理學系", name_zh: "企業管理學系", department_type: "department" }] },
        { code: "D", label: "D-日間部", name_zh: "日間部", departments: [{ code: "54", label: "54-資訊工程學系", name_zh: "資訊工程學系", department_type: "department" }] },
        { code: "G", label: "G-研究所", name_zh: "研究所", departments: [{ code: "156", label: "156-博物館學研究所碩士班", name_zh: "博物館學研究所碩士班", department_type: "graduate_institute" }] },
        { code: "T", label: "T-二年制", name_zh: "二年制", departments: [{ code: "915", label: "915-護理學系二年制在職專班", name_zh: "護理學系二年制在職專班", department_type: "department" }] },
      ],
      departments: [
        { division_code: "C", division_name_zh: "進修部", code: "0E", label: "0E-企業管理學系", name_zh: "企業管理學系", department_type: "department" },
        { division_code: "D", division_name_zh: "日間部", code: "54", label: "54-資訊工程學系", name_zh: "資訊工程學系", department_type: "department" },
        { division_code: "G", division_name_zh: "研究所", code: "156", label: "156-博物館學研究所碩士班", name_zh: "博物館學研究所碩士班", department_type: "graduate_institute" },
        { division_code: "T", division_name_zh: "二年制", code: "915", label: "915-護理學系二年制在職專班", name_zh: "護理學系二年制在職專班", department_type: "department" },
      ],
    };
    const nonOfficialCourse = course({
      department_identity: "D:ZZ:department",
      division_code: "D",
      department_code: "ZZ",
      official_department_name_zh: "不存在的測試系所",
      official_department_type: "department",
    });

    const options = buildDepartmentOptions([nonOfficialCourse], officialCatalog);
    expect(options.map((item) => item.officialName).sort()).toEqual([
      "企業管理學系",
      "博物館學研究所碩士班",
      "資訊工程學系",
      "護理學系二年制在職專班",
    ].sort());
    expect(buildDivisionOptions([], officialCatalog)).toEqual(["日間部", "研究所", "進修部", "二年制"]);
  });

  it("searches by Chinese name, code, and unit type", () => {
    const options = buildDepartmentOptions(catalog);
    expect(filterDepartmentOptions(options, "日間部", "資訊")).toHaveLength(1);
    expect(filterDepartmentOptions(options, "日間部", "資工")).toHaveLength(1);
    expect(filterDepartmentOptions(options, "日間部", "54")).toHaveLength(1);
    expect(filterDepartmentOptions(options, "研究所", "研究所")).toHaveLength(1);
  });

  it("does not treat course-audience labels or supplementary programs as a student's home department", () => {
    const options = buildDepartmentOptions([
      course({ course_id: "legacy", department: "資工系人哲" }),
      course({
        course_id: "micro",
        department: "人工智慧微學程",
        division_code: "D",
        department_code: "K99",
        official_department_name_zh: "人工智慧微學程",
        official_department_type: "micro_program",
      }),
    ]);
    expect(options).toEqual([]);
  });

  it("keeps an officially coded but untyped student cohort when its name is clearly a class", () => {
    const options = buildDepartmentOptions([
      course({
        course_id: "cohort",
        department: "國際菁英學士班",
        division_code: "D",
        department_code: "U0",
        official_department_name_zh: "國際菁英學士班",
        official_department_type: null,
      }),
    ]);
    expect(options.map((item) => item.officialName)).toEqual(["國際菁英學士班"]);
  });

  it("prefers an exact ordinary department over a post-baccalaureate variant", () => {
    const options = buildDepartmentOptions([
      course({
        course_id: "post-bacc-nursing",
        department: "學士後護理學系",
        division_code: "D",
        department_code: "1S",
        official_department_name_zh: "學士後護理學系",
        official_department_type: "department",
      }),
      course({
        course_id: "nursing",
        department: "護理學系",
        division_code: "D",
        department_code: "91",
        official_department_name_zh: "護理學系",
        official_department_type: "department",
      }),
    ]);

    expect(filterDepartmentOptions(options, "日間部", "護理學系").map((item) => item.officialName)).toEqual([
      "護理學系",
      "學士後護理學系",
    ]);
  });

  it("prefers the regular graduate unit for a broad query but honors an explicit in-service query", () => {
    const options = buildDepartmentOptions([
      course({
        course_id: "master-in-service",
        division: "研究所",
        department: "資訊工程學系碩士在職專班",
        division_code: "G",
        department_code: "515",
        official_department_name_zh: "資訊工程學系碩士在職專班",
        official_department_type: "graduate_institute",
      }),
      course({
        course_id: "master-regular",
        division: "研究所",
        department: "資訊工程學系碩士班",
        division_code: "G",
        department_code: "516",
        official_department_name_zh: "資訊工程學系碩士班",
        official_department_type: "graduate_institute",
      }),
    ]);

    expect(filterDepartmentOptions(options, "研究所", "資訊工程").map((item) => item.officialName)).toEqual([
      "資訊工程學系碩士班",
      "資訊工程學系碩士在職專班",
    ]);
    expect(filterDepartmentOptions(options, "研究所", "在職").map((item) => item.officialName)).toEqual([
      "資訊工程學系碩士在職專班",
    ]);
  });
});
