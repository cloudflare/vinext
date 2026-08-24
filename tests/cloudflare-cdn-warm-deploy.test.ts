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

function cacheableHtml(body = "ok"): Response {
  return new Response(body, {
    headers: {
      "cf-cache-status": "MISS",
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

  it("rejects promotion delays that Node timers cannot represent before deploying", async () => {
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], { warmCdnPromotionDelay: 2_147_483_648 }),
    ).rejects.toThrow(
      '--warm-cdn-promotion-delay must not exceed 2147483647 milliseconds, but got "2147483648".',
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
