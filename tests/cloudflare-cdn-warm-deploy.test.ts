import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";

const CANONICAL_RSC_VARY = `${VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER}, Cookie, Authorization, Host`;

const execFileSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
    spawn: spawnMock,
  };
});

let tmpDir: string;

function createMockChildProcess(output = "", code = 0): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr });
  queueMicrotask(() => {
    stdout.end(output);
    stderr.end();
    child.emit("close", code, null);
  });
  return child;
}

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

function versionProbeResponse(
  url: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Response | null {
  if (init?.method !== "GET") return null;
  const versionId = new URL(formatFetchUrl(url)).searchParams.get("__vinext_version_probe");
  if (!versionId) return null;
  return new Response(null, {
    status: 204,
    headers: { "X-Vinext-Worker-Version": versionId },
  });
}

describe("Cloudflare CDN warmup deploy flow", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cdn-warm-deploy-test-"));
    execFileSyncMock.mockReset();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createMockChildProcess("https://staging.example.com\n"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url, init) =>
          versionProbeResponse(url, init) ??
          new Response("ok", { status: 200, headers: { "CF-Cache-Status": "MISS" } }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects an incompatible version metadata binding before uploading", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ version_metadata: { binding: "CUSTOM_VERSION" } }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], { warmCdnConcurrency: 1 })).rejects.toThrow(
      'CDN warming requires the version metadata binding to be named "VINEXT_VERSION_METADATA", but Wrangler config uses "CUSTOM_VERSION".',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an incompatible binding from UTF-8 BOM-prefixed JSONC before uploading", async () => {
    writeFile(
      "wrangler.jsonc",
      `\uFEFF${JSON.stringify({ version_metadata: { binding: "CUSTOM_VERSION" } })}`,
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(deployWithCdnWarmup(tmpDir, ["/"], { warmCdnConcurrency: 1 })).rejects.toThrow(
      'Wrangler config uses "CUSTOM_VERSION"',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an incompatible binding for a quoted dotted TOML environment before uploading", async () => {
    writeFile(
      "wrangler.toml",
      `[env]
"staging.eu".version_metadata.binding = "CUSTOM_VERSION"
`,
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        env: "staging.eu",
        warmCdnConcurrency: 1,
      }),
    ).rejects.toThrow('Wrangler config uses "CUSTOM_VERSION" for env staging.eu');
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an incompatible binding from a root-level dotted TOML environment", async () => {
    writeFile(
      "wrangler.toml",
      `name = "root-worker"
env."staging.eu".name = "custom-worker"
env."staging.eu".route = "staging.example.com/*"
env."staging.eu".version_metadata.binding = "CUSTOM_VERSION"
`,
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        env: "staging.eu",
        warmCdnConcurrency: 1,
      }),
    ).rejects.toThrow('Wrangler config uses "CUSTOM_VERSION" for env staging.eu');
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an incompatible binding from a flattened selected environment before uploading", async () => {
    writeFile(
      "dist/server/wrangler.json",
      JSON.stringify({
        name: "my-worker-staging",
        targetEnvironment: "staging",
        version_metadata: { binding: "CUSTOM_VERSION" },
      }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        config: "dist/server/wrangler.json",
        env: "staging",
        warmCdnConcurrency: 1,
      }),
    ).rejects.toThrow('Wrangler config uses "CUSTOM_VERSION" for env staging');
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("warms browser-reusable HTML and RSC entries through a 0% staged version override", async () => {
    const events: string[] = [];
    const edgeCache = new Set<string>();
    let htmlOriginRenders = 0;
    let rscOriginRenders = 0;
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const probe = versionProbeResponse(url, init);
      if (probe) return probe;
      const requestUrl = new URL(formatFetchUrl(url));
      const requestHeaders = new Headers(init?.headers);
      const isRsc = requestHeaders.get("RSC") === "1";
      const vary = isRsc ? CANONICAL_RSC_VARY : "Cookie, Authorization, Host";
      const cacheKey = JSON.stringify([
        requestUrl.href,
        ...vary.split(",").map((field) => {
          const name = field.trim();
          return [
            name.toLowerCase(),
            name.toLowerCase() === "host" ? requestUrl.host : (requestHeaders.get(name) ?? ""),
          ];
        }),
      ]);
      const cacheStatus = edgeCache.has(cacheKey) ? "HIT" : "MISS";
      if (cacheStatus === "MISS") {
        edgeCache.add(cacheKey);
        if (isRsc) rscOriginRenders += 1;
        else htmlOriginRenders += 1;
      }
      events.push(`fetch:${requestUrl.href}`);
      return new Response(isRsc ? "flight" : "ok", {
        status: 200,
        headers: {
          "CF-Cache-Status": cacheStatus,
          "Content-Type": isRsc ? "text/x-component" : "text/html; charset=utf-8",
          Vary: vary,
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
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    const url = await deployWithCdnWarmup(tmpDir, ["/", "/about"], {
      deploymentId: "configured-deploy-id",
      rscCacheKeyMode: "response-vary",
      rscPaths: ["/"],
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
    expect(fetch).toHaveBeenCalledTimes(4);
    const probeInit = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    const firstInit = vi.mocked(fetch).mock.calls[1]![1] as RequestInit;
    const rscInit = vi.mocked(fetch).mock.calls[3]![1] as RequestInit;
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL(
        "https://app.example.com/?__vinext_version_probe=22222222-2222-4222-8222-222222222222",
      ),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("https://app.example.com/"),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      new URL("https://app.example.com/about"),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      new URL("https://app.example.com/?_rsc"),
      expect.any(Object),
    );
    expect(probeInit.method).toBe("GET");
    expect(new Headers(probeInit.headers).get("X-Vinext-Version-Probe")).toBe("1");
    expect(new Headers(firstInit.headers).get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker="22222222-2222-4222-8222-222222222222"',
    );
    expect(new Headers(rscInit.headers).get("x-deployment-id")).toBe("configured-deploy-id");
    const rscHeaders = new Headers(rscInit.headers);
    expect(rscHeaders.get("RSC")).toBe("1");
    expect(rscHeaders.get("Accept")).toBe("text/x-component");
    expect(rscHeaders.get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker="22222222-2222-4222-8222-222222222222"',
    );
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      4,
      process.execPath,
      expect.arrayContaining(["versions", "deploy", "22222222-2222-4222-8222-222222222222@100%"]),
      expect.any(Object),
    );
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      5,
      process.execPath,
      expect.arrayContaining(["triggers", "deploy"]),
      expect.any(Object),
    );
    const browserHtml = await fetch(new URL("https://app.example.com/"), {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en-US;q=0.9",
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
      },
    });
    const browserRsc = await fetch(new URL("https://app.example.com/?_rsc"), {
      headers: {
        Accept: "text/x-component",
        "Accept-Language": "en-GB,en-US;q=0.9",
        RSC: "1",
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
      },
    });
    expect(browserHtml.headers.get("CF-Cache-Status")).toBe("HIT");
    expect(browserRsc.headers.get("CF-Cache-Status")).toBe("HIT");
    expect(htmlOriginRenders).toBe(2);
    expect(rscOriginRenders).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(events).toEqual([
      "upload",
      "status",
      "stage",
      "fetch:https://app.example.com/",
      "fetch:https://app.example.com/about",
      "fetch:https://app.example.com/?_rsc",
      "promote",
      "triggers",
      "fetch:https://app.example.com/",
      "fetch:https://app.example.com/?_rsc",
    ]);
  });

  it("warms one HTML and RSC entry for every concrete host", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com", "www.example.com", "APP.EXAMPLE.COM"],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const requestUrl = new URL(formatFetchUrl(url));
      const probe = versionProbeResponse(url, init);
      if (probe) {
        events.push(`probe:${requestUrl.host}`);
        return probe;
      }
      const isRsc = new Headers(init?.headers).get("RSC") === "1";
      events.push(`${isRsc ? "rsc" : "html"}:${requestUrl.host}${requestUrl.pathname}`);
      return new Response(isRsc ? "flight" : "html", {
        status: 200,
        headers: {
          "CF-Cache-Status": "MISS",
          "Content-Type": isRsc ? "text/x-component" : "text/html",
          Vary: isRsc ? CANONICAL_RSC_VARY : "Cookie, Authorization, Host",
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
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/about"], {
      rscCacheKeyMode: "response-vary",
      rscPaths: ["/about"],
      warmCdnConcurrency: 1,
    });

    expect(events).toEqual([
      "upload",
      "status",
      "stage",
      "probe:app.example.com",
      "probe:www.example.com",
      "html:app.example.com/about",
      "rsc:app.example.com/about",
      "html:www.example.com/about",
      "rsc:www.example.com/about",
      "promote",
      "triggers",
    ]);
  });

  it("does not inherit a production custom domain for a selected environment", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["prod.example.com"],
        env: { staging: { name: "my-worker-staging" } },
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const requestUrl = new URL(formatFetchUrl(url));
      events.push(`fetch:${requestUrl.host}${requestUrl.pathname}`);
      return (
        versionProbeResponse(url, init) ??
        new Response("html", {
          status: 200,
          headers: { "CF-Cache-Status": "MISS", Vary: "Cookie, Authorization, Host" },
        })
      );
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
        return "Staged version\nhttps://my-worker-staging.example.workers.dev\n";
      }
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        events.push("promote");
        return "Deployed version\nhttps://my-worker-staging.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/about"], {
      env: "staging",
      warmCdnConcurrency: 1,
    });

    expect(events).toEqual([
      "upload",
      "status",
      "stage",
      "fetch:my-worker-staging.example.workers.dev/about",
      "fetch:my-worker-staging.example.workers.dev/about",
      "promote",
      "triggers",
    ]);
  });

  it("does not claim to warm shared entries that may belong to the previous version", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.toml",
      `name = "my-worker"
route = "app.example.com/*"
cache = { enabled = true, cross_version_cache = true }

[env.staging]
name = "my-worker-staging"
`,
    );
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
      if (args.includes("deploy") && args.includes("22222222-2222-4222-8222-222222222222@100%")) {
        events.push("promote");
        return "Deployed version\nhttps://stable.example.workers.dev\n";
      }
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], { env: "staging", warmCdnConcurrency: 1 });

    expect(events).toEqual(["upload", "status", "promote", "triggers"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send cacheable requests when version metadata is unavailable", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (
        init?.method === "GET" &&
        new URL(formatFetchUrl(url)).searchParams.has("__vinext_version_probe")
      ) {
        events.push("probe-unavailable");
        return new Response(null, {
          status: 503,
          headers: { "X-Vinext-Worker-Version": "unavailable" },
        });
      }
      events.push(`fetch:${formatFetchUrl(url)}`);
      return new Response("ok", { status: 200, headers: { "CF-Cache-Status": "MISS" } });
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
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], { warmCdnConcurrency: 1 });

    expect(events).toEqual([
      "upload",
      "status",
      "stage",
      "probe-unavailable",
      "promote",
      "triggers",
      "probe-unavailable",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not promote in strict mode when staged version metadata is unavailable", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (
        init?.method === "GET" &&
        new URL(formatFetchUrl(url)).searchParams.has("__vinext_version_probe")
      ) {
        events.push("probe-unavailable");
        return new Response(null, {
          status: 503,
          headers: { "X-Vinext-Worker-Version": "unavailable" },
        });
      }
      throw new Error("Strict warmup must not send a cacheable request without verification");
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
      if (args.includes("triggers")) {
        events.push("triggers");
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        warmCdnConcurrency: 1,
        warmCdnStrict: true,
      }),
    ).rejects.toThrow("may remain staged at 0%");

    expect(events).toEqual(["upload", "status", "stage", "probe-unavailable"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects strict cross-version warming before uploading", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
        cache: { enabled: true, cross_version_cache: true },
      }),
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        warmCdnConcurrency: 1,
        warmCdnStrict: true,
      }),
    ).rejects.toThrow("cannot safely refresh cache.cross_version_cache entries");
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "UTF-8 BOM-prefixed JSONC",
      filename: "wrangler.jsonc",
      config: `\uFEFF${JSON.stringify({
        cache: { enabled: true, cross_version_cache: true },
      })}`,
      options: { warmCdnConcurrency: 1, warmCdnStrict: true },
    },
    {
      name: "a quoted root cache table",
      filename: "wrangler.toml",
      config: `["cache"]
cross_version_cache = true
`,
      options: { warmCdnConcurrency: 1, warmCdnStrict: true },
    },
    {
      name: "a dotted cache setting below the env table",
      filename: "wrangler.toml",
      config: `[env]
staging.cache.cross_version_cache = true
`,
      options: { env: "staging", warmCdnConcurrency: 1, warmCdnStrict: true },
    },
    {
      name: "a quoted dotted environment name",
      filename: "wrangler.toml",
      config: `[env]
"staging.eu".cache.cross_version_cache = true
`,
      options: { env: "staging.eu", warmCdnConcurrency: 1, warmCdnStrict: true },
    },
    {
      name: "a root-level quoted dotted environment name",
      filename: "wrangler.toml",
      config: `env."staging.eu".cache.cross_version_cache = true
`,
      options: { env: "staging.eu", warmCdnConcurrency: 1, warmCdnStrict: true },
    },
    {
      name: "a flattened selected environment",
      filename: "dist/server/wrangler.json",
      config: JSON.stringify({
        name: "my-worker-staging",
        targetEnvironment: "staging",
        cache: { enabled: true, cross_version_cache: true },
      }),
      options: {
        config: "dist/server/wrangler.json",
        env: "staging",
        warmCdnConcurrency: 1,
        warmCdnStrict: true,
      },
    },
  ])(
    "protects cross-version cache warming configured with $name",
    async ({ filename, config, options }) => {
      writeFile(filename, config);
      const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

      await expect(deployWithCdnWarmup(tmpDir, ["/"], options)).rejects.toThrow(
        "cannot safely refresh cache.cross_version_cache entries",
      );
      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("uses the env Worker name and env custom domain for version override warmup", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        version_metadata: { binding: "CUSTOM_ROOT_VERSION" },
        custom_domains: ["app.example.com"],
        cache: { enabled: true, cross_version_cache: true },
        env: {
          staging: {
            name: "my-worker-staging-custom",
            custom_domains: ["staging.example.com"],
            cache: { enabled: true, cross_version_cache: false },
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
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], {
      env: "staging",
      warmCdnConcurrency: 1,
    });

    expect(fetch).toHaveBeenCalledWith(new URL("https://staging.example.com/"), expect.any(Object));
    const firstInit = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(new Headers(firstInit.headers).get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker-staging-custom="22222222-2222-4222-8222-222222222222"',
    );
    for (const [, args] of execFileSyncMock.mock.calls as Array<[string, string[]]>) {
      expect(args).toEqual(expect.arrayContaining(["--env", "staging"]));
    }
  });

  it("uses root-level dotted TOML env fields for the Worker override and origin", async () => {
    writeFile(
      "wrangler.toml",
      `name = "root-worker"
env."staging.eu".name = "custom-worker"
env."staging.eu".route = "staging.example.com/*"
env."staging.eu".cache = { enabled = true, cross_version_cache = false }
env."staging.eu".version_metadata.binding = "VINEXT_VERSION_METADATA"
`,
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
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], {
      env: "staging.eu",
      warmCdnConcurrency: 1,
    });

    expect(fetch).toHaveBeenCalledWith(new URL("https://staging.example.com/"), expect.any(Object));
    const firstInit = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(new Headers(firstInit.headers).get("Cloudflare-Workers-Version-Overrides")).toBe(
      'custom-worker="22222222-2222-4222-8222-222222222222"',
    );
  });

  it("falls back to ordinary deploy for a quoted BOM-prefixed service environment", async () => {
    writeFile(
      "wrangler.toml",
      `\uFEFF"legacy_env" = false
name = "service-worker"
route = "staging.example.com/*"

[env.staging]
version_metadata = { binding = "VINEXT_VERSION_METADATA" }
`,
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
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], {
      env: "staging",
      warmCdnConcurrency: 1,
    });

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["deploy", "--env", "staging"]),
      expect.any(Object),
    );
  });

  it("rejects strict warming for a named service environment before upload", async () => {
    writeFile(
      "wrangler.toml",
      `legacy_env = false
name = "service-worker"

[env.staging]
version_metadata = { binding = "VINEXT_VERSION_METADATA" }
`,
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        env: "staging",
        warmCdnStrict: true,
      }),
    ).rejects.toThrow("cannot stage named service environment staging");
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("uses the already-suffixed Worker name from a flattened selected environment", async () => {
    writeFile(
      "dist/server/wrangler.json",
      JSON.stringify({
        name: "my-worker-staging",
        topLevelName: "my-worker",
        targetEnvironment: "staging",
        definedEnvironments: ["staging"],
        legacy_env: true,
        custom_domains: ["staging.example.com"],
        cache: { enabled: true, cross_version_cache: false },
        version_metadata: { binding: "VINEXT_VERSION_METADATA" },
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
      config: "dist/server/wrangler.json",
      env: "staging",
      warmCdnConcurrency: 1,
    });

    expect(fetch).toHaveBeenCalledWith(new URL("https://staging.example.com/"), expect.any(Object));
    const firstInit = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(new Headers(firstInit.headers).get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker-staging="22222222-2222-4222-8222-222222222222"',
    );
    for (const [, args] of execFileSyncMock.mock.calls as Array<[string, string[]]>) {
      expect(args).toEqual(expect.arrayContaining(["--config", "dist/server/wrangler.json"]));
      expect(args).toEqual(expect.arrayContaining(["--env", "staging"]));
      expect(args).toEqual(expect.arrayContaining(["--name", "my-worker-staging"]));
    }
  });

  it("redirects an explicit source config to its generated flattened config", async () => {
    const sourceConfigPath = path.join(tmpDir, "wrangler.jsonc");
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        env: { staging: { name: "source-name-that-must-not-be-uploaded" } },
      }),
    );
    writeFile(
      ".wrangler/deploy/config.json",
      JSON.stringify({ configPath: "../../dist/server/wrangler.json" }),
    );
    writeFile(
      "dist/server/wrangler.json",
      JSON.stringify({
        name: "my-worker-staging",
        topLevelName: "my-worker",
        targetEnvironment: "staging",
        userConfigPath: sourceConfigPath,
        definedEnvironments: ["staging"],
        legacy_env: true,
        custom_domains: ["staging.example.com"],
        cache: { enabled: true, cross_version_cache: false },
        version_metadata: { binding: "VINEXT_VERSION_METADATA" },
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
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], {
      config: "wrangler.jsonc",
      env: "staging",
      warmCdnConcurrency: 1,
    });

    for (const [, args] of execFileSyncMock.mock.calls as Array<[string, string[]]>) {
      if (args.includes("status") || args.includes("triggers")) {
        expect(args).toEqual(expect.arrayContaining(["--config", "wrangler.jsonc"]));
      } else {
        expect(args).not.toContain("--config");
        expect(args).not.toContain("wrangler.jsonc");
      }
      expect(args).toEqual(expect.arrayContaining(["--env", "staging"]));
      expect(args).toEqual(expect.arrayContaining(["--name", "my-worker-staging"]));
    }
    const firstInit = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(new Headers(firstInit.headers).get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker-staging="22222222-2222-4222-8222-222222222222"',
    );
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
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const probe = versionProbeResponse(url, init);
      if (probe) return probe;
      events.push(`fetch:${formatFetchUrl(url)}`);
      return new Response("ok", { status: 200, headers: { "CF-Cache-Status": "MISS" } });
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
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/"], {
      warmCdnConcurrency: 1,
    });

    expect(events).toEqual([
      "upload",
      "status",
      "promote",
      "triggers",
      "fetch:https://app.example.com/",
    ]);
  });

  it("uses the triggers deploy URL for post-promotion fallback warmup", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "workers-cache",
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const probe = versionProbeResponse(url, init);
      if (probe) return probe;
      events.push(`fetch:${formatFetchUrl(url)}`);
      return new Response("ok", { status: 200, headers: { "CF-Cache-Status": "MISS" } });
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
      "promote",
      "triggers",
      "fetch:https://workers-cache.vinext.workers.dev/cached/intro",
    ]);
  });

  it("explains that the version is already live when strict fallback warming fails", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const probe = versionProbeResponse(url, init);
      if (probe) return probe;
      events.push(`fetch:${formatFetchUrl(url)}`);
      return new Response("nope", { status: 500 });
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
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        warmCdnConcurrency: 1,
        warmCdnRetries: 0,
        warmCdnStrict: true,
      }),
    ).rejects.toThrow(
      "Worker version 22222222-2222-4222-8222-222222222222 is already live at 100% and its triggers/routes have been updated",
    );
    expect(events).toEqual([
      "upload",
      "status",
      "promote",
      "triggers",
      "fetch:https://app.example.com/",
    ]);
  });

  it("explains that the version is already live when no fallback warm URL is available", async () => {
    writeFile("wrangler.jsonc", JSON.stringify({ name: "my-worker" }));
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
        warmCdnConcurrency: 1,
        warmCdnStrict: true,
      }),
    ).rejects.toThrow(
      "Worker version 22222222-2222-4222-8222-222222222222 is already live at 100% and its triggers/routes have been updated",
    );
    expect(fetch).not.toHaveBeenCalled();
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

  it("explains staged version cleanup when strict pre-promotion warmup fails", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const probe = versionProbeResponse(url, init);
      return probe ?? new Response("nope", { status: 500 });
    });
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
        warmCdnConcurrency: 1,
        warmCdnRetries: 0,
        warmCdnStrict: true,
      }),
    ).rejects.toThrow("may remain staged at 0%");
    expect(
      execFileSyncMock.mock.calls.some((call) => (call[1] as string[]).includes("triggers")),
    ).toBe(false);
  });

  it("explains the staged deployment when promotion fails after prewarming", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const probe = versionProbeResponse(url, init);
      if (probe) return probe;
      events.push(`fetch:${formatFetchUrl(url)}`);
      return new Response("html", { status: 200, headers: { "CF-Cache-Status": "MISS" } });
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
        events.push("promote-failed");
        throw new Error("promotion failed");
      }
      if (args.includes("triggers")) events.push("triggers");
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        warmCdnConcurrency: 1,
      }),
    ).rejects.toThrow("may remain staged at 0%");
    expect(events).toEqual([
      "upload",
      "status",
      "stage",
      "fetch:https://app.example.com/",
      "promote-failed",
    ]);
  });

  it("explains promoted version state when trigger deployment fails after prewarming", async () => {
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
        warmCdnConcurrency: 1,
      }),
    ).rejects.toThrow("may already be promoted to 100%");
    expect(fetch).toHaveBeenCalledTimes(2);
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
        warmCdnConcurrency: 1,
      }),
    ).rejects.toThrow("may already be promoted to 100%");
    expect(fetch).not.toHaveBeenCalled();
  });
});
