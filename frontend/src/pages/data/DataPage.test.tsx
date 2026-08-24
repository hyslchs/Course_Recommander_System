import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@/data/db", () => dbMocks);
vi.mock("@/data/queries", () => ({ useLookupCourses: () => ({ mutateAsync: vi.fn() }) }));

/** `navigator.storage` is absent in jsdom; the meter only renders once it answers. */
function stubStorageEstimate(usage: number, quota: number) {
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { estimate: async () => ({ quota, usage }) },
  });
}

function mount() {
  return render(<FeedbackProvider><DataPage /></FeedbackProvider>);
}

describe("DataPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.clearPersonalData.mockResolvedValue(undefined);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "storage");
  });

  it("reports storage headroom on a Meter and keeps it out of the warning state under the threshold", async () => {
    stubStorageEstimate(200 * 1024 * 1024, 1024 * 1024 * 1024); // 19.5%
    mount();
    const meter = await screen.findByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "19.53125");
    expect(meter.className).toContain("meter--accent");
    expect(meter.className).not.toContain("meter--warning");
    expect(screen.queryByText("儲存空間快滿了")).not.toBeInTheDocument();
  });

  it("flips the Meter to warning above 80% and says so in words, not only in colour", async () => {
    stubStorageEstimate(880 * 1024 * 1024, 1024 * 1024 * 1024); // 85.9%
    mount();
    const meter = await screen.findByRole("meter");
    expect(meter.className).toContain("meter--warning");
    // Colour is never the only channel (plan §4.3): a worded notice comes with it.
    expect(await screen.findByText("儲存空間快滿了")).toBeInTheDocument();
    expect(within(meter).getByText("880 MB / 1 GB")).toBeInTheDocument();
  });

  it("hides the Meter entirely where the browser reports no estimate", async () => {
    mount();
    await screen.findByRole("button", { name: "清除所有個人資料" });
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
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
      .toEqual(["批次加入已修課程", "本機資料摘要", "已修課程", "尚未加入已修課程"]);
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
  });

  it("describes the counts as a definition list rather than loose spans", async () => {
    mount();
    await screen.findByRole("button", { name: "清除所有個人資料" });
    const terms = document.querySelectorAll("dl.data-stats dt");
    expect([...terms].map((node) => node.textContent)).toEqual(["已修課程", "收藏", "課表方案"]);
    expect(document.querySelectorAll("dl.data-stats dd")).toHaveLength(3);
  });
});
