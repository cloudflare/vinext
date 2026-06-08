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
      entry: ["scripts/*.{js,ts,mjs,mts}", "tests/**/*.test.ts", "tests/helpers.ts"],
      project: ["tests/**/*.{js,ts}", "!tests/fixtures/**"],
    },
    "packages/vinext": {
      entry: [
        ...entriesFromPackageJson("packages/vinext/package.json"),
        // Build-time entries referenced by path constant (Vite reads them
        // from disk via `fs`), so knip wouldn't otherwise trace them.
        "src/server/app-browser-entry.ts",
        "src/server/app-ssr-entry.ts",
        // Runtime helpers imported by generated virtual entries. The imports
        // are emitted as strings, so knip cannot trace them statically.
        "src/server/app-middleware.ts",
        "src/server/app-page-dispatch.ts",
        "src/server/app-page-head.ts",
        "src/server/app-prerender-static-params.ts",
        "src/server/app-route-module-loader.ts",
        // Client-side instrumentation bundle: loaded as a side-effect module
        // by the generated hydration entries (import "vinext/instrumentation-client"),
        // so its public surface (clientInstrumentationHooks, getClientInstrumentationHooks)
        // is consumed by the user's app at runtime, not by imports knip can follow.
        "src/client/instrumentation-client.ts",
        "src/client/instrumentation-client-state.ts",
        // Shims for `next/*` internal modules — their exports are consumed by
        // type-only imports in third-party packages' .d.ts files (e.g.
        // @clerk/nextjs, @sentry/nextjs, nextjs-toploader). Those imports
        // originate in node_modules and are invisible to knip.
        "src/shims/internal/api-utils.ts",
        "src/shims/internal/app-router-context.ts",
        "src/shims/internal/utils.ts",
        // Typed WorkUnitStore exports consumed by cache.ts via AsyncLocalStorage
        // generic — knip cannot trace type-only dependencies through ALS.
        "src/shims/internal/work-unit-async-storage.ts",
        // Imported via template string in app-rsc-entry.ts (generated code),
        // so knip cannot trace the import statically.
        "src/server/prerender-work-unit-setup.ts",
        "src/server/app-page-element-builder.ts",
        "src/server/app-hook-warning-suppression.ts",
        "src/server/app-post-middleware-context.ts",
        "src/server/app-request-context.ts",
        "src/server/app-rsc-error-handler.ts",
        "src/server/isr-cache.ts",
        "src/server/rsc-stream-hints.ts",
        // #726-CACHE-01/04 defines the disabled proof boundary before runtime
        // observation recording or cache reuse is wired in later slices.
        "src/server/cache-proof.ts",
        // #726-SKIP layout-safety observation foundation. Consumed by the
        // planner, dispatch wiring, and render in later slices.
        "src/server/app-layout-param-observation.ts",
        // #726-SKIP static layout reuse proof model. Consumed by render in a
        // later slice; standalone planner + helpers here.
        "src/server/skip-cache-proof.ts",
        "src/server/static-layout-client-reuse-proof.ts",
      ],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/cloudflare": {
      entry: [...entriesFromPackageJson("packages/cloudflare/package.json")],
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

    // internal module name, not an actual dependency
    "private-next-instrumentation-client",

    // Cloudflare Workers runtime virtual module — provides `env` for
    // accessing wrangler bindings. Not an npm package. Knip strips the
    // `cloudflare:workers` specifier down to the bare scheme.
    "cloudflare",
  ],
  ignoreBinaries: [
    // workspace's own bin, invoked in CI
    "vinext",
    // system/user-project binaries invoked by runtime scripts
    "ps",
    "eslint",
    "gh",
  ],
  ignoreFiles: [
    "tests/e2e/app-router/nextjs-compat/playwright.nextjs-compat.config.ts",
    // stub module loaded via `path.resolve()` as a Vite alias target
    "packages/vinext/src/client/empty-module.ts",
  ],
  // Catalog check is noisy here (deps consumed from the workspace's own
  // sub-packages or `examples/**` which we intentionally ignore).
  // `duplicates` flags intentional compat aliases — see
  // packages/vinext/src/shims/internal/work-unit-async-storage.ts where
  // `requestAsyncStorage` is a legacy alias for `workUnitAsyncStorage`.
  exclude: ["catalog", "duplicates"],
} satisfies KnipConfig;
