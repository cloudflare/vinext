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
    expect(parseCdnCacheArg(["--cdn-cache", "kv"])).toBe("kv");
    expect(parseImageOptimizationArg(["--image-optimization=none"])).toBe("none");
  });

  it("defaults to KV data, Workers Cache, and Cloudflare Images", async () => {
    await expect(
      resolveCloudflareInitOptions([], { env: {}, isInteractive: false }),
    ).resolves.toEqual({
      dataCache: "kv",
      cdnCache: "workers",
      imageOptimization: "cloudflare-images",
    });
  });

  it("tells agents to ask and rerun with all Cloudflare flags", async () => {
    await expect(resolveCloudflareInitOptions([], { env: { CODEX_CI: "1" } })).rejects.toThrow(
      "--data-cache=..., --cdn-cache=..., and --image-optimization=...",
    );
  });

  it("prompts for each missing Cloudflare choice", async () => {
    const answers = ["2", "2", "2"];
    await expect(
      resolveCloudflareInitOptions([], {
        env: {},
        isInteractive: true,
        question: async () => answers.shift() ?? "",
      }),
    ).resolves.toEqual({ dataCache: "none", cdnCache: "kv", imageOptimization: "none" });
  });
});

describe("isAgentEnvironment", () => {
  it("detects the AI_AGENT standard and Codex", () => {
    expect(isAgentEnvironment({ AI_AGENT: "custom-agent" })).toBe(true);
    expect(isAgentEnvironment({ CODEX_CI: "1" })).toBe(true);
  });
});

describe("resolveInitPlatform", () => {
  it("uses an explicit platform in agent environments", async () => {
    await expect(
      resolveInitPlatform(["--platform=node"], { env: { CODEX_CI: "1" } }),
    ).resolves.toBe("node");
  });

  it("tells agents to ask the user and re-run with a flag", async () => {
    await expect(resolveInitPlatform([], { env: { CODEX_CI: "1" } })).rejects.toThrow(
      "Ask the user whether they want Cloudflare or Node, then re-run the command with --platform=cloudflare or --platform=node.",
    );
  });

  it("defaults the interactive prompt to Cloudflare", async () => {
    await expect(
      resolveInitPlatform([], {
        env: {},
        isInteractive: true,
        question: async () => "",
      }),
    ).resolves.toBe("cloudflare");
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
