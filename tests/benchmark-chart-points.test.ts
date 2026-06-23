import { describe, expect, it } from "vitest";
import { visibleMarkerMask } from "../apps/web/app/benchmarks/components/chart-points";

describe("benchmark chart point markers", () => {
  it("shows only the boundaries of a repeated plateau", () => {
    expect(visibleMarkerMask([5, 5, 5, 5])).toEqual([true, false, false, true]);
  });

  it("shows every non-repeated value", () => {
    expect(visibleMarkerMask([1, 2, 3, 4])).toEqual([true, true, true, true]);
  });

  it("groups values that have the same displayed value", () => {
    const formatValue = (value: number) => value.toFixed(1);

    expect(visibleMarkerMask([117.21, 117.22, 117.24, 117.31], formatValue)).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it("treats missing values as plateau boundaries", () => {
    expect(visibleMarkerMask([null, 4, 4, null, 4, 4, 4])).toEqual([
      false,
      true,
      true,
      false,
      true,
      false,
      true,
    ]);
  });
});
