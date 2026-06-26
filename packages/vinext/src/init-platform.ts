import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { isAgent } from "am-i-vibing";

export type InitPlatform = "cloudflare" | "node";
export type InitDataCache = "kv" | "none";
export type InitCdnCache = "data-cache" | "workers-cache";
export type InitImageOptimization = "cloudflare-images" | "none";

export type CloudflareInitOptions = {
  dataCache: InitDataCache;
  cdnCache: InitCdnCache;
  imageOptimization: InitImageOptimization;
};

export const INIT_PLATFORMS = {
  cloudflare: {
    name: "Cloudflare",
    options: resolveCloudflareInitOptions,
  },
  node: {
    name: "Node",
    options: async () => undefined,
  },
} satisfies Record<
  InitPlatform,
  { name: string; options: (args: string[]) => Promise<CloudflareInitOptions | undefined> }
>;

type PlatformPromptOptions = {
  env?: Record<string, string | undefined>;
  input?: Readable;
  output?: Writable;
  isInteractive?: boolean;
  question?: (prompt: string) => Promise<string>;
};

export function isAgentEnvironment(env: Record<string, string | undefined> = process.env): boolean {
  return isAgent({ env });
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
  displayedChoices: readonly string[] = choices,
): T | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    let value: string | undefined;
    if (arg === flag) {
      value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${flag} requires a value (${displayedChoices.join(" or ")}).`);
      }
    } else if (arg.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1);
      if (!value) throw new Error(`${flag} requires a value (${displayedChoices.join(" or ")}).`);
    }
    if (value) {
      if (choices.includes(value as T)) return value as T;
      throw new Error(
        `Unsupported ${flag} value "${value}". Expected ${displayedChoices.join(" or ")}.`,
      );
    }
  }
  return undefined;
}

export function parseDataCacheArg(args: string[]): InitDataCache | undefined {
  return parseChoiceArg(args, "--data-cache", ["kv", "none"]);
}

export function parseCdnCacheArg(args: string[]): InitCdnCache | undefined {
  return parseChoiceArg(args, "--cdn-cache", ["data-cache", "workers-cache"], ["data-cache"]);
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
            `    1. ${INIT_PLATFORMS.cloudflare.name} (default)\n` +
            `    2. ${INIT_PLATFORMS.node.name}\n` +
            "  Platform [1]: ",
        )
      )
        .trim()
        .toLowerCase();

      if (answer === "" || answer === "1" || answer === "cloudflare") {
        output.write("\n");
        return "cloudflare";
      }
      if (answer === "2" || answer === "node") {
        output.write("\n");
        return "node";
      }
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
  if (explicitDataCache && explicitImageOptimization) {
    return {
      dataCache: explicitDataCache,
      cdnCache: explicitCdnCache ?? "data-cache",
      imageOptimization: explicitImageOptimization,
    };
  }

  const env = options.env ?? process.env;
  if (isAgentEnvironment(env)) {
    throw new Error(
      "vinext init needs Cloudflare cache and image choices. Ask the user which data cache (kv or none) and image optimization (cloudflare-images or none) they want, then re-run with --data-cache=... and --image-optimization=....",
    );
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive) {
    return {
      dataCache: explicitDataCache ?? "kv",
      cdnCache: explicitCdnCache ?? "data-cache",
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
        if (answer === "") {
          output.write("\n");
          return defaultValue;
        }
        const value = values[answer];
        if (value) {
          output.write("\n");
          return value;
        }
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
    const cdnCache = explicitCdnCache ?? "data-cache";
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
