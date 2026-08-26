import { getRecord, putRecord } from "./db";
import { track } from "@/analytics/client";
import type { ApiEndpointName } from "@/analytics/events";
import type { AIAnswer, AIAskContext, AIHistoryTurn, ArtifactManifest, Course, DepartmentCatalog, EmbeddingIndex, HardConstraints } from "@/domain/types";
import type { RouteBundle, RouteInfo } from "@/domain/queryAnalysis";

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

async function getJson<T>(endpoint: ApiEndpointName, url: string, init?: RequestInit): Promise<T> {
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
  return JSON.parse(body) as T;
}

export async function getManifest(): Promise<ArtifactManifest> {
  return getJson("catalog_manifest", "/api/v1/catalog/manifest");
}

export function artifactCacheKey(
  manifest: ArtifactManifest,
  resource: "catalog" | "vectors",
  files: string[],
): string {
  const identities = files.map((filename) => {
    const hash = manifest.files?.[filename]?.sha256;
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

export async function getCourse(courseId: string): Promise<Course> {
  return getJson("course_detail", `/api/v1/courses/${encodeURIComponent(courseId)}`);
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

export async function getEmbeddingBundle(): Promise<{
  manifest: ArtifactManifest;
  index: EmbeddingIndex;
  vectors: Float32Array;
}> {
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
  return { manifest, index, vectors };
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const result = await getJson<{ vector: number[] }>("query_embedding", "/api/v1/query-embedding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return new Float32Array(result.vector);
}

export async function embedQueries(texts: string[]): Promise<{ vectors: Float32Array[]; modelVersion: string; dimension: number }> {
  const result = await getJson<{ vectors: number[][]; model_version: string; dimension: number }>("query_embeddings", "/api/v1/query-embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  return { vectors: result.vectors.map((vector) => new Float32Array(vector)), modelVersion: result.model_version, dimension: result.dimension };
}

export async function getFeatures(): Promise<{ compound_query_enabled: boolean; query_analysis_version: string; analytics_enabled?: boolean; ai_assistant_enabled?: boolean; ai_model?: string; ai_max_question_chars?: number }> {
  return getJson("features", "/api/v1/features");
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
