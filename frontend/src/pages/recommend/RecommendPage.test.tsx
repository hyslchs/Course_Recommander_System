import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecommendPage } from "./RecommendPage";
import { ProfileContext } from "@/hooks/localData";
import { SchedulePlanContext } from "@/hooks/useSchedulePlans";
import type { Profile, SchedulePlan } from "@/domain/types";

const apiMocks = vi.hoisted(() => ({
  embedQuery: vi.fn(),
  getCatalog: vi.fn(),
  getEmbeddingBundle: vi.fn(),
  preloadRecommendationAssets: vi.fn(),
  getFacets: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({ getAllRecords: vi.fn(), putRecord: vi.fn() }));
vi.mock("@/data/api", () => apiMocks);
vi.mock("@/data/db", () => dbMocks);

const profile: Profile = {
  id: "current", division: "日間部", department: "測試系", grade: 1, admissionYear: 115,
  interests: "", preferredWeekdays: [1, 2, 3], updatedAt: "now",
};
const plan: SchedulePlan = { id: "plan", name: "測試方案", entries: [], createdAt: "now", updatedAt: "now" };

/**
 * The one filter surface that stays on the page, drawer open or not.
 *
 * Two accessors on purpose: the role query proves the region is exposed, but an
 * open React Aria dialog `aria-hidden`s everything behind it — correct
 * behaviour — so the drawer tests have to reach the same node structurally to
 * assert that it has *not* moved yet.
 */
const appliedFilters = () => screen.getByRole("region", { name: "已套用的篩選條件" });
const appliedFiltersNode = () => document.querySelector(".applied-filters") as HTMLElement;

describe("recommend page filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getFacets.mockResolvedValue({ credits: [{ value: "2", label: "2" }, { value: "3", label: "3" }] });
    apiMocks.preloadRecommendationAssets.mockResolvedValue({
      catalog: [], courseIds: [], vectors: new Float32Array(), dimension: 1,
      searchIndex: { documents: new Map(), documentFrequency: new Map(), averageFieldLength: { title: 0, objective: 0, weekly_progress: 0, prerequisite: 0, materials: 0, skills: 0 }, documentCount: 0 },
      manifest: {},
    });
    dbMocks.getAllRecords.mockResolvedValue([]);
    dbMocks.putRecord.mockResolvedValue(undefined);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ProfileContext.Provider value={profile}>
          <SchedulePlanContext.Provider value={{ plans: [plan], activePlan: plan, selectPlan: async () => undefined }}>
            <RecommendPage />
          </SchedulePlanContext.Provider>
        </ProfileContext.Provider>
      </QueryClientProvider>,
    );
  });
  afterEach(() => cleanup());

  it("keeps the page's single h1 and drops the technical hero badge", () => {
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.querySelector(".hero")).toBeNull();
    expect(screen.queryByText("● Local-first")).not.toBeInTheDocument();
  });

  it("lists the two conditions a fresh page applies, as removable tags", () => {
    const region = within(appliedFilters());
    expect(region.getByText("已套用 2 項條件")).toBeInTheDocument();
    expect(region.getByText("星期一、二、三")).toBeInTheDocument();
    expect(region.getByText("課程類別：本系必修＋1")).toBeInTheDocument();
    // 避開衝堂 starts off, so its tag shouldn't show up yet.
    expect(region.queryByText("避開衝堂")).not.toBeInTheDocument();
  });

  it("opens the complete desktop filter dialog and applies its changes immediately", async () => {
    const user = userEvent.setup();
    const trigger = within(appliedFilters()).getByRole("button", { name: "完整篩選條件 · 已套用 2 項" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "完整篩選條件" });
    const fullFilters = within(dialog);
    expect(dialog.querySelector(".recommend-filter-modal-summary")).toHaveTextContent("2 項條件已即時套用");
    for (const group of ["時間與課表", "課程條件", "上課方式", "評量方式"]) {
      expect(fullFilters.getByRole("button", { name: new RegExp(group) })).toHaveAttribute("aria-expanded", "true");
    }
    expect(fullFilters.getByRole("button", { name: /進階條件/ })).toHaveAttribute("aria-expanded", "false");

    // Both quick-filter categories start on; avoiding conflicts starts off.
    expect(fullFilters.getByRole("button", { name: "本系必修", pressed: true })).toBeInTheDocument();
    expect(fullFilters.getByRole("button", { name: "本系選修", pressed: true })).toBeInTheDocument();
    expect(fullFilters.getByRole("button", { name: "通識課程", pressed: false })).toBeInTheDocument();
    expect(fullFilters.getByRole("button", { name: "外系課程", pressed: false })).toBeInTheDocument();
    expect(fullFilters.getByRole("button", { name: "允許衝堂", pressed: false })).toBeInTheDocument();

    await user.click(fullFilters.getByRole("button", { name: "允許衝堂", pressed: false }));
    expect(fullFilters.getByRole("button", { name: "避開衝堂", pressed: true })).toBeInTheDocument();
    expect(dialog.querySelector(".recommend-filter-modal-summary")).toHaveTextContent("3 項條件已即時套用");
    expect(within(appliedFiltersNode()).getByText("避開衝堂")).toBeInTheDocument();
    const quickConflict = document.querySelector(".quick-filter-panel .filter-conflict-toggle") as HTMLElement;
    expect(quickConflict).toHaveTextContent("避開衝堂");
    expect(quickConflict).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "完整篩選條件" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(within(appliedFilters()).getByText("已套用 3 項條件")).toBeInTheDocument();
  });

  it("opens the same complete filter dialog from the sidebar shortcut", async () => {
    const user = userEvent.setup();
    const sidebar = document.querySelector(".recommend-sidebar") as HTMLElement;
    const trigger = within(sidebar).getByRole("button", { name: "完整篩選條件 · 已套用 2 項" });

    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "完整篩選條件" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "完整篩選條件" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("reflects a quick-filter change in the complete filter immediately", async () => {
    const user = userEvent.setup();
    const sidebar = document.querySelector(".recommend-sidebar") as HTMLElement;
    await user.click(within(sidebar).getByRole("radio", { name: "日間 D 節" }));
    expect(within(sidebar).getByRole("button", { name: "完整篩選條件 · 已套用 3 項" })).toBeInTheDocument();
    await user.click(within(sidebar).getByRole("button", { name: "完整篩選條件 · 已套用 3 項" }));
    const dialog = within(await screen.findByRole("dialog", { name: "完整篩選條件" }));
    expect(dialog.getByRole("radio", { name: "日間 D 節" })).toBeChecked();
  });

  it("removes a condition from the tag itself, without opening anything", async () => {
    const user = userEvent.setup();
    const tag = within(appliedFilters()).getByText("課程類別：本系必修＋1").closest("[data-slot='tag']") as HTMLElement;
    await user.click(within(tag).getByRole("button"));
    await waitFor(() => expect(within(appliedFilters()).getByText("已套用 1 項條件")).toBeInTheDocument());
    expect(within(appliedFilters()).queryByText("課程類別：本系必修＋1")).not.toBeInTheDocument();
  });

  it("clears every condition from the always-visible 清除全部", async () => {
    const user = userEvent.setup();
    await user.click(within(appliedFilters()).getByRole("button", { name: "清除全部" }));
    await waitFor(() => expect(within(appliedFilters()).getByText("已套用 0 項條件")).toBeInTheDocument());
    expect(within(appliedFilters()).getByText("目前沒有其他篩選條件")).toBeInTheDocument();
  });
  it("applies mobile drawer changes immediately through the shared state", async () => {
    const user = userEvent.setup();
    const launcher = document.querySelector(".recommend-filter-launcher") as HTMLElement;
    await user.click(within(launcher).getByRole("button", { name: "篩選" }));
    const sheet = within(await screen.findByRole("dialog"));
    await user.click(sheet.getByRole("button", { name: "允許衝堂", pressed: false }));
    expect((await screen.findByRole("dialog")).querySelector(".recommend-filter-modal-summary")).toHaveTextContent(/3\s*項條件已即時套用/);
    expect(within(appliedFiltersNode()).getByText("已套用 3 項條件")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(appliedFilters()).getByText("避開衝堂")).toBeInTheDocument();
  });

  it("keeps only the four requested groups in the persistent quick filters", () => {
    const quick = within(document.querySelector(".quick-filter-panel") as HTMLElement);
    expect(quick.getByText("上課時間", { selector: "h3" })).toBeInTheDocument();
    expect(quick.getByText("課程類別", { selector: "h3" })).toBeInTheDocument();
    expect(quick.getByText("學分數", { selector: "h3" })).toBeInTheDocument();
    expect(quick.getByRole("button", { name: "允許衝堂", pressed: false })).toBeInTheDocument();
    expect(quick.getByRole("button", { name: "本系必修", pressed: true })).toBeInTheDocument();
    expect(quick.getByRole("button", { name: "本系選修", pressed: true })).toBeInTheDocument();
    expect(quick.getByRole("button", { name: "通識課程", pressed: false })).toBeInTheDocument();
    expect(quick.getByRole("button", { name: "外系課程", pressed: false })).toBeInTheDocument();
    for (const hidden of ["開課單位", "授課教師", "基本素養", "教學方法", "主要評量偏好"])
      expect(quick.queryByText(hidden)).not.toBeInTheDocument();
  });

  it("clears every shared condition from the drawer", async () => {
    const user = userEvent.setup();
    const launcher = document.querySelector(".recommend-filter-launcher") as HTMLElement;
    await user.click(within(launcher).getByRole("button", { name: "篩選" }));
    const sheet = within(await screen.findByRole("dialog"));
    await user.click(sheet.getByRole("button", { name: "清除全部" }));
    expect((await screen.findByRole("dialog")).querySelector(".recommend-filter-modal-summary")).toHaveTextContent(/0\s*項條件已即時套用/);
    expect(within(appliedFiltersNode()).getByText("已套用 0 項條件")).toBeInTheDocument();
  });

  it("removes eligibility filter controls from every filter surface", async () => {
    expect(screen.queryByText("課程程度")).not.toBeInTheDocument();
    expect(screen.queryByText("先修條件")).not.toBeInTheDocument();
    expect(screen.queryByText("修課資格")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(document.querySelector(".recommend-filter-launcher") as HTMLElement).getByRole("button", { name: "篩選" }));
    const sheet = within(await screen.findByRole("dialog"));
    expect(sheet.queryByText("課程程度")).not.toBeInTheDocument();
    expect(sheet.queryByText("先修條件")).not.toBeInTheDocument();
  });

  it("shows the pending filter count on the trigger badge", async () => {
    const user = userEvent.setup();
    const launcher = document.querySelector(".recommend-filter-launcher") as HTMLElement;
    expect(within(launcher).getByText("2")).toBeInTheDocument();
    await user.click(within(appliedFilters()).getByRole("button", { name: "清除全部" }));
    await waitFor(() => expect(within(launcher).queryByText("2")).not.toBeInTheDocument());
  });

  it("refuses to run with an empty topic and keeps the message next to the field", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "產生推薦" }));
    expect(await screen.findByText("請先輸入想學什麼，才能產生推薦。", { selector: ".alert__description" })).toBeInTheDocument();
    expect(apiMocks.getCatalog).not.toHaveBeenCalled();
  });

  it("names the topic field from its visible label", () => {
    expect(screen.getByRole("textbox", { name: "想學的主題或技能" })).toHaveAttribute("id", "subject-query");
  });

  it("keeps the filter sheet a labelled dialog", async () => {
    const user = userEvent.setup();
    await user.click(within(document.querySelector(".recommend-filter-launcher") as HTMLElement).getByRole("button", { name: "篩選" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAccessibleName("完整篩選條件"));
  });
});
