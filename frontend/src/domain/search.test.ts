import { describe, expect, it } from "vitest";
import { hydrateSearchIndex, scoreLexically, type SearchField, type SerializedSearchIndex } from "./search";
import type { CourseSummary } from "./types";

const fields: SearchField[] = ["title", "objective", "weekly_progress", "prerequisite", "materials", "skills"];

describe("serialized BM25 search index", () => {
  it("hydrates the compact payload with the same title matching signal", () => {
    const emptyFields = Object.fromEntries(fields.map((field) => [field, { length: 0, counts: [] }])) as unknown as SerializedSearchIndex["documents"][string]["fields"];
    const emptyFrequency = Object.fromEntries(fields.map((field) => [field, []])) as unknown as SerializedSearchIndex["document_frequency"];
    const payload: SerializedSearchIndex = {
      schema_version: "fju_bm25_index_v1",
      tokenizer_version: "nfkc-lower-ascii-han-v1",
      fields,
      field_weights: { title: 3.2, objective: 1.8, weekly_progress: 1.3, prerequisite: 1, materials: 0.9, skills: 0.8 },
      k1: 1.2,
      b: 0.75,
      vocabulary: ["資料", "資料科學", "科學"],
      document_frequency: { ...emptyFrequency, title: [[0, 1], [1, 1], [2, 1]] },
      average_field_length: { title: 2, objective: 0, weekly_progress: 0, prerequisite: 0, materials: 0, skills: 0 },
      document_count: 1,
      documents: {
        C1: {
          title_text: "資料科學",
          fields: { ...emptyFields, title: { length: 2, counts: [[0, 1], [1, 1]] } },
        },
      },
    };
    const index = hydrateSearchIndex(payload);
    const match = scoreLexically(index, { course_id: "C1" } as CourseSummary, "資料科學");
    expect(match.exactTitle).toBe(true);
    expect(match.matchedTerms).toEqual(["資料", "資料科學"]);
    expect(match.matchedFields).toContain("title");
  });
});
