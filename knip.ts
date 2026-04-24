import { readFileSync } from "node:fs";
import type { KnipConfig } from "knip";

function entriesFromPackageJson(path: string): string[] {
  const pkg = JSON.parse(readFileSync(path, "utf8")) as {
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
        .replace(/\.js$/, ".ts"),
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
    "@mdx-js/rollup",
    "@mdx-js/react",
    "@unpic/react",
    // probe via require.resolve
    "next-intl",
    // false positive
    "agent",
    "private-next-instrumentation-client",
  ],
  ignoreBinaries: [
    // workspace's own bin, invoked in CI
    "vinext",
  ],
  ignoreFiles: [
    "tests/e2e/app-router/nextjs-compat/playwright.nextjs-compat.config.ts",
    "packages/vinext/src/server/app-ssr-entry.ts",
    "packages/vinext/src/server/app-browser-entry.ts",
    "packages/vinext/src/client/empty-module.ts",
  ],
  exclude: ["catalog"],
} satisfies KnipConfig;
