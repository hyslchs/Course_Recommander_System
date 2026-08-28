import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { FeedbackProvider } from "@/components/ui";
import type { Profile, SchedulePlan } from "@/domain/types";

const apiMocks = vi.hoisted(() => ({
  askCourseAssistant: vi.fn(),
  embedQuery: vi.fn(),
  getCatalog: vi.fn(),
  getClassGroups: vi.fn(),
  getCourses: vi.fn(),
  getCoursesByIds: vi.fn(),
  getDepartmentCatalog: vi.fn(),
  getEmbeddingBundle: vi.fn(),
  preloadRecommendationAssets: vi.fn(),
  getFacets: vi.fn(),
  getFeatures: vi.fn(),
  lookupCourses: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
  clearPersonalData: vi.fn(),
  createBackup: vi.fn(),
  deleteRecord: vi.fn(),
  getAllRecords: vi.fn(),
  getRecord: vi.fn(),
  importBackup: vi.fn(),
  putRecord: vi.fn(),
  validateBackup: vi.fn(),
}));
vi.mock("@/data/api", () => apiMocks);
vi.mock("@/data/db", () => dbMocks);

// jsdom implements no layout, so it ships no `scrollIntoView`. RouteFocusManager calls it.
Element.prototype.scrollIntoView = vi.fn();

const profile: Profile = {
  id: "current", division: "日間部", department: "測試系", grade: 1, admissionYear: 115,
  interests: "", preferredWeekdays: [1, 2, 3, 4, 5], updatedAt: "now",
};
const plan: SchedulePlan = { id: "plan", name: "測試方案", entries: [], createdAt: "now", updatedAt: "now" };

function mountRoute(path: string) {
  render(<FeedbackProvider><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></FeedbackProvider>);
}

const headings = () => Array.from(document.querySelectorAll<HTMLElement>("#main-content h1"));

/**
 * `RouteFocusManager` promises "exactly one `<h1>` inside `#main-content` per
 * route" and focuses it after every navigation. Plan R9: that contract used to
 * be broken on /schedule, where the page heading and the "no plan yet" empty
 * state both rendered an `<h1>`.
 */
describe("route heading contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getAllRecords.mockImplementation(async (store: string) => (store === "profile" ? [profile] : []));
    dbMocks.putRecord.mockResolvedValue(undefined);
    apiMocks.getFacets.mockResolvedValue({});
    apiMocks.getCourses.mockResolvedValue({ items: [], total: 0, page: 1, total_pages: 1 });
    apiMocks.getCoursesByIds.mockResolvedValue([]);
    apiMocks.getDepartmentCatalog.mockResolvedValue({ divisions: [], departments: [] });
    apiMocks.getClassGroups.mockResolvedValue([]);
    apiMocks.getCatalog.mockResolvedValue([]);
    apiMocks.preloadRecommendationAssets.mockResolvedValue({
      catalog: [], courseIds: [], vectors: new Float32Array(), dimension: 1,
      searchIndex: { documents: new Map(), documentFrequency: new Map(), averageFieldLength: { title: 0, objective: 0, weekly_progress: 0, prerequisite: 0, materials: 0, skills: 0 }, documentCount: 0 },
      manifest: {},
    });
  });
  afterEach(() => cleanup());

  it.each([
    ["/onboarding", "先設定你的基本資料"],
    ["/recommend", "找到真正適合你的下一門課"],
    ["/explore", "探索課程"],
    ["/schedule", "我的課表"],
    ["/data", "資料管理"],
    ["/no-such-page", "找不到這個頁面"],
  ])("renders exactly one h1 on %s", async (path, expected) => {
    mountRoute(path);
    await waitFor(() => expect(headings()).toHaveLength(1), { timeout: 3_000 });
    expect(headings()[0]).toHaveTextContent(expected);
  });

  it("blocks profile routing when the initial local-data read fails", async () => {
    dbMocks.getAllRecords.mockRejectedValue(new Error("IndexedDB blocked"));
    mountRoute("/");

    expect(await screen.findByRole("heading", { name: "無法讀取這台裝置上的資料" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "先設定你的基本資料" })).not.toBeInTheDocument();
    expect(screen.getByText("尚未確認資料是否存在")).toBeInTheDocument();
  });

  it("keeps a single h1 on /schedule once a plan exists", async () => {
    dbMocks.getAllRecords.mockImplementation(async (store: string) => {
      if (store === "profile") return [profile];
      if (store === "schedulePlans") return [plan];
      return [];
    });
    mountRoute("/schedule");
    await waitFor(() => expect(headings()).toHaveLength(1));
    expect(headings()[0]).toHaveTextContent("我的課表");
  });

  it("moves focus to the route heading after a lazy route resolves", async () => {
    mountRoute("/explore");
    await waitFor(() => expect(headings()).toHaveLength(1));
    await waitFor(() => expect(headings()[0]).toHaveFocus());
  });

  // /schedule renders its heading, drops it for a loading panel while it fetches
  // the plan's courses, then renders it again. Focus has to end up on the final one.
  it("re-takes focus when /schedule swaps its heading around the loading panel", async () => {
    // Every call gets its resolver kept, and `releaseCourses` settles all of them.
    // A single `releaseCourses` variable overwritten per call made this test flaky
    // (~1 run in 5 of the full suite): when the query fired more than once, only
    // the last promise was resolved and whichever one the page actually awaited
    // stayed pending, so it never left the loading panel.
    // The latch also covers a call that arrives *after* the release, which a
    // refetch can do — otherwise that fresh promise would hang instead.
    const pendingCourses: Array<() => void> = [];
    let released = false;
    const releaseCourses = () => {
      released = true;
      for (const resolve of pendingCourses.splice(0)) resolve();
    };
    dbMocks.getAllRecords.mockImplementation(async (store: string) => {
      if (store === "profile") return [profile];
      if (store === "schedulePlans") return [{ ...plan, entries: [{ courseId: "day", locked: false }] }];
      return [];
    });
    apiMocks.getCoursesByIds.mockImplementation(() => new Promise((resolve) => {
      if (released) resolve([]);
      else pendingCourses.push(() => resolve([]));
    }));

    mountRoute("/schedule");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在載入課表"));
    expect(headings()).toHaveLength(0);
    releaseCourses();
    await waitFor(() => expect(headings()).toHaveLength(1));
    await waitFor(() => expect(headings()[0]).toHaveFocus());
  });
});
