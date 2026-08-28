import { getRecord, putRecord } from "./db";
import { setAnalyticsInstrumentationV3, setAnalyticsProvenance, track } from "@/analytics/client";
import type { ApiEndpointName } from "@/analytics/events";
import type { AIAnswer, AIAskContext, AIHistoryTurn, ArtifactManifest, Course, DepartmentCatalog, EmbeddingIndex, HardConstraints } from "@/domain/types";
import type { RouteBundle, RouteInfo } from "@/domain/queryAnalysis";
import { hydrateSearchIndex, type SearchIndex, type SerializedSearchIndex } from "@/domain/search";
import type { CourseSummary } from "@/domain/types";

/**
 * `fetch` plus one `api_performance` sample.
 *
 * Measured here rather than in server middleware because the number worth
 * having is the one the student experiences — DNS, TLS, the Cloudflare hop and
 * the JSON parse included. What is recorded is a *logical* endpoint name, never
 * `url`: a path can carry a course id and a query string can carry anything at
 * all, and neither belongs in a latency table.
 *
 * An aborted request is not a sample. TanStack Query cancels superseded
 * requests on every keystroke of the explore search, and counting those as
 * failures would make the error rate a measure of how fast people type.
 */
async function timedFetch(endpoint: ApiEndpointName, url: string, init?: RequestInit): Promise<Response> {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, init);
    track("api_performance", { endpoint, latency_ms: Math.round(performance.now() - startedAt), status: response.status });
    return response;
  } catch (error) {
    if ((error as Error | undefined)?.name === "AbortError") throw error;
    // `status: 0` is the agreed encoding for "never reached the server", and the
    // dashboard counts it with the 4xx/5xx in `api_error_rate`.
    track("api_performance", { endpoint, latency_ms: Math.round(performance.now() - startedAt), status: 0 });
    throw error;
  }
}

async function getJsonWithResponse<T>(endpoint: ApiEndpointName, url: string, init?: RequestInit): Promise<{ data: T; response: Response }> {
  const response = await timedFetch(endpoint, url, init);
  const body = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      const parsed = JSON.parse(body) as { detail?: string };
      detail = parsed.detail || "";
    } catch { /* response may be plain text */ }
    throw new Error(detail || `${response.status} ${body}`);
  }
  return { data: JSON.parse(body) as T, response };
}

async function getJson<T>(endpoint: ApiEndpointName, url: string, init?: RequestInit): Promise<T> {
  return (await getJsonWithResponse<T>(endpoint, url, init)).data;
}

export async function getManifest(): Promise<ArtifactManifest> {
  const manifest = await getJson<ArtifactManifest>("catalog_manifest", "/api/v1/catalog/manifest");
  setAnalyticsProvenance({
    client_artifact_version: manifest.artifact_version,
    client_artifact_bundle_id: (manifest as ArtifactManifest & { bundle_id?: string }).bundle_id,
    client_model_revision: manifest.model_revision,
  });
  return manifest;
}

export interface CatalogSummaryPayload {
  schema_version: string;
  course_count: number;
  course_ids: string[];
  courses: CourseSummary[];
  search_index: SerializedSearchIndex;
}

interface CompressedCatalogSummaryPayload {
  schema_version: string;
  encoding: "deflate-base64-v1";
  course_count: number;
  payload: string;
}

export interface RecommendationAssets {
  catalog: CourseSummary[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
  searchIndex: SearchIndex;
  manifest: ArtifactManifest;
  /** Internal diagnostics; optional for compatibility with old test seams. */
  assetSource?: "indexed_db" | "network";
  assetParseMs?: number;
  assetDecompressMs?: number;
  assetHydrateMs?: number;
}

export type RecommendationAssetState = "prefetched" | "in_flight" | "indexed_db" | "network";

type ArtifactLoadSource = "indexed_db" | "network";

interface CatalogSummaryLoad {
  data: CatalogSummaryPayload;
  source: ArtifactLoadSource;
  parseMs: number;
  decompressMs: number;
}

interface EmbeddingBundleLoad {
  data: { manifest: ArtifactManifest; index: EmbeddingIndex; vectors: Float32Array };
  source: ArtifactLoadSource;
  parseMs: number;
}

export function artifactCacheKey(
  manifest: ArtifactManifest,
  resource: "catalog" | "catalog_summary" | "vectors",
  files: string[],
): string {
  const identities = files.map((filename) => {
    const hash = Array.isArray(manifest.files)
      ? manifest.files.find((entry) => entry.filename === filename)?.sha256
      : manifest.files?.[filename]?.sha256;
    if (hash) return `${filename}=${hash}`;
    // Keep older manifests usable while ensuring a schema/generation change
    // cannot silently reuse a previously cached response.
    return `${filename}=legacy:${manifest.catalog_schema_version ?? "unknown"}:${manifest.generated_at ?? "unknown"}`;
  });
  return [
    resource,
    manifest.artifact_version,
    manifest.model_revision,
    manifest.catalog_schema_version ?? "legacy",
    ...identities,
  ].join(":");
}

export async function getFacets(): Promise<Record<string, { value: string; label: string }[]>> {
  return getJson("facets", "/api/v1/facets");
}

export async function getDepartmentCatalog(): Promise<DepartmentCatalog> {
  return getJson("departments", "/api/v1/departments");
}

export async function getCourses(params: URLSearchParams, signal?: AbortSignal) {
  return getJson<{ items: Course[]; total: number; page: number; total_pages: number }>(
    "courses",
    `/api/v1/courses?${params}`,
    { signal },
  );
}

export async function getClassGroups(params: URLSearchParams, signal?: AbortSignal): Promise<string[]> {
  const result = await getJson<{ items: string[] }>("class_groups", `/api/v1/class-groups?${params}`, { signal });
  return result.items;
}

export async function getCoursesByIds(courseIds: string[]): Promise<Course[]> {
  if (!courseIds.length) return [];
  const result = await getJson<{ items: Course[]; missing_course_ids: string[] }>("courses_batch", "/api/v1/courses/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ course_ids: courseIds }),
  });
  return result.items;
}

export async function lookupCourses(values: string[]): Promise<{
  items: Course[];
  matched_values: string[];
  unmatched_values: string[];
}> {
  return getJson("courses_lookup", "/api/v1/courses/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
}

const courseDetailCache = new Map<string, Promise<Course>>();

export function getCourse(courseId: string): Promise<Course> {
  const cached = courseDetailCache.get(courseId);
  if (cached) return cached;
  const request = getJson<Course>("course_detail", `/api/v1/courses/${encodeURIComponent(courseId)}`);
  courseDetailCache.set(courseId, request);
  void request.catch(() => {
    if (courseDetailCache.get(courseId) === request) courseDetailCache.delete(courseId);
  });
  return request;
}

async function getCatalogSummaryWithSource(): Promise<CatalogSummaryLoad> {
  const parseStarted = performance.now();
  const manifest = await getManifest();
  const key = artifactCacheKey(manifest, "catalog_summary", ["catalog-summary.json"]);
  const cached = await getRecord<{ id: string; data: CatalogSummaryPayload | CompressedCatalogSummaryPayload }>("catalogCache", key);
  const artifact = cached?.data ?? await getJson<CatalogSummaryPayload | CompressedCatalogSummaryPayload>("catalog_summary", "/api/v1/catalog/summary");
  const decompressStarted = performance.now();
  const summary = "encoding" in artifact ? await decodeCatalogSummary(artifact) : artifact;
  const decompressMs = "encoding" in artifact ? performance.now() - decompressStarted : 0;
  if (!cached) await putRecord("catalogCache", { id: key, data: summary });
  return {
    data: summary,
    source: cached ? "indexed_db" : "network",
    parseMs: performance.now() - parseStarted,
    decompressMs,
  };
}

export async function getCatalogSummary(): Promise<CatalogSummaryPayload> {
  return (await getCatalogSummaryWithSource()).data;
}

async function decodeCatalogSummary(artifact: CompressedCatalogSummaryPayload): Promise<CatalogSummaryPayload> {
  const binary = Uint8Array.from(atob(artifact.payload), (character) => character.charCodeAt(0));
  const stream = new Blob([binary]).stream().pipeThrough(new DecompressionStream("deflate"));
  return JSON.parse(await new Response(stream).text()) as CatalogSummaryPayload;
}

export async function getCatalog(): Promise<Course[]> {
  const manifest = await getManifest();
  const key = artifactCacheKey(manifest, "catalog", ["catalog.json"]);
  const cached = await getRecord<{ id: string; data: Course[] }>("catalogCache", key);
  if (cached) return cached.data;
  const catalog = await getJson<Course[]>("catalog_data", "/api/v1/catalog/data");
  await putRecord("catalogCache", { id: key, data: catalog });
  return catalog;
}

async function getEmbeddingBundleWithSource(): Promise<EmbeddingBundleLoad> {
  const parseStarted = performance.now();
  const manifest = await getManifest();
  const key = artifactCacheKey(manifest, "vectors", ["embedding-index.json", "course-embeddings.f32"]);
  const [index, cached] = await Promise.all([
    getJson<EmbeddingIndex>("embeddings_index", "/api/v1/embeddings/index"),
    getRecord<{ id: string; data: ArrayBuffer }>("catalogCache", key),
  ]);
  let data = cached?.data;
  if (!data) {
    const response = await timedFetch("embeddings_data", "/api/v1/embeddings/data");
    if (!response.ok) throw new Error("無法下載課程向量");
    data = await response.arrayBuffer();
    await putRecord("catalogCache", { id: key, data });
  }
  const vectors = new Float32Array(data);
  if (vectors.length !== index.course_ids.length * index.dimension) {
    throw new Error("課程向量與索引版本不一致");
  }
  return {
    data: { manifest, index, vectors },
    source: cached ? "indexed_db" : "network",
    parseMs: performance.now() - parseStarted,
  };
}

export async function getEmbeddingBundle(): Promise<{
  manifest: ArtifactManifest;
  index: EmbeddingIndex;
  vectors: Float32Array;
}> {
  return (await getEmbeddingBundleWithSource()).data;
}

let recommendationAssetsPromise: Promise<RecommendationAssets> | undefined;
let recommendationAssetsReady = false;
let recommendationPrefetchRequested = false;
let recommendationAssetSource: ArtifactLoadSource | undefined;

/** Return the state at the start of a recommendation request. */
export function getRecommendationAssetState(): RecommendationAssetState {
  if (recommendationAssetsPromise && !recommendationAssetsReady) return "in_flight";
  if (recommendationAssetsReady && recommendationAssetSource === "indexed_db") return "indexed_db";
  if (recommendationAssetsReady && recommendationPrefetchRequested) return "prefetched";
  return recommendationAssetSource ?? "network";
}

/** Share the background download with the first recommendation request. */
export function preloadRecommendationAssets(origin: "prefetch" | "search" = "search"): Promise<RecommendationAssets> {
  if (origin === "prefetch") recommendationPrefetchRequested = true;
  if (recommendationAssetsPromise) return recommendationAssetsPromise;
  recommendationAssetsReady = false;
  const loading = Promise.all([getCatalogSummaryWithSource(), getEmbeddingBundleWithSource()]).then(([summaryLoad, bundleLoad]) => {
    const hydrateStarted = performance.now();
    const searchIndex = hydrateSearchIndex(summaryLoad.data.search_index);
    const source: ArtifactLoadSource = summaryLoad.source === "indexed_db" && bundleLoad.source === "indexed_db"
      ? "indexed_db"
      : "network";
    recommendationAssetSource = source;
    recommendationAssetsReady = true;
    return {
      catalog: summaryLoad.data.courses,
      courseIds: bundleLoad.data.index.course_ids,
      vectors: bundleLoad.data.vectors,
      dimension: bundleLoad.data.index.dimension,
      searchIndex,
      manifest: bundleLoad.data.manifest,
      assetSource: source,
      assetParseMs: summaryLoad.parseMs + bundleLoad.parseMs,
      assetDecompressMs: summaryLoad.decompressMs,
      assetHydrateMs: performance.now() - hydrateStarted,
    };
  });
  recommendationAssetsPromise = loading.catch((error) => {
    recommendationAssetsPromise = undefined;
    recommendationAssetsReady = false;
    recommendationPrefetchRequested = false;
    recommendationAssetSource = undefined;
    throw error;
  });
  return recommendationAssetsPromise;
}

export type QueryCacheState = "hit" | "miss" | "unknown";

function queryCacheStateFromHeaders(response: Response): QueryCacheState {
  const timing = response.headers.get("Server-Timing") || response.headers.get("server-timing") || "";
  const match = timing.match(/(?:^|,)\s*query-cache;desc="(hit|miss)"/i);
  return match ? match[1].toLowerCase() as QueryCacheState : "unknown";
}

export interface QueryEmbeddingResult {
  vector: Float32Array;
  modelVersion: string;
  dimension: number;
  queryCacheState: QueryCacheState;
  requestMs: number;
}

export async function embedQueryDetailed(text: string): Promise<QueryEmbeddingResult> {
  const started = performance.now();
  const { data, response } = await getJsonWithResponse<{ vector: number[]; model_version: string; dimension: number }>("query_embedding", "/api/v1/query-embedding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return {
    vector: new Float32Array(data.vector),
    modelVersion: data.model_version,
    dimension: data.dimension,
    queryCacheState: queryCacheStateFromHeaders(response),
    requestMs: performance.now() - started,
  };
}

export async function embedQuery(text: string): Promise<Float32Array> {
  return (await embedQueryDetailed(text)).vector;
}

export async function embedQueries(texts: string[]): Promise<{ vectors: Float32Array[]; modelVersion: string; dimension: number }> {
  const result = await getJson<{ vectors: number[][]; model_version: string; dimension: number }>("query_embeddings", "/api/v1/query-embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  return { vectors: result.vectors.map((vector) => new Float32Array(vector)), modelVersion: result.model_version, dimension: result.dimension };
}

export async function getFeatures(): Promise<{ compound_query_enabled: boolean; query_analysis_version: string; analytics_enabled?: boolean; analytics_instrumentation_v3?: boolean; ai_assistant_enabled?: boolean; ai_model?: string; ai_max_question_chars?: number }> {
  const features = await getJson<{ compound_query_enabled: boolean; query_analysis_version: string; analytics_enabled?: boolean; analytics_instrumentation_v3?: boolean; ai_assistant_enabled?: boolean; ai_model?: string; ai_max_question_chars?: number }>("features", "/api/v1/features");
  setAnalyticsInstrumentationV3(features.analytics_instrumentation_v3 === true);
  setAnalyticsProvenance({ client_query_analysis_version: features.query_analysis_version });
  return features;
}

export async function askCourseAssistant(input: {
  request_id: string;
  question: string;
  history: AIHistoryTurn[];
  context: AIAskContext;
  hard_constraints: HardConstraints;
}): Promise<AIAnswer> {
  return getJson<AIAnswer>("ai_ask", "/api/v1/ai/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getRouteBundle(): Promise<RouteBundle> {
  const index = await getJson<{ routes: RouteInfo[]; dimension: number; threshold?: number; margin?: number }>("query_routes_index", "/api/v1/query-routes/index");
  const response = await timedFetch("query_routes_data", "/api/v1/query-routes/data");
  if (!response.ok) throw new Error("無法下載查詢情境向量");
  return {
    routes: index.routes,
    dimension: index.dimension,
    threshold: index.threshold,
    margin: index.margin,
    vectors: new Float32Array(await response.arrayBuffer()),
  };
}
