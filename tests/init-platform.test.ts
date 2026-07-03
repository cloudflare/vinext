import { describe, expect, it } from "vite-plus/test";
import { PassThrough } from "node:stream";
import {
  isAgentEnvironment,
  parsePlatformArg,
  parseDataCacheArg,
  parseCdnCacheArg,
  parseImageOptimizationArg,
  parsePrerenderArg,
  resolveCloudflareInitOptions,
  resolveInitOptions,
  resolveInitPlatform,
  resolveInitPrerender,
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
    expect(parseCdnCacheArg(["--cdn-cache", "data-cache"])).toBe("data-cache");
    expect(parseCdnCacheArg(["--cdn-cache=workers-cache"])).toBe("workers-cache");
    expect(parseImageOptimizationArg(["--image-optimization=none"])).toBe("none");
  });

  it("defaults to KV data, Workers Cache CDN, and Cloudflare Images", async () => {
    await expect(
      resolveCloudflareInitOptions([], { env: {}, isInteractive: false }),
    ).resolves.toEqual({
      dataCache: "kv",
      cdnCache: "workers-cache",
      imageOptimization: "cloudflare-images",
    });
  });

  it("tells agents to ask and rerun with public Cloudflare flags", async () => {
    await expect(
      resolveCloudflareInitOptions([], { env: { CODEX_THREAD_ID: "test" } }),
    ).rejects.toThrow("--cdn-cache=..., --data-cache=..., and --image-optimization=...");
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

  it("requires agents to pass the CDN cache choice with other Cloudflare choices", async () => {
    await expect(
      resolveCloudflareInitOptions(["--data-cache=kv", "--image-optimization=none"], {
        env: { CODEX_THREAD_ID: "test" },
      }),
    ).rejects.toThrow("--cdn-cache=..., --data-cache=..., and --image-optimization=...");
  });

  it("rejects legacy CDN cache choices", () => {
    expect(() => parseCdnCacheArg(["--cdn-cache=kv"])).toThrow(
      "Expected workers-cache or data-cache",
    );
    expect(() => parseCdnCacheArg(["--cdn-cache=none"])).toThrow(
      "Expected workers-cache or data-cache",
    );
  });

  it("prompts for CDN cache before the other Cloudflare choices", async () => {
    const prompts: string[] = [];
    const answers = ["2", "2", "2"];
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
      cdnCache: "data-cache",
      imageOptimization: "none",
    });
    expect(prompts).toEqual([
      "  Choose a CDN cache:\n    1. Workers Cache (default)\n    2. Data cache\n  CDN cache [1]: ",
      "  Choose a data cache:\n    1. Cloudflare KV (default)\n    2. None\n  Data cache [1]: ",
      "  Choose image optimization:\n    1. Cloudflare Images (default)\n    2. None\n  Image optimization [1]: ",
    ]);
    expect(output.read()?.toString()).toBe("\n\n\n");
  });

  it("preserves an explicit CDN cache flag during interactive setup", async () => {
    const answers = ["2", "2"];
    await expect(
      resolveCloudflareInitOptions(["--cdn-cache=data-cache"], {
        env: {},
        isInteractive: true,
        question: async () => answers.shift() ?? "",
      }),
    ).resolves.toEqual({
      dataCache: "none",
      cdnCache: "data-cache",
      imageOptimization: "none",
    });
  });

  it("prompts interactively for a missing CDN cache choice before honoring other flags", async () => {
    const prompts: string[] = [];
    const output = new PassThrough();
    await expect(
      resolveCloudflareInitOptions(["--data-cache=kv", "--image-optimization=none"], {
        env: {},
        isInteractive: true,
        output,
        question: async (prompt) => {
          prompts.push(prompt);
          return "2";
        },
      }),
    ).resolves.toEqual({
      dataCache: "kv",
      cdnCache: "data-cache",
      imageOptimization: "none",
    });
    expect(prompts).toEqual([
      "  Choose a CDN cache:\n    1. Workers Cache (default)\n    2. Data cache\n  CDN cache [1]: ",
    ]);
    expect(output.read()?.toString()).toBe("\n");
  });

  it("does not add a section break when repeating an invalid choice", async () => {
    const prompts: string[] = [];
    const answers = ["invalid", "2", "2", "2"];
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

    expect(prompts[0]).toMatch(/^  Choose a CDN cache:/);
    expect(prompts[1]).toMatch(/^  Choose a CDN cache:/);
    expect(prompts[2]).toMatch(/^  Choose a data cache:/);
    expect(prompts[3]).toMatch(/^  Choose image optimization:/);
    expect(output.read()?.toString()).toBe(
      "  Please choose Workers Cache (1) or Data cache (2).\n\n\n\n",
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
  it("shares the full vinext init option selection flow", async () => {
    await expect(
      resolveInitOptions(
        [
          "--platform=cloudflare",
          "--cdn-cache=data-cache",
          "--data-cache=none",
          "--image-optimization=none",
          "--prerender",
        ],
        { env: { CODEX_THREAD_ID: "test" } },
      ),
    ).resolves.toEqual({
      platform: "cloudflare",
      prerender: true,
      cloudflare: {
        dataCache: "none",
        cdnCache: "data-cache",
        imageOptimization: "none",
      },
    });
  });
});
