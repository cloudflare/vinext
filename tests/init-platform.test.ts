import { describe, expect, it } from "vite-plus/test";
import { PassThrough } from "node:stream";
import {
  isAgentEnvironment,
  parsePlatformArg,
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
