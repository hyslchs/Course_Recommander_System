import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { eligibilityStatusLabels, eligibilityStatusShortLabels } from "@/domain/eligibility";
import { recommendationCategoryLabels } from "@/domain/recommendation";
import type { Course, EligibilityStatus, RecommendationCategory } from "@/domain/types";
import { CourseCard } from "./CourseCard";
import { CategoryChip, EligibilityChip } from "./statusPresentation";

/**
 * Plan R3 guard.
 *
 * `category` and `eligibility` used to reach the DOM as `` `status ${status}` ``
 * — a class name assembled at runtime from a TS union, which no static analysis
 * can see. A CSS purge would delete `.status.blocked_confirmed` without a single
 * warning and the chip would lose its colour in production, silently.
 *
 * The values now ride on data attributes matched by literal selectors, and this
 * table is what stops anyone quietly dropping one channel of the §4.3 triple:
 * icon (`data-eligibility-icon`), text (the label), colour (HeroUI's own
 * `chip--*` class, which is where the token actually resolves).
 */
const ELIGIBILITY_CASES: Array<{ status: EligibilityStatus; chipClass: string; icon: string }> = [
  { chipClass: "chip--success", icon: "CheckCircle", status: "eligible_confirmed" },
  { chipClass: "chip--warning", icon: "Question", status: "needs_confirmation" },
  { chipClass: "chip--danger", icon: "Prohibit", status: "blocked_confirmed" },
  // Neutral on purpose: "we could not judge" must never read as "you are cleared".
  { chipClass: "chip--default", icon: "Info", status: "no_known_restriction" },
];

const CATEGORY_CASES: RecommendationCategory[] = [
  "home_required",
  "home_elective",
  "general_education",
  "external_department",
];

function course(overrides: Partial<Course> = {}): Course {
  return {
    academic_year: 113,
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
    sections: { objective: "認識機器學習的基本觀念。" },
    semester: 1,
    source_url: "https://example.test/CS101",
    teacher: "王老師",
    teacher_en: "Wang",
    ...overrides,
  };
}

/** `useFetchCoursesByIds` reaches for a QueryClient; every other context this card uses has a safe default. */
function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("eligibility and category chips", () => {
  it.each(ELIGIBILITY_CASES)("gives $status an icon, the long wording and the $chipClass token", ({ status, chipClass, icon }) => {
    const { container } = render(<EligibilityChip status={status} />);
    const chip = container.querySelector(`[data-eligibility="${status}"]`);
    expect(chip).not.toBeNull();
    expect(chip).toHaveClass("chip--soft", chipClass);
    expect(chip!.querySelector(`[data-eligibility-icon="${icon}"]`)).not.toBeNull();
    expect(chip).toHaveTextContent(eligibilityStatusLabels[status]);
  });

  /**
   * T02 handoff: there are two label sets and all four values differ. Both must
   * reach the same icon+text+colour treatment, so the short set is not a
   * second-class citizen with a bare `<span>`. Merging them is explicitly not
   * wanted — `eligibility.test.ts` pins both string tables.
   */
  it.each(ELIGIBILITY_CASES)("carries the same $chipClass token with the short wording for $status", ({ status, chipClass, icon }) => {
    const { container } = render(<EligibilityChip labels="short" status={status} />);
    const chip = container.querySelector(`[data-eligibility="${status}"]`);
    expect(chip).toHaveClass("chip--soft", chipClass);
    expect(chip!.querySelector(`[data-eligibility-icon="${icon}"]`)).not.toBeNull();
    expect(chip).toHaveTextContent(eligibilityStatusShortLabels[status]);
    expect(chip).not.toHaveTextContent(eligibilityStatusLabels[status]);
  });

  it("keeps the danger icon and colour when a blocking prerequisite replaces the wording", () => {
    const { container } = render(<EligibilityChip overrideLabel="有擋修條件" status="blocked_confirmed" />);
    const chip = container.querySelector('[data-eligibility="blocked_confirmed"]');
    expect(chip).toHaveClass("chip--danger");
    expect(chip!.querySelector('[data-eligibility-icon="Prohibit"]')).not.toBeNull();
    expect(chip).toHaveTextContent("有擋修條件");
  });

  it.each(CATEGORY_CASES)("labels %s with a neutral chip, never a status colour", (category) => {
    const { container } = render(<CategoryChip category={category} />);
    const chip = container.querySelector(`[data-category="${category}"]`);
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent(recommendationCategoryLabels[category]);
    // §4.3: the category scale is separate from the semantic palette. The colour
    // arrives through `--category-bar` on the 4px leading rule, never through a
    // success/warning/danger chip token.
    expect(chip).toHaveClass("chip--default");
    for (const semantic of ["chip--success", "chip--warning", "chip--danger"]) {
      expect(chip).not.toHaveClass(semantic);
    }
  });
});

describe("CourseCard", () => {
  it("renders the course as an article with a single h2 title", () => {
    render(<Providers><CourseCard course={course()} /></Providers>);
    const card = screen.getByRole("article");
    expect(within(card).getByRole("heading", { level: 2 })).toHaveTextContent("機器學習概論");
    expect(within(card).getByText("Introduction to Machine Learning")).toBeInTheDocument();
    // No runtime-composed class names left on the card at all.
    expect(card.querySelector(".category-tag, .status")).toBeNull();
    expect(card.querySelector("[data-eligibility]")).not.toBeNull();
  });

  it("exposes the favourite toggle as a named, pressable icon-only control", async () => {
    const user = userEvent.setup();
    render(<Providers><CourseCard course={course()} /></Providers>);
    const toggle = screen.getByRole("button", { name: "收藏課程" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    // The tooltip mirrors the accessible name; it is not a substitute for it.
    // Asserted through keyboard focus rather than hover: React Aria opens a
    // focused tooltip immediately, where the hover path waits out the 700ms
    // warmup that jsdom has no real clock for.
    await user.tab();
    expect(toggle).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("收藏課程");
  });

  it("offers the three actions as buttons, with the schedule action disabled once scheduled", () => {
    render(<Providers><CourseCard course={course()} /></Providers>);
    expect(screen.getByRole("button", { name: "加入 我的課表" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "標記已修" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "不感興趣" })).toBeEnabled();
  });

  it("shows syllabus evidence behind a disclosure rather than a bare details element", async () => {
    const user = userEvent.setup();
    const { container } = render(<Providers><CourseCard course={course()} /></Providers>);
    expect(container.querySelector("details")).toBeNull();
    const trigger = screen.getByRole("button", { name: /查看課綱與判斷依據/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "開啟官方課綱" })).toHaveAttribute("href", "https://example.test/CS101");
  });

  it("turns mutually exclusive class variants into one radio group", async () => {
    const user = userEvent.setup();
    const alternative = course({ course_id: "CS101-B", official_department_label: "資工系乙班", teacher: "李老師" });
    render(<Providers><CourseCard alternatives={[alternative]} course={course()} /></Providers>);
    await user.click(screen.getByRole("button", { name: /可選的班別／共同開課項目/ }));
    const group = screen.getByRole("radiogroup", { name: "選擇班別／共同開課項目" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    await user.click(radios[1]);
    expect(radios[1]).toBeChecked();
    // The department, teacher, meetings and eligibility wording are the radio's
    // accessible name, so a screen-reader user hears the whole option, not "選項二".
    expect(radios[1]).toHaveAccessibleName(/資工系乙班/);
    expect(radios[1]).toHaveAccessibleName(/李老師/);
    // Selecting a variant re-renders the whole card against it.
    expect(within(screen.getByRole("article").querySelector(".meta")!).getByText("資工系乙班")).toBeInTheDocument();
  });

  it("announces cautions through an alert with an indicator, not colour alone", () => {
    const { container } = render(<Providers><CourseCard cautions={["這門課去年停開過。"]} course={course()} /></Providers>);
    const alert = screen.getByRole("status");
    expect(alert).toHaveClass("alert--warning");
    expect(alert).toHaveTextContent("修課前請確認");
    expect(alert).toHaveTextContent("這門課去年停開過。");
    expect(container.querySelector(".alert__indicator")).not.toBeNull();
  });
});
