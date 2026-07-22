import { describe, expect, it } from "vite-plus/test";
import { findSortedStringPosition } from "../packages/vinext/src/utils/sorted-array.js";

describe("sorted array utilities", () => {
  it("finds existing sorted string positions", () => {
    const values = ["alpha", "bravo", "charlie", "delta"];

    expect(findSortedStringPosition(values, "alpha")).toEqual({ found: true, index: 0 });
    expect(findSortedStringPosition(values, "charlie")).toEqual({ found: true, index: 2 });
    expect(findSortedStringPosition(values, "delta")).toEqual({ found: true, index: 3 });
  });

  it("returns insertion positions for missing sorted strings", () => {
    const values = ["bravo", "delta"];

    expect(findSortedStringPosition([], "alpha")).toEqual({ found: false, index: 0 });
    expect(findSortedStringPosition(values, "alpha")).toEqual({ found: false, index: 0 });
    expect(findSortedStringPosition(values, "charlie")).toEqual({ found: false, index: 1 });
    expect(findSortedStringPosition(values, "echo")).toEqual({ found: false, index: 2 });
  });
});
