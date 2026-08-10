import { describe, expect, it } from "vitest";
import { evaluateEligibility, meetingsConflict } from "./eligibility";
import type { Course, Profile } from "./types";

const profile: Profile = { id: "current", division: "日間部", department: "資訊工程學系", grade: 2, admissionYear: 115, interests: "AI", preferredWeekdays: [], targetCredits: 18, allowCrossDepartment: true, updatedAt: "now" };
const course = { eligibility_rules: [{ kind: "minimum_grade", reason_code: "minimum_grade", message: "限三年級", source_field: "note", evidence: "三年級以上可選修", value: { grade: 3 } }] } as unknown as Course;

describe("eligibility", () => {
  it("blocks a student below a clear minimum grade", () => {
    expect(evaluateEligibility(course, profile, new Set()).status).toBe("blocked_confirmed");
  });
  it("detects overlapping weekday and section", () => {
    expect(meetingsConflict(
      [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }],
      [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }],
    ).conflict).toBe(true);
  });
});
