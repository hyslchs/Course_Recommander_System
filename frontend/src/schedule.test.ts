import { describe, expect, it } from "vitest";
import { buildScheduleBlocks, compareSections, hasUnscheduledMeeting, SCHEDULE_SECTIONS, sortSections } from "./schedule";
import type { Course, Meeting } from "./types";

function scheduledCourse(id: string, meetings: Meeting[]): Course {
  return {
    course_id: id,
    name_zh: `課程 ${id}`,
    teacher: "教師",
    meetings,
  } as Course;
}

describe("schedule section ordering", () => {
  it("places the noon section DN between D4 and D5", () => {
    expect(sortSections(["D1", "D5", "DN", "D4", "D6"])).toEqual(["D1", "D4", "DN", "D5", "D6"]);
  });

  it("keeps numeric sections in their natural order", () => {
    expect(compareSections("D10", "D2")).toBeGreaterThan(0);
  });

  it("defines the complete day and evening timeline", () => {
    expect(SCHEDULE_SECTIONS).toEqual([
      "D0", "D1", "D2", "D3", "D4", "DN", "D5", "D6", "D7", "D8",
      "E0", "E1", "E2", "E3", "E4",
    ]);
  });

  it("merges adjacent sections and splits gaps on the canonical timeline", () => {
    const blocks = buildScheduleBlocks([
      scheduledCourse("adjacent", [{ weekday: 2, sections: ["D2", "D3", "D4"], room: "A1", week_pattern: "A" }]),
      scheduledCourse("gap", [{ weekday: 3, sections: ["D2", "D4"], room: "A2", week_pattern: "A" }]),
    ], []);
    expect(blocks.filter((block) => block.sourceId === "adjacent").map((block) => block.sections)).toEqual([["D2", "D3", "D4"]]);
    expect(blocks.filter((block) => block.sourceId === "gap").map((block) => block.sections)).toEqual([["D2"], ["D4"]]);
  });

  it("merges adjacent times even when the source stores them as separate meetings", () => {
    const blocks = buildScheduleBlocks([
      scheduledCourse("split-source", [
        { weekday: 2, sections: ["D2"], room: "A1", week_pattern: "A" },
        { weekday: 2, sections: ["D3"], room: "A1", week_pattern: "A" },
      ]),
    ], []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sections).toEqual(["D2", "D3"]);
  });

  it("does not merge D4 and D5 across DN, but merges D8 and E0", () => {
    const blocks = buildScheduleBlocks([
      scheduledCourse("noon-gap", [{ weekday: 1, sections: ["D4", "D5"], room: null, week_pattern: "A" }]),
      scheduledCourse("evening", [{ weekday: 2, sections: ["D8", "E0"], room: null, week_pattern: "A" }]),
    ], []);
    expect(blocks.filter((block) => block.sourceId === "noon-gap")).toHaveLength(2);
    expect(blocks.find((block) => block.sourceId === "evening")?.sections).toEqual(["D8", "E0"]);
  });

  it("marks real overlaps as conflicts while keeping alternating weeks separate", () => {
    const blocks = buildScheduleBlocks([
      scheduledCourse("all", [{ weekday: 4, sections: ["D3"], room: null, week_pattern: "A" }]),
      scheduledCourse("same", [{ weekday: 4, sections: ["D3"], room: null, week_pattern: "A" }]),
      scheduledCourse("single", [{ weekday: 5, sections: ["D5"], room: null, week_pattern: "S" }]),
      scheduledCourse("double", [{ weekday: 5, sections: ["D5"], room: null, week_pattern: "D" }]),
    ], []);
    expect(blocks.filter((block) => block.weekday === 4).every((block) => block.conflict)).toBe(true);
    expect(blocks.filter((block) => block.weekday === 5).every((block) => !block.conflict)).toBe(true);
    expect(blocks.filter((block) => block.weekday === 5).every((block) => block.lane === 0 && block.laneCount === 1)).toBe(true);
  });

  it("recognizes unknown weekdays and unsupported sections as unplaced", () => {
    expect(hasUnscheduledMeeting(scheduledCourse("unknown", [{ weekday: null, sections: ["D3"], room: null, week_pattern: null }]))).toBe(true);
    expect(hasUnscheduledMeeting(scheduledCourse("unsupported", [{ weekday: 1, sections: ["X1"], room: null, week_pattern: "A" }]))).toBe(true);
  });
});
