import { describe, expect, it } from "vitest";
import { evaluateEligibility, inferAudienceDepartment, inferAudienceGrade, meetingsConflict } from "./eligibility";
import type { Course, Profile } from "./types";

const profile: Profile = { id: "current", division: "日間部", department: "資訊工程學系", grade: 2, admissionYear: 115, interests: "AI", preferredWeekdays: [], allowCrossDepartment: true, updatedAt: "now" };
const course = { eligibility_rules: [{ kind: "minimum_grade", reason_code: "minimum_grade", message: "限三年級", source_field: "note", evidence: "三年級以上可選修", value: { grade: 3 } }] } as unknown as Course;

describe("eligibility", () => {
  it("blocks a student below a clear minimum grade", () => {
    expect(evaluateEligibility(course, profile, new Set()).status).toBe("blocked_confirmed");
  });
  it("blocks an undergraduate from a graduate-level course", () => {
    const graduateCourse = { raw_department: "資工碩一", division: "研究所", eligibility_rules: [] } as unknown as Course;
    expect(evaluateEligibility(graduateCourse, { ...profile, studyLevel: "undergraduate" }, new Set()).status).toBe("blocked_confirmed");
    expect(evaluateEligibility(graduateCourse, { ...profile, studyLevel: "master" }, new Set()).status).toBe("eligible_confirmed");
  });
  it("normalizes the audience department for legacy catalog rows", () => {
    expect(inferAudienceDepartment({ audience_department: null, department: "資工碩", raw_department: "資工碩一" })).toBe("資工");
  });
  it("derives a high-grade rule from a legacy catalog row", () => {
    const highGradeCourse = { raw_department: "資工三甲", division: "日間部", eligibility_rules: [] } as unknown as Course;
    expect(inferAudienceGrade({ audience_grade: null, grade: 3, raw_department: "資工三甲" })).toBe(3);
    expect(evaluateEligibility(highGradeCourse, { ...profile, grade: 2 }, new Set()).status).toBe("blocked_confirmed");
  });
  it("detects overlapping weekday and section", () => {
    expect(meetingsConflict(
      [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }],
      [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }],
    ).conflict).toBe(true);
  });
});
