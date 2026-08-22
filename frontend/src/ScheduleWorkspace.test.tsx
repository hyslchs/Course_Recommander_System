import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMeetings, ScheduleWorkspace } from "./ScheduleWorkspace";
import type { Course, Meeting, SchedulePlan } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function course(id: string, name: string, meetings: Meeting[]): Course {
  return {
    course_id: id,
    ava_no: `NO-${id}`,
    name_zh: name,
    name_en: `${name} English`,
    credits: 2,
    required_elective_name: "選修",
    department: "測試系",
    teacher: "測試教師",
    meetings,
    sections: { objective: "測試課程目標" },
    prerequisite: "無",
    enrollment_note: "",
    source_url: `https://example.test/course/${id}`,
  } as unknown as Course;
}

describe("schedule workspace", () => {
  let container: HTMLDivElement;
  let root: Root;
  const catalog = [
    course("day", "日間課程", [{ weekday: 1, sections: ["D2", "D3"], room: "A101", week_pattern: "A" }]),
    course("night", "週末夜間課程", [{ weekday: 6, sections: ["E1", "E2"], room: "B202", week_pattern: "S" }]),
  ];
  const plan: SchedulePlan = { id: "plan", name: "測試方案", entries: [{ courseId: "day", locked: false }, { courseId: "night", locked: false }], createdAt: "now", updatedAt: "now" };

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(<ScheduleWorkspace catalog={catalog} plans={[plan]} active={plan} selectPlan={async () => undefined} />); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("auto-expands weekend and evening periods when they contain a course", () => {
    const grid = container.querySelector(".schedule-grid");
    expect(grid?.textContent).toContain("星期六");
    expect(grid?.textContent).toContain("E1");
    expect(grid?.querySelectorAll(".class-block")).toHaveLength(2);
  });

  it("opens an accessible detail drawer with the official outline link", async () => {
    const block = container.querySelector<HTMLButtonElement>('.class-block[aria-label^="日間課程"]');
    await act(async () => block?.click());
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("測試課程目標");
    expect(dialog?.querySelector<HTMLAnchorElement>("a.schedule-outline-link")?.href).toBe("https://example.test/course/day");
    const close = dialog?.querySelector<HTMLButtonElement>(".dialog-close");
    await act(async () => {
      close?.click();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(block);
  });

  it("warns when compact mode hides occupied uncommon periods", async () => {
    const compact = [...container.querySelectorAll<HTMLButtonElement>(".segmented-control button")].find((button) => button.textContent?.startsWith("核心時段"));
    await act(async () => compact?.click());
    expect(container.querySelector(".schedule-hidden-notice")?.textContent).toContain("1 門課");
    expect(container.querySelector(".schedule-grid")?.textContent).not.toContain("星期六");
  });
});

describe("meeting formatting", () => {
  it("does not mislabel an unknown weekday as Monday", () => {
    expect(formatMeetings({ meetings: [{ weekday: null, sections: ["D3"], room: null, week_pattern: null }] })).toBe("星期未定 D3");
  });
});
