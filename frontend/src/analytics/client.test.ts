import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLUSH_DELAY_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  __queuedEventsForTests,
  __resetAnalyticsForTests,
  currentSessionId,
  flushAnalytics,
  isAnalyticsEnabled,
  newInteractionId,
  setAnalyticsInstrumentationV3,
  setAnalyticsOptOut,
  setAnalyticsProvenance,
  track,
  trackV3,
} from "./client";
import { MAX_ANALYTICS_BATCH_BYTES, pageForPath } from "./events";
import { nextSearchStep } from "./searchFlow";

function lastRequestBody(fetchMock: ReturnType<typeof vi.fn>): { events: unknown[] } {
  const call = fetchMock.mock.calls.at(-1);
  return JSON.parse((call?.[1] as RequestInit).body as string) as { events: unknown[] };
}

describe("analytics client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetAnalyticsForTests();
    fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 202 })));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    __resetAnalyticsForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("queues without touching the network, then sends one batch", () => {
    track("page_view", { page: "recommendation" });
    track("feature_clicked", { feature: "open_full_filter" });
    // The whole point: nothing has gone out yet, so nothing the student did was
    // slowed down by a request.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(__queuedEventsForTests()).toHaveLength(2);

    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastRequestBody(fetchMock).events).toHaveLength(2);
  });

  it("never throws or rejects when the endpoint is down", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(() => track("search", { search_mode: "semantic", query_length: 4, result_count: 0, latency_ms: 12 })).not.toThrow();
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("stops trying after a permanent 4xx instead of retrying every batch", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 400 }));
    track("page_view", { page: "schedule" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    await vi.runAllTimersAsync();
    expect(isAnalyticsEnabled()).toBe(false);

    fetchMock.mockClear();
    track("page_view", { page: "schedule" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS * 5);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([413, 429])("keeps collecting after a transient %i", async (status) => {
    // 413 (this batch was too big) and 429 (slow down) describe one request, not
    // a payload the server will never accept — switching analytics off for the
    // whole session over either would be a self-inflicted outage.
    fetchMock.mockResolvedValue(new Response("{}", { status }));
    track("page_view", { page: "schedule" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    await vi.runAllTimersAsync();
    expect(isAnalyticsEnabled()).toBe(true);
    expect(__queuedEventsForTests()).toHaveLength(1);
  });

  it("stamps a session id that lives in sessionStorage, never localStorage", () => {
    track("page_view", { page: "recommendation" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    const [event] = lastRequestBody(fetchMock).events as { session_id: string }[];
    expect(event.session_id).toMatch(/^tmp_[0-9a-f]{12}$/);
    expect(window.sessionStorage.getItem("fju-analytics-session")).toContain(event.session_id);
    // Nothing analytics writes to localStorage is an identifier; the only key it
    // may own there is the opt-out flag.
    expect(Object.keys(window.localStorage)).not.toContain("fju-analytics-session");
  });

  it("rolls the session over on idle and on the hard age cap", () => {
    const start = 1_800_000_000_000;
    const first = currentSessionId(start);
    // The idle clock is measured from the last tracked event, not from the
    // session's start, so continued use keeps the same id.
    const lastActivity = start + SESSION_IDLE_MS - 1000;
    expect(currentSessionId(lastActivity)).toBe(first);

    // Genuinely idle past the window: a new id, so a tab left open overnight
    // does not carry one identifier into the next day.
    const resumedAt = lastActivity + SESSION_IDLE_MS + 1000;
    const afterIdle = currentSessionId(resumedAt);
    expect(afterIdle).not.toBe(first);

    // Continuously active, so the idle clock never fires — the hard age cap
    // still ends the session.
    let now = resumedAt;
    let id = afterIdle;
    while (now - resumedAt < SESSION_MAX_AGE_MS + SESSION_IDLE_MS) {
      now += SESSION_IDLE_MS - 1000;
      id = currentSessionId(now);
    }
    expect(id).not.toBe(afterIdle);
  });

  it("sends nothing at all once the student opts out", () => {
    setAnalyticsOptOut(true);
    expect(isAnalyticsEnabled()).toBe(false);
    track("page_view", { page: "privacy" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS * 3);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("fju-analytics-session")).toBeNull();

    setAnalyticsOptOut(false);
    track("page_view", { page: "privacy" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prefers sendBeacon while the page is going away", () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon });
    track("page_view", { page: "schedule" });
    flushAnalytics({ beacon: true });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("splits an over-long queue into batches the server will accept", () => {
    for (let index = 0; index < 45; index += 1) track("page_view", { page: "schedule" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    // The server rejects a batch over 40 outright, so the client never builds
    // one: 45 queued events go out as 40 + 5.
    const sizes = fetchMock.mock.calls.map(
      (call) => (JSON.parse((call[1] as RequestInit).body as string) as { events: unknown[] }).events.length,
    );
    expect(sizes).toEqual([40, 5]);
  });

  it("splits v3 events by UTF-8 body size as well as event count", () => {
    setAnalyticsInstrumentationV3(true);
    setAnalyticsProvenance({
      client_build_sha: "frontend-build-0123456789",
      client_artifact_version: "artifact-1151-embeddinggemma-768",
      client_artifact_bundle_id: "bundle-0123456789abcdef",
      client_model_revision: "model-revision-0123456789",
      client_ranking_version: "rank-courses-v1",
      client_query_analysis_version: "deterministic-v1",
    });
    for (let index = 0; index < 40; index += 1) {
      trackV3("search_result_impression", {
        course_id: `D${index}`,
        position: index + 1,
        search_mode: "keyword",
      }, { interactionId: "search_abc123" });
    }

    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    const calls = fetchMock.mock.calls;
    const sentEvents = calls.flatMap((call) => (
      JSON.parse((call[1] as RequestInit).body as string) as { events: Record<string, unknown>[] }
    ).events);
    expect(calls.length).toBeGreaterThan(1);
    expect(sentEvents).toHaveLength(40);
    for (const call of calls) {
      const body = (call[1] as RequestInit).body as string;
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_ANALYTICS_BATCH_BYTES);
    }
  });

  it("puts a failed batch back at the front of the queue", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    track("page_view", { page: "schedule" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    await vi.runAllTimersAsync();

    expect(__queuedEventsForTests()).toHaveLength(1);
    const failed = __queuedEventsForTests()[0];
    expect(failed.event).toBe("page_view");
  });

  it("carries an interaction id only when one is supplied", () => {
    const interactionId = newInteractionId("rec");
    expect(interactionId).toMatch(/^rec_[0-9a-f]{10}$/);
    track("recommendation_clicked", { course_id: "D1", position: 2 }, { interactionId });
    track("page_view", { page: "schedule" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    const [clicked, viewed] = lastRequestBody(fetchMock).events as Record<string, unknown>[];
    expect(clicked.interaction_id).toBe(interactionId);
    expect(viewed).not.toHaveProperty("interaction_id");
  });

  it("keeps Phase 1 events disabled until the backend gate and attaches bounded provenance", () => {
    trackV3("search_result_impression", { course_id: "D1", position: 1, search_mode: "keyword" });
    expect(__queuedEventsForTests()).toHaveLength(0);

    setAnalyticsProvenance({ client_build_sha: "frontend-test", client_artifact_version: "artifact-1" });
    setAnalyticsInstrumentationV3(true);
    trackV3("search_result_impression", { course_id: "D1", position: 1, search_mode: "keyword" }, { interactionId: "search_abc123" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    const [event] = lastRequestBody(fetchMock).events as Record<string, unknown>[];
    expect(event).toMatchObject({
      event: "search_result_impression",
      schema_version: 3,
      interaction_id: "search_abc123",
      provenance: { client_build_sha: "frontend-test", client_artifact_version: "artifact-1" },
    });
    expect(event).not.toHaveProperty("data.query");
  });

  it("puts nothing in the payload beyond the declared envelope", () => {
    track("filter_used", { filter: "weekday", value: "wed" }, { page: "recommendation" });
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    const [event] = lastRequestBody(fetchMock).events as Record<string, unknown>[];
    expect(Object.keys(event).sort()).toEqual(["data", "event", "page", "session_id", "timestamp"]);
    // The denylist the server enforces, asserted from the client side too.
    const serialised = JSON.stringify(event);
    for (const forbidden of ["user_id", "student_id", "email", "ip", "token", "schedule", "raw_query", "user_agent"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe("pageForPath", () => {
  it("maps known routes to enum members", () => {
    expect(pageForPath("/recommend")).toBe("recommendation");
    expect(pageForPath("/explore")).toBe("course_search");
    expect(pageForPath("/onboarding")).toBe("settings");
  });

  it("never lets a URL become the recorded value", () => {
    // A pasted or mistyped path is exactly where personal data would leak in.
    expect(pageForPath("/explore/405123456")).toBe("not_found");
    expect(pageForPath("/recommend?q=my+name")).toBe("not_found");
  });
});

describe("nextSearchStep", () => {
  it("counts refinements inside a flow and starts a new flow after a gap", () => {
    const first = nextSearchStep(undefined, 1000, 5000);
    expect(first.refinementIndex).toBe(0);

    const second = nextSearchStep(first, 3000, 5000);
    expect(second.flowId).toBe(first.flowId);
    expect(second.refinementIndex).toBe(1);

    const afterGap = nextSearchStep(second, 3000 + 6000, 5000);
    expect(afterGap.flowId).not.toBe(first.flowId);
    expect(afterGap.refinementIndex).toBe(0);
  });

  it("clamps the index to what the server accepts", () => {
    let state = nextSearchStep(undefined, 0, 5000);
    for (let step = 0; step < 200; step += 1) state = nextSearchStep(state, step, 5000);
    expect(state.refinementIndex).toBe(100);
  });
});
