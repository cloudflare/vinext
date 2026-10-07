import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  filterTrafficPaths,
  resolveTPRRoutes,
  selectRoutes,
} from "../packages/cloudflare/src/tpr.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.CLOUDFLARE_API_TOKEN;
});

describe("TPR route resolution", () => {
  it.each([
    ["missing token", "no CLOUDFLARE_API_TOKEN set"],
    ["missing zone", "could not resolve zone for app.example.com"],
    ["analytics failure", "analytics query failed: Zone analytics error: denied"],
    ["empty traffic", "no traffic data available (first deploy?)"],
  ])("preserves the typed warmup origin with %s", async (scenario, skipped) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tpr-skip-"));
    try {
      const output = path.join(root, ".cloudflare/output/v0/workers/default");
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(
        path.join(output, "worker.config.json"),
        JSON.stringify({ domains: ["app.example.com"] }),
      );
      if (scenario === "missing token") delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = "token";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = input instanceof Request ? input.url : input.toString();
          if (url.includes("/zones?")) {
            return Response.json({
              success: true,
              result: scenario === "missing zone" ? [] : [{ id: "zone-id" }],
            });
          }
          return Response.json(
            scenario === "analytics failure"
              ? { errors: [{ message: "denied" }] }
              : { data: { viewer: { zones: [] } } },
          );
        }),
      );
      await expect(resolveTPRRoutes({ root, typedConfig: true, window: 24 })).resolves.toEqual({
        routes: [],
        targetUrl: "https://app.example.com",
        skipped,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a generated typed-config domain instead of a Wrangler config", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tpr-typed-"));
    try {
      fs.writeFileSync(
        path.join(root, "wrangler.jsonc"),
        JSON.stringify({ custom_domains: ["stale.example.org"] }),
      );
      const configPath = path.join(
        root,
        ".cloudflare/output/v0/workers/default/worker.config.json",
      );
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ domains: ["app.example.com"] }));
      process.env.CLOUDFLARE_API_TOKEN = "token";
      const fetchMock = vi.fn(async () => Response.json({ success: true, result: [] }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        resolveTPRRoutes({ root, typedConfig: true, window: 24 }),
      ).resolves.toMatchObject({ skipped: "could not resolve zone for app.example.com" });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/zones?name=example.com",
        expect.any(Object),
      );

      fs.writeFileSync(configPath, JSON.stringify({ domains: [] }));
      fetchMock.mockClear();
      await expect(
        resolveTPRRoutes({ root, typedConfig: true, window: 24 }),
      ).resolves.toMatchObject({ skipped: "no custom domain — zone analytics unavailable" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("filters non-page traffic and selects the smallest requested coverage", () => {
    const traffic = filterTrafficPaths([
      { path: "/hot", requests: 70 },
      { path: "/warm", requests: 20 },
      { path: "/cold", requests: 10 },
      { path: "/api/users", requests: 100 },
      { path: "/_next/app.js", requests: 100 },
    ]);

    expect(selectRoutes(traffic, 80, 100).routes.map(({ path }) => path)).toEqual([
      "/hot",
      "/warm",
    ]);
  });

  it("keeps exact /api App Router page candidates", () => {
    expect(filterTrafficPaths([{ path: "/api", requests: 1 }])).toEqual([
      { path: "/api", requests: 1 },
    ]);
  });

  it.each([false, true])(
    "returns hot routes without rendering or writing cache entries (typed config: %s)",
    async (typedConfig) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tpr-routes-"));
      fs.writeFileSync(
        path.join(root, "wrangler.jsonc"),
        JSON.stringify({ custom_domains: ["app.example.com"] }),
      );
      if (typedConfig) {
        const output = path.join(root, ".cloudflare/output/v0/workers/default");
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(
          path.join(output, "worker.config.json"),
          JSON.stringify({ domains: ["app.example.com"] }),
        );
      }
      process.env.CLOUDFLARE_API_TOKEN = "token";
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.includes("/zones?")) {
          return Response.json({ success: true, result: [{ id: "zone-id" }] });
        }
        const body = JSON.parse(init?.body as string);
        expect(body.query).toContain("orderBy: [count_DESC]");
        expect(body.query).not.toContain("clientRequestHTTPHost");
        expect(body.variables).toMatchObject({
          zoneTag: "zone-id",
        });
        expect(body.variables).not.toHaveProperty("hostname");
        return Response.json({
          data: {
            viewer: {
              zones: [
                {
                  httpRequestsAdaptiveGroups: [
                    { count: 80, dimensions: { clientRequestPath: "/hot" } },
                    { count: 20, dimensions: { clientRequestPath: "/cold" } },
                  ],
                },
              ],
            },
          },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(resolveTPRRoutes({ root, typedConfig, window: 24 })).resolves.toMatchObject({
        targetUrl: typedConfig ? "https://app.example.com" : undefined,
        routes: [
          { path: "/hot", requests: 80 },
          { path: "/cold", requests: 20 },
        ],
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    },
  );
});
