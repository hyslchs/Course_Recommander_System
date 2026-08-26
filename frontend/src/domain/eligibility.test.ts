import { describe, expect, it } from "vitest";
import { eligibilityStatusLabels, eligibilityStatusShortLabels, evaluateEligibility, formatCourseStudyLevelLabel, getEligibilityRules, inferAudienceDepartment, inferAudienceGrade, inferCourseStudyLevel, inferProfileStudyLevel, meetingsConflict, studyLevelsMatch } from "./eligibility";
import type { Course, EligibilityStatus, Profile } from "./types";

const profile: Profile = { id: "current", division: "日間部", department: "資訊工程學系", grade: 2, admissionYear: 115, interests: "AI", preferredWeekdays: [], updatedAt: "now" };
const course = { eligibility_rules: [{ kind: "minimum_grade", reason_code: "minimum_grade", message: "限三年級", source_field: "note", evidence: "三年級以上可選修", value: { grade: 3 } }] } as unknown as Course;

describe("eligibility", () => {
  it("blocks a student below a clear minimum grade", () => {
    expect(evaluateEligibility(course, profile, new Set()).status).toBe("blocked_confirmed");
  });
  it("treats course level as information instead of an automatic restriction", () => {
    const graduateCourse = { raw_department: "資工碩一", division: "研究所", eligibility_rules: [] } as unknown as Course;
    expect(evaluateEligibility(graduateCourse, { ...profile, studyLevel: "undergraduate" }, new Set()).status).toBe("no_known_restriction");
    expect(evaluateEligibility(graduateCourse, { ...profile, division: "研究所", studyLevel: "master" }, new Set()).status).toBe("no_known_restriction");
  });
  it("uses the official division as the profile source of truth", () => {
    expect(inferProfileStudyLevel({ division: "研究所", studyLevel: "undergraduate" })).toBe("master");
    expect(inferProfileStudyLevel({ division: "日間部", studyLevel: "doctoral" })).toBe("undergraduate");
    expect(studyLevelsMatch("master", "master")).toBe(true);
    expect(studyLevelsMatch("master", "doctoral")).toBe(true);
    expect(studyLevelsMatch("undergraduate", "doctoral")).toBe(false);
  });
  it("does not classify a museum master's label as doctoral", () => {
    expect(inferCourseStudyLevel({ raw_department: "博物碩一", division: "研究所" })).toBe("master");
    expect(inferCourseStudyLevel({ raw_department: "生科博一", division: "研究所" })).toBe("doctoral");
    expect(inferCourseStudyLevel({ raw_department: "博物館學系", division: "日間部" })).toBe("undergraduate");
    expect(inferCourseStudyLevel({ raw_department: "音博演奏組一", division: "研究所" })).toBe("doctoral");
  });
  it("formats a clear course-level label for cards", () => {
    expect(formatCourseStudyLevelLabel({ raw_department: "資工二", division: "日間部" })).toBe("日間部（大學部）");
    expect(formatCourseStudyLevelLabel({ raw_department: "資工碩一", division: "研究所" })).toBe("碩士班");
    expect(formatCourseStudyLevelLabel({ raw_department: "資工博一", division: "研究所", study_level: "doctoral" })).toBe("博士班");
  });
  it("normalizes the audience department for legacy catalog rows", () => {
    expect(inferAudienceDepartment({ audience_department: null, department: "資工碩", raw_department: "資工碩一" })).toBe("資工");
  });
  it("derives a high-grade rule from a legacy catalog row", () => {
    const highGradeCourse = { raw_department: "資工三甲", division: "日間部", eligibility_rules: [] } as unknown as Course;
    expect(inferAudienceGrade({ audience_grade: null, grade: 3, raw_department: "資工三甲" })).toBe(3);
    expect(evaluateEligibility(highGradeCourse, { ...profile, grade: 2 }, new Set()).status).toBe("blocked_confirmed");
  });
  it("does not duplicate an equivalent grade restriction", () => {
    const courseWithExistingRule = {
      raw_department: "資工三甲",
      division: "日間部",
      eligibility_rules: [{ kind: "minimum_grade", reason_code: "minimum_grade", message: "限三年級以上", source_field: "note", evidence: "三年級以上", value: { grade: 3 } }],
    } as unknown as Course;
    expect(getEligibilityRules(courseWithExistingRule)).toHaveLength(1);
    expect(getEligibilityRules(courseWithExistingRule)[0].kind).toBe("minimum_grade");
  });
  it("detects overlapping weekday and section", () => {
    expect(meetingsConflict(
      [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }],
      [{ weekday: 1, sections: ["D1"], room: null, week_pattern: "A" }],
    ).conflict).toBe(true);
  });
});

describe("eligibility status labels", () => {
  const statuses: EligibilityStatus[] = ["no_known_restriction", "eligible_confirmed", "blocked_confirmed", "needs_confirmation"];

  it("keeps the long course-card wording", () => {
    expect(eligibilityStatusLabels).toEqual({
      no_known_restriction: "尚未判定出明確限制",
      eligible_confirmed: "條件已符合",
      blocked_confirmed: "目前不可修",
      needs_confirmation: "需要確認",
    });
  });

  it("keeps the short schedule-slot wording", () => {
    expect(eligibilityStatusShortLabels).toEqual({
      no_known_restriction: "未見限制",
      eligible_confirmed: "資格符合",
      blocked_confirmed: "資格不符",
      needs_confirmation: "資格待確認",
    });
  });

  it("covers every status in both wordings, with no empty label", () => {
    for (const status of statuses) {
      expect(eligibilityStatusLabels[status]).toBeTruthy();
      expect(eligibilityStatusShortLabels[status]).toBeTruthy();
    }
    expect(Object.keys(eligibilityStatusLabels).sort()).toEqual([...statuses].sort());
    expect(Object.keys(eligibilityStatusShortLabels).sort()).toEqual([...statuses].sort());
  });
});
