import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { isAgent } from "am-i-vibing";

export type InitPlatform = "cloudflare" | "node";
export type InitDataCache = "kv" | "none";
export type InitCdnCache = "data-cache" | "none" | "response-store" | "workers-cache";
export type InitImageOptimization = "cloudflare-images" | "none";
export type InitResponseStoreMode = "self-contained" | "service-binding";

export type CloudflareInitOptions = {
  dataCache: InitDataCache;
  cdnCache: InitCdnCache;
  imageOptimization: InitImageOptimization;
  responseStoreMode?: InitResponseStoreMode;
  warmCdnCache?: boolean;
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
  {
    name: string;
    options: (
      args: string[],
      options?: PlatformPromptOptions,
    ) => Promise<CloudflareInitOptions | undefined>;
  }
>;

export type PlatformPromptOptions = {
  env?: Record<string, string | undefined>;
  input?: Readable;
  output?: Writable;
  isInteractive?: boolean;
  question?: (prompt: string) => Promise<string>;
};

export type ResolvedInitOptions = {
  platform: InitPlatform;
  cloudflare?: CloudflareInitOptions;
  prerender: boolean;
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
  return parseChoiceArg(args, "--cdn-cache", [
    "none",
    "response-store",
    "workers-cache",
    "data-cache",
  ]);
}

export function parseImageOptimizationArg(args: string[]): InitImageOptimization | undefined {
  return parseChoiceArg(args, "--image-optimization", ["cloudflare-images", "none"]);
}

export function parseResponseStoreModeArg(args: string[]): InitResponseStoreMode | undefined {
  return parseChoiceArg(args, "--response-store-mode", ["service-binding", "self-contained"]);
}

export function parsePrerenderArg(args: string[]): boolean | undefined {
  return parseBooleanArg(
    args,
    "--prerender",
    "--no-prerender",
    '--prerender expects true or false when using the "--prerender=value" form.',
  );
}

export function parseWarmCdnCacheArg(args: string[]): boolean | undefined {
  return parseBooleanArg(
    args,
    "--experimental-warm-cdn-cache",
    "--no-experimental-warm-cdn-cache",
    '--experimental-warm-cdn-cache expects true or false when using the "--experimental-warm-cdn-cache=value" form.',
  );
}

function parseBooleanArg(
  args: string[],
  enabledFlag: string,
  disabledFlag: string,
  errorMessage: string,
): boolean | undefined {
  for (const arg of args) {
    if (arg === enabledFlag) return true;
    if (arg === disabledFlag) return false;
    if (!arg.startsWith(`${enabledFlag}=`)) continue;

    const value = arg.slice(enabledFlag.length + 1).toLowerCase();
    if (value === "true" || value === "yes" || value === "1") return true;
    if (value === "false" || value === "no" || value === "0") return false;
    throw new Error(errorMessage);
  }

  return undefined;
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

export async function resolveInitOptions(
  args: string[],
  options: PlatformPromptOptions = {},
): Promise<ResolvedInitOptions> {
  const platform = await resolveInitPlatform(args, options);
  const platformOptions = await INIT_PLATFORMS[platform].options(args, options);
  const explicitWarmCdnCache = parseWarmCdnCacheArg(args);
  const explicitPrerender = parsePrerenderArg(args);
  if (platform === "cloudflare" && explicitPrerender === true) {
    throw new Error(
      "--prerender is only supported by Node init. For Cloudflare, use --experimental-warm-cdn-cache with Workers Cache or Workers Response Store.",
    );
  }
  const supportsWarmCdnCache =
    platformOptions?.cdnCache === "response-store" || platformOptions?.cdnCache === "workers-cache";
  if (platform === "cloudflare" && !supportsWarmCdnCache) {
    if (explicitWarmCdnCache === true) {
      throw new Error(
        "--experimental-warm-cdn-cache requires --cdn-cache=response-store or workers-cache.",
      );
    }
  }

  const prerender =
    platform === "node"
      ? (explicitPrerender ?? (await resolveInitPrerender(args, options)))
      : false;
  const warmCdnCache =
    platform === "cloudflare" && supportsWarmCdnCache
      ? await resolveInitWarmCdnCache(args, options)
      : false;

  return {
    platform,
    prerender,
    cloudflare:
      platform === "cloudflare" && platformOptions
        ? { ...platformOptions, warmCdnCache }
        : undefined,
  };
}

export async function resolveInitPrerender(
  args: string[],
  options: PlatformPromptOptions = {},
): Promise<boolean> {
  const explicitPrerender = parsePrerenderArg(args);
  if (explicitPrerender !== undefined) return explicitPrerender;

  const env = options.env ?? process.env;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (isAgentEnvironment(env) || !isInteractive) return false;

  const readline = options.question ? undefined : createInterface({ input, output });
  const question = options.question ?? ((prompt: string) => readline!.question(prompt));

  try {
    while (true) {
      const answer = (await question("  Pre-render all static routes after build? [y/N]: "))
        .trim()
        .toLowerCase();
      if (answer === "") {
        output.write("\n");
        return false;
      }
      if (answer === "y" || answer === "yes") {
        output.write("\n");
        return true;
      }
      if (answer === "n" || answer === "no") {
        output.write("\n");
        return false;
      }
      output.write("  Please answer yes or no.\n");
    }
  } finally {
    readline?.close();
  }
}

export async function resolveInitWarmCdnCache(
  args: string[],
  options: PlatformPromptOptions = {},
): Promise<boolean> {
  const explicitWarmCdnCache = parseWarmCdnCacheArg(args);
  if (explicitWarmCdnCache !== undefined) return explicitWarmCdnCache;

  const env = options.env ?? process.env;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (isAgentEnvironment(env) || !isInteractive) return false;

  const readline = options.question ? undefined : createInterface({ input, output });
  const question = options.question ?? ((prompt: string) => readline!.question(prompt));

  try {
    while (true) {
      const answer = (await question("  Enable experimental cache pre-warm during deploy? [y/N]: "))
        .trim()
        .toLowerCase();
      if (answer === "") {
        output.write("\n");
        return false;
      }
      if (answer === "y" || answer === "yes") {
        output.write("\n");
        return true;
      }
      if (answer === "n" || answer === "no") {
        output.write("\n");
        return false;
      }
      output.write("  Please answer yes or no.\n");
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
  const requestedCdnCache = parseCdnCacheArg(args);
  const explicitResponseStoreMode = parseResponseStoreModeArg(args);
  if (explicitResponseStoreMode && requestedCdnCache && requestedCdnCache !== "response-store") {
    throw new Error("--response-store-mode can only be used with --cdn-cache=response-store.");
  }
  const explicitCdnCache =
    requestedCdnCache ?? (explicitResponseStoreMode ? "response-store" : undefined);
  const explicitImageOptimization = parseImageOptimizationArg(args);
  if (
    (explicitCdnCache === "response-store" || explicitCdnCache === "none") &&
    explicitDataCache === "kv"
  ) {
    throw new Error(`--cdn-cache=${explicitCdnCache} cannot be combined with --data-cache=kv.`);
  }
  if (explicitCdnCache === "data-cache" && explicitDataCache === "none") {
    throw new Error("--cdn-cache=data-cache requires --data-cache=kv.");
  }
  if (
    explicitCdnCache &&
    (explicitCdnCache === "response-store" ||
      explicitCdnCache === "none" ||
      explicitCdnCache === "data-cache" ||
      explicitDataCache) &&
    explicitImageOptimization
  ) {
    return {
      dataCache:
        explicitCdnCache === "response-store" || explicitCdnCache === "none"
          ? "none"
          : (explicitDataCache ?? "kv"),
      cdnCache: explicitCdnCache,
      imageOptimization: explicitImageOptimization,
      ...(explicitCdnCache === "response-store"
        ? { responseStoreMode: explicitResponseStoreMode ?? "service-binding" }
        : {}),
    };
  }

  const env = options.env ?? process.env;
  if (isAgentEnvironment(env)) {
    throw new Error(
      "vinext init needs Cloudflare cache and image choices. Ask the user whether they want no cache or which CDN cache (response-store, workers-cache, or data-cache), the Response Store mode when selected (service-binding or self-contained), data cache (kv or none), and image optimization (cloudflare-images or none) they want, then re-run with --cdn-cache=..., --response-store-mode=..., --data-cache=..., and --image-optimization=....",
    );
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive) {
    const cdnCache = explicitCdnCache ?? (explicitDataCache === "kv" ? "data-cache" : "none");
    return {
      dataCache:
        cdnCache === "response-store" || cdnCache === "none" ? "none" : (explicitDataCache ?? "kv"),
      cdnCache,
      imageOptimization: explicitImageOptimization ?? "cloudflare-images",
      ...(cdnCache === "response-store"
        ? { responseStoreMode: explicitResponseStoreMode ?? "service-binding" }
        : {}),
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

    let selectedCdnCache =
      explicitCdnCache ?? (explicitDataCache === "kv" ? "data-cache" : undefined);
    if (!selectedCdnCache) {
      while (true) {
        const answer = (await question("  Enable caching? [y/N]: ")).trim().toLowerCase();
        if (answer === "" || answer === "n" || answer === "no") {
          output.write("\n");
          selectedCdnCache = "none";
          break;
        }
        if (answer === "y" || answer === "yes") {
          output.write("\n");
          break;
        }
        output.write("  Please answer yes or no.\n");
      }
    }
    const cdnCache = await promptChoice(
      selectedCdnCache,
      "  Choose a CDN cache:\n    1. Workers Response Store (default)\n    2. Workers Cache\n    3. Data cache\n  CDN cache [1]: ",
      {
        "1": "response-store",
        "response-store": "response-store",
        "2": "workers-cache",
        "workers-cache": "workers-cache",
        workers: "workers-cache",
        "3": "data-cache",
        "data-cache": "data-cache",
        data: "data-cache",
      },
      "response-store",
      "Please choose Workers Response Store (1), Workers Cache (2), or Data cache (3).",
    );
    if ((cdnCache === "response-store" || cdnCache === "none") && explicitDataCache === "kv") {
      throw new Error(`--cdn-cache=${cdnCache} cannot be combined with --data-cache=kv.`);
    }
    if (cdnCache === "data-cache" && explicitDataCache === "none") {
      throw new Error("--cdn-cache=data-cache requires --data-cache=kv.");
    }
    const responseStoreMode =
      cdnCache === "response-store"
        ? await promptChoice(
            explicitResponseStoreMode,
            "  Choose a Workers Response Store mode:\n    1. Service binding (default)\n    2. Self-contained\n  Response Store mode [1]: ",
            {
              "1": "service-binding",
              "service-binding": "service-binding",
              service: "service-binding",
              "2": "self-contained",
              "self-contained": "self-contained",
              self: "self-contained",
            },
            "service-binding",
            "Please choose Service binding (1) or Self-contained (2).",
          )
        : undefined;
    const dataCache =
      cdnCache === "response-store" || cdnCache === "none"
        ? "none"
        : cdnCache === "data-cache"
          ? "kv"
          : await promptChoice(
              explicitDataCache,
              "  Choose a data cache:\n    1. Cloudflare KV (default)\n    2. None\n  Data cache [1]: ",
              { "1": "kv", kv: "kv", "2": "none", none: "none" },
              "kv",
              "Please choose Cloudflare KV (1) or None (2).",
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
    return {
      dataCache,
      cdnCache,
      imageOptimization,
      ...(responseStoreMode ? { responseStoreMode } : {}),
    };
  } finally {
    readline?.close();
  }
}
