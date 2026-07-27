/**
 * Tests for TPR's zone-analytics traffic query and route selection.
 *
 * The query is the step that decides which pages TPR pre-renders. These tests
 * pin the parts of the GraphQL request the schema actually validates and the
 * shape of the response that is parsed back out.
 */
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  queryTraffic,
  filterTrafficPaths,
  resolveZoneId,
  runTPR,
  selectRoutes,
  type TrafficEntry,
} from "../packages/cloudflare/src/tpr.js";

type AnalyticsPayload = {
  query: string;
  variables: {
    zoneTag: string;
    start: string;
    end: string;
    hostname: string;
    pathLike?: string;
  };
};

/** Capture the outgoing GraphQL query and reply with a canned analytics payload. */
function mockAnalytics(
  groups: Array<{ count: number; dimensions: { clientRequestPath: string } }>,
): { calls: Array<{ url: string; init: RequestInit; payload: AnalyticsPayload }> } {
  const calls: Array<{ url: string; init: RequestInit; payload: AnalyticsPayload }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const body = typeof init?.body === "string" ? init.body : "{}";
    calls.push({ url, init, payload: JSON.parse(body) as AnalyticsPayload });
    return new Response(
      JSON.stringify({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: groups }] } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("queryTraffic", () => {
  it("requests fields that exist on httpRequestsAdaptiveGroups", async () => {
    const { calls } = mockAnalytics([]);
    await queryTraffic("zone-tag", "token", 24, "app.example.com");
    const { query } = calls[0].payload;

    // `httpRequestsAdaptiveGroups` exposes `count`, not `sum { requests }`.
    // Asking for the latter fails schema validation outright:
    //   orderBy: unknown enum value sum_requests_DESC
    //   unknown field "requests"
    // Both are rejected regardless of zone plan, so the query never returns.
    expect(query).toContain("limit: 10000");
    expect(query).toContain("orderBy: [count_DESC]");
    expect(query).toContain("dimensions { clientRequestPath }");
    // `count` as a selected field, on its own line — asserting the substring
    // alone would be satisfied by `count_DESC` in orderBy and prove nothing.
    expect(query).toMatch(/^\s*count\s*$/m);
    expect(query).not.toContain("sum_requests_DESC");
    expect(query).not.toContain("sum { requests }");
  });

  it("scopes traffic to the requested hostname and time window using variables", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    const { calls } = mockAnalytics([]);
    const hostname = 'app.example.com" }) { injected } #';
    const pathLike = '/blog/%" }) { injected } #';
    await queryTraffic("zone-tag", "token", 24, hostname, pathLike);
    const call = calls[0];

    // Worker-to-worker and internal subrequests are not pages a visitor asked
    // for, so pre-rendering them would spend the budget on the wrong routes.
    expect(call.payload.query).toContain('requestSource: "eyeball"');
    expect(call.payload.query).toContain("clientRequestHTTPHost: $hostname");
    expect(call.payload.query).toContain("clientRequestPath_like: $pathLike");
    expect(call.payload.query).not.toContain(hostname);
    expect(call.payload.query).not.toContain(pathLike);
    expect(call.payload.variables).toEqual({
      zoneTag: "zone-tag",
      start: "2026-07-26T12:00:00.000Z",
      end: "2026-07-27T12:00:00.000Z",
      hostname,
      pathLike,
    });
  });

  it("authenticates a JSON POST to Cloudflare's GraphQL endpoint", async () => {
    const { calls } = mockAnalytics([]);
    await queryTraffic("zone-tag", "secret-token", 24, "app.example.com");

    const call = calls[0];
    expect(call.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("maps the response into traffic entries", async () => {
    mockAnalytics([
      { count: 120, dimensions: { clientRequestPath: "/blog" } },
      { count: 30, dimensions: { clientRequestPath: "/about" } },
    ]);

    expect(await queryTraffic("zone-tag", "token", 24, "app.example.com")).toEqual([
      { path: "/blog", requests: 120 },
      { path: "/about", requests: 30 },
    ]);
  });

  it("surfaces GraphQL errors instead of reporting empty traffic", async () => {
    // Keep API failures distinct from a real zone with no traffic so runTPR
    // can report why it skipped pre-rendering.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ errors: [{ message: "unknown enum value" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(queryTraffic("zone-tag", "token", 24, "app.example.com")).rejects.toThrow(
      /unknown enum value/,
    );
  });

  it("surfaces HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );

    await expect(queryTraffic("zone-tag", "token", 24, "app.example.com")).rejects.toThrow(
      "Zone analytics query failed: 403 Forbidden",
    );
  });

  it("excludes non-page rows before applying the 10,000-row limit", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      const { query } = JSON.parse(init.body) as AnalyticsPayload;
      const hasServerExclusions =
        query.includes('clientRequestPath_notlike: "%.js"') &&
        query.includes('clientRequestPath_notlike: "/api/%"') &&
        query.includes('clientRequestPath_notlike: "/_next/%"');
      const groups = hasServerExclusions
        ? [{ count: 42, dimensions: { clientRequestPath: "/real-page" } }]
        : Array.from({ length: 10_000 }, (_, index) => ({
            count: 100_000 - index,
            dimensions: { clientRequestPath: `/_next/static/chunk-${index}.js` },
          }));
      return new Response(
        JSON.stringify({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: groups }] } } }),
        { headers: { "Content-Type": "application/json" } },
      );
    });

    await expect(queryTraffic("zone-tag", "token", 24, "app.example.com")).resolves.toEqual([
      { path: "/real-page", requests: 42 },
    ]);
  });
});

describe("resolveZoneId", () => {
  it("prefers the longest matching zone and sends bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "child-zone", account: { id: "child-account" } }],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });

    await expect(resolveZoneId("shop.example.com", "secret-token")).resolves.toBe("child-zone");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).searchParams.get("name")).toBe("shop.example.com");
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Bearer secret-token");
  });

  it("falls back through suffixes and URL-encodes the candidate", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const name = new URL(url).searchParams.get("name");
      return new Response(
        JSON.stringify({
          success: true,
          result: name === "example.com" ? [{ id: "parent-zone" }] : [],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });

    await expect(resolveZoneId("a+b.example.com", "token")).resolves.toBe("parent-zone");
    expect(urls[0]).toContain("name=a%2Bb.example.com");
    expect(urls.map((url) => new URL(url).searchParams.get("name"))).toEqual([
      "a+b.example.com",
      "example.com",
    ]);
  });

  it("surfaces Cloudflare API errors", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }),
    );

    await expect(resolveZoneId("app.example.com", "token")).rejects.toThrow(
      "Zone lookup failed: 503 Service Unavailable",
    );
  });

  it("returns null when none of the hostname suffixes is an accessible zone", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ success: true, result: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(resolveZoneId("app.example.com", "token")).resolves.toBeNull();
  });
});

describe("runTPR traffic lookup", () => {
  it("uses the resolved zone's account and hostname when account_id is omitted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tpr-traffic-"));
    fs.writeFileSync(
      path.join(root, "wrangler.json"),
      JSON.stringify({
        custom_domains: ["app.example.com"],
        kv_namespaces: [{ binding: "VINEXT_KV_CACHE", id: "kv-id" }],
      }),
    );

    const urls: string[] = [];
    const previousToken = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "token";
    try {
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        urls.push(url);
        if (url.includes("/zones?")) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ id: "zone-id", account: { id: "zone-account-id" } }],
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/graphql")) {
          if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
          const payload = JSON.parse(init.body) as AnalyticsPayload;
          expect(payload.variables.hostname).toBe("app.example.com");
          return new Response(
            JSON.stringify({
              data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected API request: ${url}`);
      });

      await expect(runTPR({ root, coverage: 90, limit: 1000, window: 24 })).resolves.toMatchObject({
        skipped: "no traffic data available (first deploy?)",
      });
      expect(urls.some((url) => url.includes("/accounts?"))).toBe(false);
    } finally {
      if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = previousToken;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors an explicit route zone while filtering by route hostname and path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tpr-route-zone-"));
    fs.writeFileSync(
      path.join(root, "wrangler.json"),
      JSON.stringify({
        routes: [
          {
            pattern: "app.example.com/blog/*",
            zone_name: "example.com",
          },
        ],
        kv_namespaces: [{ binding: "VINEXT_KV_CACHE", id: "kv-id" }],
      }),
    );

    const previousToken = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "token";
    try {
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        if (url.includes("/zones?")) {
          expect(new URL(url).searchParams.get("name")).toBe("example.com");
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ id: "parent-zone", account: { id: "parent-account" } }],
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/graphql")) {
          if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
          const payload = JSON.parse(init.body) as AnalyticsPayload;
          expect(payload.variables).toMatchObject({
            zoneTag: "parent-zone",
            hostname: "app.example.com",
            pathLike: "/blog/%",
          });
          return new Response(
            JSON.stringify({
              data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected API request: ${url}`);
      });

      await expect(runTPR({ root, coverage: 90, limit: 1000, window: 24 })).resolves.toMatchObject({
        skipped: "no traffic data available (first deploy?)",
      });
    } finally {
      if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = previousToken;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers an explicit route zone_id without performing a name lookup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tpr-route-zone-id-"));
    fs.writeFileSync(
      path.join(root, "wrangler.json"),
      JSON.stringify({
        routes: [
          {
            pattern: "app.example.com/*",
            zone_id: "explicit/zone",
            zone_name: "example.com",
          },
        ],
        kv_namespaces: [{ binding: "VINEXT_KV_CACHE", id: "kv-id" }],
      }),
    );

    const previousToken = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "token";
    try {
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("/zones/")) {
          expect(url.endsWith("/zones/explicit%2Fzone")).toBe(true);
          return new Response(
            JSON.stringify({
              success: true,
              result: { id: "explicit/zone", account: { id: "route-account" } },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/graphql")) {
          return new Response(
            JSON.stringify({
              data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected API request: ${url}`);
      });

      await expect(runTPR({ root, coverage: 90, limit: 1000, window: 24 })).resolves.toMatchObject({
        skipped: "no traffic data available (first deploy?)",
      });
    } finally {
      if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = previousToken;
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      { path: "/api", requests: 5 },
      { path: "/__vinext/internal", requests: 4 },
      { path: "/__vinext", requests: 4 },
      { path: "/_next", requests: 4 },
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
