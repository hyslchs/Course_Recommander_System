import { describe, expect, it } from "vitest";
import { getFixedScheduleEntries } from "./fixedSchedule";
import type { Profile } from "./types";

const profile: Profile = {
  id: "current",
  division: "日間部",
  department: "圖書資訊學系",
  grade: 4,
  studyLevel: "undergraduate",
  admissionYear: 112,
  interests: "",
  preferredWeekdays: [],

  updatedAt: "now",
};

describe("fixed schedule entries", () => {
  it("adds mentor time as an independent Wednesday D5-D6 entry", () => {
    expect(getFixedScheduleEntries(profile)).toEqual([{
      id: "fju-fixed-mentor-time",
      name: "導師時間",
      teacher: "固定時段",
      meetings: [{ weekday: 3, sections: ["D5", "D6"], room: null, week_pattern: "A" }],
      locked: true,
      source: "輔大固定課表規則",
    }]);
  });

  it("does not put daytime mentor time into an evening or graduate profile", () => {
    expect(getFixedScheduleEntries({ ...profile, division: "進修部" })).toEqual([]);
    expect(getFixedScheduleEntries({ ...profile, division: "研究所", studyLevel: "master" })).toEqual([]);
    expect(getFixedScheduleEntries({ ...profile, studyLevel: "master" })).toHaveLength(1);
  });
});
