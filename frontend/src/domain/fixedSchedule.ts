import type { FixedScheduleEntry, Profile } from "./types";

export const MENTOR_TIME_ENTRY_ID = "fju-fixed-mentor-time";

/**
 * Fixed timetable commitments are not course-outline records.  They are
 * kept separate from Course so they do not acquire a fake course code,
 * teacher, credits, or recommendation metadata.
 */
export function getFixedScheduleEntries(profile: Profile): FixedScheduleEntry[] {
  if (profile.division !== "日間部") return [];

  return [{
    id: MENTOR_TIME_ENTRY_ID,
    name: "導師時間",
    teacher: "固定時段",
    meetings: [{ weekday: 3, sections: ["D5", "D6"], room: null, week_pattern: "A" }],
    locked: true,
    source: "輔大固定課表規則",
  }];
}
