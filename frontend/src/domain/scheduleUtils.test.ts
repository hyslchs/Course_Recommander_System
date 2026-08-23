import { describe, expect, it } from "vitest";
import { ACTIVE_SCHEDULE_PREFERENCE_ID, coursesInPlan, meetingsInPlan, resolveActiveSchedulePlan, type ActiveSchedulePreference } from "./scheduleUtils";
import type { Course, SchedulePlan } from "./types";

const course: Course = {
  course_id: "english",
  ava_no: "FT100",
  name_zh: "外國語文(中級英文)",
  name_en: "",
  credits: 2,
  required_elective_name: "必修",
  academic_year: 115,
  semester: 1,
  department: "FT-理工學院",
  raw_department: "FT-理工學院",
  grade: null,
  class_group: "",
  division: "日間部",
  teacher: "",
  teacher_en: "",
  meetings: [{ weekday: 4, sections: ["D3", "D4"], room: null, week_pattern: "A" }],
  sections: {},
  prerequisite: "",
  enrollment_note: "",
  eligibility_base_status: "no_known_restriction",
  eligibility_rules: [],
  source_url: "",
};

describe("schedule course resolution", () => {
  it("uses a manual time override for display and conflict checks", () => {
    const plan: SchedulePlan = {
      id: "plan",
      name: "我的課表",
      entries: [{
        courseId: course.course_id,
        locked: false,
        meetingsOverride: [{ weekday: 3, sections: ["D5", "D6"], room: null, week_pattern: "A" }],
      }],
      createdAt: "now",
      updatedAt: "now",
    };
    expect(coursesInPlan([course], plan)[0].meetings[0].sections).toEqual(["D5", "D6"]);
    expect(meetingsInPlan([course], plan)).toHaveLength(1);
  });
});

describe("active schedule plan resolution", () => {
  const plans: SchedulePlan[] = [
    { id: "a", name: "方案 A", entries: [], createdAt: "now", updatedAt: "now" },
    { id: "b", name: "方案 B", entries: [], createdAt: "now", updatedAt: "now" },
  ];

  it("uses the shared preferred plan", () => {
    expect(resolveActiveSchedulePlan(plans, "b")?.id).toBe("b");
  });

  it("falls back to the first available plan when the preference is stale", () => {
    expect(resolveActiveSchedulePlan(plans, "missing")?.id).toBe("a");
  });

  it("keeps the persisted preference key stable so saved plans survive an upgrade", () => {
    expect(ACTIVE_SCHEDULE_PREFERENCE_ID).toBe("active-schedule-plan-v1");
    const preference: ActiveSchedulePreference = { id: ACTIVE_SCHEDULE_PREFERENCE_ID, planId: "b", updatedAt: "now" };
    expect(resolveActiveSchedulePlan(plans, preference.planId)?.id).toBe("b");
  });
});
