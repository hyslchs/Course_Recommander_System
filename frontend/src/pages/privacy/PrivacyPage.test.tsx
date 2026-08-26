import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrivacyPage } from "./PrivacyPage";
import { OPT_OUT_STORAGE_KEY, __resetAnalyticsForTests, isAnalyticsEnabled, track } from "@/analytics/client";

afterEach(() => {
  __resetAnalyticsForTests();
  vi.unstubAllGlobals();
});

describe("PrivacyPage", () => {
  it("keeps the route's single h1 and puts the section titles below it", () => {
    render(<PrivacyPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("資料蒐集說明");
    expect(screen.getByRole("heading", { level: 2, name: "我們不蒐集什麼" })).toBeInTheDocument();
  });

  /**
   * The disclosure is only worth anything if it is true, so the two claims most
   * likely to drift are asserted here: personal data stays local, and the app's
   * analytics does not collect IP — *without* claiming the infrastructure keeps
   * none, which would be a promise the deployment cannot keep.
   */
  it("states the local-first and no-IP claims without overpromising", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/只儲存在你這台裝置的瀏覽器/)).toBeInTheDocument();
    expect(screen.getByText(/本系統的使用統計不會蒐集 IP 位址/)).toBeInTheDocument();
    expect(screen.getByText(/仍可能保有他們自己的連線紀錄/)).toBeInTheDocument();
    expect(screen.getByText(/搜尋關鍵字原文：不儲存/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("完全不會留下任何 IP");
  });

  it("stops all collection when the student opts out, and resumes on opt-in", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 202 })));
    vi.stubGlobal("fetch", fetchMock);
    render(<PrivacyPage />);

    const toggle = screen.getByRole("checkbox", { name: /傳送匿名使用統計/ });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(window.localStorage.getItem(OPT_OUT_STORAGE_KEY)).toBe("1");
    expect(isAnalyticsEnabled()).toBe(false);
    track("page_view", { page: "privacy" });
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(toggle);
    expect(toggle).toBeChecked();
    // The flag is cleared, not set to "0": nothing analytics writes to
    // localStorage may outlive an opt-in.
    expect(window.localStorage.getItem(OPT_OUT_STORAGE_KEY)).toBeNull();
    expect(isAnalyticsEnabled()).toBe(true);
  });
});
