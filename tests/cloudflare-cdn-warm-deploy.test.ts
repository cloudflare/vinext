import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VINEXT_RSC_BUILD_ID_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";

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
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      return new Response(isRsc ? "flight" : "html", {
        status: 200,
        headers: isRsc
          ? {
              "cache-control": "public, max-age=0, must-revalidate",
              "cf-cache-status": "MISS",
              "content-type": "text/x-component",
              [VINEXT_RSC_BUILD_ID_HEADER]: "build-a",
              vary: VINEXT_RSC_VARY_HEADER,
            }
          : { "content-type": "text/html" },
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
      deploymentId: "dpl_123",
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
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("https://app.example.com/about?_rsc"),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("https://app.example.com/"),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      new URL("https://app.example.com/about?_rsc"),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      new URL("https://app.example.com/about"),
      expect.any(Object),
    );
    const rscHeaders = new Headers(vi.mocked(fetch).mock.calls[0]![1]?.headers);
    expect(rscHeaders.get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker="22222222-2222-4222-8222-222222222222"',
    );
    expect(rscHeaders.get("accept")).toBe("text/x-component");
    expect(rscHeaders.get("rsc")).toBe("1");
    expect(rscHeaders.get("x-deployment-id")).toBe("dpl_123");
    expect(rscHeaders.get("next-router-prefetch")).toBeNull();
    expect(rscHeaders.get("next-router-state-tree")).toBeNull();
    expect(rscHeaders.get("next-url")).toBeNull();
    const firstHtmlHeaders = new Headers(vi.mocked(fetch).mock.calls[1]![1]?.headers);
    expect(firstHtmlHeaders.get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker="22222222-2222-4222-8222-222222222222"',
    );
    expect(firstHtmlHeaders.get("accept")).toBe("text/html");
    const loadingHeaders = new Headers(vi.mocked(fetch).mock.calls[2]![1]?.headers);
    expect(loadingHeaders.get("Cloudflare-Workers-Version-Overrides")).toBe(
      'my-worker="22222222-2222-4222-8222-222222222222"',
    );
    expect(loadingHeaders.get("next-router-prefetch")).toBe("1");
    expect(loadingHeaders.get("next-router-segment-prefetch")).toBe("1");
    expect(loadingHeaders.get("x-vinext-rsc-render-mode")).toBe("prefetch-loading-shell");
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
      "fetch:https://app.example.com/about?_rsc",
      "fetch:https://app.example.com/",
      "fetch:https://app.example.com/about?_rsc",
      "fetch:https://app.example.com/about",
      "promote",
    ]);
  });

  it("falls back to post-promotion warming after a non-strict staged failure", async () => {
    const events: string[] = [];
    let promotedRscAttempts = 0;
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      const isRsc = headers.get("rsc") === "1";
      const staged = headers.has("Cloudflare-Workers-Version-Overrides");
      events.push(`fetch:${staged ? "staged" : "promoted"}:${isRsc ? "rsc" : "html"}`);
      if (isRsc && !staged) promotedRscAttempts++;
      return new Response(isRsc ? "flight" : "html", {
        headers: isRsc
          ? {
              "cache-control": "public, max-age=0, must-revalidate",
              "cf-cache-status": "MISS",
              "content-type": "text/x-component",
              [VINEXT_RSC_BUILD_ID_HEADER]:
                staged || promotedRscAttempts === 1 ? "old-build" : "new-build",
              vary: VINEXT_RSC_VARY_HEADER,
            }
          : { "content-type": "text/html" },
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
        return "Triggers deployed\n";
      }
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await deployWithCdnWarmup(tmpDir, ["/about"], {
      expectedRscBuildId: "new-build",
      rscPaths: ["/about"],
      warmCdnRetries: 1,
    });

    expect(events).toEqual([
      "upload",
      "status",
      "stage",
      "triggers",
      "fetch:staged:rsc",
      "fetch:staged:rsc",
      "promote",
      "fetch:promoted:rsc",
      "fetch:promoted:rsc",
      "fetch:promoted:html",
    ]);
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

  it("replaces a stale 0% version and uses the triggers URL for pre-promotion warmup", async () => {
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

    await expect(deployWithCdnWarmup(tmpDir, ["/"], { warmCdnConcurrency: 1 })).rejects.toThrow(
      "may remain staged at 0%",
    );
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

  it("explains promoted version state when strict fallback warming fails", async () => {
    writeFile(
      "wrangler.jsonc",
      JSON.stringify({ name: "my-worker", custom_domains: ["app.example.com"] }),
    );
    vi.mocked(fetch).mockResolvedValue(new Response("not ready", { status: 500 }));
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
      if (args.includes("triggers")) return "Triggers deployed\n";
      throw new Error(`Unexpected Wrangler args: ${args.join(" ")}`);
    });
    const { deployWithCdnWarmup } = await import("../packages/cloudflare/src/deploy.js");

    await expect(
      deployWithCdnWarmup(tmpDir, ["/"], {
        warmCdnRetries: 0,
        warmCdnStrict: true,
      }),
    ).rejects.toThrow("already promoted to 100% and its Worker triggers/routes were updated");
  });

  it("explains promoted version state when strict fallback has no target URL", async () => {
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

    await expect(deployWithCdnWarmup(tmpDir, ["/"], { warmCdnStrict: true })).rejects.toThrow(
      "already promoted to 100% and its Worker triggers/routes were updated",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
