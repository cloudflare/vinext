import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const UPLOADED_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PREVIOUS_VERSION_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
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

function versionedResponse(versionId = UPLOADED_VERSION_ID, cacheStatus = "HIT"): Response {
  return new Response("ok", {
    status: 200,
    headers: { "x-vinext-worker-version": versionId, "cf-cache-status": cacheStatus },
  });
}

function warmupWranglerConfig(config: Record<string, unknown>): string {
  const env = config.env;
  const configuredEnv =
    env && typeof env === "object" && !Array.isArray(env)
      ? Object.fromEntries(
          Object.entries(env).map(([name, value]) => [
            name,
            {
              ...(value as Record<string, unknown>),
              version_metadata: { binding: "VINEXT_VERSION_METADATA" },
            },
          ]),
        )
      : undefined;
  return JSON.stringify({
    ...config,
    cache: { enabled: true, ...(config.cache as Record<string, unknown> | undefined) },
    version_metadata: { binding: "VINEXT_VERSION_METADATA" },
    ...(configuredEnv ? { env: configuredEnv } : {}),
  });
}

const WORKERS_DEV_SUBDOMAIN = "vinext.workers.dev";

/**
 * Real `wrangler versions upload` output. Alongside the version ID it prints a
 * version-scoped preview URL built as
 * `https://{first 8 of the version ID}-{worker}.{account subdomain}`, which is
 * the only pre-promotion source for the workers.dev origin: `wrangler versions
 * deploy` reports traffic splits and never prints a URL.
 */
function uploadOutput(workerName: string, versionId = UPLOADED_VERSION_ID): string {
  return (
    `Uploaded version ${versionId}\n` +
    `Version Preview URL: https://${versionId.slice(0, 8)}-${workerName}.${WORKERS_DEV_SUBDOMAIN}\n`
  );
}

function currentDeploymentOutput(): string {
  return JSON.stringify({
    versions: [{ version_id: PREVIOUS_VERSION_ID, percentage: 100 }],
  });
}

function stagedDeploymentOutput(): string {
  return JSON.stringify({
    versions: [
      { version_id: PREVIOUS_VERSION_ID, percentage: 100 },
      { version_id: UPLOADED_VERSION_ID, percentage: 0 },
    ],
  });
}

/**
 * Real `wrangler deployments status` reflects the staged split once the stage
 * command has run, which the pre-promotion ownership check re-reads.
 */
function deploymentStatusOutput(): string {
  const hasStaged = execFileSyncMock.mock.calls.some(([, args]) => isStage(args as string[]));
  return hasStaged ? stagedDeploymentOutput() : currentDeploymentOutput();
}

function isStage(args: string[]): boolean {
  return args.includes(`${PREVIOUS_VERSION_ID}@100%`) && args.includes(`${UPLOADED_VERSION_ID}@0%`);
}

function isPromotion(args: string[]): boolean {
  return args.includes(`${UPLOADED_VERSION_ID}@100%`);
}

describe("Cloudflare CDN warmup deploy flow", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cdn-warm-deploy-test-"));
    execFileSyncMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => versionedResponse()),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects a named environment without its own metadata binding before upload", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        version_metadata: { binding: "VINEXT_VERSION_METADATA" },
        env: { staging: { name: "my-worker-staging", route: "staging.example.com/*" } },
      }),
    );
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], { env: "staging" })).rejects.toThrow(
      'requires a version_metadata binding named "VINEXT_VERSION_METADATA" in Wrangler environment "staging"',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a version_metadata binding with a non-default name", async () => {
    // The runtime only ever reads env.VINEXT_VERSION_METADATA (worker-version.ts),
    // so a differently named binding would silently never stamp responses.
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ version_metadata: { binding: "CUSTOM_VERSION" } }),
    );
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).rejects.toThrow(
      'requires a version_metadata binding named "VINEXT_VERSION_METADATA" in the top-level Wrangler config',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("rejects a deploy whose Worker cache is disabled before upload", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        cache: { enabled: false },
        version_metadata: { binding: "VINEXT_VERSION_METADATA" },
      }),
    );
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).rejects.toThrow(
      "requires Cloudflare Workers caching to be enabled",
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("rejects cross-version caching before upload", async () => {
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        cache: { cross_version_cache: true },
      }),
    );
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).rejects.toThrow(
      "requires cache.cross_version_cache to be false",
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each(["123-app", "My-App"])(
    "rejects Worker name %s when it cannot be encoded as an override dictionary key",
    async (workerName) => {
      writeFile("wrangler.jsonc", warmupWranglerConfig({ name: workerName }));
      const { deployWithCdnWarmup } =
        await import("../packages/cloudflare/src/cdn-warm-deployment.js");

      await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).rejects.toThrow(
        `cannot encode Worker name "${workerName}"`,
      );
      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("uses an environment-local cache block instead of the inherited top-level block", async () => {
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        cache: { enabled: true, cross_version_cache: true },
        env: {
          staging: {
            name: "my-worker-staging",
            cache: { enabled: true },
          },
        },
      }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("my-worker-staging");
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (isPromotion(args)) return "Promoted version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], { env: "staging" })).resolves.toMatchObject({
      warmed: true,
    });
  });

  it("stages, warms the exact route with a version override, then promotes", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        cache: { enabled: true },
        routes: [{ pattern: "app.example.com/*", zone_name: "example.com" }],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const override = new Headers(init?.headers).get("Cloudflare-Workers-Version-Overrides");
      events.push(`fetch:${formatFetchUrl(url)}:${override}`);
      return versionedResponse();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return uploadOutput("my-worker");
      }
      if (args.includes("status")) {
        events.push("status");
        return deploymentStatusOutput();
      }
      if (isStage(args)) {
        events.push("stage");
        return "Staged version\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      if (isPromotion(args)) {
        events.push("promote");
        return "Promoted version\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    const result = await deployWithCdnWarmup(tmpDir, ["/", "/about"], {
      warmCdnConcurrency: 1,
    });

    expect(result).toEqual({ url: "https://my-worker.vinext.workers.dev", warmed: true });
    expect(events).toEqual([
      "upload",
      "status",
      "status",
      "stage",
      `fetch:https://app.example.com/:my-worker="${UPLOADED_VERSION_ID}"`,
      `fetch:https://app.example.com/about:my-worker="${UPLOADED_VERSION_ID}"`,
      "status",
      "promote",
      "triggers",
    ]);
  });

  it("prefers the trigger-reported production URL over the version preview URL", async () => {
    // The trigger command is the only Wrangler call that reports this custom
    // domain. The final "Deployed to:" line must use it instead of a
    // workers.dev host derived from the upload.
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        routes: [{ pattern: "app.example.com/*", zone_name: "example.com" }],
      }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("my-worker");
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\napp.example.com (custom domain)\n";
      if (isPromotion(args)) return "Promoted version\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).resolves.toEqual({
      url: "https://app.example.com",
      warmed: true,
    });
  });

  it("warms every host-wide origin before reporting the deployment warmed", async () => {
    // The hostname is part of Cloudflare's cache key: each attached route has
    // its own partition, so a two-route deployment is only warm when both
    // origins were warmed for every path.
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        routes: [
          { pattern: "app.example.com/*", zone_name: "example.com" },
          { pattern: "www.example.com/*", zone_name: "example.com" },
        ],
      }),
    );
    const fetchedUrls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (url) => {
      fetchedUrls.push(formatFetchUrl(url));
      return versionedResponse();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${UPLOADED_VERSION_ID}\n`;
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      if (isPromotion(args)) return "Promoted version\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    const result = await deployWithCdnWarmup(tmpDir, ["/", "/about"], {
      warmCdnConcurrency: 1,
    });

    expect(result.warmed).toBe(true);
    expect(fetchedUrls.sort()).toEqual([
      "https://app.example.com/",
      "https://app.example.com/about",
      "https://www.example.com/",
      "https://www.example.com/about",
    ]);
  });

  it("warms workers.dev alongside custom routes when it is explicitly enabled", async () => {
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        workers_dev: true,
        route: "app.example.com/*",
      }),
    );
    const fetchedUrls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (url) => {
      fetchedUrls.push(formatFetchUrl(url));
      return versionedResponse();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("my-worker");
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      if (isPromotion(args)) return "Promoted version\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).resolves.toMatchObject({
      warmed: true,
    });
    expect(fetchedUrls.sort()).toEqual([
      "https://app.example.com/",
      "https://my-worker.vinext.workers.dev/",
    ]);
  });

  it("does not report warmed when a second origin fails cache confirmation", async () => {
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        routes: ["app.example.com/*", "www.example.com/*"],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url) => {
      const host = new URL(formatFetchUrl(url)).host;
      // BYPASS is a response Workers Cache will never store, so the second
      // origin's partition provably stays cold.
      return host === "www.example.com"
        ? versionedResponse(UPLOADED_VERSION_ID, "BYPASS")
        : versionedResponse();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${UPLOADED_VERSION_ID}\n`;
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      if (isPromotion(args)) return "Promoted version\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    const result = await deployWithCdnWarmup(tmpDir, ["/"], { warmCdnConcurrency: 1 });

    // Non-strict still promotes, but must not claim a confirmed warm-up.
    expect(result.warmed).toBe(false);
    expect(execFileSyncMock.mock.calls.some(([, args]) => isPromotion(args as string[]))).toBe(
      true,
    );
  });

  it("fails a strict deploy before promotion when any origin cannot be confirmed", async () => {
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        routes: ["app.example.com/*", "www.example.com/*"],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url) => {
      const host = new URL(formatFetchUrl(url)).host;
      return host === "www.example.com"
        ? versionedResponse(UPLOADED_VERSION_ID, "BYPASS")
        : versionedResponse();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${UPLOADED_VERSION_ID}\n`;
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], { warmCdnConcurrency: 1, warmCdnStrict: true }),
    ).rejects.toThrow(`This deploy did not promote the uploaded Worker version`);
    expect(execFileSyncMock.mock.calls.some(([, args]) => isPromotion(args as string[]))).toBe(
      false,
    );
  });

  it("does not report warmed when a path-scoped route coexists with a warmed origin", async () => {
    // blog.example.com/blog/* has its own cache partition that warming
    // app.example.com cannot reach, so a fully confirmed app origin must not
    // produce a "confirmed pre-warmed" deployment.
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        routes: [
          { pattern: "app.example.com/*", zone_name: "example.com" },
          { pattern: "blog.example.com/blog/*", zone_name: "example.com" },
        ],
      }),
    );
    const fetchedUrls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (url) => {
      fetchedUrls.push(formatFetchUrl(url));
      return versionedResponse();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${UPLOADED_VERSION_ID}\n`;
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      if (isPromotion(args)) return "Promoted version\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    const result = await deployWithCdnWarmup(tmpDir, ["/"], { warmCdnConcurrency: 1 });

    // The reachable origin is still warmed and the promotion still happens,
    // but the deployment must not claim a confirmed warm-up.
    expect(result.warmed).toBe(false);
    expect(fetchedUrls).toEqual(["https://app.example.com/"]);
    expect(execFileSyncMock.mock.calls.some(([, args]) => isPromotion(args as string[]))).toBe(
      true,
    );
  });

  it("fails a strict deploy before warming when a route cannot be covered", async () => {
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        routes: ["app.example.com/*", "blog.example.com/blog/*"],
      }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${UPLOADED_VERSION_ID}\n`;
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], { warmCdnConcurrency: 1, warmCdnStrict: true }),
    ).rejects.toThrow("cannot cover every production route");
    expect(fetch).not.toHaveBeenCalled();
    expect(execFileSyncMock.mock.calls.some(([, args]) => isPromotion(args as string[]))).toBe(
      false,
    );
  });

  it("uses the selected environment route and Worker name for the override", async () => {
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({
        name: "my-worker",
        route: "app.example.com/*",
        env: {
          staging: {
            name: "my-worker-staging-custom",
            route: "staging.example.com/*",
          },
        },
      }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${UPLOADED_VERSION_ID}\n`;
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      if (isPromotion(args)) return "Promoted version\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await deployWithCdnWarmup(tmpDir, ["/"], { env: "staging" });

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://staging.example.com/"),
      expect.objectContaining({
        headers: expect.any(Headers),
        redirect: "manual",
      }),
    );
    const headers = new Headers(vi.mocked(fetch).mock.calls[0]![1]?.headers);
    expect(headers.get("Cloudflare-Workers-Version-Overrides")).toBe(
      `my-worker-staging-custom="${UPLOADED_VERSION_ID}"`,
    );
    for (const [, args] of execFileSyncMock.mock.calls as Array<[string, string[]]>) {
      expect(args).toEqual(expect.arrayContaining(["--env", "staging"]));
    }
  });

  it("warms workers.dev while the uploaded version remains at 0%", async () => {
    // The staging command reports a traffic split and no URL, so the only
    // pre-promotion report of the workers.dev origin is the upload's
    // version-scoped preview host. Warmup must request the production host
    // (`workers-cache.…`), never the version-prefixed preview host, which is a
    // separate cache key production traffic never reads.
    const events: string[] = [];
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      events.push(`fetch:${formatFetchUrl(url)}`);
      expect(new Headers(init?.headers).get("Cloudflare-Workers-Version-Overrides")).toBe(
        `workers-cache="${UPLOADED_VERSION_ID}"`,
      );
      return versionedResponse();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return uploadOutput("workers-cache");
      }
      if (args.includes("status")) {
        events.push("status");
        return deploymentStatusOutput();
      }
      if (isStage(args)) {
        events.push("stage");
        return "Staged version\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      if (isPromotion(args)) {
        events.push("promote");
        return "Promoted version\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    const result = await deployWithCdnWarmup(tmpDir, ["/cached/intro"], {});

    expect(result).toEqual({ url: "https://workers-cache.vinext.workers.dev", warmed: true });
    expect(events).toEqual([
      "upload",
      "status",
      "status",
      "stage",
      "fetch:https://workers-cache.vinext.workers.dev/cached/intro",
      "status",
      "promote",
      "triggers",
    ]);
  });

  it("refuses a strict workers.dev warmup when the upload reports no preview URL", async () => {
    // Wrangler omits the preview URL when preview URLs are disabled on the
    // subdomain, leaving no source for the production workers.dev origin.
    // Guessing at the account subdomain could warm a host this deployment does
    // not answer on, so strict mode refuses before promoting anything.
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${UPLOADED_VERSION_ID}\n`;
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/cached/intro"], { warmCdnStrict: true }),
    ).rejects.toThrow("requires a production URL and Worker name");
    expect(fetch).not.toHaveBeenCalled();
    for (const [, args] of execFileSyncMock.mock.calls as Array<[string, string[]]>) {
      expect(isPromotion(args)).toBe(false);
    }
  });

  it("does not claim workers.dev is warm for a path-scoped production route", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({ name: "workers-cache", route: "app.example.com/api/*" }),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache");
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) {
        events.push("stage");
        return "Staged version\n";
      }
      if (isPromotion(args)) {
        events.push("promote");
        return "Promoted version\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const warnSpy = vi.spyOn(console, "warn");
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/api/docs"], {})).resolves.toEqual({
      url: "https://workers-cache.vinext.workers.dev",
      warmed: false,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(events).toEqual(["stage", "promote", "triggers"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("path-scoped Worker routes"));
  });

  it("retries a failed override before promoting the uploaded version", async () => {
    const events: string[] = [];
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    vi.mocked(fetch)
      .mockImplementationOnce(async () => {
        events.push("fetch:old-version");
        return versionedResponse(PREVIOUS_VERSION_ID);
      })
      .mockImplementationOnce(async () => {
        events.push("fetch:new-version");
        return versionedResponse(UPLOADED_VERSION_ID);
      });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return uploadOutput("workers-cache");
      }
      if (args.includes("status")) {
        events.push("status");
        return deploymentStatusOutput();
      }
      if (isStage(args)) {
        events.push("stage");
        return "Staged version\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      if (isPromotion(args)) {
        events.push("promote");
        return "Promoted version\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await deployWithCdnWarmup(tmpDir, ["/cached/intro"], { warmCdnRetries: 1 });

    expect(events).toEqual([
      "upload",
      "status",
      "status",
      "stage",
      "fetch:old-version",
      "fetch:new-version",
      "status",
      "promote",
      "triggers",
    ]);
  });

  it("does not report warmed when the uploaded version answers 200 but the cache never stores it", async () => {
    // The uploaded version producing a 200 and Workers Cache storing that
    // response are different facts — a BYPASS (e.g. Set-Cookie or no-store)
    // passes the producer check while leaving the cache partition cold.
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    vi.mocked(fetch).mockImplementation(async () =>
      versionedResponse(UPLOADED_VERSION_ID, "BYPASS"),
    );
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache");
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      if (isPromotion(args)) return "Promoted version\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/cached/intro"], {})).resolves.toMatchObject({
      warmed: false,
    });
  });

  it("confirms a MISS fill with a second request before promoting", async () => {
    const events: string[] = [];
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    vi.mocked(fetch)
      .mockImplementationOnce(async () => {
        events.push("fetch:miss");
        return versionedResponse(UPLOADED_VERSION_ID, "MISS");
      })
      .mockImplementationOnce(async () => {
        events.push("fetch:hit");
        return versionedResponse(UPLOADED_VERSION_ID, "HIT");
      });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache");
      if (args.includes("status")) return deploymentStatusOutput();
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      if (isPromotion(args)) {
        events.push("promote");
        return "Promoted version\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/cached/intro"], {})).resolves.toMatchObject({
      warmed: true,
    });
    expect(events).toEqual(["fetch:miss", "fetch:hit", "promote"]);
  });

  it("warms a newly attached route after promotion without reporting it pre-warmed", async () => {
    const events: string[] = [];
    const warnSpy = vi.spyOn(console, "warn");
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({ name: "workers-cache", route: "new.example.com/*" }),
    );
    vi.mocked(fetch)
      .mockImplementationOnce(async (url) => {
        events.push(`fetch:old-version:${formatFetchUrl(url)}`);
        return versionedResponse(PREVIOUS_VERSION_ID);
      })
      .mockImplementationOnce(async (url) => {
        events.push(`fetch:new-version-after-triggers:${formatFetchUrl(url)}`);
        return versionedResponse(UPLOADED_VERSION_ID);
      });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return uploadOutput("workers-cache");
      }
      if (args.includes("status")) {
        events.push("status");
        return deploymentStatusOutput();
      }
      if (isStage(args)) {
        events.push("stage");
        return "Staged version\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\nnew.example.com (custom domain)\n";
      }
      if (isPromotion(args)) {
        events.push("promote-uploaded");
        return "Promoted version\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    const result = await deployWithCdnWarmup(tmpDir, ["/cached/intro"], { warmCdnRetries: 0 });

    // The desired route did not reach this Worker until triggers were applied.
    // Non-strict mode can fill it after promotion, but must not call that fill
    // a confirmed pre-warm.
    expect(result).toEqual({
      url: "https://new.example.com",
      warmed: false,
    });
    expect(events).toEqual([
      "upload",
      "status",
      "status",
      "stage",
      "fetch:old-version:https://new.example.com/cached/intro",
      "status",
      "promote-uploaded",
      "triggers",
      "fetch:new-version-after-triggers:https://new.example.com/cached/intro",
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("confirmed 0/1 path(s) served the uploaded version"),
    );
  });

  it("leaves triggers unchanged when a strict route is not already active", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({ name: "my-worker", route: "app.example.com/*" }),
    );
    vi.mocked(fetch).mockImplementation(async () => {
      events.push("fetch:old-version");
      return versionedResponse(PREVIOUS_VERSION_ID);
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return uploadOutput("my-worker");
      }
      if (args.includes("status")) {
        events.push("status");
        return deploymentStatusOutput();
      }
      if (isStage(args)) {
        events.push("stage");
        return "Staged version\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      if (isPromotion(args)) {
        events.push("promote");
        return "Promoted version\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        warmCdnRetries: 0,
        warmCdnStrict: true,
      }),
    ).rejects.toThrow(
      /CDN warmup failed for 1\/1 path\(s\); verified 0\/1\.[\s\S]*This deploy did not promote[\s\S]*another deploy may have changed the current traffic split/,
    );
    // Strict failure leaves production triggers unchanged and does not promote.
    expect(events).toEqual(["upload", "status", "status", "stage", "fetch:old-version"]);
  });

  it("stages and promotes a fresh attempt after a prior warmup left a version staged", async () => {
    const events: string[] = [];
    const failedVersionId = "33333333-3333-4333-8333-333333333333";
    const stagingSplits: string[][] = [];
    let uploadAttempts = 0;
    let statusReads = 0;
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({ name: "my-worker", route: "app.example.com/*" }),
    );
    const fetchResponses: Array<() => Response> = [
      () => {
        events.push("fetch:old-version");
        return versionedResponse(PREVIOUS_VERSION_ID);
      },
      () => {
        events.push("fetch:new-version");
        return versionedResponse(UPLOADED_VERSION_ID);
      },
    ];
    vi.mocked(fetch).mockImplementation(async () => {
      const next = fetchResponses.shift();
      if (!next) throw new Error("Unexpected fetch call");
      return next();
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        uploadAttempts++;
        const versionId = uploadAttempts === 1 ? failedVersionId : UPLOADED_VERSION_ID;
        events.push(uploadAttempts === 1 ? "upload:first" : "upload:retry");
        return uploadOutput("my-worker", versionId);
      }
      if (args.includes("status")) {
        events.push("status");
        statusReads++;
        // Reads 1-2: the first attempt's initial and pre-stage snapshots.
        // Reads 3-4: the failed attempt's 0% version remains present for the
        // retry's initial and pre-stage snapshots. Read 5 observes the retry's
        // own staged split before promotion.
        if (statusReads <= 2) return currentDeploymentOutput();
        if (statusReads <= 4) {
          return JSON.stringify({
            versions: [
              { version_id: PREVIOUS_VERSION_ID, percentage: 100 },
              { version_id: failedVersionId, percentage: 0 },
            ],
          });
        }
        return stagedDeploymentOutput();
      }
      if (
        args.includes(`${PREVIOUS_VERSION_ID}@100%`) &&
        (args.includes(`${failedVersionId}@0%`) || args.includes(`${UPLOADED_VERSION_ID}@0%`))
      ) {
        events.push("stage");
        stagingSplits.push(args);
        return "Staged version\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      if (isPromotion(args)) {
        events.push("promote");
        return "Promoted version\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        warmCdnRetries: 0,
        warmCdnStrict: true,
      }),
    ).rejects.toThrow("This deploy did not promote the uploaded Worker version");

    const result = await deployWithCdnWarmup(tmpDir, ["/"], {
      warmCdnRetries: 0,
      warmCdnStrict: true,
    });

    expect(result).toEqual({ url: "https://my-worker.vinext.workers.dev", warmed: true });
    expect(events).toEqual([
      "upload:first",
      "status",
      "status",
      "stage",
      "fetch:old-version",
      "upload:retry",
      "status",
      "status",
      "stage",
      "fetch:new-version",
      "status",
      "promote",
      "triggers",
    ]);
    expect(stagingSplits[1]).not.toContain(`${failedVersionId}@0%`);
  });

  it("surfaces an actionable error when the promotion CLI call fails, without re-reading status or applying triggers", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({ name: "my-worker", route: "app.example.com/*" }),
    );
    vi.mocked(fetch).mockImplementation(async () => versionedResponse(UPLOADED_VERSION_ID));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return `Uploaded version ${UPLOADED_VERSION_ID}\n`;
      if (args.includes("status")) {
        events.push("status");
        return deploymentStatusOutput();
      }
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      if (isPromotion(args)) {
        events.push("promote-attempt");
        throw new Error("network blip during promote");
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).rejects.toThrow(
      `Could not confirm the promotion of Worker version ${UPLOADED_VERSION_ID} succeeded`,
    );
    // One status read classifies the deployment, one runs immediately before
    // staging, and one re-checks ownership before promotion. An ambiguous
    // promotion failure must not apply triggers.
    expect(events).toEqual(["status", "status", "status", "promote-attempt"]);
  });

  it("aborts promotion when another deploy replaces the staged split during warmup", async () => {
    const otherDeployVersionId = "33333333-3333-4333-8333-333333333333";
    const commands: string[] = [];
    let statusReads = 0;
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    vi.mocked(fetch).mockImplementation(async () => versionedResponse(UPLOADED_VERSION_ID));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache");
      if (args.includes("status")) {
        statusReads++;
        // Deploy B promoted its own version while this deploy was warming.
        return statusReads < 3
          ? currentDeploymentOutput()
          : JSON.stringify({
              versions: [{ version_id: otherDeployVersionId, percentage: 100 }],
            });
      }
      if (isStage(args)) return "Staged version\n";
      if (isPromotion(args)) {
        commands.push("promote");
        return "Promoted version\n";
      }
      if (args.includes("triggers")) {
        commands.push("triggers");
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    // Non-strict mode: relaxed warmup requirements never grant permission to
    // overwrite a deployment created by another actor.
    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).rejects.toThrow(
      new RegExp(
        `no longer matches the staged traffic split[\\s\\S]*observed ${otherDeployVersionId}@100%[\\s\\S]*was not promoted`,
      ),
    );
    expect(commands).toEqual([]);
  });

  it("does not overwrite a deployment that changes before staging", async () => {
    const otherDeployVersionId = "33333333-3333-4333-8333-333333333333";
    let statusReads = 0;
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache");
      if (args.includes("status")) {
        statusReads++;
        return statusReads === 1
          ? currentDeploymentOutput()
          : JSON.stringify({
              versions: [{ version_id: otherDeployVersionId, percentage: 100 }],
            });
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).rejects.toThrow(
      new RegExp(
        `changed before CDN warmup staging[\\s\\S]*observed ${otherDeployVersionId}@100%[\\s\\S]*remains undeployed`,
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(execFileSyncMock).toHaveBeenCalledTimes(3);
    expect(execFileSyncMock.mock.calls.some(([, args]) => isStage(args as string[]))).toBe(false);
  });

  it("aborts promotion when the pre-promotion status re-read fails", async () => {
    const commands: string[] = [];
    let statusReads = 0;
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    vi.mocked(fetch).mockImplementation(async () => versionedResponse(UPLOADED_VERSION_ID));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache");
      if (args.includes("status")) {
        statusReads++;
        if (statusReads < 3) return currentDeploymentOutput();
        throw new Error("status request timed out");
      }
      if (isStage(args)) return "Staged version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      if (isPromotion(args)) {
        commands.push("promote");
        return "Promoted version\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).rejects.toThrow(
      /Could not re-read the current deployment before promotion[\s\S]*was not promoted/,
    );
    expect(commands).toEqual([]);
  });

  it("does not mutate canonical cache keys when a safe staging deployment is unavailable", async () => {
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache");
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [
            { version_id: PREVIOUS_VERSION_ID, percentage: 50 },
            { version_id: "33333333-3333-4333-8333-333333333333", percentage: 50 },
          ],
        });
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], { warmCdnStrict: true })).rejects.toThrow(
      `Observed traffic: ${PREVIOUS_VERSION_ID}@50%, 33333333-3333-4333-8333-333333333333@50%. Uploaded Worker version ${UPLOADED_VERSION_ID} remains undeployed`,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("does not stage a duplicate split when the upload is already at 100%", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache", PREVIOUS_VERSION_ID);
      if (args.includes("status")) return deploymentStatusOutput();
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).resolves.toMatchObject({ warmed: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("because it is already serving 100% traffic"),
    );
    expect(execFileSyncMock).toHaveBeenCalledTimes(3);
    expect(
      execFileSyncMock.mock.calls.some(([, args]) =>
        (args as string[]).some((arg) => arg === `${PREVIOUS_VERSION_ID}@0%`),
      ),
    ).toBe(false);
  });

  it("fails strict warmup clearly when the uploaded version is already at 100%", async () => {
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache", PREVIOUS_VERSION_ID);
      if (args.includes("status")) return deploymentStatusOutput();
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], { warmCdnStrict: true })).rejects.toThrow(
      `Worker version ${PREVIOUS_VERSION_ID} because it is already serving 100% traffic`,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("reports a deployment-status read failure before promoting without warmup", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache");
      if (args.includes("status")) throw new Error("status request timed out");
      if (isPromotion(args)) return "Promoted version\n";
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).resolves.toMatchObject({
      warmed: false,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "CDN pre-warm could not read the current deployment (status request timed out)",
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not apply triggers when a direct promotion result is ambiguous", async () => {
    const events: string[] = [];
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache");
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [
            { version_id: PREVIOUS_VERSION_ID, percentage: 50 },
            { version_id: "33333333-3333-4333-8333-333333333333", percentage: 50 },
          ],
        });
      }
      if (isPromotion(args)) {
        events.push("promote-attempt");
        throw new Error("network blip during promote");
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).rejects.toThrow(
      /Could not confirm the promotion[\s\S]*Triggers were not applied/,
    );
    expect(events).toEqual(["promote-attempt"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry failed warmups when trigger deployment fails after promotion", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      warmupWranglerConfig({ name: "my-worker", route: "new.example.com/*" }),
    );
    vi.mocked(fetch).mockImplementation(async () => {
      events.push("fetch:old-version");
      return versionedResponse(PREVIOUS_VERSION_ID);
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("my-worker");
      if (args.includes("status")) {
        events.push("status");
        return deploymentStatusOutput();
      }
      if (isStage(args)) {
        events.push("stage");
        return "Staged version\n";
      }
      if (isPromotion(args)) {
        events.push("promote");
        return "Promoted version\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        throw new Error("trigger update failed");
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], { warmCdnRetries: 0 })).rejects.toThrow(
      "Trigger state may be partially changed",
    );
    expect(events).toEqual([
      "status",
      "status",
      "stage",
      "fetch:old-version",
      "status",
      "promote",
      "triggers",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports trigger recovery after a non-strict direct promotion", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    writeFile("wrangler.jsonc", warmupWranglerConfig({ name: "workers-cache" }));
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) return uploadOutput("workers-cache");
      if (args.includes("status")) {
        return JSON.stringify({
          versions: [
            { version_id: PREVIOUS_VERSION_ID, percentage: 50 },
            { version_id: "33333333-3333-4333-8333-333333333333", percentage: 50 },
          ],
        });
      }
      if (isPromotion(args)) return "Promoted version\n";
      if (args.includes("triggers")) throw new Error("trigger update failed");
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } =
      await import("../packages/cloudflare/src/cdn-warm-deployment.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], {})).rejects.toThrow(
      "The uploaded Worker version was promoted to 100%, but applying triggers",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `Observed traffic: ${PREVIOUS_VERSION_ID}@50%, 33333333-3333-4333-8333-333333333333@50%`,
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
