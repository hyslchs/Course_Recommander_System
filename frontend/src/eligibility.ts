import type { Course, EligibilityRule, EligibilityStatus, Meeting, Profile, StudyLevel } from "./types";
import { departmentNamesMatch } from "./department";

export interface EligibilityResult {
  status: EligibilityStatus;
  blocked: EligibilityRule[];
  pending: EligibilityRule[];
  satisfied: EligibilityRule[];
}

export function inferCourseStudyLevel(course: Pick<Course, "study_level" | "raw_department" | "division">): StudyLevel {
  if (course.study_level) return course.study_level;
  const rawDepartment = course.raw_department ?? "";
  if (rawDepartment.includes("博") || rawDepartment.includes("博士")) return "doctoral";
  if (rawDepartment.includes("碩") || rawDepartment.includes("碩士") || course.division === "研究所") return "master";
  if (course.division) return "undergraduate";
  return "unknown";
}

export function inferProfileStudyLevel(profile?: Pick<Profile, "studyLevel" | "division">): StudyLevel {
  if (profile?.studyLevel) return profile.studyLevel;
  if (profile?.division === "研究所") return "master";
  return profile ? "undergraduate" : "unknown";
}

export function inferAudienceDepartment(course: Pick<Course, "audience_department" | "department" | "raw_department">): string {
  if (course.audience_department) return course.audience_department;
  const normalized = (course.raw_department ?? "")
    .replace(/(?:博士|碩士|碩職|碩|博)(?:[一二三四五六七])?$/, "")
    .replace(/[一二三四五六七][甲乙丙丁戊己庚辛壬癸愛智仁勇忠孝信義和平]*$/, "");
  return normalized || course.department;
}

export function inferAudienceGrade(course: Pick<Course, "audience_grade" | "grade" | "raw_department">): number | null {
  if (course.audience_grade != null) return course.audience_grade;
  const match = (course.raw_department ?? "").match(/([一二三四五六七1-7])(?:年級|[甲乙丙丁戊己庚辛壬癸愛智仁勇忠孝信義和平]+)?$/);
  if (!match) return course.grade;
  return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 }[match[1] as "一" | "二" | "三" | "四" | "五" | "六" | "七"] ?? Number(match[1]);
}

export function getEligibilityRules(course: Course): EligibilityRule[] {
  const rules = course.eligibility_rules ?? [];
  if (rules.some((rule) => rule.kind === "study_level_only")) return rules;
  const studyLevel = inferCourseStudyLevel(course);
  if (studyLevel === "master" || studyLevel === "doctoral") {
    const label = studyLevel === "doctoral" ? "博士班" : "研究所／碩士班";
    return [...rules, {
      kind: "study_level_only",
      reason_code: "study_level_restriction",
      message: `授課對象為${label}，請確認個人學制資格`,
      source_field: "raw_department / division",
      evidence: [course.raw_department, course.division].filter(Boolean).join("、") || label,
      value: { study_level: studyLevel },
    }];
  }
  const audienceGrade = inferAudienceGrade(course);
  if (studyLevel === "undergraduate" && audienceGrade !== null && audienceGrade >= 3) {
    return [...rules, {
      kind: "audience_grade_only",
      reason_code: "audience_grade_restriction",
      message: `課程標示為${audienceGrade}年級，請確認個人年級資格`,
      source_field: "raw_department / audience_grade",
      evidence: course.raw_department || `${audienceGrade}年級`,
      value: { grade: audienceGrade },
    }];
  }
  return rules;
}

export function evaluateEligibility(
  course: Course,
  profile: Profile | undefined,
  completedNames: Set<string>,
): EligibilityResult {
  const blocked: EligibilityRule[] = [];
  const pending: EligibilityRule[] = [];
  const satisfied: EligibilityRule[] = [];
  for (const rule of getEligibilityRules(course)) {
    const value = rule.value;
    if (rule.kind === "course_prerequisite") {
      (completedNames.has(String(value.course_name)) ? satisfied : blocked).push(rule);
    } else if (rule.kind === "minimum_grade") {
      if (!profile) pending.push(rule);
      else (profile.grade >= Number(value.grade) ? satisfied : blocked).push(rule);
    } else if (rule.kind === "exact_grade") {
      if (!profile) pending.push(rule);
      else (profile.grade === Number(value.grade) ? satisfied : blocked).push(rule);
    } else if (rule.kind === "division_only") {
      if (!profile) pending.push(rule);
      else (profile.division === value.division ? satisfied : blocked).push(rule);
    } else if (rule.kind === "department_only") {
      if (!profile) pending.push(rule);
      else {
        const expected = String(value.department ?? "");
        (departmentNamesMatch(profile.department, expected) ? satisfied : blocked).push(rule);
      }
    } else if (rule.kind === "study_level_only") {
      const studentStudyLevel = inferProfileStudyLevel(profile);
      if (studentStudyLevel === "unknown") pending.push(rule);
      else (studentStudyLevel === value.study_level ? satisfied : blocked).push(rule);
    } else if (rule.kind === "audience_grade_only") {
      if (!profile) pending.push(rule);
      else (profile.grade >= Number(value.grade) ? satisfied : blocked).push(rule);
    } else pending.push(rule);
  }
  const status: EligibilityStatus = blocked.length
    ? "blocked_confirmed"
    : pending.length
      ? "needs_confirmation"
      : satisfied.length
        ? "eligible_confirmed"
        : "no_known_restriction";
  return { status, blocked, pending, satisfied };
}

export function meetingsConflict(left: Meeting[], right: Meeting[]): { conflict: boolean; uncertain: boolean } {
  let uncertain = false;
  for (const a of left) {
    for (const b of right) {
      if (!a.weekday || a.weekday !== b.weekday) continue;
      if (!a.sections.some((section) => b.sections.includes(section))) continue;
      const patternA = a.week_pattern?.toUpperCase();
      const patternB = b.week_pattern?.toUpperCase();
      if (!patternA || !patternB) uncertain = true;
      else if (patternA === "A" || patternB === "A" || patternA === patternB) return { conflict: true, uncertain };
    }
  }
  return { conflict: false, uncertain };
}

export function courseConflicts(course: Course, scheduled: Course[]) {
  return scheduled.reduce(
    (result, other) => {
      const current = meetingsConflict(course.meetings, other.meetings);
      return { conflict: result.conflict || current.conflict, uncertain: result.uncertain || current.uncertain };
    },
    { conflict: false, uncertain: false },
  );
}
