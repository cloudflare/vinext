/**
 * Tests for TPR's zone-analytics traffic query and route selection.
 *
 * The query is the step that decides which pages TPR pre-renders, and a
 * malformed one is invisible: runTPR treats a query failure as "no traffic
 * data" and skips gracefully, so TPR silently does nothing. These tests pin
 * the parts of the GraphQL request the schema actually validates, and the
 * shape of the response that is parsed back out.
 */
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import {
  queryTraffic,
  filterTrafficPaths,
  selectRoutes,
  type TrafficEntry,
} from "../packages/cloudflare/src/tpr.js";

/** Capture the outgoing GraphQL query and reply with a canned analytics payload. */
function mockAnalytics(
  groups: Array<{ count: number; dimensions: { clientRequestPath: string } }>,
): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "{}";
    calls.push((JSON.parse(body) as { query: string }).query);
    return new Response(
      JSON.stringify({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: groups }] } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { calls };
}

describe("queryTraffic", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests fields that exist on httpRequestsAdaptiveGroups", async () => {
    const { calls } = mockAnalytics([]);
    await queryTraffic("zone-tag", "token", 24);

    // `httpRequestsAdaptiveGroups` exposes `count`, not `sum { requests }`.
    // Asking for the latter fails schema validation outright:
    //   orderBy: unknown enum value sum_requests_DESC
    //   unknown field "requests"
    // Both are rejected regardless of zone plan, so the query never returns.
    expect(calls[0]).toContain("orderBy: [count_DESC]");
    expect(calls[0]).toContain("count");
    expect(calls[0]).not.toContain("sum_requests_DESC");
    expect(calls[0]).not.toContain("sum { requests }");
  });

  it("counts only eyeball traffic over the requested window", async () => {
    const { calls } = mockAnalytics([]);
    await queryTraffic("zone-tag", "token", 24);

    // Worker-to-worker and internal subrequests are not pages a visitor asked
    // for, so pre-rendering them would spend the budget on the wrong routes.
    expect(calls[0]).toContain('requestSource: "eyeball"');
    expect(calls[0]).toContain("datetime_geq:");
    expect(calls[0]).toContain("datetime_lt:");
  });

  it("maps the response into traffic entries", async () => {
    mockAnalytics([
      { count: 120, dimensions: { clientRequestPath: "/blog" } },
      { count: 30, dimensions: { clientRequestPath: "/about" } },
    ]);

    expect(await queryTraffic("zone-tag", "token", 24)).toEqual([
      { path: "/blog", requests: 120 },
      { path: "/about", requests: 30 },
    ]);
  });

  it("surfaces GraphQL errors instead of reporting empty traffic", async () => {
    // A silent empty result is indistinguishable from a zone with no traffic,
    // which is what made the malformed query undetectable.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ errors: [{ message: "unknown enum value" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(queryTraffic("zone-tag", "token", 24)).rejects.toThrow(/unknown enum value/);
  });
});

describe("filterTrafficPaths", () => {
  it("keeps pages and drops everything that is not one", () => {
    const entries: TrafficEntry[] = [
      { path: "/", requests: 10 },
      { path: "/blog/post", requests: 9 },
      { path: "/_next/static/chunks/main.js", requests: 8 },
      { path: "/styles/app.css", requests: 7 },
      { path: "/logo.svg", requests: 6 },
      { path: "/api/revalidate", requests: 5 },
      { path: "/__vinext/internal", requests: 4 },
      { path: "/blog/post.rsc", requests: 3 },
      { path: "not-a-path", requests: 2 },
    ];

    expect(filterTrafficPaths(entries).map((e) => e.path)).toEqual(["/", "/blog/post"]);
  });
});

describe("selectRoutes", () => {
  const traffic: TrafficEntry[] = [
    { path: "/a", requests: 70 },
    { path: "/b", requests: 20 },
    { path: "/c", requests: 10 },
  ];

  it("stops once the coverage target is met", () => {
    const selected = selectRoutes(traffic, 90, 1000);
    expect(selected.routes.map((r) => r.path)).toEqual(["/a", "/b"]);
    expect(selected.totalRequests).toBe(100);
    expect(selected.coveredRequests).toBe(90);
    expect(selected.coveragePercent).toBe(90);
  });

  it("honours the hard cap before the coverage target", () => {
    expect(selectRoutes(traffic, 100, 1).routes.map((r) => r.path)).toEqual(["/a"]);
  });

  it("returns nothing for a zone with no traffic", () => {
    expect(selectRoutes([], 90, 1000)).toEqual({
      routes: [],
      totalRequests: 0,
      coveredRequests: 0,
      coveragePercent: 0,
    });
  });
});
