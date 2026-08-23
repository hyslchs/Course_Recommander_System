import { describe, expect, it } from "vitest";
import { analyzeQuery, embeddingTextsForAnalysis } from "./queryAnalysis";

describe("deterministic query analysis", () => {
  it("keeps a single goal on the baseline path", () => {
    const analysis = analyzeQuery("我想學 Python");
    expect(analysis.relation).toBe("SINGLE");
    expect(analysis.goals.map((part) => part.text)).toEqual(["Python"]);
  });

  it("recognizes explicit coverage and preserves both goals", () => {
    const analysis = analyzeQuery("資料庫＋後端");
    expect(analysis.relation).toBe("COVERAGE");
    expect(analysis.goals.map((part) => part.text)).toEqual(["資料庫", "後端"]);
    expect(embeddingTextsForAnalysis(analysis)).toEqual(["資料庫＋後端", "資料庫", "後端"]);
  });

  it("recognizes an attached intersection context", () => {
    const analysis = analyzeQuery("企業法務實習", {
      routeBundle: {
        routes: [{ id: "internship", label: "實習", policy: "attached_required" }],
        vectors: new Float32Array([1, 0]),
        dimension: 2,
      },
      segmentVectors: [new Float32Array([1, 0])],
    });
    expect(analysis.goals.map((part) => part.text)).toEqual(["企業法務"]);
    expect(analysis.contexts[0].text).toBe("實習");
    expect(analysis.relation).toBe("INTERSECTION");
  });

  it("falls back for unsupported relations instead of guessing", () => {
    const analysis = analyzeQuery("Python 或 R");
    expect(analysis.relation).toBe("FALLBACK");
    expect(analysis.unsupportedRelations[0].kind).toBe("ALTERNATIVE");
  });

  it("extracts a catalog-backed hard constraint and a semantic exclusion", () => {
    const analysis = analyzeQuery("資料庫＋後端，不要人工智慧，星期五，2學分");
    expect(analysis.hardConstraints.weekdays).toEqual([5]);
    expect(analysis.hardConstraints.credits).toEqual([2]);
    expect(analysis.exclusions.some((part) => part.text.includes("人工智慧") && !part.metadataConstraint)).toBe(true);
  });

  it("keeps the learning subject when hard conditions are embedded in prose", () => {
    const analysis = analyzeQuery("星期五且2學分的日文課");
    expect(analysis.relation).toBe("SINGLE");
    expect(analysis.goals.map((part) => part.text)).toEqual(["日文"]);
    expect(analysis.hardConstraints.weekdays).toEqual([5]);
    expect(analysis.hardConstraints.credits).toEqual([2]);
  });

  it("treats a query containing only metadata conditions as FILTER_ONLY", () => {
    const analysis = analyzeQuery("不要星期三的通識");
    expect(analysis.relation).toBe("FILTER_ONLY");
    expect(analysis.goals).toHaveLength(0);
    expect(analysis.hardConstraints.excludedWeekdays).toEqual([3]);
    expect(analysis.hardConstraints.requiredElective).toEqual(["通識"]);
  });

  it("blocks contradictory metadata constraints", () => {
    const analysis = analyzeQuery("星期五不要星期五");
    expect(analysis.relation).toBe("FALLBACK");
    expect(analysis.fallbackReason).toContain("星期");
  });
});
