import type { Course, EligibilityRule, EligibilityStatus, Meeting, Profile, StudyLevel } from "./types";
import { departmentNamesMatch } from "./department";

export interface EligibilityResult {
  status: EligibilityStatus;
  blocked: EligibilityRule[];
  pending: EligibilityRule[];
  satisfied: EligibilityRule[];
}

/**
 * The two wordings for the same status. They are deliberately different, not a
 * duplication bug: the long form is the explanatory copy on course cards, the short
 * form fits the dense status tag inside the schedule slot recommendation dialog.
 * Keep both here so the wording pairs stay visible side by side and cannot drift apart.
 */
export const eligibilityStatusLabels: Record<EligibilityStatus, string> = {
  no_known_restriction: "尚未判定出明確限制",
  eligible_confirmed: "條件已符合",
  blocked_confirmed: "目前不可修",
  needs_confirmation: "需要確認",
};

export const eligibilityStatusShortLabels: Record<EligibilityStatus, string> = {
  no_known_restriction: "未見限制",
  eligible_confirmed: "資格符合",
  blocked_confirmed: "資格不符",
  needs_confirmation: "資格待確認",
};

const noPrerequisiteLabels = new Set([
  "",
  "無",
  "none",
  "no",
  "n/a",
  "na",
  "無none",
  "none無",
  "no無",
  "無no",
  "無先修",
  "無先修課程",
  "無先修條件",
  "無先修要求",
  "無需先修",
  "無需先修課程",
  "無需先修條件",
  "無須先修",
  "無須先修課程",
  "無須先修條件",
  "不需要先修",
  "不需要先修課程",
  "不需要先修條件",
  "免先修",
  "免先修課程",
  "無特殊要求",
  "無特別要求",
  "無特殊先修",
  "無特殊先修課程",
  "無特殊先修條件",
  "無特定先修課程要求",
  "無限制",
  "無經驗可",
]);

export function isNoPrerequisiteText(value: string | null | undefined): boolean {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s/g, "")
    .replace(/[。．.!！,，、;；:：_＿]/g, "")
    .replace(/[\[\]()（）【】{}「」『』]/g, "");
  return noPrerequisiteLabels.has(normalized)
    || /^no(?:specific)?prerequisites?(?:arerequired|isrequired|required)?$/i.test(normalized);
}

export function inferCourseStudyLevel(course: Pick<Course, "study_level" | "raw_department" | "division">): StudyLevel {
  if (course.study_level) return course.study_level;
  const rawDepartment = (course.raw_department ?? "").replace(/\s/g, "");
  // 「博物碩一」的「博」是系所名稱的一部分，不能先以單一字元判成博士。
  if (/(?:碩士|碩職|碩)(?:班|[一二三四五六七1-7])?$/.test(rawDepartment) || course.division?.includes("碩士")) return "master";
  if (/(?:博士|博)(?:班|[一二三四五六七1-7])?$/.test(rawDepartment)
    || rawDepartment.includes("博士")
    || course.division?.includes("博士")
    || (rawDepartment.includes("博") && !rawDepartment.includes("博物"))) return "doctoral";
  if (course.division === "研究所") return "master";
  if (course.division) return "undergraduate";
  return "unknown";
}

export function formatCourseStudyLevelLabel(course: Pick<Course, "study_level" | "raw_department" | "division">): string {
  const level = inferCourseStudyLevel(course);
  if (level === "master") return "碩士班";
  if (level === "doctoral") return "博士班";
  if (level === "undergraduate") {
    const division = course.division?.trim();
    return division && division !== "研究所" ? `${division}（大學部）` : "大學部";
  }
  return course.division?.trim() || "學制未標示";
}

export function inferProfileStudyLevel(profile?: Pick<Profile, "studyLevel" | "division">): StudyLevel {
  if (!profile) return "unknown";
  // The official FJU outline search groups master's, in-service master's,
  // and doctoral programs under the single division 「研究所」. Treat the
  // division as the source of truth so a stale stored studyLevel cannot
  // contradict the official division selected by the user.
  if (profile.division === "研究所") return "master";
  if (["日間部", "進修部", "二年制"].includes(profile.division)) return "undergraduate";
  return profile.studyLevel ?? "unknown";
}

export function studyLevelsMatch(studentLevel: StudyLevel, courseLevel: StudyLevel): boolean {
  if (studentLevel === "unknown" || courseLevel === "unknown") return false;
  const studentIsGraduate = studentLevel === "master" || studentLevel === "doctoral";
  const courseIsGraduate = courseLevel === "master" || courseLevel === "doctoral";
  return studentIsGraduate ? courseIsGraduate : !courseIsGraduate;
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
  // Course level is informational in the recommender. Some departments allow
  // undergraduates to take graduate courses early, so it must not become an
  // automatic eligibility restriction.
  const rules = (course.eligibility_rules ?? []).filter((rule) => rule.kind !== "study_level_only");
  const studyLevel = inferCourseStudyLevel(course);
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
      else (studyLevelsMatch(studentStudyLevel, value.study_level as StudyLevel) ? satisfied : blocked).push(rule);
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
