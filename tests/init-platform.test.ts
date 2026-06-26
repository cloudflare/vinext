import { describe, expect, it } from "vite-plus/test";
import { PassThrough } from "node:stream";
import {
  isAgentEnvironment,
  parsePlatformArg,
  parseDataCacheArg,
  parseCdnCacheArg,
  parseImageOptimizationArg,
  resolveCloudflareInitOptions,
  resolveInitPlatform,
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

  it("defaults to KV data, data-cache CDN fallback, and Cloudflare Images", async () => {
    await expect(
      resolveCloudflareInitOptions([], { env: {}, isInteractive: false }),
    ).resolves.toEqual({
      dataCache: "kv",
      cdnCache: "data-cache",
      imageOptimization: "cloudflare-images",
    });
  });

  it("tells agents to ask and rerun with public Cloudflare flags", async () => {
    await expect(
      resolveCloudflareInitOptions([], { env: { CODEX_THREAD_ID: "test" } }),
    ).rejects.toThrow("--data-cache=... and --image-optimization=...");
  });

  it("lets agents omit the default CDN cache flag", async () => {
    await expect(
      resolveCloudflareInitOptions(["--data-cache=kv", "--image-optimization=none"], {
        env: { CODEX_THREAD_ID: "test" },
      }),
    ).resolves.toEqual({
      dataCache: "kv",
      cdnCache: "data-cache",
      imageOptimization: "none",
    });
  });

  it("rejects legacy CDN cache choices", () => {
    expect(() => parseCdnCacheArg(["--cdn-cache=kv"])).toThrow("Expected data-cache");
    expect(() => parseCdnCacheArg(["--cdn-cache=none"])).toThrow("Expected data-cache");
  });

  it("prompts only for public Cloudflare choices", async () => {
    const prompts: string[] = [];
    const answers = ["2", "2"];
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
      "  Choose a data cache:\n    1. Cloudflare KV (default)\n    2. None\n  Data cache [1]: ",
      "  Choose image optimization:\n    1. Cloudflare Images (default)\n    2. None\n  Image optimization [1]: ",
    ]);
    expect(output.read()?.toString()).toBe("\n\n");
    expect(prompts.join("\n")).not.toContain("Workers Cache");
    expect(prompts.join("\n")).not.toContain("CDN");
  });

  it("preserves the hidden Workers Cache flag during interactive setup", async () => {
    const answers = ["2", "2"];
    await expect(
      resolveCloudflareInitOptions(["--cdn-cache=workers-cache"], {
        env: {},
        isInteractive: true,
        question: async () => answers.shift() ?? "",
      }),
    ).resolves.toEqual({
      dataCache: "none",
      cdnCache: "workers-cache",
      imageOptimization: "none",
    });
  });

  it("does not add a section break when repeating an invalid choice", async () => {
    const prompts: string[] = [];
    const answers = ["invalid", "2", "2"];
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

    expect(prompts[0]).toMatch(/^  Choose a data cache:/);
    expect(prompts[1]).toMatch(/^  Choose a data cache:/);
    expect(prompts[2]).toMatch(/^  Choose image optimization:/);
    expect(output.read()?.toString()).toBe("  Please choose Cloudflare KV (1) or None (2).\n\n\n");
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
