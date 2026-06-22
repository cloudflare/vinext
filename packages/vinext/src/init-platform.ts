import { createInterface } from "node:readline/promises";
import fs from "node:fs";
import type { Readable, Writable } from "node:stream";

export type InitPlatform = "cloudflare" | "node";

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
