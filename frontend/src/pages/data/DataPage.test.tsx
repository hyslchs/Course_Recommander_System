import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataPage } from "./DataPage";
import { FeedbackProvider } from "@/components/ui";

const dbMocks = vi.hoisted(() => ({
  clearPersonalData: vi.fn(),
  createBackup: vi.fn(),
  deleteRecord: vi.fn(),
  getAllRecords: vi.fn(),
  getRecord: vi.fn(),
  importBackup: vi.fn(),
  putRecord: vi.fn(),
  putRecords: vi.fn(),
  validateBackup: vi.fn(),
}));
const localDataMocks = vi.hoisted(() => ({ completedCourses: [] as unknown[], favorites: [] as unknown[], dismissedCourses: [] as unknown[] }));
const queryMocks = vi.hoisted(() => ({ courses: [] as unknown[] }));
vi.mock("@/data/db", () => dbMocks);
vi.mock("@/hooks/localData", () => ({
  useLocalDataState: () => ({ writable: true }),
  useLocalRecords: (store: "completedCourses" | "favorites" | "dismissedCourses") => localDataMocks[store],
}));
vi.mock("@/data/queries", () => ({
  useCoursesByIds: () => ({ data: queryMocks.courses, error: null, isPending: false }),
  useLookupCourses: () => ({ mutateAsync: vi.fn() }),
}));

function mount() {
  return render(<FeedbackProvider><DataPage /></FeedbackProvider>);
}

describe("DataPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localDataMocks.completedCourses = [];
    localDataMocks.favorites = [];
    localDataMocks.dismissedCourses = [];
    queryMocks.courses = [];
    dbMocks.clearPersonalData.mockResolvedValue(undefined);
    dbMocks.deleteRecord.mockResolvedValue(undefined);
  });
  /**
   * The one irreversible control on the page. `ConfirmDialog` is HeroUI's
   * `AlertDialog`, so this pins the three behaviours the plain button never had:
   * a contained Tab cycle, Escape to cancel, and focus back on the opener.
   */
  it("guards the destructive clear behind a focus-trapping alertdialog", async () => {
    const user = userEvent.setup();
    mount();
    const trigger = await screen.findByRole("button", { name: "清除所有個人資料" });
    await user.click(trigger);

    const dialog = await screen.findByRole("alertdialog");
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    const confirm = within(dialog).getByRole("button", { name: "清除所有資料" });

    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    // Contained: Tab past the last control wraps back inside instead of escaping.
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(dbMocks.clearPersonalData).not.toHaveBeenCalled();
    // React Aria restores on the next animation frame rather than synchronously.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("clears only after the confirm button, and announces the result", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "清除所有個人資料" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "清除所有資料" }));
    await waitFor(() => expect(dbMocks.clearPersonalData).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status")).toHaveTextContent("這台裝置上的個人資料已清除");
  });

  it("keeps the route's single h1 and puts the card titles below it", async () => {
    mount();
    await screen.findByRole("button", { name: "清除所有個人資料" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("資料管理");
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent))
      .toEqual(["批次加入已修課程", "備份與清除", "收藏課程", "尚未收藏課程", "不感興趣的課程", "沒有不感興趣的課程", "已修課程", "尚未加入已修課程"]);
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
  });


  it("removes the local summary while keeping data actions and the favorites section", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "收藏課程" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "尚未收藏課程" })).toBeInTheDocument();
    expect(screen.queryByText("本機資料摘要")).not.toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "匯出備份檔案" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "匯入備份檔案" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除所有個人資料" })).toBeInTheDocument();
  });
  it("shows the batch-import note directly, without an info button", async () => {
    mount();
    expect(await screen.findByText("本系統僅包含 115-1 學年度之課程大綱資料，若您已修的課程未於 115-1 學年度開設，可能顯示查無此課程。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看批次加入說明" })).not.toBeInTheDocument();
  });
  it("shows favorited course details and lets the user cancel the favorite", async () => {
    const user = userEvent.setup();
    localDataMocks.favorites = [{ id: "CS101", addedAt: "2026-08-26T00:00:00.000Z" }];
    queryMocks.courses = [{
      course_id: "CS101",
      name_zh: "機器學習概論",
      department: "資訊工程學系",
      department_display: "資訊工程學系",
      teacher: "王老師",
      credits: 3,
      source_url: "https://example.edu/course/CS101",
    }];

    mount();
    expect(screen.getByText("機器學習概論")).toBeInTheDocument();
    expect(screen.getByText("資訊工程學系 · 王老師 · 3 學分")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看官方課綱" })).toHaveAttribute("href", "https://example.edu/course/CS101");
    await user.click(screen.getByRole("button", { name: "取消收藏" }));
    await waitFor(() => expect(dbMocks.deleteRecord).toHaveBeenCalledWith("favorites", "CS101"));
    expect(await screen.findByText("已取消收藏「機器學習概論」")).toBeInTheDocument();
  });
  it("shows dismissed course details and lets the user restore recommendations", async () => {
    const user = userEvent.setup();
    localDataMocks.dismissedCourses = [{ id: "CS202", addedAt: "2026-08-26T00:00:00.000Z" }];
    queryMocks.courses = [{
      course_id: "CS202",
      name_zh: "編譯器設計",
      department: "資訊工程學系",
      department_display: "資訊工程學系",
      teacher: "李老師",
      credits: 3,
      source_url: "https://example.edu/course/CS202",
    }];

    mount();
    expect(screen.getByRole("heading", { name: "不感興趣的課程" })).toBeInTheDocument();
    expect(screen.getByText("編譯器設計")).toBeInTheDocument();
    expect(screen.getByText("資訊工程學系 · 李老師 · 3 學分")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "恢復推薦" }));
    await waitFor(() => expect(dbMocks.deleteRecord).toHaveBeenCalledWith("dismissedCourses", "CS202"));
    expect(await screen.findByText("已恢復推薦「編譯器設計」")).toBeInTheDocument();
  });
});
