import { describe, expect, it } from "vitest";
import {
  benchmarkSelectionUrl,
  individualRunsVisibilityUrl,
  resolveIndividualRunsVisibilityFromSearch,
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

  it("resolves individual run visibility from URL state", () => {
    expect(resolveIndividualRunsVisibilityFromSearch("?benchmark=client-size")).toBe(true);
    expect(resolveIndividualRunsVisibilityFromSearch("?benchmark=client-size&runs=hidden")).toBe(
      false,
    );
  });

  it("only persists the non-default hidden individual runs state", () => {
    expect(
      individualRunsVisibilityUrl(
        "/benchmarks",
        new URLSearchParams("benchmark=client-size"),
        false,
        "#trends",
      ),
    ).toBe("/benchmarks?benchmark=client-size&runs=hidden#trends");
    expect(
      individualRunsVisibilityUrl(
        "/benchmarks",
        new URLSearchParams("benchmark=client-size&runs=hidden"),
        true,
        "#trends",
      ),
    ).toBe("/benchmarks?benchmark=client-size#trends");
  });
});
