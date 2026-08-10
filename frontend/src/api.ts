import { getRecord, putRecord } from "./db";
import type { ArtifactManifest, Course, EmbeddingIndex } from "./types";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

export async function getManifest(): Promise<ArtifactManifest> {
  return getJson("/api/v1/catalog/manifest");
}

export async function getFacets(): Promise<Record<string, { value: string; label: string }[]>> {
  return getJson("/api/v1/facets");
}

export async function getCourses(params: URLSearchParams) {
  return getJson<{ items: Course[]; total: number; page: number; total_pages: number }>(
    `/api/v1/courses?${params}`,
  );
}

export async function getCourse(courseId: string): Promise<Course> {
  return getJson(`/api/v1/courses/${encodeURIComponent(courseId)}`);
}

export async function getCatalog(): Promise<Course[]> {
  const manifest = await getManifest();
  const key = `catalog:${manifest.artifact_version}:${manifest.model_revision}`;
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
  const key = `vectors:${manifest.artifact_version}:${manifest.model_revision}`;
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
