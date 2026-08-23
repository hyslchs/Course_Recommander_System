import { describe, expect, it } from "vitest";
import {
  buildScheduleBlocks,
  compareSections,
  formatMeetings,
  hasUnscheduledMeeting,
  parseManualSections,
  SCHEDULE_SECTIONS,
  sortSections,
  unplacedBlock,
  weekdayLabels,
  weekPatternLabel,
} from "./schedule";
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

describe("weekPatternLabel", () => {
  it("labels the alternating week markers case-insensitively", () => {
    expect(weekPatternLabel("S")).toBe("單週");
    expect(weekPatternLabel("s")).toBe("單週");
    expect(weekPatternLabel("D")).toBe("雙週");
    expect(weekPatternLabel("d")).toBe("雙週");
  });

  it("stays empty for every-week, unknown and missing patterns", () => {
    expect(weekPatternLabel("A")).toBe("");
    expect(weekPatternLabel("")).toBe("");
    expect(weekPatternLabel(null)).toBe("");
  });
});

describe("formatMeetings", () => {
  it("reports an empty meeting list as undecided", () => {
    expect(formatMeetings({ meetings: [] })).toBe("時間未定");
  });

  it("does not mislabel an unknown weekday as Monday", () => {
    expect(formatMeetings({ meetings: [{ weekday: null, sections: ["D3"], room: null, week_pattern: null }] })).toBe("星期未定 D3");
  });

  it("names every weekday from its 1-based number", () => {
    expect(weekdayLabels).toHaveLength(7);
    expect(formatMeetings({ meetings: [{ weekday: 7, sections: ["D1"], room: null, week_pattern: null }] })).toBe("星期日 D1");
    expect(formatMeetings({ meetings: [{ weekday: 8, sections: ["D1"], room: null, week_pattern: null }] })).toBe("星期未定 D1");
  });

  it("marks missing sections as undecided", () => {
    expect(formatMeetings({ meetings: [{ weekday: 2, sections: [], room: null, week_pattern: null }] })).toBe("星期二 節次未定");
  });

  it("appends the room and the week pattern when they are known", () => {
    expect(formatMeetings({ meetings: [{ weekday: 3, sections: ["D5", "D6"], room: "LM101", week_pattern: "S" }] }))
      .toBe("星期三 D5、D6 LM101 · 單週");
    expect(formatMeetings({ meetings: [{ weekday: 3, sections: ["D5"], room: null, week_pattern: "D" }] }))
      .toBe("星期三 D5 雙週");
    expect(formatMeetings({ meetings: [{ weekday: 3, sections: ["D5"], room: "LM101", week_pattern: "A" }] }))
      .toBe("星期三 D5 LM101");
  });

  it("joins several meetings with a full-width semicolon", () => {
    expect(formatMeetings({ meetings: [
      { weekday: 1, sections: ["D1"], room: null, week_pattern: "A" },
      { weekday: 4, sections: ["E1"], room: null, week_pattern: "A" },
    ] })).toBe("星期一 D1；星期四 E1");
  });
});

describe("parseManualSections", () => {
  it("accepts the separators a student is likely to type", () => {
    expect(parseManualSections("D5,D6")).toEqual(["D5", "D6"]);
    expect(parseManualSections("D5 D6")).toEqual(["D5", "D6"]);
    expect(parseManualSections("D5、D6")).toEqual(["D5", "D6"]);
    expect(parseManualSections("D5，D6；D7;D8")).toEqual(["D5", "D6", "D7", "D8"]);
  });

  it("upper-cases lowercase input", () => {
    expect(parseManualSections("d5,dn,e0")).toEqual(["D5", "DN", "E0"]);
  });

  it("drops duplicates while keeping first-seen order", () => {
    expect(parseManualSections("D6,D5,d6")).toEqual(["D6", "D5"]);
  });

  it("drops anything outside D0-D8 / DN / E0-E4", () => {
    expect(parseManualSections("D9,E5,X1,DD,D,5")).toEqual([]);
    expect(parseManualSections("D5,D9,E4")).toEqual(["D5", "E4"]);
  });

  it("returns nothing for blank input", () => {
    expect(parseManualSections("")).toEqual([]);
    expect(parseManualSections("   ")).toEqual([]);
  });
});

describe("unplacedBlock", () => {
  it("builds a placeholder block that carries no real timetable position", () => {
    expect(unplacedBlock({ course_id: "C1", name_zh: "無時間課程", teacher: "王老師" } as Course)).toEqual({
      id: "unplaced-C1",
      source: "course",
      sourceId: "C1",
      name: "無時間課程",
      teacher: "王老師",
      weekday: 1,
      sections: [],
      startSection: "D1",
      endSection: "D1",
      room: null,
      weekPattern: null,
      meetingIndex: 0,
      lane: 0,
      laneCount: 1,
      conflict: false,
    });
  });

  it("falls back to a placeholder teacher name", () => {
    expect(unplacedBlock({ course_id: "C2", name_zh: "課", teacher: "" } as Course).teacher).toBe("教師未定");
  });
});
