import { getRecord, putRecord } from "./db";
import type { AIAnswer, AIAskContext, AIHistoryTurn, ArtifactManifest, Course, DepartmentCatalog, EmbeddingIndex, HardConstraints } from "./types";
import type { RouteBundle, RouteInfo } from "./queryAnalysis";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
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
  return getJson("/api/v1/catalog/manifest");
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
  return getJson("/api/v1/facets");
}

export async function getDepartmentCatalog(): Promise<DepartmentCatalog> {
  return getJson("/api/v1/departments");
}

export async function getCourses(params: URLSearchParams, signal?: AbortSignal) {
  return getJson<{ items: Course[]; total: number; page: number; total_pages: number }>(
    `/api/v1/courses?${params}`,
    { signal },
  );
}

export async function getCourse(courseId: string): Promise<Course> {
  return getJson(`/api/v1/courses/${encodeURIComponent(courseId)}`);
}

export async function getCatalog(): Promise<Course[]> {
  const manifest = await getManifest();
  const key = artifactCacheKey(manifest, "catalog", ["catalog.json"]);
  const cached = await getRecord<{ id: string; data: Course[] }>("catalogCache", key);
  if (cached) return cached.data;
  const catalog = await getJson<Course[]>("/api/v1/catalog/data");
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
    getJson<EmbeddingIndex>("/api/v1/embeddings/index"),
    getRecord<{ id: string; data: ArrayBuffer }>("catalogCache", key),
  ]);
  let data = cached?.data;
  if (!data) {
    const response = await fetch("/api/v1/embeddings/data");
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
  const result = await getJson<{ vector: number[] }>("/api/v1/query-embedding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return new Float32Array(result.vector);
}

export async function embedQueries(texts: string[]): Promise<{ vectors: Float32Array[]; modelVersion: string; dimension: number }> {
  const result = await getJson<{ vectors: number[][]; model_version: string; dimension: number }>("/api/v1/query-embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  return { vectors: result.vectors.map((vector) => new Float32Array(vector)), modelVersion: result.model_version, dimension: result.dimension };
}

export async function getFeatures(): Promise<{ compound_query_enabled: boolean; query_analysis_version: string; ai_assistant_enabled?: boolean; ai_model?: string; ai_max_question_chars?: number }> {
  return getJson("/api/v1/features");
}

export async function askCourseAssistant(input: {
  request_id: string;
  question: string;
  history: AIHistoryTurn[];
  context: AIAskContext;
  hard_constraints: HardConstraints;
}): Promise<AIAnswer> {
  return getJson<AIAnswer>("/api/v1/ai/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getRouteBundle(): Promise<RouteBundle> {
  const index = await getJson<{ routes: RouteInfo[]; dimension: number; threshold?: number; margin?: number }>("/api/v1/query-routes/index");
  const response = await fetch("/api/v1/query-routes/data");
  if (!response.ok) throw new Error("無法下載查詢情境向量");
  return {
    routes: index.routes,
    dimension: index.dimension,
    threshold: index.threshold,
    margin: index.margin,
    vectors: new Float32Array(await response.arrayBuffer()),
  };
}
