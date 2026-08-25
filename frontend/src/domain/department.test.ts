import { describe, expect, it } from "vitest";
import { departmentNamesMatch, normalizeDepartmentLabel, sameDepartment } from "./department";
import type { Course, Profile } from "./types";

const profile = { department: "圖資", department_code: null } as Profile;
const course = { department: "圖書資訊學系", raw_department: "圖資一", department_code: null } as Course;

describe("official department identity", () => {
  it("normalizes grade and official suffixes", () => {
    expect(normalizeDepartmentLabel("圖書資訊學系碩士班")).toBe("圖書資訊");
    expect(normalizeDepartmentLabel("圖資一")).toBe("圖資");
  });

  it("recognizes a local abbreviation as the official department name", () => {
    expect(departmentNamesMatch("圖資", "圖書資訊學系")).toBe(true);
    expect(sameDepartment(course, profile)).toBe(true);
  });

  it("does not merge unrelated department names", () => {
    expect(departmentNamesMatch("資工", "資訊管理學系")).toBe(false);
    expect(departmentNamesMatch("企業管理學系", "國際企業管理學程")).toBe(false);
    expect(departmentNamesMatch("企業管理學系", "企業財稅管理學分學程")).toBe(false);
  });

  it("does not merge official identities with different codes or types", () => {
    const department = {
      department: "企業管理學系",
      department_identity: "D:0E:department",
      department_code: "0E",
      division_code: "D",
      raw_department: "企管四",
    } as Course;
    const programProfile = {
      ...profile,
      department: "國際企業管理學程",
      department_identity: "D:K14:program",
      department_code: "K14",
      division_code: "D",
    } as Profile;
    expect(sameDepartment(department, programProfile)).toBe(false);
  });
});
