import { createInterface } from "node:readline/promises";
import fs from "node:fs";
import type { Readable, Writable } from "node:stream";

export type InitPlatform = "cloudflare" | "node";
export type InitDataCache = "kv" | "none";
export type InitCdnCache = "workers" | "kv" | "none";
export type InitImageOptimization = "cloudflare-images" | "none";

export type CloudflareInitOptions = {
  dataCache: InitDataCache;
  cdnCache: InitCdnCache;
  imageOptimization: InitImageOptimization;
};

type PlatformPromptOptions = {
  env?: Record<string, string | undefined>;
  input?: Readable;
  output?: Writable;
  isInteractive?: boolean;
  question?: (prompt: string) => Promise<string>;
};

const AGENT_ENV_VARS = [
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CURSOR_TRACE_ID",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "DEVIN",
  "REPL_ID",
  "V0_ENV",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "OPENCODE_CLIENT",
  "COPILOT_MODEL",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
] as const;

export function isAgentEnvironment(env: Record<string, string | undefined> = process.env): boolean {
  if (env.AI_AGENT) return true;
  if (env.CURSOR_EXTENSION_HOST_ROLE === "agent-exec") return true;
  return AGENT_ENV_VARS.some((name) => Boolean(env[name])) || fs.existsSync("/opt/.devin");
}

export function parsePlatformArg(args: string[]): InitPlatform | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    let value: string | undefined;

    if (arg === "--platform") {
      value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--platform requires a value (cloudflare or node).");
      }
    } else if (arg.startsWith("--platform=")) {
      value = arg.slice("--platform=".length);
      if (!value) {
        throw new Error("--platform requires a value (cloudflare or node).");
      }
    }

    if (value) {
      if (value === "cloudflare" || value === "node") return value;
      throw new Error(`Unsupported platform "${value}". Expected cloudflare or node.`);
    }
  }

  return undefined;
}

function parseChoiceArg<T extends string>(
  args: string[],
  flag: string,
  choices: readonly T[],
): T | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    let value: string | undefined;
    if (arg === flag) {
      value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${flag} requires a value (${choices.join(" or ")}).`);
      }
    } else if (arg.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1);
      if (!value) throw new Error(`${flag} requires a value (${choices.join(" or ")}).`);
    }
    if (value) {
      if (choices.includes(value as T)) return value as T;
      throw new Error(`Unsupported ${flag} value "${value}". Expected ${choices.join(" or ")}.`);
    }
  }
  return undefined;
}

export function parseDataCacheArg(args: string[]): InitDataCache | undefined {
  return parseChoiceArg(args, "--data-cache", ["kv", "none"]);
}

export function parseCdnCacheArg(args: string[]): InitCdnCache | undefined {
  return parseChoiceArg(args, "--cdn-cache", ["workers", "kv", "none"]);
}

export function parseImageOptimizationArg(args: string[]): InitImageOptimization | undefined {
  return parseChoiceArg(args, "--image-optimization", ["cloudflare-images", "none"]);
}

export async function resolveInitPlatform(
  args: string[],
  options: PlatformPromptOptions = {},
): Promise<InitPlatform> {
  const explicitPlatform = parsePlatformArg(args);
  if (explicitPlatform) return explicitPlatform;

  const env = options.env ?? process.env;
  if (isAgentEnvironment(env)) {
    throw new Error(
      "vinext init needs a deployment target. Ask the user whether they want Cloudflare or Node, then re-run the command with --platform=cloudflare or --platform=node.",
    );
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive) return "cloudflare";

  const readline = options.question ? undefined : createInterface({ input, output });
  const question = options.question ?? ((prompt: string) => readline!.question(prompt));

  try {
    while (true) {
      const answer = (
        await question(
          "  Choose a deployment platform:\n" +
            "    1. Cloudflare (default)\n" +
            "    2. Node\n" +
            "  Platform [1]: ",
        )
      )
        .trim()
        .toLowerCase();

      if (answer === "" || answer === "1" || answer === "cloudflare") return "cloudflare";
      if (answer === "2" || answer === "node") return "node";
      output.write("  Please choose Cloudflare (1) or Node (2).\n");
    }
  } finally {
    readline?.close();
  }
}

export async function resolveCloudflareInitOptions(
  args: string[],
  options: PlatformPromptOptions = {},
): Promise<CloudflareInitOptions> {
  const explicitDataCache = parseDataCacheArg(args);
  const explicitCdnCache = parseCdnCacheArg(args);
  const explicitImageOptimization = parseImageOptimizationArg(args);
  if (explicitDataCache && explicitCdnCache && explicitImageOptimization) {
    return {
      dataCache: explicitDataCache,
      cdnCache: explicitCdnCache,
      imageOptimization: explicitImageOptimization,
    };
  }

  const env = options.env ?? process.env;
  if (isAgentEnvironment(env)) {
    throw new Error(
      "vinext init needs Cloudflare cache and image choices. Ask the user which data cache (kv or none), CDN cache (workers, kv, or none), and image optimization (cloudflare-images or none) they want, then re-run with --data-cache=..., --cdn-cache=..., and --image-optimization=....",
    );
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive) {
    return {
      dataCache: explicitDataCache ?? "kv",
      cdnCache: explicitCdnCache ?? "workers",
      imageOptimization: explicitImageOptimization ?? "cloudflare-images",
    };
  }

  const readline = options.question ? undefined : createInterface({ input, output });
  const question = options.question ?? ((prompt: string) => readline!.question(prompt));
  try {
    const promptChoice = async <T extends string>(
      current: T | undefined,
      prompt: string,
      values: Record<string, T>,
      defaultValue: T,
      error: string,
    ): Promise<T> => {
      if (current) return current;
      while (true) {
        const answer = (await question(prompt)).trim().toLowerCase();
        if (answer === "") return defaultValue;
        const value = values[answer];
        if (value) return value;
        output.write(`  ${error}\n`);
      }
    };

    const dataCache = await promptChoice(
      explicitDataCache,
      "  Choose a data cache:\n    1. Cloudflare KV (default)\n    2. None\n  Data cache [1]: ",
      { "1": "kv", kv: "kv", "2": "none", none: "none" },
      "kv",
      "Please choose Cloudflare KV (1) or None (2).",
    );
    const cdnCache = await promptChoice(
      explicitCdnCache,
      "  Choose a CDN/page cache:\n    1. Workers Cache (default)\n    2. Cloudflare KV\n    3. None\n  CDN cache [1]: ",
      {
        "1": "workers",
        workers: "workers",
        "workers-cache": "workers",
        "2": "kv",
        kv: "kv",
        "3": "none",
        none: "none",
      },
      "workers",
      "Please choose Workers Cache (1), Cloudflare KV (2), or None (3).",
    );
    const imageOptimization = await promptChoice(
      explicitImageOptimization,
      "  Choose image optimization:\n    1. Cloudflare Images (default)\n    2. None\n  Image optimization [1]: ",
      {
        "1": "cloudflare-images",
        "cloudflare-images": "cloudflare-images",
        images: "cloudflare-images",
        "2": "none",
        none: "none",
      },
      "cloudflare-images",
      "Please choose Cloudflare Images (1) or None (2).",
    );
    return { dataCache, cdnCache, imageOptimization };
  } finally {
    readline?.close();
  }
}
