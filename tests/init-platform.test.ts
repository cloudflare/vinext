import { describe, expect, it } from "vite-plus/test";
import { PassThrough } from "node:stream";
import {
  isAgentEnvironment,
  parsePlatformArg,
  parseDataCacheArg,
  parseCdnCacheArg,
  parseImageOptimizationArg,
  parseResponseStoreModeArg,
  parsePrerenderArg,
  parseWarmCdnCacheArg,
  resolveCloudflareInitOptions,
  resolveInitOptions,
  resolveInitPlatform,
  resolveInitPrerender,
  resolveInitWarmCdnCache,
} from "../packages/vinext/src/init-platform.js";

describe("parsePlatformArg", () => {
  it("parses both supported flag forms", () => {
    expect(parsePlatformArg(["--platform", "cloudflare"])).toBe("cloudflare");
    expect(parsePlatformArg(["--platform=node"])).toBe("node");
  });

  it("rejects missing and unsupported values", () => {
    expect(() => parsePlatformArg(["--platform"])).toThrow("requires a value");
    expect(() => parsePlatformArg(["--platform=vercel"])).toThrow('Unsupported platform "vercel"');
  });
});

describe("Cloudflare init choices", () => {
  it("parses cache and image flags", () => {
    expect(parseDataCacheArg(["--data-cache=none"])).toBe("none");
    expect(parseCdnCacheArg(["--cdn-cache=none"])).toBe("none");
    expect(parseCdnCacheArg(["--cdn-cache", "data-cache"])).toBe("data-cache");
    expect(parseCdnCacheArg(["--cdn-cache=response-store"])).toBe("response-store");
    expect(parseCdnCacheArg(["--cdn-cache=workers-cache"])).toBe("workers-cache");
    expect(parseCdnCacheArg(["--cdn-cache=static-assets"])).toBe("static-assets");
    expect(parseImageOptimizationArg(["--image-optimization=none"])).toBe("none");
    expect(parseResponseStoreModeArg(["--response-store-mode=self-contained"])).toBe(
      "self-contained",
    );
  });

  it("defaults to no cache and Cloudflare Images", async () => {
    await expect(
      resolveCloudflareInitOptions([], { env: {}, isInteractive: false }),
    ).resolves.toEqual({
      dataCache: "none",
      cdnCache: "none",
      imageOptimization: "cloudflare-images",
    });
  });

  it("tells agents to ask and rerun with public Cloudflare flags", async () => {
    await expect(
      resolveCloudflareInitOptions([], { env: { CODEX_THREAD_ID: "test" } }),
    ).rejects.toThrow(
      "--cdn-cache=..., --response-store-mode=..., --data-cache=..., and --image-optimization=...",
    );
  });

  it("uses explicit Cloudflare choices in agent environments", async () => {
    await expect(
      resolveCloudflareInitOptions(
        ["--cdn-cache=workers-cache", "--data-cache=kv", "--image-optimization=none"],
        {
          env: { CODEX_THREAD_ID: "test" },
        },
      ),
    ).resolves.toEqual({
      dataCache: "kv",
      cdnCache: "workers-cache",
      imageOptimization: "none",
    });
  });

  it("accepts Static Assets non-interactively", async () => {
    await expect(
      resolveCloudflareInitOptions(
        ["--cdn-cache=static-assets", "--data-cache=none", "--image-optimization=none"],
        { env: { CODEX_THREAD_ID: "test" } },
      ),
    ).resolves.toEqual({
      dataCache: "none",
      cdnCache: "static-assets",
      imageOptimization: "none",
    });
  });

  it("requires agents to pass the CDN cache choice with other Cloudflare choices", async () => {
    await expect(
      resolveCloudflareInitOptions(["--data-cache=kv", "--image-optimization=none"], {
        env: { CODEX_THREAD_ID: "test" },
      }),
    ).rejects.toThrow(
      "--cdn-cache=..., --response-store-mode=..., --data-cache=..., and --image-optimization=...",
    );
  });

  it("rejects legacy CDN cache choices", () => {
    expect(() => parseCdnCacheArg(["--cdn-cache=kv"])).toThrow(
      "Expected none or response-store or workers-cache or static-assets or data-cache",
    );
  });

  it("prompts for CDN cache before the other Cloudflare choices", async () => {
    const prompts: string[] = [];
    const answers = ["yes", "2", "2", "2"];
    const output = new PassThrough();
    await expect(
      resolveCloudflareInitOptions([], {
        env: {},
        isInteractive: true,
        output,
        question: async (prompt) => {
          prompts.push(prompt);
          return answers.shift() ?? "";
        },
      }),
    ).resolves.toEqual({
      dataCache: "none",
      cdnCache: "workers-cache",
      imageOptimization: "none",
    });
    expect(prompts).toEqual([
      "  Enable caching? [y/N]: ",
      "  Choose a CDN cache:\n    1. Workers Response Store (default)\n    2. Workers Cache\n    3. Data cache\n    4. Static Assets (read-only; App Router only)\n  CDN cache [1]: ",
      "  Choose a data cache:\n    1. Cloudflare KV (default)\n    2. None\n  Data cache [1]: ",
      "  Choose image optimization:\n    1. Cloudflare Images (default)\n    2. None\n  Image optimization [1]: ",
    ]);
    expect(output.read()?.toString()).toBe("\n\n\n\n");
  });

  it("offers the read-only Static Assets cache", async () => {
    const answers = ["yes", "4", "2", "2"];
    await expect(
      resolveCloudflareInitOptions([], {
        env: {},
        isInteractive: true,
        question: async () => answers.shift() ?? "",
      }),
    ).resolves.toEqual({
      dataCache: "none",
      cdnCache: "static-assets",
      imageOptimization: "none",
    });
  });

  it("keeps caching disabled when the opt-in prompt is declined", async () => {
    const prompts: string[] = [];
    const output = new PassThrough();
    await expect(
      resolveCloudflareInitOptions([], {
        env: {},
        isInteractive: true,
        output,
        question: async (prompt) => {
          prompts.push(prompt);
          return "";
        },
      }),
    ).resolves.toEqual({
      dataCache: "none",
      cdnCache: "none",
      imageOptimization: "cloudflare-images",
    });
    expect(prompts).toEqual([
      "  Enable caching? [y/N]: ",
      "  Choose image optimization:\n    1. Cloudflare Images (default)\n    2. None\n  Image optimization [1]: ",
    ]);
    expect(output.read()?.toString()).toBe("\n\n");
  });

  it("defaults to Workers Response Store after caching is enabled", async () => {
    const answers = ["yes", "", "", ""];
    await expect(
      resolveCloudflareInitOptions([], {
        env: {},
        isInteractive: true,
        question: async () => answers.shift() ?? "",
      }),
    ).resolves.toEqual({
      dataCache: "none",
      cdnCache: "response-store",
      imageOptimization: "cloudflare-images",
      responseStoreMode: "service-binding",
    });
  });

  it("lets interactive setup choose a self-contained Response Store", async () => {
    const answers = ["yes", "1", "2", "2"];
    await expect(
      resolveCloudflareInitOptions([], {
        env: {},
        isInteractive: true,
        question: async () => answers.shift() ?? "",
      }),
    ).resolves.toEqual({
      dataCache: "none",
      cdnCache: "response-store",
      imageOptimization: "none",
      responseStoreMode: "self-contained",
    });
  });

  it("accepts a Response Store mode non-interactively", async () => {
    await expect(
      resolveCloudflareInitOptions(
        ["--response-store-mode=self-contained", "--image-optimization=none"],
        { env: {}, isInteractive: false },
      ),
    ).resolves.toEqual({
      dataCache: "none",
      cdnCache: "response-store",
      imageOptimization: "none",
      responseStoreMode: "self-contained",
    });
  });

  it("rejects a Response Store mode with another cache", async () => {
    await expect(
      resolveCloudflareInitOptions(
        ["--cdn-cache=workers-cache", "--response-store-mode=self-contained"],
        { env: {}, isInteractive: false },
      ),
    ).rejects.toThrow("can only be used with --cdn-cache=response-store");
  });

  it("preserves an explicit CDN cache flag during interactive setup", async () => {
    const answers = ["2"];
    await expect(
      resolveCloudflareInitOptions(["--cdn-cache=data-cache"], {
        env: {},
        isInteractive: true,
        question: async () => answers.shift() ?? "",
      }),
    ).resolves.toEqual({
      dataCache: "kv",
      cdnCache: "data-cache",
      imageOptimization: "none",
    });
  });

  it("derives the Data cache CDN choice from an explicit KV data cache", async () => {
    const prompts: string[] = [];
    const output = new PassThrough();
    await expect(
      resolveCloudflareInitOptions(["--data-cache=kv", "--image-optimization=none"], {
        env: {},
        isInteractive: true,
        output,
        question: async (prompt) => {
          prompts.push(prompt);
          return "";
        },
      }),
    ).resolves.toEqual({
      dataCache: "kv",
      cdnCache: "data-cache",
      imageOptimization: "none",
    });
    expect(prompts).toEqual([]);
    expect(output.read()).toBeNull();
  });

  it("does not add a section break when repeating an invalid choice", async () => {
    const prompts: string[] = [];
    const answers = ["yes", "invalid", "3", "2"];
    const output = new PassThrough();
    await resolveCloudflareInitOptions([], {
      env: {},
      isInteractive: true,
      output,
      question: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? "";
      },
    });

    expect(prompts[0]).toMatch(/^  Enable caching/);
    expect(prompts[1]).toMatch(/^  Choose a CDN cache:/);
    expect(prompts[2]).toMatch(/^  Choose a CDN cache:/);
    expect(prompts[3]).toMatch(/^  Choose image optimization:/);
    expect(output.read()?.toString()).toBe(
      "\n  Please choose Workers Response Store (1), Workers Cache (2), Data cache (3), or Static Assets (4).\n\n\n",
    );
  });
});

describe("prerender init choice", () => {
  it("parses explicit prerender flags", () => {
    expect(parsePrerenderArg(["--prerender"])).toBe(true);
    expect(parsePrerenderArg(["--no-prerender"])).toBe(false);
    expect(parsePrerenderArg(["--prerender=true"])).toBe(true);
    expect(parsePrerenderArg(["--prerender=false"])).toBe(false);
  });

  it("rejects unsupported explicit values", () => {
    expect(() => parsePrerenderArg(["--prerender=maybe"])).toThrow(
      "--prerender expects true or false",
    );
  });

  it("defaults non-interactive and agent environments to disabled", async () => {
    await expect(resolveInitPrerender([], { env: {}, isInteractive: false })).resolves.toBe(false);
    await expect(
      resolveInitPrerender([], { env: { CODEX_THREAD_ID: "test" }, isInteractive: true }),
    ).resolves.toBe(false);
  });

  it("defaults the interactive prompt to No", async () => {
    const prompts: string[] = [];
    const output = new PassThrough();
    await expect(
      resolveInitPrerender([], {
        env: {},
        isInteractive: true,
        output,
        question: async (prompt) => {
          prompts.push(prompt);
          return "";
        },
      }),
    ).resolves.toBe(false);
    expect(prompts).toEqual(["  Pre-render all static routes after build? [y/N]: "]);
    expect(output.read()?.toString()).toBe("\n");
  });

  it("accepts Yes from the interactive prompt", async () => {
    await expect(
      resolveInitPrerender([], {
        env: {},
        isInteractive: true,
        question: async () => "yes",
      }),
    ).resolves.toBe(true);
  });
});

describe("warm CDN cache init choice", () => {
  it("parses explicit warm CDN cache flags", () => {
    expect(parseWarmCdnCacheArg(["--experimental-warm-cdn-cache"])).toBe(true);
    expect(parseWarmCdnCacheArg(["--no-experimental-warm-cdn-cache"])).toBe(false);
    expect(parseWarmCdnCacheArg(["--experimental-warm-cdn-cache=true"])).toBe(true);
    expect(parseWarmCdnCacheArg(["--experimental-warm-cdn-cache=false"])).toBe(false);
  });

  it("rejects unsupported explicit values", () => {
    expect(() => parseWarmCdnCacheArg(["--experimental-warm-cdn-cache=maybe"])).toThrow(
      "--experimental-warm-cdn-cache expects true or false",
    );
  });

  it("defaults non-interactive and agent environments to disabled", async () => {
    await expect(resolveInitWarmCdnCache([], { env: {}, isInteractive: false })).resolves.toBe(
      false,
    );
    await expect(
      resolveInitWarmCdnCache([], { env: { CODEX_THREAD_ID: "test" }, isInteractive: true }),
    ).resolves.toBe(false);
  });

  it("defaults the interactive prompt to No", async () => {
    const prompts: string[] = [];
    const output = new PassThrough();
    await expect(
      resolveInitWarmCdnCache([], {
        env: {},
        isInteractive: true,
        output,
        question: async (prompt) => {
          prompts.push(prompt);
          return "";
        },
      }),
    ).resolves.toBe(false);
    expect(prompts).toEqual(["  Enable experimental cache pre-warm during deploy? [y/N]: "]);
    expect(output.read()?.toString()).toBe("\n");
  });
});

describe("isAgentEnvironment", () => {
  it("detects agents supported by am-i-vibing", () => {
    expect(isAgentEnvironment({ CODEX_THREAD_ID: "test" })).toBe(true);
    expect(isAgentEnvironment({ CLAUDECODE: "1" })).toBe(true);
  });
});

describe("resolveInitPlatform", () => {
  it("uses an explicit platform in agent environments", async () => {
    await expect(
      resolveInitPlatform(["--platform=node"], { env: { CODEX_THREAD_ID: "test" } }),
    ).resolves.toBe("node");
  });

  it("tells agents to ask the user and re-run with a flag", async () => {
    await expect(resolveInitPlatform([], { env: { CODEX_THREAD_ID: "test" } })).rejects.toThrow(
      "Ask the user whether they want Cloudflare or Node, then re-run the command with --platform=cloudflare or --platform=node.",
    );
  });

  it("defaults the interactive prompt to Cloudflare", async () => {
    const prompts: string[] = [];
    const output = new PassThrough();
    await expect(
      resolveInitPlatform([], {
        env: {},
        isInteractive: true,
        output,
        question: async (prompt) => {
          prompts.push(prompt);
          return "";
        },
      }),
    ).resolves.toBe("cloudflare");
    expect(prompts).toEqual([
      "  Choose a deployment platform:\n    1. Cloudflare (default)\n    2. Node\n  Platform [1]: ",
    ]);
    expect(output.read()?.toString()).toBe("\n");
  });

  it("accepts Node from the interactive prompt", async () => {
    await expect(
      resolveInitPlatform([], {
        env: {},
        isInteractive: true,
        question: async () => "2",
      }),
    ).resolves.toBe("node");
  });

  it("falls back to Cloudflare for non-interactive human environments", async () => {
    const output = new PassThrough();
    await expect(resolveInitPlatform([], { env: {}, isInteractive: false, output })).resolves.toBe(
      "cloudflare",
    );
  });
});

describe("resolveInitOptions", () => {
  it("keeps prerender available for Node init", async () => {
    await expect(
      resolveInitOptions(["--platform=node", "--prerender"], {
        env: { CODEX_THREAD_ID: "test" },
      }),
    ).resolves.toEqual({ platform: "node", prerender: true, cloudflare: undefined });
  });

  it("defaults Cloudflare init to no cache", async () => {
    await expect(resolveInitOptions([], { env: {}, isInteractive: false })).resolves.toEqual({
      platform: "cloudflare",
      prerender: false,
      cloudflare: {
        dataCache: "none",
        cdnCache: "none",
        imageOptimization: "cloudflare-images",
        warmCdnCache: false,
      },
    });
  });

  it("shares the full Cloudflare init option selection flow", async () => {
    await expect(
      resolveInitOptions(
        [
          "--platform=cloudflare",
          "--cdn-cache=data-cache",
          "--data-cache=kv",
          "--image-optimization=none",
        ],
        { env: { CODEX_THREAD_ID: "test" } },
      ),
    ).resolves.toEqual({
      platform: "cloudflare",
      prerender: false,
      cloudflare: {
        dataCache: "kv",
        cdnCache: "data-cache",
        imageOptimization: "none",
        warmCdnCache: false,
      },
    });
  });

  it("uses Workers Response Store as the default cache choice", async () => {
    const prompts: string[] = [];
    const answers = ["yes", "", "", "", ""];

    await expect(
      resolveInitOptions(["--platform=cloudflare"], {
        env: {},
        isInteractive: true,
        question: async (prompt) => {
          prompts.push(prompt);
          return answers.shift() ?? "";
        },
      }),
    ).resolves.toEqual({
      platform: "cloudflare",
      prerender: false,
      cloudflare: {
        dataCache: "none",
        cdnCache: "response-store",
        imageOptimization: "cloudflare-images",
        responseStoreMode: "service-binding",
        warmCdnCache: false,
      },
    });

    expect(prompts).toEqual([
      "  Enable caching? [y/N]: ",
      "  Choose a CDN cache:\n    1. Workers Response Store (default)\n    2. Workers Cache\n    3. Data cache\n    4. Static Assets (read-only; App Router only)\n  CDN cache [1]: ",
      "  Choose a Workers Response Store mode:\n    1. Service binding (default)\n    2. Self-contained\n  Response Store mode [1]: ",
      "  Choose image optimization:\n    1. Cloudflare Images (default)\n    2. None\n  Image optimization [1]: ",
      "  Enable experimental cache pre-warm during deploy? [y/N]: ",
    ]);
  });

  it("rejects the Node-only prerender flag for Cloudflare init", async () => {
    await expect(
      resolveInitOptions(
        [
          "--platform=cloudflare",
          "--cdn-cache=response-store",
          "--image-optimization=none",
          "--prerender",
        ],
        { env: { CODEX_THREAD_ID: "test" } },
      ),
    ).rejects.toThrow(
      "--prerender is only supported by Node init. For Cloudflare, choose --cdn-cache=static-assets",
    );
  });

  it("does not ask about pre-warming when Data cache is selected for CDN cache", async () => {
    const prompts: string[] = [];
    const answers = ["yes", "3", "", ""];

    await expect(
      resolveInitOptions(["--platform=cloudflare"], {
        env: {},
        isInteractive: true,
        question: async (prompt) => {
          prompts.push(prompt);
          return answers.shift() ?? "";
        },
      }),
    ).resolves.toEqual({
      platform: "cloudflare",
      prerender: false,
      cloudflare: {
        dataCache: "kv",
        cdnCache: "data-cache",
        imageOptimization: "cloudflare-images",
        warmCdnCache: false,
      },
    });

    expect(prompts).toEqual([
      "  Enable caching? [y/N]: ",
      "  Choose a CDN cache:\n    1. Workers Response Store (default)\n    2. Workers Cache\n    3. Data cache\n    4. Static Assets (read-only; App Router only)\n  CDN cache [1]: ",
      "  Choose image optimization:\n    1. Cloudflare Images (default)\n    2. None\n  Image optimization [1]: ",
    ]);
  });

  it("rejects disabling the selected Data cache", async () => {
    await expect(
      resolveInitOptions(
        [
          "--platform=cloudflare",
          "--cdn-cache=data-cache",
          "--data-cache=none",
          "--image-optimization=none",
        ],
        { env: {}, isInteractive: false },
      ),
    ).rejects.toThrow("--cdn-cache=data-cache requires --data-cache=kv");
  });

  it("rejects warm CDN cache when Data cache is selected for CDN cache", async () => {
    await expect(
      resolveInitOptions(
        [
          "--platform=cloudflare",
          "--cdn-cache=data-cache",
          "--data-cache=kv",
          "--image-optimization=none",
          "--experimental-warm-cdn-cache",
        ],
        { env: {}, isInteractive: false },
      ),
    ).rejects.toThrow(
      "--experimental-warm-cdn-cache requires --cdn-cache=response-store or workers-cache",
    );
  });

  it("rejects cache warming when caching is disabled", async () => {
    await expect(
      resolveInitOptions(
        [
          "--platform=cloudflare",
          "--cdn-cache=none",
          "--image-optimization=none",
          "--experimental-warm-cdn-cache",
        ],
        { env: { CODEX_THREAD_ID: "test" } },
      ),
    ).rejects.toThrow(
      "--experimental-warm-cdn-cache requires --cdn-cache=response-store or workers-cache",
    );
  });
});
