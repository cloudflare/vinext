import { describe, expect, it } from "vitest";
import {
  benchmarkSelectionUrl,
  resolveSelectedBenchmark,
  resolveSelectedBenchmarkFromSearch,
} from "../apps/web/app/benchmarks/components/benchmark-url-state";

describe("benchmark URL state", () => {
  it("selects the requested benchmark when it exists", () => {
    expect(resolveSelectedBenchmark(["client-size", "production-build"], "production-build")).toBe(
      "production-build",
    );
  });

  it("falls back to the first benchmark for missing or invalid state", () => {
    expect(resolveSelectedBenchmark(["client-size", "production-build"], null)).toBe("client-size");
    expect(resolveSelectedBenchmark(["client-size", "production-build"], "unknown")).toBe(
      "client-size",
    );
    expect(resolveSelectedBenchmark([], "production-build")).toBeUndefined();
  });

  it("resolves the selected benchmark from a browser search string", () => {
    expect(
      resolveSelectedBenchmarkFromSearch(
        ["client-size", "production-build"],
        "?view=compact&benchmark=production-build",
      ),
    ).toBe("production-build");
  });

  it("updates the benchmark while preserving other URL state", () => {
    expect(
      benchmarkSelectionUrl(
        "/benchmarks",
        new URLSearchParams("view=compact&benchmark=client-size"),
        "production-build",
        "#trends",
      ),
    ).toBe("/benchmarks?view=compact&benchmark=production-build#trends");
  });
});
