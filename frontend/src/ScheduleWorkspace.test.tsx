import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMeetings, ScheduleWorkspace } from "./ScheduleWorkspace";
import type { Course, Meeting, Profile, SchedulePlan } from "./types";

const apiMocks = vi.hoisted(() => ({ getEmbeddingBundle: vi.fn() }));
const dbMocks = vi.hoisted(() => ({ getAllRecords: vi.fn(), putRecord: vi.fn() }));
vi.mock("./api", () => apiMocks);
vi.mock("./db", () => dbMocks);

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
    course("candidate", "資料分析實務", [{ weekday: 3, sections: ["D5", "D6"], room: "C303", week_pattern: "A" }]),
  ];
  const plan: SchedulePlan = { id: "plan", name: "測試方案", entries: [{ courseId: "day", locked: false }, { courseId: "night", locked: false }], createdAt: "now", updatedAt: "now" };
  const profile: Profile = { id: "current", division: "日間部", department: "測試系", grade: 1, admissionYear: 115, interests: "", preferredWeekdays: [1, 2, 3, 4, 5], updatedAt: "now" };

  beforeEach(async () => {
    vi.clearAllMocks();
    apiMocks.getEmbeddingBundle.mockResolvedValue({
      index: { course_ids: catalog.map((item) => item.course_id), dimension: 2 },
      vectors: new Float32Array([1, 0, 0, 1, 0.95, 0.05]),
    });
    dbMocks.getAllRecords.mockResolvedValue([]);
    dbMocks.putRecord.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(<ScheduleWorkspace catalog={catalog} plans={[plan]} active={plan} profile={profile} selectPlan={async () => undefined} />); });
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
    const dialog = document.querySelector('[role="dialog"]');
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

  it("opens timetable-based recommendations from an empty keyboard-accessible slot", async () => {
    expect(container.querySelector('[aria-label="推薦星期一 D2 可以排入的課程"]')).toBeNull();
    const slot = container.querySelector<HTMLButtonElement>('[aria-label="推薦星期三 D5 可以排入的課程"]');
    expect(slot?.tabIndex).toBeGreaterThanOrEqual(-1);
    await act(async () => {
      slot?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const dialog = document.querySelector('.slot-recommendation-dialog[role="dialog"]');
    expect(dialog?.textContent).toContain("星期三 D5 的課程推薦");
    expect(dialog?.textContent).toContain("資料分析實務");
    expect(dialog?.textContent).toContain("本系選修");
    expect(dialog?.textContent).toContain("完整上課時間不與目前課表衝堂");
    expect(dialog?.querySelectorAll(".slot-category-filter")).toHaveLength(4);
    const homeElectiveFilter = dialog?.querySelector<HTMLButtonElement>(".slot-category-filter.home_elective");
    expect(homeElectiveFilter?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => homeElectiveFilter?.click());
    expect(dialog?.querySelector<HTMLButtonElement>(".slot-category-filter.home_elective")?.getAttribute("aria-pressed")).toBe("false");
    expect(dialog?.textContent).not.toContain("資料分析實務");
    await act(async () => dialog?.querySelector<HTMLButtonElement>(".slot-category-filter.home_elective")?.click());
    expect(dialog?.textContent).toContain("資料分析實務");
  });

  it("adds a recommended course to the active plan", async () => {
    const slot = container.querySelector<HTMLButtonElement>('[aria-label="推薦星期三 D5 可以排入的課程"]');
    await act(async () => {
      slot?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const add = document.querySelector<HTMLButtonElement>(".slot-recommendation-actions button");
    await act(async () => {
      add?.click();
      await Promise.resolve();
    });
    expect(dbMocks.putRecord).toHaveBeenCalledWith("schedulePlans", expect.objectContaining({
      entries: expect.arrayContaining([expect.objectContaining({ courseId: "candidate", locked: false })]),
    }));
  });
});

describe("meeting formatting", () => {
  it("does not mislabel an unknown weekday as Monday", () => {
    expect(formatMeetings({ meetings: [{ weekday: null, sections: ["D3"], room: null, week_pattern: null }] })).toBe("星期未定 D3");
  });
});
