import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { I18nProvider } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorePage, pageNumbers } from "./ExplorePage";
import { sortCourseRows, type CourseRow } from "./CourseTable";
import { DESKTOP_QUERY } from "./useIsDesktop";
import { FeedbackProvider } from "@/components/ui";
import { LocalDataProvider } from "@/hooks/localData";
import { SchedulePlanProvider } from "@/hooks/useSchedulePlans";
import type { Course } from "@/domain/types";

const apiMocks = vi.hoisted(() => ({
  askCourseAssistant: vi.fn(),
  embedQuery: vi.fn(),
  getCatalog: vi.fn(),
  getClassGroups: vi.fn(),
  getCourses: vi.fn(),
  getCoursesByIds: vi.fn(),
  getDepartmentCatalog: vi.fn(),
  getEmbeddingBundle: vi.fn(),
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

function course(overrides: Partial<Course> = {}): Course {
  return {
    academic_year: 115,
    ava_no: "1",
    class_group: "A",
    course_id: "CS101",
    credits: 3,
    department: "資訊工程學系",
    division: "日間部",
    eligibility_base_status: "no_known_restriction",
    eligibility_rules: [],
    enrollment_note: "",
    grade: 2,
    meetings: [],
    name_en: "Introduction to Machine Learning",
    name_zh: "機器學習概論",
    prerequisite: "",
    raw_department: "資訊工程學系",
    required_elective_name: "選修",
    sections: { objective: "" },
    semester: 1,
    source_url: "https://example.test/CS101",
    teacher: "王老師",
    teacher_en: "Wang",
    ...overrides,
  };
}

const row = (overrides: Partial<Course>, status: CourseRow["status"] = "no_known_restriction"): CourseRow =>
  ({ course: course(overrides), status });

/**
 * `test/setup.ts` stubs `matchMedia` to report "no match" for everything, which
 * is the `<lg` (card) branch. Swapping in a stub that answers `true` for the one
 * query `useIsDesktop` asks is what drives the table branch — the same switch a
 * real 1024px viewport flips.
 */
function setViewport(desktop: boolean) {
  window.matchMedia = ((query: string) => ({
    addEventListener: () => {},
    addListener: () => {},
    dispatchEvent: () => false,
    matches: desktop && query === DESKTOP_QUERY,
    media: query,
    onchange: null,
    removeEventListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false, staleTime: Infinity } },
  });
  return render(
    <I18nProvider locale="zh-Hant-TW">
      <QueryClientProvider client={client}>
        <LocalDataProvider>
          <SchedulePlanProvider>
            <FeedbackProvider>
              <MemoryRouter><ExplorePage /></MemoryRouter>
            </FeedbackProvider>
          </SchedulePlanProvider>
        </LocalDataProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

/** One page of `total` results, so the pagination boundaries are exercisable. */
function respondWith(items: Course[], total = items.length) {
  apiMocks.getCourses.mockImplementation(async (params: URLSearchParams) => {
    const page = Number(params.get("page") ?? 1);
    return { items, page, total, total_pages: Math.max(1, Math.ceil(total / 25)) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setViewport(false);
  dbMocks.getAllRecords.mockResolvedValue([]);
  dbMocks.putRecord.mockResolvedValue(undefined);
  apiMocks.getFacets.mockResolvedValue({ departments: [] });
  apiMocks.getCatalog.mockResolvedValue([]);
  apiMocks.getCoursesByIds.mockResolvedValue([]);
  respondWith([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

/**
 * The core of T34: catalogue browsing is *comparison* on a wide screen and
 * *reading* on a phone, so the two layouts are different components, not one
 * component with a media query. Both branches are asserted from the same
 * fixture so a regression in either is visible.
 */
describe("ExplorePage — layout switches at lg", () => {
  it("renders cards, not a table, below lg", async () => {
    respondWith([course()]);
    renderPage();

    expect(await screen.findByRole("heading", { level: 2, name: "機器學習概論" })).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    // The card's own action, which the table deliberately does not carry.
    expect(screen.getByRole("button", { name: /加入/ })).toBeInTheDocument();
  });

  it("renders the sortable table, not cards, at lg and above", async () => {
    setViewport(true);
    respondWith([course()]);
    renderPage();

    const table = await screen.findByRole("grid", { name: "課程查詢結果" });
    // Every one of the seven comparison axes plan T34 names.
    for (const label of ["課號", "課名", "教師", "時間", "學分", "系所", "資格"]) {
      expect(within(table).getByRole("columnheader", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { level: 2, name: "機器學習概論" })).not.toBeInTheDocument();
  });

  it("gives the table an accessible name and keeps the route's single h1", async () => {
    setViewport(true);
    respondWith([course()]);
    renderPage();

    await screen.findByRole("grid", { name: "課程查詢結果" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("課程資料庫");
  });

  it("reserves table-shaped space while the first page loads, so nothing jumps", async () => {
    setViewport(true);
    apiMocks.getCourses.mockReturnValue(new Promise(() => {}));
    renderPage();

    const status = await screen.findByRole("status", { name: "正在載入課程" });
    // A table skeleton, not the card-grid one: same columns, same row box —
    // and `aria-hidden`, so eight rows of bones are not read out.
    const bones = status.querySelector("table");
    expect(bones).toHaveAttribute("aria-hidden", "true");
    expect(bones?.querySelectorAll("thead th")).toHaveLength(7);
    expect(bones?.querySelectorAll("tbody tr")).toHaveLength(8);
    // Not focusable, which is what makes hiding it from the a11y tree legitimate.
    expect(status.querySelectorAll("[tabindex]")).toHaveLength(0);
  });
});

describe("ExplorePage — sorting", () => {
  const rows = [
    row({ course_id: "b", name_zh: "乙課", credits: 1 }),
    row({ course_id: "a", name_zh: "甲課", credits: 3 }),
    row({ course_id: "c", name_zh: "丙課", credits: 2 }),
  ];

  it("sorts ascending then descending on the same column", () => {
    const ascending = sortCourseRows(rows, { column: "credits", direction: "ascending" });
    expect(ascending.map((item) => item.course.credits)).toEqual([1, 2, 3]);
    const descending = sortCourseRows(rows, { column: "credits", direction: "descending" });
    expect(descending.map((item) => item.course.credits)).toEqual([3, 2, 1]);
  });

  it("leaves the server order alone when nothing is sorted", () => {
    expect(sortCourseRows(rows, undefined)).toBe(rows);
  });

  /** "Not stated" is not "zero credits", so it must not lead an ascending sort. */
  it("sinks courses with no credits to the bottom of an ascending sort", () => {
    const withUnknown = [row({ course_id: "x", credits: null }), ...rows];
    expect(sortCourseRows(withUnknown, { column: "credits", direction: "ascending" })
      .map((item) => item.course.course_id)).toEqual(["b", "c", "a", "x"]);
  });

  it("orders 課號 numerically, not as text", () => {
    const numbered = [row({ course_id: "10", ava_no: "10" }), row({ course_id: "9", ava_no: "9" })];
    expect(sortCourseRows(numbered, { column: "ava_no", direction: "ascending" })
      .map((item) => item.course.ava_no)).toEqual(["9", "10"]);
  });

  it("orders 時間 by the earliest slot, with undated courses last", () => {
    const timed = [
      row({ course_id: "none", meetings: [] }),
      row({ course_id: "tue", meetings: [{ weekday: 2, sections: ["D1"], room: null, week_pattern: null }] }),
      row({ course_id: "mon-late", meetings: [{ weekday: 1, sections: ["D6"], room: null, week_pattern: null }] }),
      row({ course_id: "mon-early", meetings: [{ weekday: 1, sections: ["D2"], room: null, week_pattern: null }] }),
    ];
    expect(sortCourseRows(timed, { column: "meeting", direction: "ascending" })
      .map((item) => item.course.course_id)).toEqual(["mon-early", "mon-late", "tue", "none"]);
  });

  it("orders 資格 best-first, so one click surfaces what a student can take", () => {
    const graded = [
      row({ course_id: "blocked" }, "blocked_confirmed"),
      row({ course_id: "ok" }, "eligible_confirmed"),
      row({ course_id: "maybe" }, "needs_confirmation"),
    ];
    expect(sortCourseRows(graded, { column: "eligibility", direction: "ascending" })
      .map((item) => item.course.course_id)).toEqual(["ok", "maybe", "blocked"]);
  });

  it("reorders the rendered rows when a column header is activated", async () => {
    const user = userEvent.setup();
    setViewport(true);
    respondWith([
      course({ course_id: "b", name_zh: "乙課", credits: 1 }),
      course({ course_id: "a", name_zh: "甲課", credits: 3 }),
    ]);
    renderPage();

    const table = await screen.findByRole("grid", { name: "課程查詢結果" });
    const names = () => within(table).getAllByRole("rowheader").map((cell) => cell.textContent ?? "");
    expect(names()[0]).toContain("乙課");

    await user.click(within(table).getByRole("columnheader", { name: /學分/ }));
    await waitFor(() => expect(names()[0]).toContain("乙課"));
    await user.click(within(table).getByRole("columnheader", { name: /學分/ }));
    await waitFor(() => expect(names()[0]).toContain("甲課"));
  });

  it("says out loud that the sort only covers the page on screen", async () => {
    setViewport(true);
    respondWith([course()], 400);
    renderPage();

    await screen.findByRole("grid", { name: "課程查詢結果" });
    expect(screen.getByText(/排序套用於目前這一頁的 1 筆結果/)).toBeInTheDocument();
  });
});

describe("ExplorePage — pagination boundaries", () => {
  it("disables 上一頁 on the first page and 下一頁 on the last", async () => {
    const user = userEvent.setup();
    // 51 results at 25 per page = three pages.
    respondWith([course()], 51);
    renderPage();

    expect(await screen.findByRole("button", { name: "上一頁" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一頁" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "第 3 頁" }));
    // The page-3 request has to resolve before the boundary flips, and RTL's
    // 1s default is not enough for that once the whole suite runs in parallel.
    await waitFor(
      () => expect(screen.getByRole("button", { name: "下一頁" })).toBeDisabled(),
      { timeout: 4000 },
    );
    expect(screen.getByRole("button", { name: "上一頁" })).toBeEnabled();
  });

  it("summarises the window of results, not just the page number", async () => {
    respondWith([course()], 51);
    renderPage();
    expect(await screen.findByText("第 1–25 筆，共 51 筆")).toBeInTheDocument();
  });

  it("hides pagination when a filter returns nothing", async () => {
    respondWith([], 0);
    renderPage();
    expect(await screen.findByText("找不到符合條件的課程")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下一頁" })).not.toBeInTheDocument();
  });

  it("lists every page when there are few, and elides the middle when there are many", () => {
    expect(pageNumbers(1, 3)).toEqual([1, 2, 3]);
    expect(pageNumbers(1, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageNumbers(1, 20)).toEqual([1, 2, "ellipsis", 20]);
    expect(pageNumbers(10, 20)).toEqual([1, "ellipsis", 9, 10, 11, "ellipsis", 20]);
    expect(pageNumbers(20, 20)).toEqual([1, "ellipsis", 19, 20]);
  });
});

describe("ExplorePage — filters", () => {
  /**
   * The 300ms debounce predates this migration and has to survive it: 25 rows
   * per keystroke is the thing it exists to prevent.
   *
   * `fireEvent.change` rather than `user.type` because the assertion is about
   * the clock, and userEvent drives its own timers — under fake timers the two
   * deadlock, and under real timers a slow machine can spend 300ms typing two
   * characters and fire the request the test is asserting has not fired.
   */
  it("waits 300ms after the last keystroke before querying", async () => {
    vi.useFakeTimers();
    try {
      respondWith([course()]);
      renderPage();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      const input = screen.getByRole("searchbox", { name: "搜尋課程" });
      await act(async () => { fireEvent.change(input, { target: { value: "機器" } }); });

      await act(async () => { await vi.advanceTimersByTimeAsync(299); });
      expect(apiMocks.getCourses.mock.calls.every(([params]) => !params.get("q"))).toBe(true);

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(apiMocks.getCourses.mock.calls.some(([params]) => params.get("q") === "機器")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The department list is the whole university, so the picker is a ComboBox and
   * its filter is `filterDepartmentOptions` — the same domain helper onboarding
   * uses. 「資訊」 must therefore match both the code-prefixed label and the name.
   */
  it("filters the department list with the shared domain matcher", async () => {
    const user = userEvent.setup();
    apiMocks.getFacets.mockResolvedValue({
      departments: [
        { value: "D:52:department", label: "52-資訊工程學系", code: "52", name_zh: "資訊工程學系", department_type: "department" },
        { value: "D:70:department", label: "70-護理學系", code: "70", name_zh: "護理學系", department_type: "department" },
      ],
    });
    respondWith([course()]);
    renderPage();
    // Wait for the facets to land: an empty ComboBox is a different widget from
    // a populated one, and the point of the test is the populated one.
    await screen.findByRole("heading", { level: 2, name: "機器學習概論" });

    const field = screen.getByRole("combobox", { name: "開課系所" });
    await user.click(field);
    /*
      A regex, not an exact string, and onboarding's test does the same for the
      same reason: React Aria points the popover listbox's `aria-labelledby` at
      both the field label AND the element wrapping the options, so its computed
      accessible name is 「52-資訊工程學系70-護理學系 開課系所」. Pre-existing
      HeroUI behaviour, not something this page introduces — pinned here so a
      future exact-match assertion is not written by mistake.
    */
    const list = await screen.findByRole("listbox", { name: /開課系所/ });
    expect(within(list).getAllByRole("option")).toHaveLength(2);

    await user.type(field, "資訊");
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(1));
    expect(within(list).getByRole("option")).toHaveTextContent("52-資訊工程學系");

    await user.click(within(list).getByRole("option"));
    await waitFor(() => expect(
      apiMocks.getCourses.mock.calls.some(([params]) => params.get("department") === "D:52:department"),
    ).toBe(true));
  });

  it("sends the chosen weekday and returns to page 1", async () => {
    const user = userEvent.setup();
    respondWith([course()], 51);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "第 2 頁" }));
    await waitFor(() => expect(
      apiMocks.getCourses.mock.calls.some(([params]) => params.get("page") === "2"),
    ).toBe(true));

    await user.click(screen.getByRole("button", { name: /上課星期/ }));
    await user.click(await screen.findByRole("option", { name: "星期三" }));

    await waitFor(() => expect(apiMocks.getCourses.mock.calls.some(
      ([params]) => params.get("weekday") === "3" && params.get("page") === "1",
    )).toBe(true));
  });
});
