import type { CourseSummary, Meeting, ScheduleEntry, SchedulePlan } from "./types";

/** Record id under which the shared active plan is persisted in the `recommendationPreferences` store. */
export const ACTIVE_SCHEDULE_PREFERENCE_ID = "active-schedule-plan-v1";

export interface ActiveSchedulePreference {
  id: typeof ACTIVE_SCHEDULE_PREFERENCE_ID;
  planId: string;
  updatedAt: string;
}

/** Return the course as it is actually scheduled, including a manual time override. */
export function courseForScheduleEntry<T extends CourseSummary>(course: T, entry: ScheduleEntry): T {
  return (entry.meetingsOverride ? { ...course, meetings: entry.meetingsOverride } : course) as T;
}

/** Resolve all catalog-backed entries in a plan while preserving their order. */
export function coursesInPlan<T extends CourseSummary>(catalog: T[], plan?: SchedulePlan): T[] {
  if (!plan) return [];
  const courseById = new Map(catalog.map((course) => [course.course_id, course]));
  return plan.entries.flatMap((entry) => {
    const course = courseById.get(entry.courseId);
    return course ? [courseForScheduleEntry(course, entry)] : [];
  });
}

/** Return every occupied meeting, including non-course fixed timetable entries. */
export function meetingsInPlan<T extends CourseSummary>(catalog: T[], plan?: SchedulePlan): Meeting[] {
  if (!plan) return [];
  return [
    ...coursesInPlan(catalog, plan).flatMap((course) => course.meetings),
    ...(plan.fixedEntries ?? []).flatMap((entry) => entry.meetings),
  ];
}

/** Resolve the shared active plan, falling back safely when a saved plan was removed or imported elsewhere. */
export function resolveActiveSchedulePlan(plans: SchedulePlan[], preferredPlanId?: string): SchedulePlan | undefined {
  return plans.find((plan) => plan.id === preferredPlanId) ?? plans[0];
}
