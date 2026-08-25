/**
 * Verifies that a `cache.data` / `cache.cdn` adapter pointing at a LOCAL file by
 * absolute path — i.e. what `require.resolve("./my-adapter")` yields in a user's
 * vite config — resolves and bundles into the Cloudflare worker. A bare relative
 * specifier would have no on-disk anchor (the registration module is virtual),
 * so absolute paths are the supported way to reference local adapters.
 *
 * This is a real Cloudflare build, so it also proves nothing throws at build
 * time: the descriptor is inert config data, and the adapter is only invoked at
 * request time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const tmpDirs: string[] = [];
const workerEntryPath = path
  .resolve(import.meta.dirname, "../packages/vinext/src/server/app-router-entry.ts")
  .replace(/\\/g, "/");
const cfPluginPath = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin/dist/index.mjs",
);

type CloudflarePluginFactory = (opts?: {
  viteEnvironment?: { name: string; childEnvironments?: string[] };
}) => import("vite").Plugin;

function writeFixtureFile(root: string, filePath: string, content: string) {
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function readTextFilesRecursive(root: string): string {
  let output = "";
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output += readTextFilesRecursive(entryPath);
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    output += fs.readFileSync(entryPath, "utf-8");
  }
  return output;
}

function readStaticEntryClosure(root: string, entryKey: string): string {
  const serverDir = path.join(root, "dist/server");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(serverDir, ".vite/manifest.json"), "utf-8"),
  ) as Record<string, { file?: unknown; imports?: unknown }>;
  const resolvedEntryKey = Object.keys(manifest).find(
    (key) => key === entryKey || key.endsWith(entryKey),
  );
  if (!resolvedEntryKey) {
    throw new Error(`Missing emitted manifest entry ${JSON.stringify(entryKey)}`);
  }
  const pending = [resolvedEntryKey];
  const visited = new Set<string>();
  let output = "";

  while (pending.length > 0) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const entry = manifest[key];
    if (!entry || typeof entry.file !== "string") {
      throw new Error(`Missing emitted manifest entry ${JSON.stringify(key)}`);
    }
    output += fs.readFileSync(path.join(serverDir, entry.file), "utf-8");
    if (Array.isArray(entry.imports)) {
      pending.push(...entry.imports.filter((value): value is string => typeof value === "string"));
    }
  }

  return output;
}

function writeCloudflareAppFixture(root: string, name: string) {
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ name, private: true, type: "module" }, null, 2),
  );
  writeFixtureFile(
    root,
    "wrangler.jsonc",
    `{
  "name": ${JSON.stringify(name)},
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "main": "./worker/index.ts",
  "assets": { "not_found_handling": "none", "binding": "ASSETS" }
}
`,
  );
  writeFixtureFile(
    root,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          types: ["vite/client", "@vitejs/plugin-rsc/types"],
        },
        include: ["app", "*.ts", "*.tsx"],
      },
      null,
      2,
    ),
  );
  writeFixtureFile(
    root,
    "app/layout.tsx",
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
  );
  writeFixtureFile(
    root,
    "app/page.tsx",
    `export default function HomePage() {
  return <main>home</main>;
}
`,
  );
  writeFixtureFile(
    root,
    "mdx-components.tsx",
    `export function useMDXComponents(components: Record<string, unknown>) {
  return components;
}
`,
  );
  writeFixtureFile(
    root,
    "worker/index.ts",
    `import handler from ${JSON.stringify(workerEntryPath)};\n\nexport default handler;\n`,
  );
}

const LOCAL_ADAPTER_MARKER = "__VINEXT_LOCAL_DATA_ADAPTER_MARKER__";

describe("config-driven cache adapter — local file by absolute path", () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves and bundles a require.resolve-style absolute adapter path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cache-adapter-build-"));
    tmpDirs.push(root);
    writeCloudflareAppFixture(root, "vinext-cache-adapter-build");

    // A local adapter module the user would reference via
    // `require.resolve("./cache/my-data-adapter")` → an ABSOLUTE path.
    writeFixtureFile(
      root,
      "cache/my-data-adapter.ts",
      `// A custom adapter module: default-exports a factory ({ env, options }) => CacheHandler.
const createAdapter = () => {
  const store = new Map();
  // The marker is a live property of the returned (escaping) handler, so it
  // survives tree-shaking/minification and proves this module was bundled.
  return {
    adapterMarker: "${LOCAL_ADAPTER_MARKER}",
    async get(key) { return store.get(key) ?? null; },
    async set(key, data) { store.set(key, data); },
    async revalidateTag() {},
  };
};

export default createAdapter;
`,
    );

    // This absolute path is exactly what require.resolve("./cache/my-data-adapter")
    // produces in a vite.config (modulo extension resolution).
    const adapterAbsPath = path.join(root, "cache/my-data-adapter.ts").replace(/\\/g, "/");

    const { cloudflare } = (await import(pathToFileURL(cfPluginPath).href)) as {
      cloudflare: CloudflarePluginFactory;
    };
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root, cache: { data: { adapter: adapterAbsPath } } }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      logLevel: "silent",
      // Build with vinext's production default (server minification ON) so this
      // test covers the real shipping path. The assertion below keys off the
      // adapter's `LOCAL_ADAPTER_MARKER` string literal, whose contents survive
      // minification verbatim (only identifiers are mangled) — so it remains a
      // valid "the adapter module was bundled" signal under minify. We
      // intentionally do NOT grep for the readable `registerConfiguredCacheAdapters`
      // function name: minify renames it (harmlessly — it is called by reference,
      // never by name), so that grep would be a minify-off-only proxy that no
      // longer reflects production.
    });

    // Build completing at all proves the absolute-path import resolved and that
    // the inert descriptor did not require any Workers context at build time.
    await builder.buildApp();

    const buildOutput = readTextFilesRecursive(path.join(root, "dist"));
    // Minify-safe: the marker is a string literal in the escaping handler, so
    // its presence proves the local adapter module was bundled even though the
    // build ran minified (the production default).
    expect(buildOutput).toContain(LOCAL_ADAPTER_MARKER);

    // Security regression: the Cloudflare build must emit a `.assetsignore` that
    // excludes Vite's `.vite/` build metadata from the deployed asset bundle.
    // The ASSETS binding serves matching files before the Worker runs, so
    // without this `/.vite/manifest.json` would be publicly fetchable (it leaks
    // the source-file → chunk mapping, including unlinked routes). The Node prod
    // server blocks `/.vite/` for the same reason. Reuses this build to avoid a
    // second expensive Cloudflare build in CI.
    const assetsIgnore = fs.readFileSync(path.join(root, "dist/client/.assetsignore"), "utf-8");
    expect(assetsIgnore.split("\n").map((l) => l.trim())).toContain(".vite");
    // The manifest exists on disk (the build reads it) but is now excluded.
    expect(fs.existsSync(path.join(root, "dist/client/.vite/manifest.json"))).toBe(true);
    expect(
      fs.readFileSync(
        path.join(root, "dist/server/__vinext_pregenerated_concrete_paths.js"),
        "utf-8",
      ),
    ).toContain("__VINEXT_PREGENERATED_CONCRETE_PATHS");
  }, 60_000);

  it("preserves the CDN response entrypoint through Cloudflare's virtual host entry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cdn-entrypoint-build-"));
    tmpDirs.push(root);
    writeCloudflareAppFixture(root, "vinext-cdn-entrypoint-build");
    fs.rmSync(path.join(root, "node_modules"));
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "fixtures/cf-app-basic/node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    writeFixtureFile(
      root,
      "worker/index.ts",
      'import handler from "vinext/server/fetch-handler";\n\nexport default handler;\n',
    );

    const { cloudflare } = (await import(pathToFileURL(cfPluginPath).href)) as {
      cloudflare: CloudflarePluginFactory;
    };
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root, cache: { cdn: cdnAdapter() } }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      logLevel: "silent",
    });

    await builder.buildApp();

    const worker = fs.readFileSync(path.join(root, "dist/server/index.js"), "utf8");
    expect(worker).toMatch(/export\s*\{[^}]*\b(?:[A-Za-z_$][\w$]*\s+as\s+)?VinextCachedResponse\b/);
    const wrangler = JSON.parse(
      fs.readFileSync(path.join(root, "dist/server/wrangler.json"), "utf8"),
    );
    expect(wrangler.exports).toMatchObject({
      default: { type: "worker", cache: { enabled: false } },
      VinextCachedResponse: { type: "worker", cache: { enabled: true } },
    });
  }, 60_000);

  it("keeps the adapter-owned response entrypoint when a custom Worker uses its reserved export", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cdn-entrypoint-collision-"));
    tmpDirs.push(root);
    writeCloudflareAppFixture(root, "vinext-cdn-entrypoint-collision");
    fs.rmSync(path.join(root, "node_modules"));
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "fixtures/cf-app-basic/node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    writeFixtureFile(
      root,
      "worker/index.ts",
      [
        'import handler from "vinext/server/fetch-handler";',
        'export class VinextCachedResponse { marker = "CUSTOM_RESERVED_EXPORT_MARKER"; }',
        "export default handler;",
        "",
      ].join("\n"),
    );

    const { cloudflare } = (await import(pathToFileURL(cfPluginPath).href)) as {
      cloudflare: CloudflarePluginFactory;
    };
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root, cache: { cdn: cdnAdapter() } }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      logLevel: "silent",
    });

    await builder.buildApp();

    const buildOutput = readTextFilesRecursive(path.join(root, "dist/server"));
    expect(buildOutput).toContain("Invalid vinext response-stage invocation");
    expect(buildOutput).not.toContain("CUSTOM_RESERVED_EXPORT_MARKER");
  }, 60_000);

  it("keeps the data adapter out of the emitted request-stage graph", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cache-adapter-stages-"));
    tmpDirs.push(root);
    writeCloudflareAppFixture(root, "vinext-cache-adapter-stages");
    writeFixtureFile(
      root,
      "cache/my-data-adapter.ts",
      `export default function createAdapter() {
  return {
    adapterMarker: "${LOCAL_ADAPTER_MARKER}",
    async get() { return null; },
    async set() {},
    async revalidateTag() {},
  };
}
`,
    );
    writeFixtureFile(
      root,
      "worker/index.ts",
      `import handler from ${JSON.stringify(
        path
          .resolve(import.meta.dirname, "../packages/vinext/src/server/fetch-handler.ts")
          .replace(/\\/g, "/"),
      )};\n\nexport default handler;\n`,
    );
    writeFixtureFile(
      root,
      "cache/my-cdn-adapter.ts",
      `export default function createAdapter() {
  return {
    ownsBackgroundRevalidation: false,
    async get() { return null; },
    async set() {},
    buildResponseHeaders() { return {}; },
    async revalidateTag() {},
  };
}
`,
    );
    writeFixtureFile(
      root,
      "cache/stage-entry.ts",
      `export const loadRequestStage = () => import("virtual:vinext-request-stage");
export const loadResponseStage = () => import("virtual:vinext-response-stage");
export default {
  async fetch(request) {
    const stage = request.url.includes("response")
      ? await loadResponseStage()
      : await loadRequestStage();
    return new Response(Object.keys(stage).join(","));
  },
};
`,
    );
    const adapterAbsPath = path.join(root, "cache/my-data-adapter.ts").replace(/\\/g, "/");
    const cdnAdapterAbsPath = path.join(root, "cache/my-cdn-adapter.ts").replace(/\\/g, "/");
    const stageEntryAbsPath = path.join(root, "cache/stage-entry.ts").replace(/\\/g, "/");
    const { cloudflare } = (await import(pathToFileURL(cfPluginPath).href)) as {
      cloudflare: CloudflarePluginFactory;
    };
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({
          appDir: root,
          cache: {
            cdn: {
              adapter: cdnAdapterAbsPath,
              output: { entry: stageEntryAbsPath, type: "multi-stage" },
            },
            data: { adapter: adapterAbsPath },
          },
        }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      logLevel: "silent",
    });

    await builder.buildApp();

    expect(readStaticEntryClosure(root, "virtual:vinext-request-stage")).not.toContain(
      LOCAL_ADAPTER_MARKER,
    );
    expect(readStaticEntryClosure(root, "virtual:vinext-response-stage")).toContain(
      LOCAL_ADAPTER_MARKER,
    );
  }, 60_000);
});
