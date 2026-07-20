import { describe, expect, it } from "vitest";
import {
  CLASSIFIED_SUITES,
  getSuiteSupport,
  NON_SUPPORTED_SUITES,
  SUITE_SUPPORT_POLICY,
} from "../apps/web/app/compatibility/suite-support";
import {
  bucketByRouter,
  bucketPassRate,
  bucketSupportedPassRate,
} from "../apps/web/app/compatibility/router-buckets";

describe("compatibility suite support policy", () => {
  it("defaults newly-added suites to supported", () => {
    expect(getSuiteSupport("test/e2e/new-suite/new-suite.test.ts")).toEqual({
      status: "supported",
      feature: null,
      reason: null,
    });
  });

  it("keeps deferred, Vite-equivalent, and unsupported states distinct", () => {
    const counts = Object.values(SUITE_SUPPORT_POLICY).reduce(
      (result, policy) => {
        result[policy.status]++;
        return result;
      },
      { deferred: 0, "needs-vite-equivalent": 0, unsupported: 0 },
    );

    expect(counts).toEqual({
      deferred: 25,
      "needs-vite-equivalent": 3,
      unsupported: 5,
    });
    expect(NON_SUPPORTED_SUITES).toHaveLength(33);
    expect(CLASSIFIED_SUITES).toHaveLength(69);
    expect(new Set(CLASSIFIED_SUITES).size).toBe(69);
  });

  it("uses canonical Next.js suite paths", () => {
    for (const suite of NON_SUPPORTED_SUITES) {
      expect(suite).toMatch(/^test\/e2e\/.+\.test\.[jt]sx?$/);
      expect(getSuiteSupport(suite).reason).toBeTruthy();
    }
  });
});

describe("compatibility rate buckets", () => {
  it("retains raw results while excluding non-supported suites from the supported rate", () => {
    const buckets = bucketByRouter([
      {
        router: "app" as const,
        supportStatus: "supported" as const,
        passed: 8,
        failed: 2,
        skipped: 1,
      },
      {
        router: "app" as const,
        supportStatus: "deferred" as const,
        passed: 1,
        failed: 9,
        skipped: 0,
      },
      {
        router: "both" as const,
        supportStatus: "supported" as const,
        passed: 5,
        failed: 0,
        skipped: 0,
      },
    ]);

    expect(buckets.all).toEqual({
      files: 3,
      passed: 14,
      failed: 11,
      skipped: 1,
      supportedPassed: 13,
      supportedFailed: 2,
    });
    expect(bucketPassRate(buckets.all)).toBeCloseTo(56, 2);
    expect(bucketSupportedPassRate(buckets.all)).toBeCloseTo(86.67, 2);

    // Mixed suites continue to count toward both router buckets.
    expect(buckets.app.supportedPassed).toBe(13);
    expect(buckets.pages.supportedPassed).toBe(5);
  });
});
