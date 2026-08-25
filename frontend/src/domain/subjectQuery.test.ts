import { describe, expect, it } from "vitest";
import { sanitizeSubjectQuery } from "./subjectQuery";

describe("subject-only recommendation queries", () => {
  it("keeps only the learning topic when schedule and prerequisite constraints are included", () => {
    const result = sanitizeSubjectQuery("我是白天工作的進修部三年級學生，只能上平日晚間或星期六，想學電子商務、社群行銷與零售數據分析，不要有高階先修");
    expect(result.subjectQuery).toBe("電子商務、社群行銷與零售數據分析");
    expect(result.detectedFilterPhrases.map((item) => item.kind)).toEqual(expect.arrayContaining(["profile", "schedule", "exclusion"]));
  });

  it("removes a negative topic so it cannot attract the embedding", () => {
    const result = sanitizeSubjectQuery("我是心理博士二年級，想學進階研究設計、多變量統計與因果推論，避免大學入門課");
    expect(result.subjectQuery).toBe("進階研究設計、多變量統計與因果推論");
    expect(result.detectedFilterPhrases).toContainEqual({ kind: "exclusion", text: "避免大學入門課" });
  });

  it("removes a high-level nursing prerequisite exclusion from the subject vector", () => {
    const result = sanitizeSubjectQuery("想學護理實作，不要高階護理先修");
    expect(result.subjectQuery).toBe("護理實作");
    expect(result.detectedFilterPhrases).toContainEqual({ kind: "exclusion", text: "不要高階護理先修" });
  });

  it("keeps pedagogical preferences that contribute to subject relevance", () => {
    const result = sanitizeSubjectQuery("想學 Python 程式設計與人工智慧，希望課程有實作與業界案例");
    expect(result.subjectQuery).toBe("Python 程式設計與人工智慧，希望課程有實作與業界案例");
    expect(result.detectedFilterPhrases).toEqual([]);
  });

  it("detects explicit credit and course-scope filters", () => {
    const result = sanitizeSubjectQuery("想學資料分析，只要兩學分，限本系選修課程");
    expect(result.subjectQuery).toBe("資料分析");
    expect(result.detectedFilterPhrases.map((item) => item.kind)).toEqual(expect.arrayContaining(["credit", "course_scope"]));
  });

  it("returns an empty subject when the input only contains filters", () => {
    const result = sanitizeSubjectQuery("只能星期六，不要先修，兩學分");
    expect(result.subjectQuery).toBe("");
    expect(result.detectedFilterPhrases.length).toBeGreaterThanOrEqual(3);
  });

  it("removes the complete no-prerequisite phrase from the subject text", () => {
    const result = sanitizeSubjectQuery("想學資料分析，無先修課程");
    expect(result.subjectQuery).toBe("資料分析");
    expect(result.detectedFilterPhrases).toContainEqual({ kind: "prerequisite", text: "無先修課程" });
  });
});
