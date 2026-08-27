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
import { withCacheabilityManifestArtifact } from "../packages/cloudflare/src/cacheability-artifact.js";
import { MAX_CACHEABILITY_MANIFEST_ROUTES } from "../packages/cloudflare/src/cacheability-manifest-limits.js";
import { CACHEABILITY_MANIFEST_MODULE } from "../packages/vinext/src/server/cacheability-manifest.js";
import { VINEXT_CACHEABILITY_PROBE_HEADER } from "../packages/vinext/src/server/headers.js";

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

const OLD_VERSION = "11111111-1111-4111-8111-111111111111";
const PROBE_VERSION = "22222222-2222-4222-8222-222222222222";
const FINAL_VERSION = "33333333-3333-4333-8333-333333333333";

function writeTwoStageWorkerArtifact(): void {
  writeFile(
    "dist/server/wrangler.json",
    JSON.stringify({ main: "index.js", name: "my-worker", workers_dev: true }),
  );
  writeFile("dist/server/index.js", `import "./${CACHEABILITY_MANIFEST_MODULE}";\n`);
  writeFile(`dist/server/${CACHEABILITY_MANIFEST_MODULE}`, "export default null;\n");
  writeFile(
    "dist/server/vinext-server.json",
    JSON.stringify({ prerenderSecret: "test-prerender-secret" }),
  );
}

function appPageProbeResponse(state: "static-candidate" | "probe-failed" = "static-candidate") {
  return Response.json(
    {
      kind: "app-page",
      pattern: "/about",
      ...(state === "probe-failed" ? { reason: "render classification failed" } : {}),
      state,
      status: 200,
      version: 1,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a",
      },
    },
  );
}

function mockTwoStageWrangler(
  options: {
    failFinalUpload?: boolean;
    replaceFinalStageBeforeHandoff?: "identity" | "traffic";
  } = {},
) {
  const state = {
    finalManifestSource: null as string | null,
    finalStaged: false,
    promoted: false,
    statusCount: 0,
    triggerDeploys: 0,
    uploads: 0,
  };
  execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
    if (args.includes("upload")) {
      state.uploads++;
      if (state.uploads === 2 && options.failFinalUpload) throw new Error("final upload failed");
      if (state.uploads === 2) {
        const configPath = path.resolve(tmpDir, args[args.indexOf("--config") + 1]!);
        state.finalManifestSource = fs.readFileSync(
          path.join(path.dirname(configPath), CACHEABILITY_MANIFEST_MODULE),
          "utf8",
        );
      }
      return `Uploaded my-worker\nWorker Version ID: ${state.uploads === 1 ? PROBE_VERSION : FINAL_VERSION}\n`;
    }
    if (args.includes("status")) {
      state.statusCount++;
      const replaceFinalStage =
        state.finalStaged && state.statusCount >= 7 && options.replaceFinalStageBeforeHandoff;
      return JSON.stringify({
        id:
          state.statusCount === 1
            ? "initial-deployment"
            : replaceFinalStage
              ? "replacement-deployment"
              : state.finalStaged
                ? "final-stage-deployment"
                : "probe-stage-deployment",
        versions:
          state.statusCount === 1
            ? [{ version_id: OLD_VERSION, percentage: 100 }]
            : replaceFinalStage === "traffic"
              ? [{ version_id: "44444444-4444-4444-8444-444444444444", percentage: 100 }]
              : state.finalStaged
                ? [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: FINAL_VERSION, percentage: 0 },
                  ]
                : [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: PROBE_VERSION, percentage: 0 },
                  ],
      });
    }
    if (args.includes(`${PROBE_VERSION}@0%`)) {
      return "Staged version\nhttps://my-worker.example.workers.dev\n";
    }
    if (args.includes(`${FINAL_VERSION}@0%`)) {
      state.finalStaged = true;
      return "Staged version\nhttps://my-worker.example.workers.dev\n";
    }
    if (args.includes(`${FINAL_VERSION}@100%`)) {
      state.promoted = true;
      return "Promoted version\nhttps://my-worker.example.workers.dev\n";
    }
    if (args.includes("triggers")) {
      state.triggerDeploys++;
      return "Triggers deployed\nhttps://my-worker.example.workers.dev\n";
    }
    throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
  });
  return state;
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

  it("rejects a generated artifact whose Worker main cannot reach the manifest module", () => {
    writeTwoStageWorkerArtifact();
    writeFile("dist/server/index.js", "export default { fetch() {} };\n");

    expect(() =>
      withCacheabilityManifestArtifact(
        tmpDir,
        "dist/server/wrangler.json",
        { buildId: "build-a", routes: {}, version: 1 },
        () => undefined,
      ),
    ).toThrow(`Worker main module to import ${CACHEABILITY_MANIFEST_MODULE}`);
  });

  it.each([
    ["comment", `// import "./${CACHEABILITY_MANIFEST_MODULE}";\nexport default {};\n`],
    [
      "string",
      `const marker = 'import "./${CACHEABILITY_MANIFEST_MODULE}"';\nexport default {};\n`,
    ],
    [
      "template",
      `const marker = \`import "./${CACHEABILITY_MANIFEST_MODULE}"\`;\nexport default {};\n`,
    ],
    [
      "regular expression",
      `/import "\\.\\/${CACHEABILITY_MANIFEST_MODULE}"/;\nexport default {};\n`,
    ],
    ["dynamic import", `void import("./${CACHEABILITY_MANIFEST_MODULE}");\nexport default {};\n`],
    [
      "longer specifier",
      `import "./${CACHEABILITY_MANIFEST_MODULE}.backup";\nexport default {};\n`,
    ],
  ])("rejects a manifest filename mentioned only by a %s", (_label, mainSource) => {
    writeTwoStageWorkerArtifact();
    writeFile("dist/server/index.js", mainSource);

    expect(() =>
      withCacheabilityManifestArtifact(
        tmpDir,
        "dist/server/wrangler.json",
        { buildId: "build-a", routes: {}, version: 1 },
        () => undefined,
      ),
    ).toThrow(`Worker main module to import ${CACHEABILITY_MANIFEST_MODULE}`);
  });

  it.each([
    [
      "static import",
      `import manifest from "./${CACHEABILITY_MANIFEST_MODULE}";\nexport default manifest;\n`,
    ],
    [
      "static re-export",
      `export { default as manifest } from "./${CACHEABILITY_MANIFEST_MODULE}";\n`,
    ],
  ])("accepts a manifest reached by a %s", (_label, mainSource) => {
    writeTwoStageWorkerArtifact();
    writeFile("dist/server/index.js", mainSource);

    expect(() =>
      withCacheabilityManifestArtifact(
        tmpDir,
        "dist/server/wrangler.json",
        { buildId: "build-a", routes: {}, version: 1 },
        () => undefined,
      ),
    ).not.toThrow();
  });

  it("rejects a manifest with more exact identities than the deployment bound", () => {
    writeTwoStageWorkerArtifact();
    const route = {
      kind: "app-page" as const,
      pattern: "/page",
      representation: "html" as const,
      requestKey: "/page",
      state: "static-candidate" as const,
      status: 200,
    };
    const routes = Object.fromEntries(
      Array.from({ length: MAX_CACHEABILITY_MANIFEST_ROUTES + 1 }, (_, index) => [
        `route-${index}`,
        route,
      ]),
    );

    expect(() =>
      withCacheabilityManifestArtifact(
        tmpDir,
        "dist/server/wrangler.json",
        { buildId: "build-a", routes, version: 1 },
        () => undefined,
      ),
    ).toThrow(`the limit is ${MAX_CACHEABILITY_MANIFEST_ROUTES}`);
  });

  it("uploads only static identities, then warms once and promotes the final version", async () => {
    writeTwoStageWorkerArtifact();
    const events: string[] = [];
    let uploadCount = 0;
    let statusCount = 0;
    let finalStaged = false;
    let cacheRequestCount = 0;
    let finalManifestSource = "";
    let finalConfig: unknown;

    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploadCount++;
        if (uploadCount === 2) {
          const configPath = path.resolve(tmpDir, args[args.indexOf("--config") + 1]!);
          finalConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
          finalManifestSource = fs.readFileSync(
            path.join(path.dirname(configPath), CACHEABILITY_MANIFEST_MODULE),
            "utf8",
          );
          events.push("upload-final");
          return `Uploaded my-worker\nWorker Version ID: ${FINAL_VERSION}\n`;
        }
        events.push("upload-probe");
        return `Uploaded my-worker\nWorker Version ID: ${PROBE_VERSION}\n`;
      }
      if (args.includes("status")) {
        statusCount++;
        events.push(`status-${statusCount}`);
        return JSON.stringify({
          versions:
            statusCount === 1
              ? [{ version_id: OLD_VERSION, percentage: 100 }]
              : finalStaged
                ? [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: FINAL_VERSION, percentage: 0 },
                  ]
                : [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: PROBE_VERSION, percentage: 0 },
                  ],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        events.push("stage-probe");
        return "Staged probe version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes(`${FINAL_VERSION}@0%`)) {
        finalStaged = true;
        events.push("stage-final");
        return "Staged final version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes(`${FINAL_VERSION}@100%`)) {
        events.push("promote-final");
        return "Promoted final version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1") {
        const pathname = new URL(formatFetchUrl(input)).pathname;
        events.push(`probe-${pathname}`);
        return pathname === "/dynamic"
          ? Response.json(
              {
                kind: "app-page",
                pattern: "/dynamic",
                state: "dynamic",
                status: 200,
                version: 1,
              },
              { headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a" } },
            )
          : appPageProbeResponse();
      }
      if (isReadinessFetch(input)) events.push("readiness");
      else {
        cacheRequestCount++;
        events.push(cacheRequestCount === 1 ? "warm" : "unexpected-second-request");
      }
      return cacheableHtml("ok", cacheRequestCount > 1 ? "HIT" : "MISS");
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    const deployedUrl = await deployWithCdnWarmup(tmpDir, [], {
      cacheabilityProbe: true,
      config: "dist/server/wrangler.json",
      discoverWarmPlan: async () => ({
        appPaths: ["/about", "/dynamic"],
        buildId: "app-build-a",
        buildIdentity: "app-build-a",
        loadingShellPaths: [],
        // The discovery manifest can contain a mixed App/Pages HTML plan.
        // This stack only certifies App Pages; the Pages path stays private.
        paths: ["/about", "/dynamic", "/pages-about"],
        rscPaths: [],
      }),
      warmCdnConcurrency: 1,
      warmCdnPromotionDelay: 0,
      warmCdnReadinessProbes: 1,
      warmCdnRetries: 0,
    });

    expect(deployedUrl).toBe("https://my-worker.example.workers.dev");
    expect(uploadCount).toBe(2);
    expect(statusCount).toBe(7);
    expect(cacheRequestCount).toBe(1);
    expect(events).toEqual([
      "upload-probe",
      "status-1",
      "stage-probe",
      "status-2",
      "readiness",
      "probe-/about",
      "probe-/dynamic",
      "status-3",
      "upload-final",
      "status-4",
      "status-5",
      "stage-final",
      "status-6",
      "triggers",
      "readiness",
      "warm",
      "status-7",
      "promote-final",
    ]);
    expect(finalConfig).toEqual({ main: "index.js", name: "my-worker", workers_dev: true });
    const manifestJson = JSON.parse(
      finalManifestSource.slice("export default ".length, -2),
    ) as string;
    const manifest = JSON.parse(manifestJson) as {
      buildId: string;
      routes: Record<string, { pattern: string; state: string }>;
    };
    expect(manifest.buildId).toBe("app-build-a");
    expect(Object.values(manifest.routes)).toEqual([
      expect.objectContaining({ pattern: "/about", state: "static-candidate" }),
    ]);
    expect(
      fs.readFileSync(path.join(tmpDir, "dist/server", CACHEABILITY_MANIFEST_MODULE), "utf8"),
    ).toBe("export default null;\n");
  });

  it("promotes a final Worker with an empty manifest when discovery finds no identities", async () => {
    writeTwoStageWorkerArtifact();
    const wrangler = mockTwoStageWrangler();
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: [],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: [],
          rscPaths: [],
        }),
      }),
    ).resolves.toBe("https://my-worker.example.workers.dev");

    expect(wrangler.uploads).toBe(2);
    expect(wrangler.promoted).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const manifestJson = JSON.parse(
      wrangler.finalManifestSource!.slice("export default ".length, -2),
    ) as string;
    expect(JSON.parse(manifestJson)).toEqual({ buildId: "app-build-a", routes: {}, version: 1 });
  });

  it("promotes an empty manifest when every discovered identity is dynamic", async () => {
    writeTwoStageWorkerArtifact();
    const wrangler = mockTwoStageWrangler();
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1"
        ? Response.json(
            {
              kind: "app-page",
              pattern: "/dynamic",
              state: "dynamic",
              status: 200,
              version: 1,
            },
            { headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a" } },
          )
        : isReadinessFetch(input)
          ? cacheableHtml()
          : new Response("unexpected", { status: 500 }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/dynamic"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/dynamic"],
          rscPaths: [],
        }),
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).resolves.toBe("https://my-worker.example.workers.dev");

    expect(wrangler.uploads).toBe(2);
    expect(wrangler.promoted).toBe(true);
    expect(getRealWarmFetchCalls()).toHaveLength(1);
    const manifestJson = JSON.parse(
      wrangler.finalManifestSource!.slice("export default ".length, -2),
    ) as string;
    expect(JSON.parse(manifestJson)).toEqual({ buildId: "app-build-a", routes: {}, version: 1 });
  });

  it("leaves an empty-manifest final Worker staged when promotion is disabled", async () => {
    writeTwoStageWorkerArtifact();
    const wrangler = mockTwoStageWrangler();
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: [],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: [],
          rscPaths: [],
        }),
        warmCdnPromote: false,
      }),
    ).resolves.toBe("https://my-worker.example.workers.dev");

    expect(wrangler.uploads).toBe(2);
    expect(wrangler.finalStaged).toBe(true);
    expect(wrangler.promoted).toBe(false);
    expect(wrangler.triggerDeploys).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not promote when a staged cache fill cannot be reused", async () => {
    writeTwoStageWorkerArtifact();
    let uploadCount = 0;
    let statusCount = 0;
    let finalStaged = false;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploadCount++;
        return `Uploaded my-worker\nWorker Version ID: ${uploadCount === 1 ? PROBE_VERSION : FINAL_VERSION}\n`;
      }
      if (args.includes("status")) {
        statusCount++;
        return JSON.stringify({
          versions:
            statusCount === 1
              ? [{ version_id: OLD_VERSION, percentage: 100 }]
              : finalStaged
                ? [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: FINAL_VERSION, percentage: 0 },
                  ]
                : [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: PROBE_VERSION, percentage: 0 },
                  ],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        return "Staged probe version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes(`${FINAL_VERSION}@0%`)) {
        finalStaged = true;
        return "Staged final version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes(`${FINAL_VERSION}@100%`)) {
        throw new Error("final version must not be promoted");
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1") {
        return appPageProbeResponse();
      }
      if (isReadinessFetch(input)) return cacheableHtml();
      return cacheableHtml();
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        dangerouslyPromoteOnCdnWarmError: true,
        warmCdnCertify: true,
        warmCdnConcurrency: 1,
        warmCdnPromotionDelay: 0,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("CF-Cache-Status is MISS; the cache fill is not reusable");
    expect(uploadCount).toBe(2);
    expect(
      (execFileSyncMock.mock.calls as Array<[string, string[]]>).some(([, args]) =>
        args.includes(`${FINAL_VERSION}@100%`),
      ),
    ).toBe(false);
  });

  it("does not let the dangerous override bypass a failed initial certified fill", async () => {
    writeTwoStageWorkerArtifact();
    const wrangler = mockTwoStageWrangler();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1") {
        return appPageProbeResponse();
      }
      if (isReadinessFetch(input)) return cacheableHtml();
      return new Response("failed fill", {
        status: 500,
        headers: {
          "cache-control": "no-store",
          [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a",
        },
      });
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        dangerouslyPromoteOnCdnWarmError: true,
        warmCdnCertify: true,
        warmCdnConcurrency: 1,
        warmCdnPromotionDelay: 0,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("HTTP 500");
    expect(wrangler.promoted).toBe(false);
  });

  it("does not overwrite deployment traffic changed before promotion", async () => {
    writeTwoStageWorkerArtifact();
    let uploadCount = 0;
    let statusCount = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploadCount++;
        return `Uploaded my-worker\nWorker Version ID: ${uploadCount === 1 ? PROBE_VERSION : FINAL_VERSION}\n`;
      }
      if (args.includes("status")) {
        statusCount++;
        const versions =
          statusCount === 1
            ? [{ version_id: OLD_VERSION, percentage: 100 }]
            : statusCount === 7
              ? [{ version_id: "44444444-4444-4444-8444-444444444444", percentage: 100 }]
              : statusCount === 6
                ? [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: FINAL_VERSION, percentage: 0 },
                  ]
                : [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: PROBE_VERSION, percentage: 0 },
                  ];
        return JSON.stringify({ versions });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        return "Staged probe version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes(`${FINAL_VERSION}@0%`)) {
        return "Staged final version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes(`${FINAL_VERSION}@100%`)) {
        throw new Error("final version must not overwrite the concurrent deployment");
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    let cacheRequestCount = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1") {
        return appPageProbeResponse();
      }
      if (isReadinessFetch(input)) return cacheableHtml();
      cacheRequestCount++;
      return cacheableHtml("ok", cacheRequestCount === 1 ? "MISS" : "HIT");
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        warmCdnCertify: true,
        warmCdnConcurrency: 1,
        warmCdnPromotionDelay: 0,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow(
      "deployment traffic or deployment identity changed before the final version could be promoted",
    );
    expect(statusCount).toBe(7);
    expect(
      (execFileSyncMock.mock.calls as Array<[string, string[]]>).some(([, args]) =>
        args.includes(`${FINAL_VERSION}@100%`),
      ),
    ).toBe(false);
  });

  it("leaves production triggers untouched when an exact request cannot be classified", async () => {
    writeTwoStageWorkerArtifact();
    const wrangler = mockTwoStageWrangler();
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1"
        ? appPageProbeResponse("probe-failed")
        : isReadinessFetch(input)
          ? cacheableHtml()
          : new Response("unexpected", { status: 500 }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        warmCdnConcurrency: 1,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("render classification failed");
    expect(wrangler.uploads).toBe(1);
    expect(wrangler.triggerDeploys).toBe(0);
    expect(wrangler.promoted).toBe(false);
  });

  it("leaves production triggers untouched when the manifest-bearing upload fails", async () => {
    writeTwoStageWorkerArtifact();
    const wrangler = mockTwoStageWrangler({ failFinalUpload: true });
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1"
        ? appPageProbeResponse()
        : isReadinessFetch(input)
          ? cacheableHtml()
          : new Response("unexpected", { status: 500 }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        warmCdnConcurrency: 1,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("final upload failed");
    expect(wrangler.uploads).toBe(2);
    expect(wrangler.triggerDeploys).toBe(0);
  });

  it.each([
    { dangerousOverride: false, shouldPromote: false },
    { dangerousOverride: true, shouldPromote: true },
  ])(
    "blocks a skipped prepared cache fill unless the dangerous override is $dangerousOverride",
    async ({ dangerousOverride, shouldPromote }) => {
      writeTwoStageWorkerArtifact();
      const wrangler = mockTwoStageWrangler();
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1") {
          return appPageProbeResponse();
        }
        if (isReadinessFetch(input)) return cacheableHtml();
        return new Response("private", {
          headers: {
            "cache-control": "no-store",
            "cf-cache-status": "BYPASS",
            [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a",
          },
        });
      });
      const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

      const deployment = deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        dangerouslyPromoteOnCdnWarmError: dangerousOverride,
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        warmCdnConcurrency: 1,
        warmCdnPromotionDelay: 0,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      });

      if (shouldPromote) {
        await expect(deployment).resolves.toBe("https://my-worker.example.workers.dev");
      } else {
        await expect(deployment).rejects.toThrow(
          "could not fill 1/1 planned cache entries because Cloudflare refused cache admission",
        );
      }
      expect(wrangler.promoted).toBe(shouldPromote);
    },
  );

  it("bounds queued prepared cache fills by one hard phase deadline", async () => {
    writeTwoStageWorkerArtifact();
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const wrangler = mockTwoStageWrangler();
    let fillCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1") {
        return appPageProbeResponse();
      }
      if (isReadinessFetch(input)) return cacheableHtml();
      fillCalls++;
      now = 120_001;
      return cacheableHtml();
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/first", "/queued"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/first", "/queued"],
          rscPaths: [],
        }),
        warmCdnConcurrency: 1,
        warmCdnPromotionDelay: 0,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("CDN warmup exceeded its 120000ms phase deadline");
    expect(fillCalls).toBe(1);
    expect(wrangler.promoted).toBe(false);
  });

  it("uses the dedicated cacheability-probe retry budget before the legacy warm fallback", async () => {
    writeTwoStageWorkerArtifact();
    let uploads = 0;
    let probeAttempts = 0;
    let staged = false;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploads++;
        return `Uploaded my-worker\nWorker Version ID: ${PROBE_VERSION}\n`;
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: staged
            ? [
                { version_id: OLD_VERSION, percentage: 100 },
                { version_id: PROBE_VERSION, percentage: 0 },
              ]
            : [{ version_id: OLD_VERSION, percentage: 100 }],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        staged = true;
        return "Staged probe version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1") {
        probeAttempts++;
        return new Response("unavailable", {
          status: 503,
          headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "app-build-a" },
        });
      }
      return isReadinessFetch(input)
        ? cacheableHtml()
        : new Response("unexpected", { status: 500 });
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        warmCdnConcurrency: 1,
        warmCdnProbeRetries: 0,
        warmCdnProbeTimeout: 100,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 5,
      }),
    ).rejects.toThrow("probe returned HTTP 503");
    expect(probeAttempts).toBe(1);
    expect(uploads).toBe(1);
  });

  it("refuses the final upload when deployment traffic changes during probing", async () => {
    writeTwoStageWorkerArtifact();
    let uploads = 0;
    let statuses = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploads++;
        return `Uploaded my-worker\nWorker Version ID: ${PROBE_VERSION}\n`;
      }
      if (args.includes("status")) {
        statuses++;
        return JSON.stringify({
          versions:
            statuses === 1
              ? [{ version_id: OLD_VERSION, percentage: 100 }]
              : statuses === 2
                ? [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: PROBE_VERSION, percentage: 0 },
                  ]
                : [
                    { version_id: OLD_VERSION, percentage: 50 },
                    { version_id: FINAL_VERSION, percentage: 50 },
                  ],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        return "Staged probe version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        return "Triggers deployed\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1"
        ? appPageProbeResponse()
        : isReadinessFetch(input)
          ? cacheableHtml()
          : new Response("unexpected", { status: 500 }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        warmCdnConcurrency: 1,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("deployment traffic or deployment identity changed");
    expect(statuses).toBe(3);
    expect(uploads).toBe(1);
  });

  it("refuses the final upload when deployment identity changes with identical traffic", async () => {
    writeTwoStageWorkerArtifact();
    let statuses = 0;
    let uploads = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploads++;
        return `Uploaded my-worker\nWorker Version ID: ${PROBE_VERSION}\n`;
      }
      if (args.includes("status")) {
        statuses++;
        return JSON.stringify({
          id:
            statuses === 1
              ? "initial-deployment"
              : statuses === 2
                ? "probe-deployment"
                : "replacement-deployment",
          versions:
            statuses === 1
              ? [{ version_id: OLD_VERSION, percentage: 100 }]
              : [
                  { version_id: OLD_VERSION, percentage: 100 },
                  { version_id: PROBE_VERSION, percentage: 0 },
                ],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        return "Staged probe version\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1"
        ? appPageProbeResponse()
        : isReadinessFetch(input)
          ? cacheableHtml()
          : new Response("unexpected", { status: 500 }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        warmCdnConcurrency: 1,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("deployment identity changed while cacheability was being probed");
    expect(uploads).toBe(1);
  });

  it("reports when final staging completed before Wrangler failed", async () => {
    writeTwoStageWorkerArtifact();
    let uploads = 0;
    let state: "old" | "probe" | "final" = "old";
    let triggerDeploys = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploads++;
        return `Uploaded my-worker\nWorker Version ID: ${uploads === 1 ? PROBE_VERSION : FINAL_VERSION}\n`;
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions:
            state === "old"
              ? [{ version_id: OLD_VERSION, percentage: 100 }]
              : [
                  { version_id: OLD_VERSION, percentage: 100 },
                  {
                    version_id: state === "probe" ? PROBE_VERSION : FINAL_VERSION,
                    percentage: 0,
                  },
                ],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        state = "probe";
        return "Staged probe version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes(`${FINAL_VERSION}@0%`)) {
        state = "final";
        throw new Error("Wrangler failed while syncing settings");
      }
      if (args.includes("triggers")) {
        triggerDeploys++;
        return "Triggers must not be applied\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1"
        ? appPageProbeResponse()
        : isReadinessFetch(input)
          ? cacheableHtml()
          : new Response("unexpected", { status: 500 }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        warmCdnConcurrency: 1,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("uploaded version is staged at 0%");
    expect(triggerDeploys).toBe(0);
  });

  it("does not stage the final version when traffic changes immediately after its upload", async () => {
    writeTwoStageWorkerArtifact();
    let uploads = 0;
    let statuses = 0;
    let finalStaged = false;
    let triggersApplied = false;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploads++;
        return `Uploaded my-worker\nWorker Version ID: ${uploads === 1 ? PROBE_VERSION : FINAL_VERSION}\n`;
      }
      if (args.includes("status")) {
        statuses++;
        return JSON.stringify({
          versions:
            statuses === 1
              ? [{ version_id: OLD_VERSION, percentage: 100 }]
              : statuses < 4
                ? [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: PROBE_VERSION, percentage: 0 },
                  ]
                : [{ version_id: "44444444-4444-4444-8444-444444444444", percentage: 100 }],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        return "Staged probe version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes(`${FINAL_VERSION}@0%`)) {
        finalStaged = true;
        return "Final version must not be staged";
      }
      if (args.includes("triggers")) {
        triggersApplied = true;
        return "Triggers must not be applied";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1"
        ? appPageProbeResponse()
        : isReadinessFetch(input)
          ? cacheableHtml()
          : new Response("unexpected", { status: 500 }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: ["/about"],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: ["/about"],
          rscPaths: [],
        }),
        warmCdnConcurrency: 1,
        warmCdnReadinessProbes: 1,
        warmCdnRetries: 0,
      }),
    ).rejects.toThrow("deployment identity changed before the final version could be staged");
    expect(uploads).toBe(2);
    expect(statuses).toBe(4);
    expect(finalStaged).toBe(false);
    expect(triggersApplied).toBe(false);
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
    expect(
      (execFileSyncMock.mock.calls as Array<[string, string[]]>).filter(([, args]) =>
        args.includes("triggers"),
      ),
    ).toHaveLength(1);
  });

  it("reports when staging completed before Wrangler failed", async () => {
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    let staged = false;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return `Uploaded version ${PROBE_VERSION}\n`;
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: staged
            ? [
                { version_id: OLD_VERSION, percentage: 100 },
                { version_id: PROBE_VERSION, percentage: 0 },
              ]
            : [{ version_id: OLD_VERSION, percentage: 100 }],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        staged = true;
        throw new Error("Wrangler failed while syncing settings");
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        expectedBuildId: "app-build-a",
      }),
    ).rejects.toThrow("uploaded version is staged at 0%");
  });

  it("reports when a failed staging command did not change traffic", async () => {
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${PROBE_VERSION}\n`;
      if (args.includes("status")) {
        return JSON.stringify({
          id: "old-deployment",
          versions: [{ version_id: OLD_VERSION, percentage: 100 }],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) throw new Error("staging failed");
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], { expectedBuildId: "app-build-a" }),
    ).rejects.toThrow("deployment traffic was not changed");
  });

  it("reports an unknown outcome when failed staging cannot be reconciled", async () => {
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
    let statusReads = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${PROBE_VERSION}\n`;
      if (args.includes("status")) {
        statusReads++;
        if (statusReads > 1) throw new Error("status unavailable");
        return JSON.stringify({
          versions: [{ version_id: OLD_VERSION, percentage: 100 }],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) throw new Error("staging failed");
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], { expectedBuildId: "app-build-a" }),
    ).rejects.toThrow("deployment outcome is unknown (status unavailable)");
  });

  it("reports when promotion completed before Wrangler failed", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    let state: "old" | "staged" | "promoted" = "old";
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${PROBE_VERSION}\n`;
      if (args.includes("status")) {
        return JSON.stringify({
          versions:
            state === "old"
              ? [{ version_id: OLD_VERSION, percentage: 100 }]
              : state === "staged"
                ? [
                    { version_id: OLD_VERSION, percentage: 100 },
                    { version_id: PROBE_VERSION, percentage: 0 },
                  ]
                : [{ version_id: PROBE_VERSION, percentage: 100 }],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        state = "staged";
        return "Staged version\nhttps://my-worker.example.workers.dev\n";
      }
      if (args.includes(`${PROBE_VERSION}@100%`)) {
        state = "promoted";
        throw new Error("Wrangler failed while syncing settings");
      }
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        expectedBuildId: "app-build-a",
        warmCdnPromotionDelay: 0,
        warmCdnReadinessProbes: 1,
      }),
    ).rejects.toThrow("already promoted to 100%");
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
    let staged = false;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return "Uploaded version 22222222-2222-4222-8222-222222222222\n";
      }
      if (args.includes("status")) {
        return JSON.stringify({
          versions: staged
            ? [
                { version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 },
                { version_id: "22222222-2222-4222-8222-222222222222", percentage: 0 },
              ]
            : [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        });
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@0%")) {
        staged = true;
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
    ).rejects.toThrow("remains staged at 0%");
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

  it.each(["identity", "traffic"] as const)(
    "rejects no-promote handoff when staged deployment %s changes after warming",
    async (change) => {
      writeTwoStageWorkerArtifact();
      const wrangler = mockTwoStageWrangler({ replaceFinalStageBeforeHandoff: change });
      const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

      await expect(
        deployWithCdnWarmup(tmpDir, [], {
          cacheabilityProbe: true,
          config: "dist/server/wrangler.json",
          discoverWarmPlan: async () => ({
            appPaths: [],
            buildId: "app-build-a",
            buildIdentity: "app-build-a",
            loadingShellPaths: [],
            paths: [],
            rscPaths: [],
          }),
          warmCdnPromote: false,
        }),
      ).rejects.toThrow("changed before the no-promote handoff");

      expect(wrangler.triggerDeploys).toBe(1);
      expect(wrangler.promoted).toBe(false);
    },
  );

  it("explains an unconfirmed deployment after successful probe staging", async () => {
    writeTwoStageWorkerArtifact();
    let statusReads = 0;
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        return `Uploaded my-worker\nWorker Version ID: ${PROBE_VERSION}\n`;
      }
      if (args.includes("status")) {
        statusReads++;
        if (statusReads > 1) throw new Error("deployment status unavailable");
        return JSON.stringify({
          id: "initial-deployment",
          versions: [{ version_id: OLD_VERSION, percentage: 100 }],
        });
      }
      if (args.includes(`${PROBE_VERSION}@0%`)) {
        return "Staged probe version\nhttps://my-worker.example.workers.dev\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, [], {
        cacheabilityProbe: true,
        config: "dist/server/wrangler.json",
        discoverWarmPlan: async () => ({
          appPaths: [],
          buildId: "app-build-a",
          buildIdentity: "app-build-a",
          loadingShellPaths: [],
          paths: [],
          rscPaths: [],
        }),
      }),
    ).rejects.toThrow("probe staging command completed");
    expect(
      (execFileSyncMock.mock.calls as Array<[string, string[]]>).filter(([, args]) =>
        args.includes("triggers"),
      ),
    ).toHaveLength(0);
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
