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
  it("filters non-page traffic and selects the smallest requested coverage", () => {
    const traffic = filterTrafficPaths([
      { path: "/hot", requests: 70 },
      { path: "/warm", requests: 20 },
      { path: "/cold", requests: 10 },
      { path: "/api", requests: 100 },
      { path: "/_next/app.js", requests: 100 },
    ]);

    expect(selectRoutes(traffic, 80, 100).routes.map(({ path }) => path)).toEqual([
      "/hot",
      "/warm",
    ]);
  });

  it("returns hot routes without rendering or writing cache entries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tpr-routes-"));
    fs.writeFileSync(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({ custom_domains: ["app.example.com"] }),
    );
    process.env.CLOUDFLARE_API_TOKEN = "token";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/zones?")) {
        return Response.json({ success: true, result: [{ id: "zone-id" }] });
      }
      const body = JSON.parse(init?.body as string);
      expect(body.query).toContain("orderBy: [count_DESC]");
      expect(body.variables).toMatchObject({
        hostname: "app.example.com",
        zoneTag: "zone-id",
      });
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

    await expect(resolveTPRRoutes({ root, window: 24 })).resolves.toMatchObject({
      routes: [
        { path: "/hot", requests: 80 },
        { path: "/cold", requests: 20 },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
