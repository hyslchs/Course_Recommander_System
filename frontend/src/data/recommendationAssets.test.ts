import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getRecord: vi.fn(),
  putRecord: vi.fn(),
}));
const hydrateMock = vi.hoisted(() => vi.fn(() => ({
  documents: new Map(),
  documentFrequency: new Map(),
  averageFieldLength: { title: 0, objective: 0, weekly_progress: 0, prerequisite: 0, materials: 0, skills: 0 },
  documentCount: 1,
})));
const trackMock = vi.hoisted(() => vi.fn());

vi.mock("./db", () => dbMocks);
vi.mock("@/domain/search", () => ({ hydrateSearchIndex: hydrateMock }));
vi.mock("@/analytics/client", () => ({
  setAnalyticsInstrumentationV3: vi.fn(),
  setAnalyticsProvenance: vi.fn(),
  track: trackMock,
}));

const manifest = {
  artifact_version: "fju_recommender_v3",
  catalog_schema_version: "fju_catalog_v2",
  model_revision: "revision-1",
  dimension: 2,
  files: {
    "catalog-summary.json": { sha256: "summary-a", bytes: 10 },
    "embedding-index.json": { sha256: "index-a", bytes: 10 },
    "course-embeddings.f32": { sha256: "vectors-a", bytes: 8 },
  },
};
const summary = {
  schema_version: "fju_catalog_summary_v1",
  course_count: 1,
  course_ids: ["C1"],
  courses: [{ course_id: "C1" }],
  search_index: {},
};
const embeddingIndex = { course_ids: ["C1"], dimension: 2 };

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function vectorBuffer(): ArrayBuffer {
  return new Float32Array([1, 0]).buffer;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function loadApi() {
  vi.resetModules();
  return import("./api");
}

describe("recommendation asset loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    dbMocks.getRecord.mockResolvedValue(undefined);
    dbMocks.putRecord.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shares prefetch with the first search and exposes the in-flight state", async () => {
    const api = await loadApi();
    const release = deferred<void>();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/catalog/manifest")) return Promise.resolve(jsonResponse(manifest));
      if (url.includes("/catalog/summary")) return release.promise.then(() => jsonResponse(summary));
      if (url.includes("/embeddings/index")) return Promise.resolve(jsonResponse(embeddingIndex));
      if (url.includes("/embeddings/data")) return release.promise.then(() => new Response(vectorBuffer(), { status: 200 }));
      throw new Error(`unexpected endpoint: ${url}`);
    });

    const prefetched = api.preloadRecommendationAssets("prefetch");
    expect(api.getRecommendationAssetState()).toBe("in_flight");
    const searched = api.preloadRecommendationAssets("search");
    expect(searched).toBe(prefetched);

    release.resolve();
    await prefetched;

    expect(api.getRecommendationAssetState()).toBe("prefetched");
    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/catalog/manifest"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/catalog/summary"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/embeddings/data"))).toHaveLength(1);
  });

  it("uses cached assets without rehydrating the search index twice", async () => {
    const api = await loadApi();
    dbMocks.getRecord.mockImplementation(async (_store: string, id: string) => (
      id.startsWith("catalog_summary")
        ? { id, data: summary }
        : { id, data: vectorBuffer() }
    ));
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/catalog/manifest")) return Promise.resolve(jsonResponse(manifest));
      if (url.includes("/embeddings/index")) return Promise.resolve(jsonResponse(embeddingIndex));
      throw new Error(`cached path requested an unexpected endpoint: ${url}`);
    });

    const first = api.preloadRecommendationAssets("prefetch");
    await first;
    const second = api.preloadRecommendationAssets("search");
    await second;

    expect(api.getRecommendationAssetState()).toBe("indexed_db");
    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(dbMocks.putRecord).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/embeddings/data"))).toHaveLength(0);
  });
});

describe("API timing telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("records API latency only after the response body and JSON parse complete", async () => {
    const api = await loadApi();
    const release = deferred<void>();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      text: () => release.promise.then(() => JSON.stringify({
        vector: [1, 0], model_version: "revision-1", dimension: 2,
      })),
    } as Response);

    const request = api.embedQueryDetailed("test");
    await Promise.resolve();
    expect(trackMock).not.toHaveBeenCalled();

    release.resolve();
    await request;
    expect(trackMock).toHaveBeenCalledWith("api_performance", expect.objectContaining({
      endpoint: "query_embedding",
      status: 200,
    }));
  });
});
