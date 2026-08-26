import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
const rankMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/api", () => apiMocks);
vi.mock("@/data/db", () => dbMocks);
vi.mock("@/domain/recommendation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/recommendation")>()),
  rankCoursesWithDiagnostics: rankMock,
}));
// Only `track` is replaced; the session and interaction-id helpers stay real, so
// the ids asserted below are the ones the app would really mint.
vi.mock("@/analytics/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/analytics/client")>()),
  track: trackMock,
}));
// The card is not under test here and needs a fully-formed Course to render.
vi.mock("@/components/CourseCard", () => ({
  CourseCard: ({ course }: { course: { course_id: string } }) => <div data-testid="card">{course.course_id}</div>,
}));

const profile: Profile = {
  id: "current", division: "日間部", department: "測試系", grade: 1, admissionYear: 115,
  interests: "", preferredWeekdays: [1, 2, 3], updatedAt: "now",
};
const plan: SchedulePlan = { id: "plan", name: "測試方案", entries: [], createdAt: "now", updatedAt: "now" };

/** Just enough shape for the page; `CourseCard` is stubbed above. */
function fakeRecommendations(count: number) {
  return {
    candidateCount: count,
    recommendations: Array.from({ length: count }, (_, index) => ({
      course: { course_id: `C${index}` },
      alternatives: [],
      reasons: [],
      category: "home_elective",
    })),
  };
}

const eventsNamed = (name: string) => trackMock.mock.calls.filter(([event]) => event === name);

async function runSearch(user: ReturnType<typeof userEvent.setup>, topic: string) {
  const field = screen.getByRole("textbox", { name: "想學的主題或技能" });
  await user.clear(field);
  await user.type(field, topic);
  await user.click(screen.getByRole("button", { name: "產生推薦" }));
}

describe("recommend page analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getFacets.mockResolvedValue({});
    apiMocks.getCatalog.mockResolvedValue([]);
    apiMocks.getEmbeddingBundle.mockResolvedValue({
      manifest: {}, index: { course_ids: [], dimension: 1 }, vectors: new Float32Array(),
    });
    apiMocks.embedQuery.mockResolvedValue(new Float32Array([1]));
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

  it("reports one search per run, carrying the length of the query and never the query", async () => {
    const user = userEvent.setup();
    rankMock.mockReturnValue(fakeRecommendations(3));
    await runSearch(user, "資料分析");

    await waitFor(() => expect(eventsNamed("search")).toHaveLength(1));
    const [, data, context] = eventsNamed("search")[0];
    expect(data).toMatchObject({ search_mode: "semantic", query_length: 4, result_count: 3 });
    expect(data.latency_ms).toBeGreaterThanOrEqual(0);
    expect(context.interactionId).toMatch(/^rec_/);
    // The text the student typed appears in no event, in any field.
    expect(JSON.stringify(trackMock.mock.calls)).not.toContain("資料分析");
  });

  /**
   * The regression this file exists for.
   *
   * Opening a run re-renders, and the re-rank effect depends on the run — so a
   * run opened at *request* time made the effect fire against the results still
   * on screen, and the second search reported the first search's result count
   * with a near-zero latency. The run is now opened in `onSuccess`, batched with
   * the new embedding.
   */
  it("reports the new result count on a second search, not the previous one", async () => {
    const user = userEvent.setup();
    rankMock.mockReturnValue(fakeRecommendations(3));
    await runSearch(user, "資料分析");
    await waitFor(() => expect(eventsNamed("search")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("card")).toHaveLength(3));

    rankMock.mockReturnValue(fakeRecommendations(7));
    await runSearch(user, "行銷");
    await waitFor(() => expect(eventsNamed("search")).toHaveLength(2));
    expect(eventsNamed("search")[1][1]).toMatchObject({ result_count: 7, query_length: 2 });
    // And the two runs are distinct interactions, so their funnels do not merge.
    expect(eventsNamed("search")[1][2].interactionId).not.toBe(eventsNamed("search")[0][2].interactionId);
  });

  it("raises zero_result alongside the search when nothing matched", async () => {
    const user = userEvent.setup();
    rankMock.mockReturnValue(fakeRecommendations(0));
    await runSearch(user, "找不到的東西");

    await waitFor(() => expect(eventsNamed("zero_result")).toHaveLength(1));
    const [, , searchContext] = eventsNamed("search")[0];
    const [, zeroData, zeroContext] = eventsNamed("zero_result")[0];
    expect(zeroData).toEqual({ search_mode: "semantic" });
    // Same interaction, so the rate is a join on one id.
    expect(zeroContext.interactionId).toBe(searchContext.interactionId);
  });

  it("reports a refinement only from the second search of a flow", async () => {
    const user = userEvent.setup();
    rankMock.mockReturnValue(fakeRecommendations(2));
    await runSearch(user, "AI");
    await waitFor(() => expect(eventsNamed("search")).toHaveLength(1));
    expect(eventsNamed("search_refined")).toHaveLength(0);

    await runSearch(user, "生成式 AI");
    await waitFor(() => expect(eventsNamed("search")).toHaveLength(2));
    expect(eventsNamed("search_refined")).toHaveLength(1);
    expect(eventsNamed("search_refined")[0][1]).toEqual({ refinement_index: 1 });
    expect(eventsNamed("search_refined")[0][2].interactionId).toMatch(/^flow_/);
  });

  it("reports the run as skipped when a new search replaces untouched results", async () => {
    const user = userEvent.setup();
    rankMock.mockReturnValue(fakeRecommendations(4));
    await runSearch(user, "AI");
    await waitFor(() => expect(screen.getAllByTestId("card")).toHaveLength(4));
    expect(eventsNamed("recommendation_skipped")).toHaveLength(0);

    await runSearch(user, "行銷");
    await waitFor(() => expect(eventsNamed("recommendation_skipped")).toHaveLength(1));
    expect(eventsNamed("recommendation_skipped")[0][1]).toMatchObject({ result_count: 4, method: "semantic" });
  });

  it("records the filter that changed, with no personal field attached", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "通識課程", pressed: false }));

    const filterEvents = eventsNamed("filter_used");
    expect(filterEvents).toHaveLength(1);
    expect(filterEvents[0][1]).toEqual({ filter: "course_category", value: "general_education" });
    const serialised = JSON.stringify(trackMock.mock.calls);
    for (const personal of ["測試系", "日間部", "admissionYear", "preferredWeekdays", "grade"]) {
      expect(serialised).not.toContain(personal);
    }
  });

  /*
    Not tested here: "the page survives a throwing `track`". The real `track`
    cannot throw — it wraps its whole body — and the property that actually
    matters (the product works when the analytics endpoint is down) is covered
    where the transport lives, in `analytics/client.test.ts`, and server-side in
    `tests/test_analytics.py::test_analytics_outage_does_not_break_the_product`.
  */

  it("reports a failed recommendation as a fixed error code and no run", async () => {
    apiMocks.embedQuery.mockRejectedValue(new Error("query 向量服務失效：資料分析"));
    const user = userEvent.setup();
    await runSearch(user, "資料分析");

    await waitFor(() => expect(eventsNamed("error")).toHaveLength(1));
    expect(eventsNamed("error")[0][1]).toEqual({
      component: "recommendation",
      error_code: "EMBEDDING_REQUEST_FAILED",
    });
    // No results were shown, so there is no search and nothing to skip — and
    // the thrown message, which here contains the query, reaches no event.
    expect(eventsNamed("search")).toHaveLength(0);
    expect(eventsNamed("recommendation_skipped")).toHaveLength(0);
    expect(JSON.stringify(trackMock.mock.calls)).not.toContain("資料分析");
  });
});
