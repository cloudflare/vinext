import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { addEslintIgnores, init, type InitOptions } from "../packages/vinext/src/init.js";
import { createIsolatedFixture } from "./helpers.js";

// A create-next-app 16 scaffold with its generated eslint.config.mjs and the
// eslint and eslint-config-next it installs.
const fixture = path.resolve(import.meta.dirname, "fixtures/init-eslint-next");
// The fixture's own ESLint, which the repo's root does not install.
const { ESLint } = createRequire(path.join(fixture, "package.json"))("eslint") as {
  ESLint: new (options: { cwd: string }) => { isPathIgnored(filePath: string): Promise<boolean> };
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function copyFixture(): Promise<string> {
  const root = await createIsolatedFixture(
    fixture,
    "vinext-init-eslint-",
    undefined,
    path.join(fixture, "node_modules"),
  );
  roots.push(root);
  return root;
}

async function runInit(root: string, options: Partial<InitOptions>): Promise<string> {
  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => {
    output.push(args.join(" "));
  });
  try {
    await init({ root, skipCheck: true, install: false, platform: "node", ...options });
  } finally {
    log.mockRestore();
  }
  return output.join("\n");
}

async function ignoredPaths(root: string, files: string[]): Promise<string[]> {
  const eslint = new ESLint({ cwd: root });
  const ignored: string[] = [];
  for (const file of files) {
    if (await eslint.isPathIgnored(path.join(root, file))) ignored.push(file);
  }
  return ignored;
}

// Files `vite build` writes for each platform's output.
const cloudflareOutput = ".cloudflare/output/v0/workers/default/bundle/ssr/index.js";
const wranglerOutput = ".wrangler/tmp/dev-abc/index.js";
const nodeOutput = "dist/server/index.js";
const cacheOutput = ".vinext/cache/entry.js";

describe("vinext init ESLint ignores", () => {
  it("makes eslint-config-next ignore the Cloudflare build output", async () => {
    const root = await copyFixture();
    // create-next-app's config ignores only Next.js output, so ESLint lints
    // .cloudflare/ even though init lists it in .gitignore.
    expect(await ignoredPaths(root, [cloudflareOutput, nodeOutput, cacheOutput])).toEqual([]);

    const output = await runInit(root, {
      platform: "cloudflare",
      cloudflare: { dataCache: "none", cdnCache: "none", imageOptimization: "none" },
    });

    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(".cloudflare/");
    expect(fs.readFileSync(path.join(root, "eslint.config.mjs"), "utf8")).toContain(
      [
        '    "next-env.d.ts",',
        "    // vinext build output:",
        '    "dist/**",',
        '    ".vinext/**",',
        '    ".cloudflare/**",',
        "  ]),",
      ].join("\n"),
    );
    expect(output).toContain(
      "✓ Added vinext output directories to the ignores in eslint.config.mjs",
    );
    expect(
      await ignoredPaths(root, [cloudflareOutput, nodeOutput, cacheOutput, "app/page.tsx"]),
    ).toEqual([cloudflareOutput, nodeOutput, cacheOutput]);
  });

  it("ignores the Node and legacy Wrangler output and adds each entry once", async () => {
    const root = await copyFixture();
    await runInit(root, {});
    const nodeConfig = fs.readFileSync(path.join(root, "eslint.config.mjs"), "utf8");
    expect(await ignoredPaths(root, [nodeOutput, cacheOutput, cloudflareOutput])).toEqual([
      nodeOutput,
      cacheOutput,
    ]);

    await runInit(root, {});
    expect(fs.readFileSync(path.join(root, "eslint.config.mjs"), "utf8")).toBe(nodeConfig);

    await runInit(root, {
      platform: "cloudflare",
      cloudflare: {
        dataCache: "none",
        cdnCache: "none",
        imageOptimization: "none",
        legacyWrangler: true,
      },
    });
    expect(await ignoredPaths(root, [wranglerOutput, nodeOutput])).toEqual([
      wranglerOutput,
      nodeOutput,
    ]);
    expect(
      fs.readFileSync(path.join(root, "eslint.config.mjs"), "utf8").match(/dist\/\*\*/g),
    ).toHaveLength(1);
  });
});

describe("addEslintIgnores", () => {
  // create-next-app 15's FlatCompat template.
  it("extends the ignores object of the create-next-app 15 config", () => {
    const source = [
      "const eslintConfig = [",
      '  ...compat.extends("next/core-web-vitals", "next/typescript"),',
      "  {",
      "    ignores: [",
      "      'node_modules/**',",
      "      '.next/**',",
      "      'next-env.d.ts',",
      "    ],",
      "  },",
      "];",
    ].join("\n");
    expect(addEslintIgnores(source, ["dist/**", ".cloudflare/**"])).toBe(
      [
        "const eslintConfig = [",
        '  ...compat.extends("next/core-web-vitals", "next/typescript"),',
        "  {",
        "    ignores: [",
        "      'node_modules/**',",
        "      '.next/**',",
        "      'next-env.d.ts',",
        "      // vinext build output:",
        "      'dist/**',",
        "      '.cloudflare/**',",
        "    ],",
        "  },",
        "];",
      ].join("\n"),
    );
  });

  it("leaves a config without eslint-config-next's default ignores to the user", () => {
    expect(addEslintIgnores("export default [{ ignores: ['out/**'] }];", ["dist/**"])).toBe(
      undefined,
    );
    // Already ignored entries need no change.
    expect(addEslintIgnores("export default [{ ignores: ['dist/**'] }];", ["dist/**"])).toBe(
      "export default [{ ignores: ['dist/**'] }];",
    );
  });
});
