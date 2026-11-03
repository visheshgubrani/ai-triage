import { describe, expect, it } from "vitest";
import { wilsonLowerBound } from "./stats";

describe("wilsonLowerBound", () => {
  it("is 0 for an empty sample", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it("stays well below 1 for a perfect small sample", () => {
    // 10/10 correct is not evidence of 99% precision.
    expect(wilsonLowerBound(10, 10)).toBeCloseTo(0.7225, 3);
  });

  it("tightens as n grows", () => {
    expect(wilsonLowerBound(990, 1000)).toBeGreaterThan(0.98);
  });

  it("rejects impossible counts", () => {
    expect(() => wilsonLowerBound(11, 10)).toThrow(RangeError);
  });
});
