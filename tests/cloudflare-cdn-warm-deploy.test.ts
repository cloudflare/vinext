import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VINEXT_RSC_BUILD_ID_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { VINEXT_CDN_BUILD_ID_HEADER } from "../packages/cloudflare/src/cache/cdn-build-id.js";
import { VINEXT_EXPECTED_WORKER_VERSION_HEADER } from "../packages/cloudflare/src/version-headers.js";
import { CACHEABILITY_MANIFEST_PLACEHOLDER } from "../packages/vinext/src/server/cacheability-manifest.js";
import {
  CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY,
  CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS,
} from "../packages/vinext/src/server/cacheability-limits.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const delayMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setTimeout: delayMock,
  };
});

let tmpDir: string;

function writeFile(relativePath: string, content: string): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function writeTwoStageArtifact(): void {
  writeFile("dist/server/vinext-server.json", JSON.stringify({ prerenderSecret: "secret-a" }));
  writeFile(
    "dist/server/entry.js",
    `const cacheabilityManifest = ${JSON.stringify(CACHEABILITY_MANIFEST_PLACEHOLDER)};`,
  );
  writeFile("dist/server/wrangler.json", "{}");
}

function formatFetchUrl(url: Parameters<typeof fetch>[0]): string {
  if (url instanceof URL) return url.href;
  if (typeof url === "string") return url;
  return url.url;
}

function isReadinessFetch(url: Parameters<typeof fetch>[0]): boolean {
  return new URL(formatFetchUrl(url)).searchParams.has("__vinext_cdn_warm_readiness");
}

function getRealWarmFetchCalls() {
  return vi.mocked(fetch).mock.calls.filter(([url]) => !isReadinessFetch(url));
}

function cacheableHtml(body = "ok", cacheStatus = "MISS"): Response {
  return new Response(body, {
    headers: {
      "cf-cache-status": cacheStatus,
      "content-type": "text/html",
      [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a",
    },
  });
}

function cacheableRsc(body = "flight"): Response {
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "cdn-cache-control": "public, max-age=60",
      "cf-cache-status": "MISS",
      "content-type": "text/x-component",
      [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a",
      [VINEXT_RSC_BUILD_ID_HEADER]: "app-build-a",
      vary: VINEXT_RSC_VARY_HEADER,
    },
  });
}

describe("Cloudflare CDN warmup deploy flow", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cdn-warm-deploy-test-"));
    execFileSyncMock.mockReset();
    delayMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => cacheableHtml()),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recognizes warm plans that contain only canonical RSC requests", async () => {
    const { hasCdnWarmRequests } = await import("../packages/cloudflare/src/deploy.js");

    expect(hasCdnWarmRequests({ loadingShellPaths: [], paths: [], rscPaths: ["/dashboard"] })).toBe(
      true,
    );
    expect(hasCdnWarmRequests({ loadingShellPaths: ["/dashboard"], paths: [], rscPaths: [] })).toBe(
      true,
    );
    expect(hasCdnWarmRequests({ loadingShellPaths: [], paths: [], rscPaths: [] })).toBe(false);
  });

  it("keeps two-stage request deadlines beyond the Worker capture lease", async () => {
    const { resolveCacheabilityDeployRequestTimeoutMs } =
      await import("../packages/cloudflare/src/deploy.js");

    expect(resolveCacheabilityDeployRequestTimeoutMs()).toBeGreaterThan(
      CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS,
    );
    expect(resolveCacheabilityDeployRequestTimeoutMs(1_000)).toBeGreaterThan(
      CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS,
    );
    expect(resolveCacheabilityDeployRequestTimeoutMs(45_000)).toBe(45_000);
  });

  it("removes only the proven-dynamic HTML key and runtime-checks other representations", async () => {
    const { omitProvenDynamicWarmPaths } = await import("../packages/cloudflare/src/deploy.js");

    expect(
      omitProvenDynamicWarmPaths(
        {
          loadingShellPaths: ["/products/one", "/static"],
          paths: ["/products/one", "/products/two", "/static"],
          rscPaths: ["/products/one", "/products/two", "/static"],
        },
        [
          {
            kind: "app-page",
            pattern: "/products/:id",
            probePath: "/products/one",
            warmPaths: ["/products/one", "/products/two"],
          },
          {
            kind: "app-page",
            pattern: "/static",
            probePath: "/static",
            warmPaths: ["/static"],
          },
        ],
        {
          routes: {
            "app-page:/products/:id": {
              kind: "app-page",
              pattern: "/products/:id",
              state: "dynamic",
            },
            "app-page:/static": {
              kind: "app-page",
              pattern: "/static",
              state: "static-candidate",
            },
          },
          version: 1,
        },
      ),
    ).toEqual({
      omitted: 2,
      plan: {
        loadingShellPaths: ["/products/one", "/static"],
        paths: ["/static"],
        rscPaths: ["/products/one", "/products/two", "/static"],
      },
    });
  });

  it("adds proven exact and runtime-checked sibling representations to the final warm plan", async () => {
    const { includeCacheabilityManifestWarmPaths } =
      await import("../packages/cloudflare/src/deploy.js");

    expect(
      includeCacheabilityManifestWarmPaths(
        { loadingShellPaths: [], paths: ["/page"], rscPaths: ["/page"] },
        [
          {
            kind: "app-route",
            path: "/api/static",
            pattern: "/api/:kind",
            probePath: "/api/static",
            warmPaths: ["/api/static"],
          },
          {
            kind: "app-route",
            path: "/api/dynamic",
            pattern: "/api/:kind",
            probePath: "/api/dynamic",
            warmPaths: ["/api/dynamic"],
          },
          {
            kind: "pages-page",
            path: "/pages-ssr",
            pattern: "/pages-ssr",
            probePath: "/pages-ssr",
            runtimeCheckWarmPaths: ["/fr/pages-ssr"],
            warmPaths: ["/pages-ssr"],
          },
        ],
        {
          routes: {
            '["app-route","/api/:kind","/api/static"]': {
              kind: "app-route",
              path: "/api/static",
              pattern: "/api/:kind",
              state: "static-candidate",
            },
            '["app-route","/api/:kind","/api/dynamic"]': {
              kind: "app-route",
              path: "/api/dynamic",
              pattern: "/api/:kind",
              state: "dynamic",
            },
            "pages-page:/pages-ssr": {
              kind: "pages-page",
              pattern: "/pages-ssr",
              state: "static-candidate",
            },
          },
          version: 1,
        },
      ),
    ).toEqual({
      loadingShellPaths: [],
      paths: ["/page", "/api/static", "/fr/pages-ssr", "/pages-ssr"],
      rscPaths: ["/page"],
    });
  });

  it("derives rewritten warm representations from the staged Worker's resolved route kind", async () => {
    const { applyResolvedCacheabilityWarmKinds } =
      await import("../packages/cloudflare/src/deploy.js");
    const routes = [
      {
        kind: "app-page" as const,
        path: "/page-to-api",
        pattern: "/page-to-api",
        probePath: "/page-to-api",
        warmPaths: ["/page-to-api"],
      },
      {
        kind: "app-route" as const,
        path: "/api-to-page",
        pattern: "/api-to-page",
        probePath: "/api-to-page",
        warmPaths: ["/api-to-page"],
      },
      {
        kind: "app-page" as const,
        path: "/target-page",
        pattern: "/target-page",
        probePath: "/target-page",
        warmPaths: ["/target-page"],
      },
    ];

    expect(
      applyResolvedCacheabilityWarmKinds(
        {
          loadingShellPaths: ["/page-to-api", "/target-page"],
          paths: ["/page-to-api", "/api-to-page", "/target-page"],
          rscPaths: ["/page-to-api", "/target-page"],
        },
        routes,
        [
          {
            exactPath: "/page-to-api",
            kind: "app-route",
            pattern: "/target-api",
            sourceKind: "app-page",
            sourcePattern: "/page-to-api",
            state: "static-candidate",
          },
          {
            exactPath: "/api-to-page",
            kind: "app-page",
            pattern: "/target-page",
            sourceKind: "app-route",
            sourcePattern: "/api-to-page",
            state: "static-candidate",
          },
        ],
      ),
    ).toEqual({
      loadingShellPaths: ["/target-page", "/api-to-page"],
      paths: ["/target-page", "/page-to-api", "/api-to-page"],
      rscPaths: ["/target-page", "/api-to-page"],
    });
  });

  it("uploads a probe Worker, builds a route manifest, then warms and promotes a second Worker", async () => {
    const events: string[] = [];
    const warmPaths = Array.from({ length: 9 }, (_, index) => `/products/${index}`);
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker", workers_dev: true }));
    writeTwoStageArtifact();
    let uploadCount = 0;
    let statusCount = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploadCount += 1;
        const id =
          uploadCount === 1
            ? "22222222-2222-4222-8222-222222222222"
            : "33333333-3333-4333-8333-333333333333";
        events.push(`upload:${uploadCount}`);
        if (uploadCount === 1) {
          expect(fs.readFileSync(path.join(tmpDir, "dist/server/entry.js"), "utf-8")).toContain(
            CACHEABILITY_MANIFEST_PLACEHOLDER,
          );
        } else {
          const configArg = args[args.indexOf("--config") + 1];
          const artifact = fs.readFileSync(
            path.join(tmpDir, path.dirname(configArg), "entry.js"),
            "utf-8",
          );
          const manifestArtifact = fs.readFileSync(
            path.join(tmpDir, path.dirname(configArg), "__vinext_cacheability_manifest.js"),
            "utf-8",
          );
          expect(artifact).toContain("__vinext_cacheability_manifest.js");
          expect(manifestArtifact).toContain("static-candidate");
          expect(manifestArtifact).toContain("app-page:/products/:id");
          expect(artifact).not.toContain(CACHEABILITY_MANIFEST_PLACEHOLDER);
        }
        return `Uploaded my-worker\nWorker Version ID: ${id}\nVersion Preview URL: https://${id.slice(0, 8)}-my-worker.example.workers.dev\n`;
      }
      if (args.includes("status")) {
        statusCount += 1;
        events.push("status");
        return JSON.stringify({
          versions:
            statusCount >= 4
              ? [{ version_id: "33333333-3333-4333-8333-333333333333", percentage: 100 }]
              : [
                  { version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 },
                  ...(statusCount === 2
                    ? [
                        {
                          version_id: "22222222-2222-4222-8222-222222222222",
                          percentage: 0,
                        },
                      ]
                    : statusCount === 3
                      ? [
                          {
                            version_id: "33333333-3333-4333-8333-333333333333",
                            percentage: 0,
                          },
                        ]
                      : []),
                ],
        });
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        events.push("stage:probe");
        return "Staged version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("33333333-3333-4333-8333-333333333333@0%")) {
        events.push("stage:final");
        return "Staged version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("33333333-3333-4333-8333-333333333333@100%")) {
        events.push("promote:final");
        return "Deployed version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    let probeAttempts = 0;
    let warmAttempts = 0;
    let activeCacheRequests = 0;
    let peakWarmRequests = 0;
    let peakVerificationRequests = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get("X-Vinext-Cacheability-Probe") === "identity") {
        expect(headers.get("X-Vinext-Prerender-Secret")).toBe("secret-a");
        expect(headers.get("Cloudflare-Workers-Version-Overrides")).toContain(
          "22222222-2222-4222-8222-222222222222",
        );
        return Response.json({
          kind: "app-page",
          pattern: "/products/:id",
          status: 200,
          version: 1,
        });
      }
      if (headers.get("X-Vinext-Cacheability-Probe") === "1") {
        probeAttempts += 1;
        if (probeAttempts === 1) {
          events.push("probe-transient");
          return new Response("version route propagating", { status: 503 });
        }
        events.push("probe-route");
        expect(headers.get("X-Vinext-Prerender-Secret")).toBe("secret-a");
        expect(headers.get("Cloudflare-Workers-Version-Overrides")).toContain(
          "22222222-2222-4222-8222-222222222222",
        );
        return Response.json({
          kind: "app-page",
          pattern: "/products/:id",
          state: "static-candidate",
          status: 200,
          version: 1,
        });
      }
      if (isReadinessFetch(input)) {
        events.push("readiness:final");
        expect(headers.get("Cloudflare-Workers-Version-Overrides")).toContain(
          "33333333-3333-4333-8333-333333333333",
        );
      } else {
        warmAttempts += 1;
        const isVerification = warmAttempts > warmPaths.length;
        if (warmAttempts === 1) events.push("warm:final");
        if (warmAttempts === warmPaths.length + 1) events.push("verify:final");
        expect(headers.get("Cloudflare-Workers-Version-Overrides")).toBeNull();
        expect(headers.get("X-Vinext-Cacheability-Probe")).toBe("warm");
        expect(headers.get("X-Vinext-Prerender-Secret")).toBe("secret-a");
        activeCacheRequests += 1;
        if (isVerification) {
          peakVerificationRequests = Math.max(peakVerificationRequests, activeCacheRequests);
        } else {
          peakWarmRequests = Math.max(peakWarmRequests, activeCacheRequests);
        }
        await Promise.resolve();
        activeCacheRequests -= 1;
        return cacheableHtml("ok", isVerification ? "HIT" : "MISS");
      }
      return cacheableHtml();
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, [], {
      discoverWarmPlan: async () => {
        events.push("discover");
        return {
          buildId: "build-a",
          buildIdentity: "app-build-a",
          cacheabilityRoutes: [
            {
              kind: "app-page",
              path: warmPaths[0],
              pattern: "/products/:id",
              probePath: warmPaths[0],
              probeGroupPaths: warmPaths.slice(1),
              runtimeCheckWarmPaths: warmPaths.slice(1),
              warmPaths,
            },
          ],
          loadingShellPaths: [],
          paths: warmPaths,
          rscPaths: [],
        };
      },
      warmCdnConcurrency: 100,
      warmCdnPromotionDelay: 0,
      warmCdnReadinessProbes: 1,
      twoStageCacheability: true,
    });

    expect(events).toEqual([
      "upload:1",
      "status",
      "stage:probe",
      "discover",
      "probe-transient",
      "probe-route",
      "upload:2",
      "status",
      "stage:final",
      "readiness:final",
      "status",
      "promote:final",
      "status",
      "triggers",
      "warm:final",
      "verify:final",
      "status",
    ]);
    expect(delayMock).toHaveBeenCalledWith(1_000);
    expect(peakWarmRequests).toBe(CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY);
    expect(peakVerificationRequests).toBe(CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY);
    expect(fs.readFileSync(path.join(tmpDir, "dist/server/entry.js"), "utf-8")).toContain(
      CACHEABILITY_MANIFEST_PLACEHOLDER,
    );
  });

  it("fails if a concurrent deployment appears during active cache certification", async () => {
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker", workers_dev: true }));
    writeTwoStageArtifact();
    let uploadCount = 0;
    let statusCount = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploadCount += 1;
        const id =
          uploadCount === 1
            ? "22222222-2222-4222-8222-222222222222"
            : "33333333-3333-4333-8333-333333333333";
        return `Uploaded my-worker\nWorker Version ID: ${id}\nVersion Preview URL: https://${id.slice(0, 8)}-my-worker.example.workers.dev\n`;
      }
      if (args.includes("status")) {
        statusCount += 1;
        const versions =
          statusCount === 1
            ? [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }]
            : statusCount === 2
              ? [
                  { version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 },
                  { version_id: "22222222-2222-4222-8222-222222222222", percentage: 0 },
                ]
              : statusCount === 3
                ? [
                    { version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 },
                    { version_id: "33333333-3333-4333-8333-333333333333", percentage: 0 },
                  ]
                : statusCount === 4
                  ? [{ version_id: "33333333-3333-4333-8333-333333333333", percentage: 100 }]
                  : [{ version_id: "44444444-4444-4444-8444-444444444444", percentage: 100 }];
        return JSON.stringify({ versions });
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged probe\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("33333333-3333-4333-8333-333333333333@0%")) {
        return "Staged final\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("33333333-3333-4333-8333-333333333333@100%")) {
        return "Promoted final\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    let activeRequest = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get("X-Vinext-Cacheability-Probe") === "1") {
        return Response.json({
          kind: "app-page",
          pattern: "/products/:id",
          state: "static-candidate",
          status: 200,
          version: 1,
        });
      }
      if (isReadinessFetch(input)) return cacheableHtml();
      activeRequest += 1;
      return cacheableHtml("ok", activeRequest === 1 ? "MISS" : "HIT");
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        discoverWarmPlan: async () => ({
          buildId: "build-a",
          buildIdentity: "app-build-a",
          cacheabilityRoutes: [
            { kind: "app-page", pattern: "/products/:id", probePath: "/products/known" },
          ],
          loadingShellPaths: [],
          paths: ["/products/known"],
          rscPaths: [],
        }),
        warmCdnPromotionDelay: 0,
        warmCdnReadinessProbes: 1,
        twoStageCacheability: true,
      }),
    ).rejects.toThrow("concurrent Worker deployment during active cache warming and certification");

    expect(statusCount).toBe(5);
    expect(activeRequest).toBe(2);
  });

  it("does not upload or promote the final Worker when a route probe fails", async () => {
    const events: string[] = [];
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker", workers_dev: true }));
    writeTwoStageArtifact();
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload:probe");
        return (
          "Uploaded my-worker\n" +
          "Worker Version ID: 22222222-2222-4222-8222-222222222222\n" +
          "Version Preview URL: https://22222222-my-worker.example.workers.dev\n"
        );
      }
      if (args.includes("status")) {
        events.push("status");
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        events.push("stage:probe");
        return "Staged version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Vinext-Cacheability-Probe")).toBe("1");
      events.push("probe-failed");
      return Response.json({
        kind: "app-page",
        pattern: "/products/:id",
        reason: "render stream failed",
        state: "probe-failed",
        status: 500,
        version: 1,
      });
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        discoverWarmPlan: async () => ({
          buildId: "build-a",
          buildIdentity: "app-build-a",
          cacheabilityRoutes: [
            { kind: "app-page", pattern: "/products/:id", probePath: "/products/known" },
          ],
          loadingShellPaths: [],
          paths: ["/products/known"],
          rscPaths: [],
        }),
        warmCdnPromotionDelay: 0,
        twoStageCacheability: true,
      }),
    ).rejects.toThrow(
      "Cacheability probing failed; refusing to upload or promote the final Worker",
    );

    expect(events).toEqual(["upload:probe", "status", "stage:probe", "probe-failed"]);
  });

  it("fails before discovery or trigger mutation when the probe upload has no preview URL", async () => {
    const events: string[] = [];
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker", workers_dev: true }));
    writeTwoStageArtifact();
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload:probe");
        return "Uploaded my-worker\nWorker Version ID: 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("triggers")) events.push("triggers");
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const discoverWarmPlan = vi.fn();
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        discoverWarmPlan,
        twoStageCacheability: true,
      }),
    ).rejects.toThrow("requires a Worker version preview URL");

    expect(discoverWarmPlan).not.toHaveBeenCalled();
    expect(events).toEqual(["upload:probe"]);
  });

  it("fails before reading or changing deployment state when no Worker name is available", async () => {
    writeFile("wrangler.jsonc", "{}");
    writeTwoStageArtifact();
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return (
          "Uploaded version\n" +
          "Worker Version ID: 22222222-2222-4222-8222-222222222222\n" +
          "Version Preview URL: https://22222222-worker.example.workers.dev\n"
        );
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        discoverWarmPlan: async () => ({ loadingShellPaths: [], paths: [], rscPaths: [] }),
        twoStageCacheability: true,
      }),
    ).rejects.toThrow("requires a Worker name for version overrides");

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported two-stage configs before uploading a probe Worker", async () => {
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        config: "wrangler.jsonc",
        discoverWarmPlan: async () => ({ loadingShellPaths: [], paths: [], rscPaths: [] }),
        twoStageCacheability: true,
      }),
    ).rejects.toThrow("requires the generated Wrangler config under dist");

    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("does not let the dangerous override bypass two-stage cacheability certification", async () => {
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    writeTwoStageArtifact();
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return (
          "Uploaded my-worker\n" +
          "Worker Version ID: 22222222-2222-4222-8222-222222222222\n" +
          "Version Preview URL: https://22222222-my-worker.example.workers.dev\n"
        );
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [
            { version_id: "11111111-1111-4111-8111-111111111111", percentage: 50 },
            { version_id: "33333333-3333-4333-8333-333333333333", percentage: 50 },
          ],
        });
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const discoverWarmPlan = vi.fn();
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        dangerouslyPromoteOnCdnWarmError: true,
        discoverWarmPlan,
        twoStageCacheability: true,
      }),
    ).rejects.toThrow("Cacheability certification cannot be bypassed");

    expect(discoverWarmPlan).not.toHaveBeenCalled();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("aborts final staging when the serving deployment changes during probing", async () => {
    const events: string[] = [];
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    writeTwoStageArtifact();
    let uploadCount = 0;
    let statusCount = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploadCount += 1;
        events.push(`upload:${uploadCount}`);
        const id =
          uploadCount === 1
            ? "22222222-2222-4222-8222-222222222222"
            : "33333333-3333-4333-8333-333333333333";
        return `Uploaded my-worker\nWorker Version ID: ${id}\nVersion Preview URL: https://${id.slice(0, 8)}-my-worker.example.workers.dev\n`;
      }
      if (args.includes("status")) {
        statusCount += 1;
        events.push(`status:${statusCount}`);
        const id =
          statusCount === 1
            ? "11111111-1111-4111-8111-111111111111"
            : "44444444-4444-4444-8444-444444444444";
        return JSON.stringify({ versions: [{ version_id: id, percentage: 100 }] });
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        events.push("stage:probe");
        return "Staged probe\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("triggers")) events.push("triggers");
      if (args.some((arg) => arg.includes("33333333-3333-4333-8333-333333333333@"))) {
        events.push("stage-or-promote:final");
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        kind: "app-page",
        pattern: "/products/:id",
        state: "static-candidate",
        version: 1,
      }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        discoverWarmPlan: async () => ({
          buildId: "build-a",
          buildIdentity: "app-build-a",
          cacheabilityRoutes: [
            { kind: "app-page", pattern: "/products/:id", probePath: "/products/known" },
          ],
          loadingShellPaths: [],
          paths: ["/products/known"],
          rscPaths: [],
        }),
        twoStageCacheability: true,
      }),
    ).rejects.toThrow("detected a concurrent Worker deployment");

    expect(events).toEqual(["upload:1", "status:1", "stage:probe", "upload:2", "status:2"]);
  });

  it("checks final readiness before triggers even when every warm path is dynamic", async () => {
    const events: string[] = [];
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    writeTwoStageArtifact();
    let uploadCount = 0;
    let statusCount = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploadCount += 1;
        const id =
          uploadCount === 1
            ? "22222222-2222-4222-8222-222222222222"
            : "33333333-3333-4333-8333-333333333333";
        events.push(`upload:${uploadCount}`);
        return `Uploaded my-worker\nWorker Version ID: ${id}\nVersion Preview URL: https://${id.slice(0, 8)}-my-worker.example.workers.dev\n`;
      }
      if (args.includes("status")) {
        statusCount += 1;
        events.push("status");
        return JSON.stringify({
          versions:
            statusCount >= 4
              ? [{ version_id: "33333333-3333-4333-8333-333333333333", percentage: 100 }]
              : [
                  { version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 },
                  ...(statusCount === 2
                    ? [
                        {
                          version_id: "22222222-2222-4222-8222-222222222222",
                          percentage: 0,
                        },
                      ]
                    : statusCount === 3
                      ? [
                          {
                            version_id: "33333333-3333-4333-8333-333333333333",
                            percentage: 0,
                          },
                        ]
                      : []),
                ],
        });
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        events.push("stage:probe");
        return "Staged probe\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("33333333-3333-4333-8333-333333333333@0%")) {
        events.push("stage:final");
        return "Staged final\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("33333333-3333-4333-8333-333333333333@100%")) {
        events.push("promote:final");
        return "Promoted final\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get("X-Vinext-Cacheability-Probe") === "1") {
        events.push("probe:dynamic");
        return Response.json({
          kind: "app-page",
          pattern: "/account",
          state: "dynamic",
          version: 1,
        });
      }
      expect(isReadinessFetch(input)).toBe(true);
      events.push("readiness:final");
      return cacheableHtml();
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, [], {
      discoverWarmPlan: async () => ({
        buildId: "build-a",
        buildIdentity: "app-build-a",
        cacheabilityRoutes: [
          {
            kind: "app-page",
            path: "/account",
            pattern: "/account",
            probePath: "/account",
            warmPaths: ["/account"],
          },
        ],
        loadingShellPaths: [],
        paths: ["/account"],
        rscPaths: [],
      }),
      warmCdnPromotionDelay: 0,
      warmCdnReadinessProbeDelay: 0,
      warmCdnReadinessProbes: 1,
      twoStageCacheability: true,
    });

    expect(events).toEqual([
      "upload:1",
      "status",
      "stage:probe",
      "probe:dynamic",
      "upload:2",
      "status",
      "stage:final",
      "readiness:final",
      "status",
      "promote:final",
      "status",
      "triggers",
      "status",
    ]);
  });

  it("does not overwrite a concurrent deployment after final staging", async () => {
    const events: string[] = [];
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    writeTwoStageArtifact();
    let uploadCount = 0;
    let statusCount = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploadCount += 1;
        const id =
          uploadCount === 1
            ? "22222222-2222-4222-8222-222222222222"
            : "33333333-3333-4333-8333-333333333333";
        events.push(`upload:${uploadCount}`);
        return `Uploaded my-worker\nWorker Version ID: ${id}\nVersion Preview URL: https://${id.slice(0, 8)}-my-worker.example.workers.dev\n`;
      }
      if (args.includes("status")) {
        statusCount += 1;
        events.push(`status:${statusCount}`);
        const versions =
          statusCount === 1
            ? [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }]
            : statusCount === 2
              ? [
                  { version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 },
                  { version_id: "22222222-2222-4222-8222-222222222222", percentage: 0 },
                ]
              : [{ version_id: "44444444-4444-4444-8444-444444444444", percentage: 100 }];
        return JSON.stringify({ versions });
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        events.push("stage:probe");
        return "Staged probe\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("33333333-3333-4333-8333-333333333333@0%")) {
        events.push("stage:final");
        return "Staged final\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("33333333-3333-4333-8333-333333333333@100%")) {
        events.push("promote:final");
        return "Promoted final\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get("X-Vinext-Cacheability-Probe") === "1") {
        events.push("probe");
        return Response.json({
          kind: "app-page",
          pattern: "/products/:id",
          state: "static-candidate",
          version: 1,
        });
      }
      expect(isReadinessFetch(input)).toBe(true);
      events.push("readiness");
      return cacheableHtml();
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        discoverWarmPlan: async () => ({
          buildId: "build-a",
          buildIdentity: "app-build-a",
          cacheabilityRoutes: [
            { kind: "app-page", pattern: "/products/:id", probePath: "/products/known" },
          ],
          loadingShellPaths: [],
          paths: ["/products/known"],
          rscPaths: [],
        }),
        warmCdnPromotionDelay: 0,
        warmCdnReadinessProbes: 1,
        twoStageCacheability: true,
      }),
    ).rejects.toThrow("detected a concurrent Worker deployment after staging");

    expect(events).toEqual([
      "upload:1",
      "status:1",
      "stage:probe",
      "probe",
      "upload:2",
      "status:2",
      "stage:final",
      "readiness",
      "status:3",
    ]);
  });

  it("rejects promotion delays that Node timers cannot represent before deploying", async () => {
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], { warmCdnPromotionDelay: 2_147_483_648 }),
    ).rejects.toThrow(
      '--warm-cdn-promotion-delay must not exceed 2147483647 milliseconds, but got "2147483648".',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("rejects incompatible two-stage no-promote and propagation-delay options before upload", async () => {
    writeTwoStageArtifact();
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        twoStageCacheability: true,
        warmCdnPromote: false,
      }),
    ).rejects.toThrow("--warm-cdn-no-promote is incompatible with two-stage cacheability probing");
    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        twoStageCacheability: true,
        warmCdnPromotionDelay: 1,
      }),
    ).rejects.toThrow(
      "--warm-cdn-promotion-delay is incompatible with two-stage cacheability probing",
    );

    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("does not promote when deployment status cannot be read", async () => {
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded my-worker (1.23 sec)\nWorker Version ID: 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        throw new Error("deployment status unavailable");
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        expectedBuildId: "app-build-a",
      }),
    ).rejects.toThrow("deployment status unavailable");
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors custom staged-readiness probe count and delay before warming", async () => {
    const events: string[] = [];
    const readinessHeaders: Headers[] = [];
    const readinessUrls: string[] = [];
    let readinessAttempt = 0;
    delayMock.mockImplementation(async (milliseconds: number) => {
      events.push(`delay:${milliseconds}`);
    });
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(formatFetchUrl(input));
      const isReadinessProbe = url.searchParams.has("__vinext_cdn_warm_readiness");
      if (isReadinessProbe) {
        readinessHeaders.push(new Headers(init?.headers));
        readinessUrls.push(url.href);
      }
      const buildId = isReadinessProbe && readinessAttempt++ === 0 ? "old-build" : "app-build-a";
      events.push(isReadinessProbe ? `readiness:${buildId}` : `warm:${url.pathname}${url.search}`);
      return new Response("flight", {
        headers: {
          "cache-control": "public, max-age=0, must-revalidate",
          "cdn-cache-control": "public, max-age=60",
          "cf-cache-status": "MISS",
          "content-type": "text/x-component",
          [VINEXT_RSC_BUILD_ID_HEADER]: buildId,
          vary: VINEXT_RSC_VARY_HEADER,
        },
      });
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded my-worker\nWorker Version ID: 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("11111111-1111-4111-8111-111111111111@100%")) {
        events.push("stage");
        return "Staged version\nhttps://app.example.com\n";
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        events.push("promote");
        return "Deployed version\nhttps://app.example.com\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n  app.example.com (custom domain)\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, [], {
      expectedRscBuildId: "app-build-a",
      rscPaths: ["/about"],
      warmCdnConcurrency: 1,
      warmCdnPromotionDelay: 0,
      warmCdnReadinessProbeDelay: 250,
      warmCdnReadinessProbes: 3,
    });

    expect(events).toEqual([
      "stage",
      "triggers",
      "readiness:old-build",
      "delay:250",
      "readiness:app-build-a",
      "delay:250",
      "readiness:app-build-a",
      "delay:250",
      "readiness:app-build-a",
      "warm:/about?_rsc",
      "promote",
    ]);
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) => {
        const url = new URL(formatFetchUrl(input));
        return url.pathname === "/about" && url.search === "?_rsc";
      }),
    ).toHaveLength(1);
    expect(new Set(readinessUrls).size).toBe(4);
    expect(readinessUrls.every((url) => new URL(url).searchParams.has("_rsc"))).toBe(true);
    expect(
      readinessHeaders.every(
        (value) =>
          value.get("accept") === "text/x-component" &&
          value.get("cache-control") === "no-cache" &&
          value.get("rsc") === "1" &&
          value.has("Cloudflare-Workers-Version-Overrides") &&
          value.get(VINEXT_EXPECTED_WORKER_VERSION_HEADER) ===
            "22222222-2222-4222-8222-222222222222",
      ),
    ).toBe(true);
  });

  it("discovers binding-backed paths from the staged version before readiness and warming", async () => {
    const events: string[] = [];
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      events.push(isReadinessFetch(input) ? "readiness" : "warm");
      return headers.get("rsc") === "1" ? cacheableRsc() : cacheableHtml();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded my-worker\nWorker Version ID: 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("11111111-1111-4111-8111-111111111111@100%")) {
        events.push("stage");
        return "Staged version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        events.push("promote");
        return "Deployed version\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, [], {
      discoverWarmPlan: async ({ headers, targetUrl }) => {
        events.push("discover");
        expect(targetUrl).toBe("https://my-worker.example.workers.dev");
        expect(new Headers(headers).get("Cloudflare-Workers-Version-Overrides")).toBe(
          'my-worker="22222222-2222-4222-8222-222222222222"',
        );
        return {
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/cached/intro"],
          rscBuildId: "app-build-a",
          rscPaths: ["/cached/intro"],
        };
      },
      warmCdnPromotionDelay: 0,
      warmCdnReadinessProbeDelay: 0,
      warmCdnReadinessProbes: 1,
    });

    expect(events).toEqual([
      "stage",
      "triggers",
      "discover",
      "readiness",
      "warm",
      "warm",
      "promote",
    ]);
  });

  it("warms the production custom domain through a 0% staged version override", async () => {
    const events: string[] = [];
    delayMock.mockImplementation(async (milliseconds: number) => {
      events.push(`delay:${milliseconds}`);
    });
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      events.push(isReadinessFetch(url) ? "readiness" : `fetch:${formatFetchUrl(url)}`);
      const headers = new Headers(init?.headers);
      const isRsc = headers.get("rsc") === "1";
      return new Response(isRsc ? "flight" : "html", {
        status: 200,
        headers: isRsc
          ? {
              "cache-control": "public, max-age=0, must-revalidate",
              "cdn-cache-control": "public, max-age=60",
              "cf-cache-status": "MISS",
              "content-type": "text/x-component",
              [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a",
              [VINEXT_RSC_BUILD_ID_HEADER]: "build-a",
              vary: VINEXT_RSC_VARY_HEADER,
            }
          : {
              "cf-cache-status": "MISS",
              "content-type": "text/html",
              [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a",
            },
      });
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return "Uploaded version 22222222-2222-4222-8222-222222222222\nhttps://preview.example.workers.dev\n";
      }
      if (args.includes("status")) {
        events.push("status");
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (
        args.includes("deploy") &&
        args.includes("11111111-1111-4111-8111-111111111111@100%") &&
        args.includes("22222222-2222-4222-8222-222222222222@0%")
      ) {
        events.push("stage");
        return "Staged version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        events.push("promote");
        return "Deployed version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n  app.example.com (custom domain)\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    const url = await deployWithCdnWarmup(tmpDir, ["/", "/about"], {
      deploymentId: "dpl_123",
      expectedBuildId: "app-build-a",
      expectedRscBuildId: "build-a",
      loadingShellPaths: ["/about"],
      rscPaths: ["/about"],
      warmCdnConcurrency: 1,
    });

    expect(url).toBe("https://stable.example.workers.dev");
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      expect.arrayContaining(["versions", "upload"]),
      expect.any(Object),
    );
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      expect.arrayContaining(["deployments", "status", "--json"]),
      expect.any(Object),
    );
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      3,
      process.execPath,
      expect.arrayContaining([
        "versions",
        "deploy",
        "11111111-1111-4111-8111-111111111111@100%",
        "22222222-2222-4222-8222-222222222222@0%",
      ]),
      expect.any(Object),
    );
    const warmCalls = getRealWarmFetchCalls();
    expect(warmCalls).toHaveLength(4);
    expect(warmCalls[0]).toEqual([
      new URL("https://app.example.com/about?_rsc"),
      expect.any(Object),
    ]);
    expect(warmCalls[1]).toEqual([
      new URL("https://app.example.com/about?_rsc=9qLBDIU2NgN178cB"),
      expect.any(Object),
    ]);
    expect(warmCalls[2]).toEqual([new URL("https://app.example.com/"), expect.any(Object)]);
    expect(warmCalls[3]).toEqual([new URL("https://app.example.com/about"), expect.any(Object)]);
    const rscHeaders = new Headers(warmCalls[0]![1]?.headers);
    expect(rscHeaders.get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker="22222222-2222-4222-8222-222222222222"',
    );
    expect(rscHeaders.get(VINEXT_EXPECTED_WORKER_VERSION_HEADER)).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(rscHeaders.get("accept")).toBe("text/x-component");
    expect(rscHeaders.get("rsc")).toBe("1");
    expect(rscHeaders.get("x-deployment-id")).toBe("dpl_123");
    expect(rscHeaders.get("next-router-prefetch")).toBeNull();
    expect(rscHeaders.get("next-router-state-tree")).toBeNull();
    expect(rscHeaders.get("next-url")).toBeNull();
    const loadingHeaders = new Headers(warmCalls[1]![1]?.headers);
    expect(loadingHeaders.get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker="22222222-2222-4222-8222-222222222222"',
    );
    expect(loadingHeaders.get("next-router-prefetch")).toBe("1");
    expect(loadingHeaders.get("next-router-segment-prefetch")).toBe("1");
    expect(loadingHeaders.get("x-vinext-rsc-render-mode")).toBe("prefetch-loading-shell");
    const firstHtmlHeaders = new Headers(warmCalls[2]![1]?.headers);
    expect(firstHtmlHeaders.get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker="22222222-2222-4222-8222-222222222222"',
    );
    expect(firstHtmlHeaders.get("accept")).toBe("text/html");
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      4,
      process.execPath,
      expect.arrayContaining(["triggers", "deploy"]),
      expect.any(Object),
    );
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      5,
      process.execPath,
      expect.arrayContaining(["versions", "deploy", "22222222-2222-4222-8222-222222222222@100%"]),
      expect.any(Object),
    );
    expect(events).toEqual([
      "upload",
      "status",
      "stage",
      "triggers",
      "readiness",
      "delay:1000",
      "readiness",
      "delay:1000",
      "readiness",
      "delay:1000",
      "readiness",
      "delay:1000",
      "readiness",
      "delay:1000",
      "readiness",
      "fetch:https://app.example.com/about?_rsc",
      "fetch:https://app.example.com/about?_rsc=9qLBDIU2NgN178cB",
      "fetch:https://app.example.com/",
      "fetch:https://app.example.com/about",
      "delay:15000",
      "promote",
    ]);
    expect(delayMock).toHaveBeenCalledTimes(6);
    expect(delayMock).toHaveBeenLastCalledWith(15_000);
  });

  it.each([
    ["singular route", { name: "my-worker", workers_dev: false, route: "sub.example.com/*" }],
    [
      "routes object with a zone name",
      {
        name: "my-worker",
        workers_dev: false,
        routes: [{ pattern: "sub.example.com/*", zone_name: "example.com" }],
      },
    ],
  ])("warms the concrete Worker host from a %s", async (_label, config) => {
    writeFile("wrangler.jsonc", JSON.stringify(config));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        return "Deployed version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\n  sub.example.com/*\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/about"], {
      expectedBuildId: "app-build-a",
      warmCdnConcurrency: 1,
      warmCdnPromotionDelay: 0,
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://sub.example.com/about"),
      expect.any(Object),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([url]) => formatFetchUrl(url).startsWith("https://sub.example.com/")),
    ).toBe(true);
  });

  it("does not promote after a partial staged warmup failure", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const headers = new Headers(init?.headers);
      const isRsc = headers.get("rsc") === "1";
      const isLoadingShell = headers.has("next-router-segment-prefetch");
      const staged = headers.has("Cloudflare-Workers-Version-Overrides");
      const kind = isLoadingShell ? "loading" : isRsc ? "rsc" : "html";
      events.push(
        isReadinessFetch(url) ? "readiness" : `fetch:${staged ? "staged" : "promoted"}:${kind}`,
      );
      return new Response(isRsc ? "flight" : "html", {
        headers: isRsc
          ? {
              "cache-control": "public, max-age=0, must-revalidate",
              "cdn-cache-control": "public, max-age=60",
              "cf-cache-status": "MISS",
              "content-type": "text/x-component",
              [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a",
              [VINEXT_RSC_BUILD_ID_HEADER]: staged && isLoadingShell ? "old-build" : "new-build",
              vary: VINEXT_RSC_VARY_HEADER,
            }
          : {
              "cf-cache-status": "MISS",
              "content-type": "text/html",
              [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a",
            },
      });
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        events.push("status");
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("11111111-1111-4111-8111-111111111111@100%")) {
        events.push("stage");
        return "Staged version\nhttps://app.example.com\n";
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        events.push("promote");
        return "Deployed version\nhttps://app.example.com\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n  app.example.com (custom domain)\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/about"], {
        expectedBuildId: "app-build-a",
        expectedRscBuildId: "new-build",
        loadingShellPaths: ["/about"],
        rscPaths: ["/about"],
        warmCdnRetries: 1,
      }),
    ).rejects.toThrow("response X-Vinext-RSC-Build-Id does not match build new-build");

    expect(events).not.toContain("promote");
    expect(events).not.toContain("fetch:promoted:loading");
    expect(events.filter((event) => event === "fetch:staged:loading")).toHaveLength(1);
  });

  it("promotes after failed staged readiness only with the dangerous override", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const staged = new Headers(init?.headers).has("Cloudflare-Workers-Version-Overrides");
      events.push(`fetch:${staged ? "staged" : "promoted"}`);
      return new Response("html", {
        headers: {
          "cdn-cache-control": "public, max-age=60",
          "cf-cache-status": "MISS",
          "content-type": "text/html",
          [VINEXT_CDN_BUILD_ID_HEADER]: staged ? "old-build" : "new-build",
        },
      });
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        events.push("status");
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("11111111-1111-4111-8111-111111111111@100%")) {
        events.push("stage");
        return "Staged version\nhttps://app.example.com\n";
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        events.push("promote");
        return "Deployed version\nhttps://app.example.com\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n  app.example.com (custom domain)\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/about"], {
      dangerouslyPromoteOnCdnWarmError: true,
      expectedBuildId: "new-build",
      warmCdnRetries: 1,
    });

    expect(events.slice(0, 4)).toEqual(["upload", "status", "stage", "triggers"]);
    expect(events.filter((event) => event === "fetch:staged")).toHaveLength(7);
    expect(events.slice(-2)).toEqual(["promote", "fetch:promoted"]);
    expect(delayMock).toHaveBeenCalledTimes(6);
    expect(delayMock).toHaveBeenCalledWith(1_000);
  });

  it("uses the env Worker name and env custom domain for version override warmup", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
        env: {
          staging: {
            name: "my-worker-staging-custom",
            custom_domains: ["staging.example.com"],
          },
        },
      }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        return "Deployed version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\n  staging.example.com (custom domain)\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], {
      env: "staging",
      expectedBuildId: "app-build-a",
      warmCdnConcurrency: 1,
      warmCdnPromotionDelay: 2_500,
    });

    expect(fetch).toHaveBeenCalledWith(new URL("https://staging.example.com/"), expect.any(Object));
    const firstInit = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(new Headers(firstInit.headers).get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker-staging-custom="22222222-2222-4222-8222-222222222222"',
    );
    expect(new Headers(firstInit.headers).get(VINEXT_EXPECTED_WORKER_VERSION_HEADER)).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(delayMock).toHaveBeenCalledWith(2_500);
    for (const [, args] of execFileSyncMock.mock.calls as Array<[string, string[]]>) {
      expect(args).toEqual(expect.arrayContaining(["--env", "staging"]));
    }
  });

  it("does not inherit the production custom domain for a named environment", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
        env: { staging: { name: "my-worker-staging" } },
      }),
    );
    const { resolveCdnWarmupTargetUrl } = await import("../packages/cloudflare/src/deploy.js");

    expect(
      resolveCdnWarmupTargetUrl(tmpDir, "https://my-worker-staging.example.workers.dev", {
        env: "staging",
      }),
    ).toBe("https://my-worker-staging.example.workers.dev");
  });

  it("does not infer a warmup target from zone-oriented Wrangler config", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        workers_dev: false,
        routes: [{ pattern: "sub.example.com/*", zone_name: "example.com" }],
      }),
    );
    const { resolveCdnWarmupTargetUrl } = await import("../packages/cloudflare/src/deploy.js");

    expect(resolveCdnWarmupTargetUrl(tmpDir, null)).toBeNull();
  });

  it("skips unverifiable HTML only with the dangerous override", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockImplementation(async (url) => {
      events.push(isReadinessFetch(url) ? "readiness" : `fetch:${formatFetchUrl(url)}`);
      return cacheableHtml();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        events.push("status");
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        events.push("stage");
        return "Staged version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        events.push("promote");
        return "Deployed version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n  app.example.com (custom domain)\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/about"], {
      dangerouslyPromoteOnCdnWarmError: true,
      warmCdnConcurrency: 1,
    });

    expect(events).toEqual(["upload", "status", "stage", "triggers", "promote"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects no-promote HTML warmup without verifiable build identity before upload", async () => {
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/about"], {
        warmCdnPromote: false,
      }),
    ).rejects.toThrow("CDN HTML warmup requires a CDN adapter");
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies triggers before post-promotion fallback warmup", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url) => {
      events.push(`fetch:${formatFetchUrl(url)}`);
      return cacheableRsc();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        events.push("status");
        return JSON.stringify({
          versions: [
            { version_id: "11111111-1111-4111-8111-111111111111", percentage: 50 },
            { version_id: "33333333-3333-4333-8333-333333333333", percentage: 50 },
          ],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        events.push("promote");
        return "Deployed version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n  app.example.com (custom domain)\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], {
      dangerouslyPromoteOnCdnWarmError: true,
      expectedRscBuildId: "app-build-a",
      rscPaths: ["/"],
      warmCdnConcurrency: 1,
    });

    expect(events).toEqual([
      "upload",
      "status",
      "promote",
      "triggers",
      "fetch:https://app.example.com/?_rsc",
    ]);
  });

  it("leaves the warmed Worker version staged when promotion is disabled", async () => {
    const events: string[] = [];
    delayMock.mockImplementation(async (milliseconds: number) => {
      events.push(`delay:${milliseconds}`);
    });
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockImplementation(async (url) => {
      events.push(isReadinessFetch(url) ? "readiness" : `fetch:${formatFetchUrl(url)}`);
      return cacheableHtml();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return "Uploaded version 22222222-2222-4222-8222-222222222222\nhttps://preview.example.workers.dev\n";
      }
      if (args.includes("status")) {
        events.push("status");
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        events.push("stage");
        return "Staged version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n  app.example.com (custom domain)\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/about"], {
        expectedBuildId: "app-build-a",
        warmCdnConcurrency: 1,
        warmCdnPromote: false,
      }),
    ).resolves.toBe("https://stable.example.workers.dev");

    expect(events.filter((event) => event !== "readiness" && !event.startsWith("delay:"))).toEqual([
      "upload",
      "status",
      "stage",
      "triggers",
      "fetch:https://app.example.com/about",
    ]);
    expect(events.filter((event) => event === "readiness")).toHaveLength(6);
    expect(events.filter((event) => event === "delay:1000")).toHaveLength(5);
  });

  it("fails no-promote deployment when staged readiness cannot be established", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response("old", {
        headers: {
          "cf-cache-status": "MISS",
          "content-type": "text/html",
          [VINEXT_CDN_BUILD_ID_HEADER]: "old-build",
        },
      }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded my-worker\nWorker Version ID: 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged version\nhttps://app.example.com\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\n  app.example.com (custom domain)\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/about"], {
        expectedBuildId: "app-build-a",
        warmCdnPromote: false,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("promotion is disabled");
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(
      (execFileSyncMock.mock.calls as Array<[string, string[]]>).some(([, args]) =>
        args.includes("22222222-2222-4222-8222-222222222222@100%"),
      ),
    ).toBe(false);
  });

  it("fails no-promote deployment when a staged warm request remains unsuccessful", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (isReadinessFetch(url)) return cacheableHtml();
      return new Response("unavailable", { status: 503 });
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded my-worker\nWorker Version ID: 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged version\nhttps://app.example.com\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\n  app.example.com (custom domain)\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/about"], {
        expectedBuildId: "app-build-a",
        warmCdnPromote: false,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("CDN warmup failed for 1/1 request(s)");
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(
      (execFileSyncMock.mock.calls as Array<[string, string[]]>).some(([, args]) =>
        args.includes("22222222-2222-4222-8222-222222222222@100%"),
      ),
    ).toBe(false);
  });

  it("rejects HTML warmup without verifiable build identity before upload", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/about"], {
        warmCdnConcurrency: 1,
        warmCdnPromote: false,
      }),
    ).rejects.toThrow("CDN HTML warmup requires a CDN adapter");
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replaces a stale 0% version and uses the triggers URL for pre-promotion warmup", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "workers-cache",
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url) => {
      events.push(isReadinessFetch(url) ? "readiness" : `fetch:${formatFetchUrl(url)}`);
      return cacheableHtml();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        events.push("status");
        return JSON.stringify({
          versions: [
            { version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 },
            { version_id: "33333333-3333-4333-8333-333333333333", percentage: 0 },
          ],
        });
      }
      if (
        args.includes("deploy") &&
        args.includes("11111111-1111-4111-8111-111111111111@100%") &&
        args.includes("22222222-2222-4222-8222-222222222222@0%")
      ) {
        events.push("stage");
        return "Staged workers-cache version\n";
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        events.push("promote");
        return "Deployed workers-cache version 22222222-2222-4222-8222-222222222222 at 100%\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Deployed workers-cache triggers\n  https://workers-cache.vinext.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    const url = await deployWithCdnWarmup(tmpDir, ["/cached/intro"], {
      expectedBuildId: "app-build-a",
      warmCdnConcurrency: 1,
    });

    expect(url).toBe("https://workers-cache.vinext.workers.dev");
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://workers-cache.vinext.workers.dev/cached/intro"),
      expect.any(Object),
    );
    expect(events).toEqual([
      "upload",
      "status",
      "stage",
      "triggers",
      "readiness",
      "readiness",
      "readiness",
      "readiness",
      "readiness",
      "readiness",
      "fetch:https://workers-cache.vinext.workers.dev/cached/intro",
      "promote",
    ]);
  });

  it("uses the explicit Worker name for version upload, override, promotion, and triggers", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "config-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        return "Deployed version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], {
      expectedBuildId: "app-build-a",
      name: "cli-worker",
      warmCdnConcurrency: 1,
    });

    const firstInit = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(new Headers(firstInit.headers).get("Cloudflare-Workers-Version-Overrides")).toBe(
      'cli-worker="22222222-2222-4222-8222-222222222222"',
    );
    for (const [, args] of execFileSyncMock.mock.calls as Array<[string, string[]]>) {
      expect(args).toEqual(expect.arrayContaining(["--name", "cli-worker"]));
    }
  });

  it("uses Wrangler's uploaded Worker name for a TOML config", async () => {
    writeFile(
      "wrangler.toml",
      ["name = 'toml-worker'", "workers_dev = false", "route = 'app.example.com/*'"].join("\n"),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return [
          "Uploaded toml-worker (1.23 sec)",
          "Worker Version ID: 22222222-2222-4222-8222-222222222222",
        ].join("\n");
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged version\n";
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        return "Promoted version\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\n  app.example.com/*\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], {
      expectedBuildId: "app-build-a",
      warmCdnConcurrency: 1,
      warmCdnPromotionDelay: 0,
    });

    const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
    expect(headers.get("Cloudflare-Workers-Version-Overrides")).toBe(
      'toml-worker="22222222-2222-4222-8222-222222222222"',
    );
  });

  it("explains staged version cleanup when pre-promotion warmup fails", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    vi.mocked(fetch).mockResolvedValue(new Response("nope", { status: 500 }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        expectedBuildId: "app-build-a",
        warmCdnConcurrency: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("may remain staged at 0%");
  });

  it("explains staged version cleanup when trigger deployment fails after staging", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        throw new Error("trigger deploy failed");
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        expectedBuildId: "app-build-a",
        warmCdnConcurrency: 1,
      }),
    ).rejects.toThrow("may remain staged at 0%");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains staged version cleanup when promotion fails", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        return "Staged version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        throw new Error("promotion failed");
      }
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        expectedBuildId: "app-build-a",
        warmCdnConcurrency: 1,
      }),
    ).rejects.toThrow("may remain staged at 0%");
  });

  it("explains promoted version state when fallback trigger deployment fails", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [
            { version_id: "11111111-1111-4111-8111-111111111111", percentage: 50 },
            { version_id: "33333333-3333-4333-8333-333333333333", percentage: 50 },
          ],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        return "Deployed version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        throw new Error("trigger deploy failed");
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        dangerouslyPromoteOnCdnWarmError: true,
        expectedBuildId: "app-build-a",
        warmCdnConcurrency: 1,
      }),
    ).rejects.toThrow("may already be promoted to 100%");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not promote warmup when the existing deployment cannot be staged", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [
            { version_id: "11111111-1111-4111-8111-111111111111", percentage: 50 },
            { version_id: "33333333-3333-4333-8333-333333333333", percentage: 50 },
          ],
        });
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        expectedBuildId: "app-build-a",
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("cannot stage the uploaded Worker at 0%");
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not require a target URL before rejecting unstaged warmup", async () => {
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker", workers_dev: false }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [
            { version_id: "11111111-1111-4111-8111-111111111111", percentage: 50 },
            { version_id: "33333333-3333-4333-8333-333333333333", percentage: 50 },
          ],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        return "Deployed version\n";
      }
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        expectedBuildId: "app-build-a",
      }),
    ).rejects.toThrow("cannot stage the uploaded Worker at 0%");
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
