import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AssistantPage } from "./AssistantPage";
import { ProfileContext } from "@/hooks/localData";
import type { Profile } from "@/domain/types";

vi.mock("@/data/db", () => ({ putRecord: vi.fn() }));
vi.mock("@/data/queries", () => ({
  useAskCourseAssistant: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useFeatures: () => ({ data: { ai_assistant_enabled: true, ai_max_question_chars: 500 }, isError: false, isPending: false }),
}));

const profile: Profile = {
  admissionYear: 115, department: "測試系", division: "日間部", grade: 1,
  id: "current", interests: "", preferredWeekdays: [1], updatedAt: "now",
};

function mount(withProfile: boolean) {
  return render(
    <MemoryRouter>
      <ProfileContext.Provider value={withProfile ? profile : undefined}>
        <AssistantPage />
      </ProfileContext.Provider>
    </MemoryRouter>,
  );
}

/**
 * The route stays behind `AI_ASSISTANT_VISIBLE === false`, so `/assistant`
 * redirects and the page is unreachable in a browser. These are the minimum
 * guards that the T36 control migration still mounts and keeps its heading
 * contract; the page is deliberately not developed further.
 */
describe("AssistantPage (hidden route)", () => {
  it("still asks for onboarding before anything else", () => {
    mount(false);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("先完成個人設定");
  });

  it("renders the consent gate on HeroUI primitives with one h1", () => {
    const { container } = mount(true);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("跟課程資料聊聊");
    // Card.Title is an h3 by default; the consent card is explicitly demoted.
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("使用前先確認資料範圍");
    expect(container.querySelector('[data-page="assistant"] [data-slot="card"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同意並開始使用" }).className).toContain("button");
  });
});
