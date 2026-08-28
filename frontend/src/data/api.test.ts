import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactCacheKey, embedQuery, embedQueryDetailed } from "./api";
import type { ArtifactManifest } from "@/domain/types";

const manifest: ArtifactManifest = {
  artifact_version: "fju_recommender_v3",
  catalog_schema_version: "fju_catalog_v2",
  academic_year: 115,
  semester: 1,
  generated_at: "2026-08-21T00:00:00+00:00",
  model_name: "test/model",
  model_revision: "revision-1",
  dimension: 3,
  course_count: 2,
  files: {
    "catalog.json": { sha256: "catalog-a", bytes: 10 },
    "embedding-index.json": { sha256: "index-a", bytes: 10 },
    "course-embeddings.f32": { sha256: "vectors-a", bytes: 24 },
  },
};

describe("artifact cache keys", () => {
  it("changes when the catalog file hash changes", () => {
    const changed = {
      ...manifest,
      files: { ...manifest.files, "catalog.json": { sha256: "catalog-b", bytes: 10 } },
    };
    expect(artifactCacheKey(manifest, "catalog", ["catalog.json"])).not.toBe(
      artifactCacheKey(changed, "catalog", ["catalog.json"]),
    );
  });

  it("changes when the catalog schema version changes", () => {
    const changed = { ...manifest, catalog_schema_version: "fju_catalog_v3" };
    expect(artifactCacheKey(manifest, "catalog", ["catalog.json"])).not.toBe(
      artifactCacheKey(changed, "catalog", ["catalog.json"]),
    );
  });

  it("includes both index and vector hashes for the embedding cache", () => {
    const key = artifactCacheKey(manifest, "vectors", ["embedding-index.json", "course-embeddings.f32"]);
    expect(key).toContain("embedding-index.json=index-a");
    expect(key).toContain("course-embeddings.f32=vectors-a");
  });
});

describe("query embedding telemetry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads cache state from Server-Timing without changing the response contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      vector: [1, 0, 0], model_version: "revision-1", dimension: 3,
    }), {
      status: 200,
      headers: { "Server-Timing": 'query-cache;desc="hit", query-inference;dur=0' },
    }))));
    const result = await embedQueryDetailed("資料分析");
    expect(Array.from(result.vector)).toEqual([1, 0, 0]);
    expect(result.modelVersion).toBe("revision-1");
    expect(result.dimension).toBe(3);
    expect(result.queryCacheState).toBe("hit");
    expect(result.requestMs).toBeGreaterThanOrEqual(0);
    await expect(embedQuery("資料分析")).resolves.toEqual(new Float32Array([1, 0, 0]));
  });
});
