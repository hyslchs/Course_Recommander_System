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

  it("keeps the page's single h1 and drops the green hero", () => {
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.querySelector(".hero")).toBeNull();
    expect(screen.getByText("● Local-first")).toBeInTheDocument();
  });

  it("lists the three conditions a fresh page applies, as removable tags", () => {
    const region = within(appliedFilters());
    expect(region.getByText("已套用 3 項條件")).toBeInTheDocument();
    expect(region.getByText("星期一、二、三")).toBeInTheDocument();
    expect(region.getByText("排除未滿足先修")).toBeInTheDocument();
    expect(region.getByText("檢查衝堂")).toBeInTheDocument();
  });

  it("removes a condition from the tag itself, without opening anything", async () => {
    const user = userEvent.setup();
    const tag = within(appliedFilters()).getByText("檢查衝堂").closest("[data-slot='tag']") as HTMLElement;
    await user.click(within(tag).getByRole("button"));
    await waitFor(() => expect(within(appliedFilters()).getByText("已套用 2 項條件")).toBeInTheDocument());
    expect(within(appliedFilters()).queryByText("檢查衝堂")).not.toBeInTheDocument();
  });

  it("clears every condition from the always-visible 清除全部", async () => {
    const user = userEvent.setup();
    await user.click(within(appliedFilters()).getByRole("button", { name: "清除全部" }));
    await waitFor(() => expect(within(appliedFilters()).getByText("已套用 0 項條件")).toBeInTheDocument());
    expect(within(appliedFilters()).getByText("目前沒有額外的硬條件")).toBeInTheDocument();
  });

  it("holds drawer edits back until the sheet closes", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /篩選/ }));
    const sheet = within(await screen.findByRole("dialog"));

    await user.click(sheet.getByRole("switch", { name: "納入完整課表檢查衝堂" }));
    // The draft moved; the page has not.
    expect(sheet.getByRole("button", { name: "套用 2 項" })).toBeInTheDocument();
    expect(within(appliedFiltersNode()).getByText("已套用 3 項條件")).toBeInTheDocument();
    expect(within(appliedFiltersNode()).getByText("檢查衝堂")).toBeInTheDocument();

    await user.click(sheet.getByRole("button", { name: "套用 2 項" }));
    await waitFor(() => expect(within(appliedFilters()).getByText("已套用 2 項條件")).toBeInTheDocument());
    expect(within(appliedFilters()).queryByText("檢查衝堂")).not.toBeInTheDocument();
  });

  it("commits the draft when the sheet is dismissed with Escape, not discards it", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /篩選/ }));
    const sheet = within(await screen.findByRole("dialog"));
    await user.click(sheet.getByRole("switch", { name: "暫時忽略星期限制" }));
    expect(within(appliedFiltersNode()).getByText("星期一、二、三")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(appliedFilters()).queryByText("星期一、二、三")).not.toBeInTheDocument();
    expect(within(appliedFilters()).getByText("已套用 2 項條件")).toBeInTheDocument();
  });

  it("flattens the nested 進階設定 to one disclosure per group inside the sheet", async () => {
    const user = userEvent.setup();
    // Desktop sidebar: one 進階設定 per control that owns advanced options, and
    // only 先修條件 has one while 課程程度 is still 不限程度.
    await user.click(screen.getByRole("button", { name: /修課資格/ }));
    expect(screen.getAllByRole("button", { name: /進階設定/ })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /篩選/ }));
    const sheet = within(await screen.findByRole("dialog"));
    await user.click(sheet.getByRole("button", { name: /修課資格/ }));
    // Sheet: exactly one, at the bottom of the group — never nested (plan §5.2-6).
    expect(sheet.getAllByRole("button", { name: /進階設定/ })).toHaveLength(1);
  });

  it("shows the pending filter count on the trigger badge", async () => {
    const user = userEvent.setup();
    const launcher = document.querySelector(".recommend-filter-launcher") as HTMLElement;
    expect(within(launcher).getByText("3")).toBeInTheDocument();
    await user.click(within(appliedFilters()).getByRole("button", { name: "清除全部" }));
    await waitFor(() => expect(within(launcher).queryByText("3")).not.toBeInTheDocument());
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
    await user.click(screen.getByRole("button", { name: /篩選/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAccessibleName("硬條件篩選"));
  });
});
