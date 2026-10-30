import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin } from "vite";
import { describe, expect, it } from "vite-plus/test";
import type { TracedPackages } from "../packages/vinext/src/build/nitro-trace-includes.js";

// Ported in spirit from Next.js: test/e2e/twoslash
// https://github.com/vercel/next.js/tree/canary/test/e2e/twoslash
//
// A server-external package that reads its own non-JS files at runtime is only
// complete in traced output when the app lists those files in
// `outputFileTracingIncludes`. Nitro traces externals file by file, so the
// option has to reach Nitro's trace.

const NITRO_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "../examples/app-router-nitro/node_modules",
);

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

const PNPM_NATIVE = "node_modules/.pnpm/@native+core-x@1.0.0/node_modules/@native/core-x";

const nextHash = createRequire(import.meta.url)("next/dist/shared/lib/hash") as {
  djb2Hash(value: string): number;
};

const pkg = (name: string, version: string) => JSON.stringify({ name, version, main: "index.js" });

/** Build a vinext + Nitro (node-server) app and return its traced node_modules dir. */
async function buildNitroApp(
  root: string,
  files: Record<string, string>,
  options: { plugins?: Plugin[]; nitro?: Record<string, unknown> } = {},
): Promise<string> {
  const vinext = (await import("../packages/vinext/src/index.js")).default;
  const nitroModule = (await import(
    pathToFileURL(path.join(NITRO_NODE_MODULES, "nitro/dist/vite.mjs")).href
  )) as { nitro(options: Record<string, unknown>): Plugin[] };

  const nodeModules = path.join(root, "node_modules");
  await fs.mkdir(nodeModules);
  for (const entry of await fs.readdir(NITRO_NODE_MODULES)) {
    if (entry.startsWith(".")) continue;
    await fs.symlink(
      path.join(NITRO_NODE_MODULES, entry),
      path.join(nodeModules, entry),
      "junction",
    );
  }
  await writeFiles(root, {
    "package.json": JSON.stringify({ name: "trace-includes", private: true, type: "module" }),
    "app/layout.tsx": `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    // Generated client directories such as Prisma's have no package.json at
    // their node_modules root.
    "node_modules/.prisma/client/index.js": "module.exports = {};",
    "node_modules/.prisma/client/schema.prisma": "generator client {}",
    "node_modules/@scope/extra/package.json": pkg("@scope/extra", "2.0.0"),
    "node_modules/@scope/extra/types/index.d.ts": "export {};",
    "node_modules/pkg/package.json": pkg("pkg", "1.0.0"),
    "node_modules/pkg/index.js": "module.exports = 'pkg';",
    [`${PNPM_NATIVE}/package.json`]: pkg("@native/core-x", "1.0.0"),
    [`${PNPM_NATIVE}/lib/a.js`]: "",
    [`${PNPM_NATIVE}/lib/.bin/b.js`]: "",
    ...files,
  });
  // Next.js test/integration/build-trace-extra-entries: an include through a
  // symlinked package keeps the link name.
  await fs.symlink("pkg", path.join(nodeModules, "pkg-behind-symlink"), "junction");
  // pnpm layout: the package directory links into node_modules/.pnpm.
  await fs.mkdir(path.join(nodeModules, "@native"));
  await fs.symlink(
    path.join(root, PNPM_NATIVE),
    path.join(nodeModules, "@native/core-x"),
    "junction",
  );

  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [
      ...(options.plugins ?? []),
      vinext({ appDir: root }),
      nitroModule.nitro({ preset: "node-server", ...options.nitro }),
    ],
    logLevel: "silent",
  });
  await builder.buildApp();
  return path.join(root, ".output", "server", "node_modules");
}

describe("Nitro outputFileTracingIncludes", () => {
  it("adds included node_modules files to Nitro's traced output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-includes-"));
    try {
      // Written while the server builds, after Nitro module setup.
      const lateFilePlugin: Plugin = {
        name: "test:late-file",
        async buildStart() {
          await fs.writeFile(path.join(root, "node_modules/data-pkg/data/late.txt"), "late");
        },
      };
      const traced = await buildNitroApp(
        root,
        {
          "next.config.mjs": `export default {
  serverExternalPackages: ["data-pkg"],
  outputFileTracingIncludes: {
    "/": [
      "./node_modules/data-pkg/data/*.txt",
      "./node_modules/@scope/extra/**",
      "./node_modules/.prisma/client/**",
      "./node_modules/helper/**",
      "./node_modules/pkg-behind-symlink/*",
      "./node_modules/@native/core-*/**",
      "./node_modules/data-pkg/node_modules/nested-data/*",
    ],
    "/api/*": ["./node_modules/api-only/**"],
    "/no-such-route": ["./node_modules/unmatched/**"],
    // A root server entry, named like Next.js names it.
    instrumentation: ["./node_modules/instrumentation-only/**"],
  },
  outputFileTracingExcludes: {
    "/": ["./node_modules/data-pkg/data/skip.txt"],
    // Also matches next-server, so it applies to the server trace too.
    "*": ["./node_modules/data-pkg/optional.js"],
    "/api/foo": ["./node_modules/api-only/lib/skip.js", "./node_modules/data-pkg/extra.js"],
  },
};`,
          "app/route.ts": `import readData from "data-pkg";
export function GET() { return new Response(readData()); }`,
          "app/api/foo/route.ts": `import readData from "data-pkg";
export function GET() { return new Response(readData()); }`,
          "instrumentation.ts": "export function register() {}",
          "node_modules/instrumentation-only/package.json": pkg("instrumentation-only", "1.0.0"),
          "node_modules/instrumentation-only/index.js": "module.exports = 1;",
          // Only selected by the "/api/*" key.
          "node_modules/api-only/package.json": pkg("api-only", "1.0.0"),
          "node_modules/api-only/lib/index.js": "module.exports = 1;",
          "node_modules/api-only/lib/skip.js": "module.exports = 2;",
          // Next.js expands includes with `dot: true`.
          "node_modules/api-only/.config/settings.json": "{}",
          "node_modules/unmatched/package.json": pkg("unmatched", "1.0.0"),
          "node_modules/unmatched/index.js": "module.exports = 1;",
          // The data directory name is built at runtime so the file tracer
          // cannot discover it statically, like TypeScript's lib.*.d.ts files.
          "node_modules/data-pkg/package.json": pkg("data-pkg", "1.0.0"),
          "node_modules/data-pkg/index.js": `const fs = require("fs");
const path = require("path");
require("helper");
require("./extra.js");
try { require("./optional.js"); } catch {}
const dir = path.join(__dirname, String.fromCharCode(100, 97, 116, 97));
module.exports = () => fs.readdirSync(dir).join(",");`,
          "node_modules/data-pkg/extra.js": "module.exports = 1;",
          "node_modules/data-pkg/optional.js": "module.exports = 1;",
          "node_modules/data-pkg/data/a.txt": "a",
          "node_modules/data-pkg/data/b.txt": "b",
          "node_modules/data-pkg/data/skip.txt": "skip",
          // data-pkg resolves its own copy of helper; the hoisted copy is a
          // different version that only the include glob selects.
          "node_modules/data-pkg/node_modules/helper/package.json": pkg("helper", "1.0.0"),
          "node_modules/data-pkg/node_modules/helper/index.js": "module.exports = 1;",
          "node_modules/helper/package.json": pkg("helper", "2.0.0"),
          "node_modules/helper/index.js": "module.exports = 2;",
          "node_modules/helper/extra.txt": "extra",
          // Nested, and not traced by Nitro.
          "node_modules/data-pkg/node_modules/nested-data/package.json": pkg(
            "nested-data",
            "1.0.0",
          ),
          "node_modules/data-pkg/node_modules/nested-data/data.json": "{}",
        },
        { plugins: [lateFilePlugin] },
      );

      expect(await exists(path.join(traced, "data-pkg", "data", "a.txt"))).toBe(true);
      expect(await exists(path.join(traced, "data-pkg", "data", "b.txt"))).toBe(true);
      expect(await exists(path.join(traced, "data-pkg", "data", "late.txt"))).toBe(true);
      expect(await exists(path.join(traced, "data-pkg", "data", "skip.txt"))).toBe(false);
      expect(await exists(path.join(traced, "data-pkg", "index.js"))).toBe(true);
      // The server bundle is shared, so a traced file is only dropped when
      // every route excludes it: "/" may still need what "/api/foo" excludes.
      expect(await exists(path.join(traced, "data-pkg", "extra.js"))).toBe(true);
      expect(await exists(path.join(traced, "data-pkg", "optional.js"))).toBe(false);
      // Route keys are matched against the app's routes.
      expect(await exists(path.join(traced, "api-only", "lib", "index.js"))).toBe(true);
      expect(await exists(path.join(traced, "api-only", ".config", "settings.json"))).toBe(true);
      expect(await exists(path.join(traced, "unmatched"))).toBe(false);
      expect(await exists(path.join(traced, "instrumentation-only", "index.js"))).toBe(true);
      // Excluded by a different key that matches the same route.
      expect(await exists(path.join(traced, "api-only", "lib", "skip.js"))).toBe(false);
      // A wildcard segment selecting a symlinked (pnpm-style) package.
      expect(await exists(path.join(traced, "@native", "core-x", "lib", "a.js"))).toBe(true);
      expect(await exists(path.join(traced, "@native", "core-x", "lib", ".bin", "b.js"))).toBe(
        true,
      );
      expect(await exists(path.join(traced, "@scope", "extra", "types", "index.d.ts"))).toBe(true);
      expect(await exists(path.join(traced, ".prisma", "client", "schema.prisma"))).toBe(true);
      expect(await exists(path.join(traced, "pkg-behind-symlink", "index.js"))).toBe(true);
      expect(await exists(path.join(traced, "pkg"))).toBe(false);
      // The traced copy of helper stays the one the output resolves.
      const helperPkg = JSON.parse(
        await fs.readFile(path.join(traced, "helper", "package.json"), "utf8"),
      );
      expect(helperPkg.version).toBe("1.0.0");
      expect(await exists(path.join(traced, "helper", "extra.txt"))).toBe(false);
      // A nested package keeps its place under its parent.
      expect(
        await exists(path.join(traced, "data-pkg", "node_modules", "nested-data", "data.json")),
      ).toBe(true);
      expect(await exists(path.join(traced, "nested-data"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("copies included files when Nitro traces no external packages", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-untraced-"));
    try {
      // Presets package serverDir in Nitro `compiled` hooks (Vercel copies it
      // into each function), and those run before module hooks.
      let shippedBeforeCompiled = false;
      const traced = await buildNitroApp(
        root,
        {
          "next.config.mjs": `export default {
  outputFileTracingIncludes: {
    "/": [
      "./node_modules/@scope/extra/**",
      "./node_modules/.prisma/client/**",
      "./node_modules/pkg-behind-symlink/*",
      "./node_modules/parent/node_modules/child/data.json",
    ],
  },
  outputFileTracingExcludes: { "/": ["./node_modules/.prisma/client/index.js"] },
};`,
          "app/route.ts": `export function GET() { return new Response("ok"); }`,
          "node_modules/parent/package.json": pkg("parent", "1.0.0"),
          "node_modules/parent/node_modules/child/package.json": pkg("child", "1.0.0"),
          "node_modules/parent/node_modules/child/data.json": "{}",
        },
        {
          nitro: {
            hooks: {
              async compiled() {
                shippedBeforeCompiled = await exists(
                  path.join(root, ".output/server/node_modules/@scope/extra/types/index.d.ts"),
                );
              },
            },
          },
        },
      );

      expect(shippedBeforeCompiled).toBe(true);
      expect(await exists(path.join(traced, "@scope", "extra", "package.json"))).toBe(true);
      expect(await exists(path.join(traced, "@scope", "extra", "types", "index.d.ts"))).toBe(true);
      expect(await exists(path.join(traced, ".prisma", "client", "schema.prisma"))).toBe(true);
      expect(await exists(path.join(traced, ".prisma", "client", "index.js"))).toBe(false);
      expect(await exists(path.join(traced, "pkg-behind-symlink", "index.js"))).toBe(true);
      expect(await exists(path.join(traced, "pkg"))).toBe(false);
      // A nested package keeps its place under its parent.
      expect(await exists(path.join(traced, "parent", "node_modules", "child", "data.json"))).toBe(
        true,
      );
      expect(await exists(path.join(traced, "child"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("warns when included files are outside node_modules", async () => {
    const { createNitroTraceIncludes } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-outside-"));
    try {
      await writeFiles(root, { "content/a.md": "a", "content/b.md": "b" });
      const warnings: string[] = [];
      const traceIncludes = createNitroTraceIncludes({
        root,
        routes: ["/app"],
        includes: { "/": ["./content/*.md"] },
        excludes: {},
        warn: (message) => warnings.push(message),
      });
      expect(traceIncludes).not.toBeNull();
      const tracedPackages = {};
      traceIncludes!.tracedPackages(tracedPackages);
      expect(tracedPackages).toEqual({});
      expect(warnings).toEqual([
        "[vinext] outputFileTracingIncludes matched 2 file(s) outside node_modules. " +
          "Nitro's traced output only contains node_modules, so these files are not copied.",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("unions each route's matched includes minus its matched excludes", async () => {
    const { createNitroTraceIncludes } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-routes-")),
    );
    try {
      await writeFiles(root, {
        "node_modules/inc/package.json": pkg("inc", "1.0.0"),
        "node_modules/inc/a.txt": "",
        "node_modules/inc/b.txt": "",
        "node_modules/inc/c.txt": "",
        "node_modules/inc/d.txt": "",
        "node_modules/traced/index.js": "",
        "node_modules/traced/all.js": "",
        "node_modules/traced/some.js": "",
      });
      const traced = (file: string) => path.join(root, "node_modules/traced", file);
      const tracedPackages: TracedPackages = {
        traced: {
          name: "traced",
          versions: {
            "1.0.0": {
              path: path.join(root, "node_modules/traced"),
              files: [traced("index.js"), traced("all.js"), traced("some.js")],
              pkgJSON: { name: "traced", version: "1.0.0" },
            },
          },
        },
      };
      createNitroTraceIncludes({
        root,
        // Next.js route names of app/api/foo/route.ts, app/page.tsx and pages/docs.tsx.
        routes: ["/app/api/foo", "/app", "/pages/docs"],
        includes: {
          "/api/*": ["node_modules/inc/a.txt", "node_modules/inc/b.txt"],
          "/pages/**": ["node_modules/inc/b.txt", "node_modules/inc/c.txt"],
          "/missing": ["node_modules/inc/d.txt"],
        },
        excludes: {
          // b.txt is excluded for /app/api/foo, but /pages/docs includes it too.
          "/api/foo": ["node_modules/inc/{a,b}.txt", "node_modules/traced/some.js"],
          "*": ["node_modules/traced/all.js"],
        },
        warn: () => {},
      })!.tracedPackages(tracedPackages);

      const inc = path.join(root, "node_modules/inc");
      expect(tracedPackages.inc.versions["1.0.0"].files.sort()).toEqual([
        path.join(inc, "b.txt"),
        path.join(inc, "c.txt"),
      ]);
      // Only the file every route excludes leaves Nitro's trace.
      expect(tracedPackages.traced.versions["1.0.0"].files).toEqual([
        traced("index.js"),
        traced("some.js"),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("names routes the way Next.js's build trace step does", async () => {
    const { collectTraceRouteNames } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-names-"));
    try {
      const page = "export default function Page() { return null; }";
      await writeFiles(root, {
        "app/layout.tsx": page,
        "app/page.tsx": page,
        "app/(group)/about/page.tsx": page,
        "app/blog/[slug]/page.tsx": page,
        "app/api/hello/route.ts": "export function GET() {}",
        "app/sitemap.ts": "export default function sitemap() { return []; }",
        "app/products/sitemap.ts":
          "export async function generateSitemaps() { return [{ id: 0 }]; }\n" +
          "export default function sitemap() { return []; }",
        "app/products/icon.tsx":
          "export function generateImageMetadata() { return [{ id: 'small' }]; }\n" +
          "export default function Icon() { return null; }",
        "app/products/opengraph-image.tsx": "export default function Image() { return null; }",
        "app/blog/[slug]/icon.png": "",
        "app/(marketing)/twitter-image.tsx": "export default function Image() { return null; }",
        // A route only a parallel slot fills, and a private folder.
        "app/@modal/photo/page.tsx": page,
        "app/@modal/default.tsx": page,
        "app/_private/page.tsx": page,
        // Next.js reads `%5F` as `_`.
        "app/%5Fsites/page.tsx": page,
        "app/%5Fsites/icon.png": "",
        "pages/legacy.tsx": page,
        "pages/docs/index.tsx": page,
        "pages/api/x.ts": "export default function handler() {}",
      });
      const names = await collectTraceRouteNames({
        appDir: path.join(root, "app"),
        pagesDir: path.join(root, "pages"),
        pageExtensions: ["tsx", "ts", "jsx", "js"],
        rootEntries: ["instrumentation", "proxy"],
      });
      // Next.js hashes the parent path of metadata files below route groups.
      const groupSuffix = nextHash.djb2Hash("/(marketing)").toString(36).slice(0, 6);
      // `next build --webpack` entry names (`.next/server/**/*.js.nft.json`)
      // after normalizeAppPath / normalizePagePath. `_global-error` is only
      // built without pages.
      expect(names.sort()).toEqual(
        [
          "/app",
          "/app/about",
          "/app/blog/[slug]",
          "/app/api/hello",
          "/app/sitemap.xml",
          "/app/products/sitemap/[__metadata_id__]",
          "/app/products/icon/[__metadata_id__]",
          "/app/products/opengraph-image",
          "/app/blog/[slug]/icon.png",
          `/app/twitter-image-${groupSuffix}`,
          "/app/photo",
          "/app/_sites",
          "/app/_sites/icon.png",
          "/app/_not-found",
          "/pages/legacy",
          "/pages/docs",
          "/pages/api/x",
          "/pages/_app",
          "/pages/_document",
          "/pages/_error",
          "instrumentation",
          "proxy",
        ].sort(),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("names the built-in routes when the only pages file is a reserved index page", async () => {
    const { collectTraceRouteNames } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-reserved-"));
    try {
      const page = "export default function Page() { return null; }";
      await writeFiles(root, { "app/page.tsx": page, "pages/_app/index.tsx": page });
      const names = await collectTraceRouteNames({
        appDir: path.join(root, "app"),
        pagesDir: path.join(root, "pages"),
        pageExtensions: ["tsx", "ts", "jsx", "js"],
      });
      // `getPageFromPath` reads `_app/index` as `_app`, so this build is hybrid.
      expect(names.sort()).toEqual(
        ["/app", "/app/_not-found", "/pages/_app", "/pages/_document", "/pages/_error"].sort(),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("names the built-in routes of app-only builds", async () => {
    const { collectTraceRouteNames } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-app-only-"));
    try {
      await writeFiles(root, {
        "app/page.tsx": "export default function Page() { return null; }",
        "app/robots.ts": "export default function robots() { return {}; }",
        "pages/.gitkeep": "",
      });
      const names = await collectTraceRouteNames({
        appDir: path.join(root, "app"),
        // A pages directory without pages is an app-only build.
        pagesDir: path.join(root, "pages"),
        pageExtensions: ["tsx", "ts", "jsx", "js"],
      });
      expect(names.sort()).toEqual(
        ["/app", "/app/robots.txt", "/app/_not-found", "/app/_global-error"].sort(),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("names the not-found route of an app with only a root not-found page", async () => {
    const { collectTraceRouteNames } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-not-found-"));
    try {
      const page = "export default function Page() { return null; }";
      await writeFiles(root, { "app/layout.tsx": page, "app/not-found.tsx": page });
      const names = await collectTraceRouteNames({
        appDir: path.join(root, "app"),
        pagesDir: null,
        pageExtensions: ["tsx", "ts", "jsx", "js"],
      });
      expect(names.sort()).toEqual(["/app/_not-found", "/app/_global-error"].sort());
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("fails safe on glob syntax it does not match exactly", async () => {
    const { createNitroTraceIncludes } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-inexact-")),
    );
    try {
      await writeFiles(root, {
        "node_modules/inc/package.json": pkg("inc", "1.0.0"),
        "node_modules/inc/a.txt": "",
        "node_modules/inc/b.txt": "",
      });
      const warnings: string[] = [];
      const tracedPackages: TracedPackages = {};
      createNitroTraceIncludes({
        root,
        routes: ["/app"],
        // A POSIX class key applies to every route; an extglob spanning `/` is ignored.
        includes: { "/[[:digit:]]": ["node_modules/inc/*.txt"] },
        excludes: { "/": ["node_modules/@(inc/a).txt"] },
        warn: (message) => warnings.push(message),
      })!.tracedPackages(tracedPackages);
      const inc = path.join(root, "node_modules/inc");
      expect(tracedPackages.inc.versions["1.0.0"].files.sort()).toEqual([
        path.join(inc, "a.txt"),
        path.join(inc, "b.txt"),
      ]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("/[[:digit:]], node_modules/@(inc/a).txt");
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it.each([
    ["the default virtual store", PNPM_NATIVE],
    ["a custom virtualStoreDir", ".pnpm-store/@native+core-x@1.0.0/node_modules/@native/core-x"],
  ])("applies excludes to pnpm packages in %s by their node_modules path", async (_, storeDir) => {
    const { createNitroTraceIncludes } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-pnpm-")),
    );
    try {
      const store = path.join(root, storeDir);
      // A copy no `node_modules/<name>` link resolves to.
      const other = path.join(root, ".pnpm-store/other@1.0.0/node_modules/@native/core-x");
      await writeFiles(root, {
        [`${storeDir}/package.json`]: pkg("@native/core-x", "1.0.0"),
        [`${storeDir}/index.js`]: "",
        [`${storeDir}/lib/a.js`]: "",
        [`${path.relative(root, other)}/lib/a.js`]: "",
      });
      await fs.mkdir(path.join(root, "node_modules/@native"), { recursive: true });
      await fs.symlink(store, path.join(root, "node_modules/@native/core-x"));
      // Nitro lists the real paths in the store.
      const tracedPackages: TracedPackages = {
        "@native/core-x": {
          name: "@native/core-x",
          versions: {
            "1.0.0": {
              path: store,
              files: [path.join(store, "index.js"), path.join(store, "lib/a.js")],
              pkgJSON: { name: "@native/core-x", version: "1.0.0" },
            },
            "2.0.0": {
              path: other,
              files: [path.join(other, "lib/a.js")],
              pkgJSON: { name: "@native/core-x", version: "2.0.0" },
            },
          },
        },
      };
      createNitroTraceIncludes({
        root,
        routes: ["/app"],
        includes: {},
        excludes: { "*": ["node_modules/@native/core-x/lib/**"] },
        warn: () => {},
      })!.tracedPackages(tracedPackages);
      expect(tracedPackages["@native/core-x"].versions["1.0.0"].files).toEqual([
        path.join(store, "index.js"),
      ]);
      expect(tracedPackages["@native/core-x"].versions["2.0.0"].files).toEqual([
        path.join(other, "lib/a.js"),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("keeps traced files the server trace does not exclude", async () => {
    const { createNitroTraceIncludes } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-server-")),
    );
    try {
      const dir = path.join(root, "node_modules/traced");
      const tracedPackages: TracedPackages = {
        traced: {
          name: "traced",
          versions: {
            "1.0.0": {
              path: dir,
              files: ["a.js", "b.js", "c.js"].map((file) => path.join(dir, file)),
              pkgJSON: { name: "traced", version: "1.0.0" },
            },
          },
        },
      };
      createNitroTraceIncludes({
        root,
        routes: ["/app"],
        includes: {},
        // Next.js applies only keys matching `next-server` to the server's
        // own trace, which Nitro's trace also holds.
        excludes: {
          "/app": ["node_modules/traced/a.js", "node_modules/traced/c.js"],
          "next-server": ["node_modules/traced/b.js", "node_modules/traced/c.js"],
        },
        warn: () => {},
      })!.tracedPackages(tracedPackages);
      expect(tracedPackages.traced.versions["1.0.0"].files).toEqual([
        path.join(dir, "a.js"),
        path.join(dir, "b.js"),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("keeps the included files of a version whose traced files are all excluded", async () => {
    const { createNitroTraceIncludes } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-versions-")),
    );
    try {
      await writeFiles(root, {
        "node_modules/pkg/package.json": pkg("pkg", "1.0.0"),
        "node_modules/pkg/index.js": "",
        "node_modules/pkg/data.txt": "",
        "node_modules/other/node_modules/pkg/package.json": pkg("pkg", "2.0.0"),
        "node_modules/other/node_modules/pkg/index.js": "",
      });
      const top = path.join(root, "node_modules/pkg");
      const nested = path.join(root, "node_modules/other/node_modules/pkg");
      const tracedPackages: TracedPackages = {
        pkg: {
          name: "pkg",
          versions: {
            "1.0.0": {
              path: top,
              files: [path.join(top, "index.js")],
              pkgJSON: { name: "pkg", version: "1.0.0" },
            },
            "2.0.0": {
              path: nested,
              files: [path.join(nested, "index.js")],
              pkgJSON: { name: "pkg", version: "2.0.0" },
            },
          },
        },
      };
      const warnings: string[] = [];
      createNitroTraceIncludes({
        root,
        routes: ["/app"],
        includes: { "*": ["node_modules/pkg/data.txt"] },
        excludes: { "*": ["node_modules/pkg/index.js"] },
        warn: (message) => warnings.push(message),
      })!.tracedPackages(tracedPackages);
      expect(tracedPackages.pkg.versions["1.0.0"].files).toEqual([path.join(top, "data.txt")]);
      expect(tracedPackages.pkg.versions["2.0.0"].files).toEqual([path.join(nested, "index.js")]);
      expect(warnings).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it.each([
    ["nested", "node_modules/other", "node_modules/other/node_modules/pkg"],
    [
      "pnpm",
      "node_modules/.pnpm/other@1.0.0/node_modules/other",
      "node_modules/.pnpm/pkg@2.0.0/node_modules/pkg",
    ],
  ])(
    "keeps the placement of a %s version left with only included files",
    async (_, otherDir, nestedDir) => {
      const { createNitroTraceIncludes } =
        await import("../packages/vinext/src/build/nitro-trace-includes.js");
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-nested-only-")),
      );
      try {
        await writeFiles(root, {
          "node_modules/pkg/package.json": pkg("pkg", "1.0.0"),
          "node_modules/pkg/index.js": "",
          [`${otherDir}/package.json`]: pkg("other", "1.0.0"),
          [`${otherDir}/index.js`]: "",
          [`${nestedDir}/package.json`]: pkg("pkg", "2.0.0"),
          [`${nestedDir}/index.js`]: "",
          [`${nestedDir}/data.txt`]: "",
        });
        const top = path.join(root, "node_modules/pkg");
        const other = path.join(root, otherDir);
        const nested = path.join(root, nestedDir);
        // nf3's trace: the server imports `pkg` 1.0.0 and `other`, which
        // imports `pkg` 2.0.0.
        const server = path.join(root, ".output/server/index.mjs");
        const tracedFiles: Record<
          string,
          { parents: string[]; pkgName?: string; pkgVersion?: string }
        > = {
          [path.join(top, "index.js")]: { parents: [server], pkgName: "pkg", pkgVersion: "1.0.0" },
          [path.join(other, "index.js")]: {
            parents: [server],
            pkgName: "other",
            pkgVersion: "1.0.0",
          },
          [path.join(nested, "index.js")]: {
            parents: [path.join(other, "index.js")],
            pkgName: "pkg",
            pkgVersion: "2.0.0",
          },
        };
        const tracedPackages: TracedPackages = {
          pkg: {
            name: "pkg",
            versions: {
              "1.0.0": {
                path: top,
                files: [path.join(top, "index.js")],
                pkgJSON: { name: "pkg", version: "1.0.0" },
              },
              "2.0.0": {
                path: nested,
                files: [path.join(nested, "index.js")],
                pkgJSON: { name: "pkg", version: "2.0.0" },
              },
            },
          },
        };
        const traceIncludes = createNitroTraceIncludes({
          root,
          routes: ["/app"],
          includes: { "*": [`${nestedDir}/data.txt`] },
          excludes: { "*": [`${nestedDir}/index.js`] },
          warn: () => {},
        })!;
        traceIncludes.tracedFiles(tracedFiles);
        traceIncludes.tracedPackages(tracedPackages);
        // nf3 writes the version with its package.json and links it under the
        // packages that import its files (`findPackageParents`); a version
        // without parents would become the root `node_modules/pkg`.
        const parentsOf = (version: string) => [
          ...new Set(
            tracedPackages.pkg.versions[version].files.flatMap((file) =>
              (tracedFiles[file]?.parents ?? []).flatMap((parent) => {
                const parentFile = tracedFiles[parent];
                if (!parentFile || parentFile.pkgName === "pkg") return [];
                return [`${parentFile.pkgName}@${parentFile.pkgVersion}`];
              }),
            ),
          ),
        ];
        expect(tracedPackages.pkg.versions["2.0.0"].files).toEqual([path.join(nested, "data.txt")]);
        expect(parentsOf("2.0.0")).toEqual(["other@1.0.0"]);
        expect(parentsOf("1.0.0")).toEqual([]);
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});
