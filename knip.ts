import { readFileSync } from "node:fs";
import type { KnipConfig } from "knip";

function entriesFromPackageJson(relativePath: string): string[] {
  const pkg = JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as {
    bin?: string | Record<string, string>;
    exports?: Record<string, unknown>;
  };
  const targets = new Set<string>();

  const visit = (value: unknown) => {
    if (typeof value === "string") targets.add(value);
    else if (value && typeof value === "object") for (const v of Object.values(value)) visit(v);
  };

  visit(pkg.bin);
  visit(pkg.exports);

  return [...targets]
    .filter((t) => t.endsWith(".js"))
    .map((t) =>
      t
        .replace(/^\.\//, "")
        .replace(/^dist\//, "src/")
        .replace(/\.js$/, ".{ts,tsx}"),
    );
}

export default {
  workspaces: {
    ".": {
      entry: ["scripts/*.{js,ts}", "tests/**/*.test.ts", "tests/helpers.ts"],
      project: ["scripts/**/*.{js,ts}", "tests/**/*.{js,ts}", "!tests/fixtures/**"],
    },
    "packages/vinext": {
      entry: entriesFromPackageJson("packages/vinext/package.json"),
      project: ["src/**/*.{ts,tsx}"],
    },
  },
  ignoreWorkspaces: ["examples/**", "tests/fixtures/**", "benchmarks/**"],
  ignoreDependencies: [
    "@typescript/native-preview",

    // Declared at root package.json but imported from workspace/example code:
    //   @mdx-js/react — no direct imports; retained for MDX runtime resolution.
    //   @mdx-js/rollup — imported from examples/app-router-playground/vite.config.ts
    //     which doesn't declare it locally and relies on root hoisting.
    "@mdx-js/react",
    "@mdx-js/rollup",

    // probed via require.resolve
    "next-intl",

    // vitest reporter
    "agent",

    // internal module name, not an actual dependency
    "private-next-instrumentation-client",
  ],
  ignoreBinaries: [
    // workspace's own bin, invoked in CI
    "vinext",
  ],
  ignoreFiles: [
    "tests/e2e/app-router/nextjs-compat/playwright.nextjs-compat.config.ts",
    // files read via fs
    "packages/vinext/src/server/app-browser-entry.ts",
    "packages/vinext/src/server/app-ssr-entry.ts",
    // stub module
    "packages/vinext/src/client/empty-module.ts",
  ],
  exclude: ["catalog"],
} satisfies KnipConfig;
