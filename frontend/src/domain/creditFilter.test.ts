import { describe, expect, it } from "vitest";
import {
  formatCreditFilterSummary,
  getHighCreditOptions,
  HIGH_CREDIT_THRESHOLD,
  isHighCreditFilterSelected,
  toggleHighCreditFilter,
} from "./creditFilter";

describe("getHighCreditOptions", () => {
  it("keeps every credit value at or above the threshold", () => {
    expect(getHighCreditOptions([1, 2, 3, 4, 5, 6])).toEqual([4, 5, 6]);
    expect(HIGH_CREDIT_THRESHOLD).toBe(4);
  });

  it("preserves the incoming order instead of sorting", () => {
    expect(getHighCreditOptions([6, 2, 4, 9])).toEqual([6, 4, 9]);
  });

  it("returns nothing when the catalog only offers low credit courses", () => {
    expect(getHighCreditOptions([1, 2, 3])).toEqual([]);
    expect(getHighCreditOptions([])).toEqual([]);
  });
});

describe("isHighCreditFilterSelected", () => {
  it("is selected only when every covered credit value is selected", () => {
    expect(isHighCreditFilterSelected([4, 5, 6], [4, 5, 6])).toBe(true);
    expect(isHighCreditFilterSelected([4, 6], [4, 5, 6])).toBe(false);
  });

  it("ignores unrelated selected credits", () => {
    expect(isHighCreditFilterSelected([1, 2, 4, 5], [4, 5])).toBe(true);
  });

  it("is never selected when there is nothing to cover", () => {
    expect(isHighCreditFilterSelected([], [])).toBe(false);
    expect(isHighCreditFilterSelected([1, 2], [])).toBe(false);
  });
});

describe("toggleHighCreditFilter", () => {
  it("adds every covered credit value when the combined chip is off", () => {
    expect(toggleHighCreditFilter([2], [4, 5])).toEqual([2, 4, 5]);
  });

  it("does not duplicate credits that were already selected individually", () => {
    expect(toggleHighCreditFilter([4], [4, 5])).toEqual([4, 5]);
  });

  it("removes every covered credit value when the combined chip is on", () => {
    expect(toggleHighCreditFilter([2, 4, 5], [4, 5])).toEqual([2]);
  });

  it("leaves the selection untouched when there is nothing to cover", () => {
    expect(toggleHighCreditFilter([1, 2], [])).toEqual([1, 2]);
  });

  it("does not mutate the incoming selection", () => {
    const selected = [2];
    toggleHighCreditFilter(selected, [4, 5]);
    expect(selected).toEqual([2]);
  });
});

describe("formatCreditFilterSummary", () => {
  it("is empty when nothing is selected", () => {
    expect(formatCreditFilterSummary([], [4, 5])).toBe("");
  });

  it("lists individual credits in ascending order", () => {
    expect(formatCreditFilterSummary([3, 1, 2], [])).toBe("1 學分、2 學分、3 學分");
  });

  it("folds the covered credits into the combined label and puts it last", () => {
    expect(formatCreditFilterSummary([2, 4, 5], [4, 5])).toBe("2 學分、4 學分以上");
  });

  it("keeps high credits listed individually while the combined chip is incomplete", () => {
    expect(formatCreditFilterSummary([2, 4], [4, 5])).toBe("2 學分、4 學分");
  });

  it("does not mutate the incoming selection while sorting", () => {
    const selected = [3, 1];
    formatCreditFilterSummary(selected, []);
    expect(selected).toEqual([3, 1]);
  });
});
