import { describe, expect, it } from "vitest";
import { hasRollingMedian, rollingMedian } from "../apps/web/app/benchmarks/components/trend";

describe("benchmark chart rolling median", () => {
  it("starts after a complete observation window", () => {
    expect(rollingMedian([9, 1, 8, 2, 7, 3, 6, 4], 7)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      6,
      4,
    ]);
  });

  it("keeps missing runs as gaps without consuming the observation window", () => {
    expect(rollingMedian([1, 2, null, 100, 4], 3)).toEqual([null, null, null, 2, 4]);
  });

  it("averages the middle values for even windows", () => {
    expect(rollingMedian([1, 10, 2, 9], 4)).toEqual([null, null, null, 5.5]);
  });

  it("rejects invalid window sizes", () => {
    expect(() => rollingMedian([1], 0)).toThrow("Rolling median window must be a positive integer");
  });

  it("only offers a trend view after enough actual observations", () => {
    expect(hasRollingMedian([1, null, 2, 3], 4)).toBe(false);
    expect(hasRollingMedian([1, null, 2, 3, 4], 4)).toBe(true);
  });
});
