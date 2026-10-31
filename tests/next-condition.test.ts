/**
 * Ported from Next.js: test/e2e/app-dir/next-condition/next-condition.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/next-condition/next-condition.test.ts
 *
 * Next.js adds the `next-js` export condition to every bundled layer except
 * middleware and instrumentation, but only when Cache Components is enabled
 * (webpack-config.ts `conditionNames`, next-core `custom_conditions`). Packages
 * in `serverExternalPackages` are loaded by the server runtime and never see it.
 * The upstream middleware, proxy and instrumentation cases are not ported:
 * those share a Vite environment with routes in vinext, so they resolve the
 * same conditions (docs/reference/differences.mdx).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { createBuilder, createServer } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const FIXTURE_ROOT = path.resolve(import.meta.dirname, "fixtures/next-condition");
const CACHE_COMPONENTS_ENV = "VINEXT_TEST_CACHE_COMPONENTS";
const CLOUDFLARE_PLUGIN_PATH = path.resolve(
  import.meta.dirname,
  "fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin/dist/index.mjs",
);

type CloudflarePluginFactory = (options: {
  viteEnvironment: { name: string; childEnvironments: string[] };
  config: Record<string, unknown>;
}) => import("vite").Plugin;

type RenderedRoute = { server: string; client: string };

const EXTERNAL: RenderedRoute = {
  server: "EXPORTS DEFAULT CLIENT | IMPORTS DEFAULT CLIENT | EXPORTS DEFAULT CLIENT",
  client: "EXPORTS DEFAULT CLIENT | IMPORTS DEFAULT CLIENT",
};

const EXPECTED: Record<"enabled" | "disabled", Record<string, RenderedRoute>> = {
  enabled: {
    esm: {
      server: "EXPORTS NEXT SERVER | IMPORTS NEXT SERVER | EXPORTS NEXT SERVER",
      client: "EXPORTS NEXT CLIENT | IMPORTS NEXT CLIENT",
    },
    cjs: {
      server: "EXPORTS NEXT SERVER | IMPORTS NEXT SERVER | EXPORTS NEXT SERVER",
      client: "EXPORTS NEXT CLIENT | IMPORTS NEXT CLIENT",
    },
    "external-esm": EXTERNAL,
    "external-cjs": EXTERNAL,
    // With Cache Components, barrel optimization leaves the package to Vite,
    // which resolves `react-server` before `next-js` in rsc.
    barrel: { server: "BARREL SERVER", client: "BARREL NEXT" },
    // Pages Router dependencies that vinext bundles.
    "pages-esm": { server: "EXPORTS NEXT CLIENT", client: "" },
  },
  disabled: {
    esm: {
      server: "EXPORTS DEFAULT SERVER | IMPORTS DEFAULT SERVER | EXPORTS DEFAULT SERVER",
      client: "EXPORTS DEFAULT CLIENT | IMPORTS DEFAULT CLIENT",
    },
    cjs: {
      server: "EXPORTS DEFAULT SERVER | IMPORTS DEFAULT SERVER | EXPORTS DEFAULT SERVER",
      client: "EXPORTS DEFAULT CLIENT | IMPORTS DEFAULT CLIENT",
    },
    "external-esm": EXTERNAL,
    "external-cjs": EXTERNAL,
    barrel: { server: "BARREL SERVER", client: "BARREL DEFAULT" },
    "pages-esm": { server: "EXPORTS DEFAULT CLIENT", client: "" },
  },
};

async function renderRoute(baseUrl: string, route: string): Promise<RenderedRoute> {
  const response = await fetch(`${baseUrl}/${route}`);
  expect(response.status).toBe(200);
  const html = (await response.text()).replaceAll("<!-- -->", "");
  const text = (id: string) => new RegExp(`<p id="${id}">(.*?)</p>`).exec(html)?.[1];
  return { server: text("server") ?? "", client: text("client") ?? "" };
}

// Collects the browser code the dev server serves for a client component's
// package imports: pre-bundled dependencies, or the package files themselves
// (and the `#imports` files they re-export) for packages the optimizer skips.
async function fetchDevBrowserPackageCode(baseUrl: string, route: string): Promise<string> {
  const fetchModule = async (url: string) => {
    const response = await fetch(new URL(url, baseUrl));
    expect(response.status, url).toBe(200);
    return response.text();
  };
  const packageImports = (code: string) =>
    [...code.matchAll(/from\s*"([^"]*my-[^"]*-package[^"]*)"/g)].map((match) => match[1]);
  let urls = packageImports(await fetchModule(`/app/${route}/client.js`));
  expect(urls, `${route} client imports`).toHaveLength(2);
  let code = "";
  for (let depth = 0; depth < 2 && urls.length > 0; depth++) {
    const modules = await Promise.all(urls.map(fetchModule));
    code += modules.join("\n");
    urls = modules.flatMap(packageImports);
  }
  return code;
}

function readScripts(dir: string, excludeDir?: string): string {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".js"))
    .filter((file) => !excludeDir || !file.startsWith(`${excludeDir}${path.sep}`))
    .map((file) => fs.readFileSync(path.join(dir, file), "utf8"))
    .join("\n");
}

const VARIANTS = ["NEXT SERVER", "NEXT CLIENT", "DEFAULT SERVER", "DEFAULT CLIENT"];

// An environment resolves one variant of every package, so finding no other
// variant in its output shows that each package resolved the expected one.
function expectOnlyVariant(code: string, variant: string, label: string) {
  for (const kind of ["EXPORTS", "IMPORTS"]) {
    for (const candidate of VARIANTS) {
      const marker = `${kind} ${candidate}`;
      expect(code.includes(marker), `${label}: ${marker}`).toBe(candidate === variant);
    }
  }
}

const previousCacheComponentsEnv = process.env[CACHE_COMPONENTS_ENV];
afterAll(() => {
  fs.rmSync(path.join(FIXTURE_ROOT, "dist"), { recursive: true, force: true });
  fs.rmSync(path.join(FIXTURE_ROOT, ".wrangler"), { recursive: true, force: true });
  if (previousCacheComponentsEnv === undefined) delete process.env[CACHE_COMPONENTS_ENV];
  else process.env[CACHE_COMPONENTS_ENV] = previousCacheComponentsEnv;
});

describe.each([
  { mode: "enabled", cacheComponents: true },
  { mode: "disabled", cacheComponents: false },
] as const)("`next-js` condition with Cache Components $mode", ({ mode, cacheComponents }) => {
  it("resolves package conditions in the dev server", async () => {
    process.env[CACHE_COMPONENTS_ENV] = String(cacheComponents);
    const server = await createServer({
      root: FIXTURE_ROOT,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: FIXTURE_ROOT })],
      server: { host: "127.0.0.1", port: 0 },
      // Pre-bundled for SSR, so the `#imports` inside them resolve through
      // the server dependency optimizer.
      environments: {
        ssr: { optimizeDeps: { include: ["my-esm-package/imports", "my-cjs-package/imports"] } },
      },
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("Missing dev server address");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      for (const [route, expected] of Object.entries(EXPECTED[mode])) {
        expect(await renderRoute(baseUrl, route), route).toEqual(expected);
      }
      // The browser bundles every package, including server-external ones.
      // Those skip the client optimizer, so the CommonJS one reaches the dev
      // browser untransformed and is left out here; the build covers it.
      const [included, excluded] = cacheComponents
        ? ["NEXT CLIENT", "DEFAULT CLIENT"]
        : ["DEFAULT CLIENT", "NEXT CLIENT"];
      for (const route of ["esm", "cjs", "external-esm"]) {
        const code = await fetchDevBrowserPackageCode(baseUrl, route);
        expect(code.includes(`EXPORTS ${included}`), `${route} EXPORTS ${included}`).toBe(true);
        expect(code.includes(`IMPORTS ${included}`), `${route} IMPORTS ${included}`).toBe(true);
        expect(code.includes(excluded), `${route} ${excluded}`).toBe(false);
      }
    } finally {
      await server.close();
    }
  }, 120_000);

  it("resolves package conditions in the production build", async () => {
    process.env[CACHE_COMPONENTS_ENV] = String(cacheComponents);
    // Each mode builds into its own directory: Node caches the server entry
    // by URL, so a second build at the same path would serve the first one.
    const outDir = path.join(FIXTURE_ROOT, "dist", mode);
    const clientOutDir = path.join(outDir, "client");
    const builder = await createBuilder({
      root: FIXTURE_ROOT,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext({
          appDir: FIXTURE_ROOT,
          clientOutDir,
          rscOutDir: path.join(outDir, "server"),
          ssrOutDir: path.join(outDir, "server/ssr"),
        }),
      ],
    });
    await builder.buildApp();

    // The browser bundles every package, including server-external ones.
    expectOnlyVariant(
      readScripts(clientOutDir),
      cacheComponents ? "NEXT CLIENT" : "DEFAULT CLIENT",
      "client",
    );

    const result = await startProdServer({
      host: "127.0.0.1",
      port: 0,
      outDir,
    });
    const server = "server" in result ? result.server : result;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      for (const [route, expected] of Object.entries(EXPECTED[mode])) {
        expect(await renderRoute(`http://127.0.0.1:${address.port}`, route), route).toEqual(
          expected,
        );
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);

  it("resolves package conditions in the Cloudflare Workers build", async () => {
    process.env[CACHE_COMPONENTS_ENV] = String(cacheComponents);
    const outDir = path.join(FIXTURE_ROOT, "dist", `cloudflare-${mode}`);
    const { cloudflare } = (await import(pathToFileURL(CLOUDFLARE_PLUGIN_PATH).href)) as {
      cloudflare: CloudflarePluginFactory;
    };
    const builder = await createBuilder({
      root: FIXTURE_ROOT,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext({
          appDir: FIXTURE_ROOT,
          clientOutDir: path.join(outDir, "client"),
          rscOutDir: path.join(outDir, "server"),
          ssrOutDir: path.join(outDir, "server/ssr"),
        }),
        cloudflare({
          viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
          config: {
            name: "next-condition",
            compatibility_date: "2026-02-12",
            compatibility_flags: ["nodejs_compat"],
            main: "vinext/server/app-router-entry",
          },
        }),
      ],
    });
    await builder.buildApp();

    // The Worker bundles every package, including server-external ones.
    const variant = cacheComponents ? "NEXT" : "DEFAULT";
    expectOnlyVariant(readScripts(path.join(outDir, "server"), "ssr"), `${variant} SERVER`, "rsc");
    expectOnlyVariant(readScripts(path.join(outDir, "server/ssr")), `${variant} CLIENT`, "ssr");
    expectOnlyVariant(readScripts(path.join(outDir, "client")), `${variant} CLIENT`, "client");
    const barrels = {
      rsc: [readScripts(path.join(outDir, "server"), "ssr"), "SERVER"],
      ssr: [readScripts(path.join(outDir, "server/ssr")), variant],
    };
    for (const [label, [code, barrel]] of Object.entries(barrels)) {
      for (const candidate of ["SERVER", "NEXT", "DEFAULT"]) {
        const marker = `BARREL ${candidate}`;
        expect(code.includes(marker), `${label}: ${marker}`).toBe(candidate === barrel);
      }
    }
  }, 120_000);
});
