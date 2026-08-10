import type { Course, EligibilityRule, EligibilityStatus, Meeting, Profile } from "./types";

export interface EligibilityResult {
  status: EligibilityStatus;
  blocked: EligibilityRule[];
  pending: EligibilityRule[];
  satisfied: EligibilityRule[];
}

export function evaluateEligibility(
  course: Course,
  profile: Profile | undefined,
  completedNames: Set<string>,
): EligibilityResult {
  const blocked: EligibilityRule[] = [];
  const pending: EligibilityRule[] = [];
  const satisfied: EligibilityRule[] = [];
  for (const rule of course.eligibility_rules) {
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
        (profile.department.includes(expected) || expected.includes(profile.department) ? satisfied : blocked).push(rule);
      }
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
