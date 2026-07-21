import fs from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { transformWithOxc } from "vite";

async function evaluateConfigFiles(processValue?: object): Promise<string[]> {
  const source = await fs.readFile(
    new URL("../packages/vinext/src/shims/constants.ts", import.meta.url),
    "utf8",
  );
  const transformed = await transformWithOxc(source, "constants.ts", {
    target: "es2022",
  });
  const context: Record<string, unknown> = {};
  if (processValue !== undefined) context.process = processValue;
  vm.runInNewContext(
    `${transformed.code.replace(/^export /gm, "")}\nglobalThis.__configFiles = CONFIG_FILES;`,
    context,
  );
  return context.__configFiles as string[];
}

describe("next/constants process feature detection", () => {
  // Next.js reads this feature in its shared constants module. Its webpack
  // client runtime supplies `process`; vinext's Vite client runtime does not.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/constants.ts
  it("evaluates without a process global in browser and Edge-like runtimes", async () => {
    await expect(evaluateConfigFiles()).resolves.toEqual([
      "next.config.js",
      "next.config.mjs",
      "next.config.ts",
    ]);
    await expect(evaluateConfigFiles({})).resolves.toEqual([
      "next.config.js",
      "next.config.mjs",
      "next.config.ts",
    ]);
  });

  it("retains Node's native TypeScript config detection", async () => {
    await expect(evaluateConfigFiles({ features: { typescript: true } })).resolves.toEqual([
      "next.config.js",
      "next.config.mjs",
      "next.config.ts",
      "next.config.mts",
    ]);
  });
});
