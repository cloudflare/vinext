import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
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

describe("Cloudflare CDN warmup deploy flow", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cdn-warm-deploy-test-"));
    execFileSyncMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("warms the production custom domain through a 0% staged version override", async () => {
    const events: string[] = [];
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({
        name: "my-worker",
        custom_domains: ["app.example.com"],
      }),
    );
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      events.push(`fetch:${formatFetchUrl(url)}`);
      if (new Headers(init?.headers).get("rsc") === "1") {
        return new Response("flight", {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "cf-cache-status": "MISS",
            "content-type": "text/x-component",
            vary: VINEXT_RSC_VARY_HEADER,
          },
        });
      }
      return new Response("ok", { status: 200 });
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("upload")) {
        events.push("upload");
        return [
          "Uploaded version 22222222-2222-4222-8222-222222222222",
          "Version Preview URL: https://22222222-my-worker.example.workers.dev",
          "",
        ].join("\n");
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
      deploymentId: "dpl_123",
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
    expect(fetch).toHaveBeenCalledTimes(3);
    const firstInit = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("https://22222222-my-worker.example.workers.dev/"),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("https://22222222-my-worker.example.workers.dev/about"),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      new URL("https://22222222-my-worker.example.workers.dev/about?_rsc"),
      expect.any(Object),
    );
    expect(new Headers(firstInit.headers).get("Cloudflare-Workers-Version-Overrides")).toBeNull();
    const rscHeaders = new Headers(vi.mocked(fetch).mock.calls[2]![1]?.headers);
    expect(rscHeaders.get("Cloudflare-Workers-Version-Overrides")).toBeNull();
    expect(rscHeaders.get("x-deployment-id")).toBe("dpl_123");
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
      "fetch:https://22222222-my-worker.example.workers.dev/",
      "fetch:https://22222222-my-worker.example.workers.dev/about",
      "fetch:https://22222222-my-worker.example.workers.dev/about?_rsc",
      "promote",
    ]);
  });

  it("warms a version preview alias without changing deployment traffic", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      return new Response(isRsc ? "flight" : "html", {
        headers: isRsc
          ? {
              "cache-control": "public, max-age=0, must-revalidate",
              "cf-cache-status": "MISS",
              "content-type": "text/x-component",
              vary: VINEXT_RSC_VARY_HEADER,
            }
          : { "content-type": "text/html" },
      });
    });
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      expect(args).toEqual(
        expect.arrayContaining(["versions", "upload", "--preview-alias", "pr-123"]),
      );
      return [
        "Uploaded version 22222222-2222-4222-8222-222222222222",
        "Version Preview URL: https://22222222-workers-cache.example.workers.dev",
        "Version Preview Alias URL: https://pr-123-workers-cache.example.workers.dev",
        "",
      ].join("\n");
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    const url = await deployWithCdnWarmup(tmpDir, ["/cached/intro"], {
      previewAlias: "pr-123",
      rscPaths: ["/cached/intro"],
      warmCdnStrict: true,
    });

    expect(url).toBe("https://pr-123-workers-cache.example.workers.dev");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("https://22222222-workers-cache.example.workers.dev/cached/intro"),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("https://22222222-workers-cache.example.workers.dev/cached/intro?_rsc"),
      expect.any(Object),
    );
  });

  it("rejects cross-version caching before uploading a Worker version", async () => {
    writeFile(
      "wrangler.jsonc",
      `{
        // A shared entry could make an old version look successfully warmed.
        "cache": { "cross_version_cache": true },
      }`,
    );
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/cached/intro"], {
        rscPaths: ["/cached/intro"],
        warmCdnStrict: true,
      }),
    ).rejects.toThrow("does not support cache.cross_version_cache=true");

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
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
      return new Response("ok", { status: 200 });
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
    vi.mocked(fetch).mockImplementation(async (url) => {
      events.push(`fetch:${formatFetchUrl(url)}`);
      return new Response("ok", { status: 200 });
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
        warmCdnConcurrency: 1,
        warmCdnRetries: 0,
        warmCdnStrict: true,
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
        warmCdnConcurrency: 1,
      }),
    ).rejects.toThrow("may remain staged at 0%");
    expect(fetch).not.toHaveBeenCalled();
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
