import { describe, expect, it } from "vitest";
import { artifactCacheKey } from "./api";
import type { ArtifactManifest } from "./types";

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
