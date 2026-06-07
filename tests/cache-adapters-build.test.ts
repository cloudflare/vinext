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
  }, 60_000);
});
