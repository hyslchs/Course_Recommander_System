import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleWorkspace } from "./ScheduleWorkspace";
import { ProfileContext } from "@/hooks/localData";
import { SchedulePlanContext } from "@/hooks/useSchedulePlans";
import type { Course, Meeting, Profile, SchedulePlan } from "@/domain/types";

const apiMocks = vi.hoisted(() => ({ getCatalog: vi.fn(), getCourses: vi.fn(), getEmbeddingBundle: vi.fn() }));
const dbMocks = vi.hoisted(() => ({ getAllRecords: vi.fn(), putRecord: vi.fn() }));
vi.mock("@/data/api", () => apiMocks);
vi.mock("@/data/db", () => dbMocks);

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

/** Accessible name of a `.class-block` button: `課名，星期X 節次…`. Slot buttons never contain the comma. */
const classBlockName = /，星期/;

describe("schedule workspace", () => {
  const catalog = [
    course("day", "日間課程", [{ weekday: 1, sections: ["D2", "D3"], room: "A101", week_pattern: "A" }]),
    course("night", "週末夜間課程", [{ weekday: 6, sections: ["E1", "E2"], room: "B202", week_pattern: "S" }]),
    course("candidate", "資料分析實務", [{ weekday: 3, sections: ["D5", "D6"], room: "C303", week_pattern: "A" }]),
  ];
  const plan: SchedulePlan = { id: "plan", name: "測試方案", entries: [{ courseId: "day", locked: false }, { courseId: "night", locked: false }], createdAt: "now", updatedAt: "now" };
  const profile: Profile = { id: "current", division: "日間部", department: "測試系", grade: 1, admissionYear: 115, interests: "", preferredWeekdays: [1, 2, 3, 4, 5], updatedAt: "now" };

  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getCatalog.mockResolvedValue(catalog);
    apiMocks.getCourses.mockResolvedValue({ items: [], total: 0, page: 1, total_pages: 1 });
    apiMocks.getEmbeddingBundle.mockResolvedValue({
      index: { course_ids: catalog.map((item) => item.course_id), dimension: 2 },
      vectors: new Float32Array([1, 0, 0, 1, 0.95, 0.05]),
    });
    dbMocks.getAllRecords.mockResolvedValue([]);
    dbMocks.putRecord.mockResolvedValue(undefined);
    // T21 moved plans and profile onto context, so those two are supplied as static
    // values here. Everything else is still deliberately absent — no FeedbackProvider,
    // no router, no app shell: the workspace must stay usable standalone.
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ProfileContext.Provider value={profile}>
          <SchedulePlanContext.Provider value={{ plans: [plan], activePlan: plan, selectPlan: async () => undefined }}>
            <ScheduleWorkspace catalog={catalog} />
          </SchedulePlanContext.Provider>
        </ProfileContext.Provider>
      </QueryClientProvider>,
    );
  });

  // `globals: true` lets testing-library register its own auto-cleanup, so this is redundant —
  // kept deliberately (cleanup is idempotent) so the suite does not silently leak DOM between
  // tests if that vitest.config.ts flag is ever dropped.
  afterEach(() => cleanup());

  const openSlotRecommendations = async (user: ReturnType<typeof userEvent.setup>, name: string, dialogName: string) => {
    await user.click(screen.getByRole("button", { name }));
    return screen.findByRole("dialog", { name: dialogName });
  };

  it("auto-expands weekend and evening periods when they contain a course", () => {
    const grid = within(screen.getByRole("grid"));
    expect(grid.getByRole("columnheader", { name: "星期六" })).toBeInTheDocument();
    expect(grid.getByRole("rowheader", { name: "E1" })).toBeInTheDocument();
    expect(grid.getAllByRole("button", { name: classBlockName })).toHaveLength(2);
    expect(grid.getByRole("button", { name: /^日間課程，/ })).toBeInTheDocument();
    expect(grid.getByRole("button", { name: /^週末夜間課程，/ })).toBeInTheDocument();
  });

  it("opens an accessible detail drawer with the official outline link", async () => {
    const user = userEvent.setup();
    const block = within(screen.getByRole("grid")).getByRole("button", { name: /^日間課程，/ });
    await user.click(block);
    const dialog = within(await screen.findByRole("dialog", { name: "日間課程" }));
    expect(dialog.getByText("測試課程目標")).toBeInTheDocument();
    expect(dialog.getByRole("link", { name: "開啟官方完整課綱" })).toHaveAttribute("href", "https://example.test/course/day");
    await user.click(dialog.getByRole("button", { name: "關閉對話框" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(block).toHaveFocus());
  });

  it("warns when compact mode hides occupied uncommon periods", async () => {
    const user = userEvent.setup();
    // T35: the view-range control is a HeroUI `ToggleButtonGroup` with
    // `selectionMode="single"`, which React Aria exposes as radiogroup/radio +
    // `aria-checked` rather than the hand-rolled group + `aria-pressed` it
    // replaced. That is the APG pattern for a mutually exclusive segmented
    // control, so the query moves with it rather than the markup moving back.
    const viewRange = within(screen.getByRole("radiogroup", { name: "課表顯示範圍" }));
    await user.click(viewRange.getByRole("radio", { name: /^核心時段/ }));
    expect(screen.getByRole("button", { name: "顯示有課時段" })).toBeInTheDocument();
    // Was `getByText(/1 門課/)` because the notice carried no role at all (T01
    // handoff 2). It is a `StateAlert` with `role="status"` now, so compact mode
    // no longer hides courses silently from a screen reader.
    expect(within(screen.getByRole("status")).getByText(/1 門課/)).toBeInTheDocument();
    expect(within(screen.getByRole("grid")).queryByRole("columnheader", { name: "星期六" })).not.toBeInTheDocument();
  });

  it("opens timetable-based recommendations from an empty keyboard-accessible slot", async () => {
    const user = userEvent.setup();
    expect(screen.queryByRole("button", { name: "推薦星期一 D2 可以排入的課程" })).not.toBeInTheDocument();
    const slot = screen.getByRole("button", { name: "推薦星期三 D5 可以排入的課程" });
    expect(slot.tabIndex).toBeGreaterThanOrEqual(-1);

    await user.click(slot);
    const dialog = within(await screen.findByRole("dialog", { name: "星期三 D5 的課程推薦" }));
    expect(dialog.getByText(/只推薦完整上課時間能排入課表的課程/)).toBeInTheDocument();

    const recommendation = within(await dialog.findByRole("article"));
    expect(recommendation.getByRole("heading", { name: "資料分析實務" })).toBeInTheDocument();
    expect(recommendation.getByText("本系選修")).toBeInTheDocument();
    expect(recommendation.getByText(/完整上課時間不與目前課表衝堂/)).toBeInTheDocument();

    const filters = within(dialog.getByRole("group", { name: "顯示哪些課程" }));
    expect(filters.getAllByRole("button", { pressed: true })).toHaveLength(4);
    await user.click(filters.getByRole("button", { name: "本系選修", pressed: true }));
    expect(filters.getAllByRole("button", { pressed: true })).toHaveLength(3);
    expect(filters.getAllByRole("button", { pressed: false })).toHaveLength(1);
    expect(dialog.queryByRole("heading", { name: "資料分析實務" })).not.toBeInTheDocument();

    await user.click(filters.getByRole("button", { name: "本系選修", pressed: false }));
    expect(dialog.getByRole("heading", { name: "資料分析實務" })).toBeInTheDocument();
  });

  it("adds a recommended course to the active plan", async () => {
    const user = userEvent.setup();
    const dialog = within(await openSlotRecommendations(user, "推薦星期三 D5 可以排入的課程", "星期三 D5 的課程推薦"));
    const recommendation = within(await dialog.findByRole("article"));
    await user.click(recommendation.getByRole("button", { name: "加入課表" }));
    await waitFor(() => expect(dbMocks.putRecord).toHaveBeenCalledWith("schedulePlans", expect.objectContaining({
      entries: expect.arrayContaining([expect.objectContaining({ courseId: "candidate", locked: false })]),
    })));
  });
});
