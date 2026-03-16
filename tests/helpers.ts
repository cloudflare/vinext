/**
 * Test helpers for vinext integration tests.
 *
 * Eliminates boilerplate for:
 * - Creating Pages Router / App Router dev servers
 * - Fetching pages and asserting on responses
 * - Static export setup
 */

import http, { type IncomingHttpHeaders } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createServer, build, type ViteDevServer } from "vite";
import vinext from "../packages/vinext/src/index.js";
import path from "node:path";

// ── Fixture paths ─────────────────────────────────────────────
export const PAGES_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-basic");
export const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-basic");
export const PAGES_I18N_DOMAINS_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/pages-i18n-domains",
);
export const PAGES_I18N_DOMAINS_BASEPATH_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/pages-i18n-domains-basepath",
);

// ── Shared RSC virtual module entries (used by @vitejs/plugin-rsc) ──
export const RSC_ENTRIES = {
  rsc: "virtual:vinext-rsc-entry",
  ssr: "virtual:vinext-app-ssr-entry",
  client: "virtual:vinext-app-browser-entry",
} as const;

// ── Server lifecycle helper ───────────────────────────────────

export interface TestServerResult {
  server: ViteDevServer;
  baseUrl: string;
}

/**
 * Start a Vite dev server against a fixture directory.
 *
 * vinext() auto-registers @vitejs/plugin-rsc when an app/ directory is
 * detected, so callers do NOT need to inject rsc() manually.
 *
 * @param fixtureDir - Path to the fixture directory
 * @param opts.listen - If false, creates server without listening (default: true)
 */
export async function startFixtureServer(
  fixtureDir: string,
  opts?: {
    appRouter?: boolean;
    listen?: boolean;
    server?: {
      host?: string;
      allowedHosts?: true | string[];
      cors?: boolean;
      port?: number;
    };
  },
): Promise<TestServerResult> {
  // vinext() auto-registers @vitejs/plugin-rsc when app/ is detected.
  // Pass appDir explicitly since tests run with configFile: false and
  // cwd may not be the fixture directory.
  // Note: opts.appRouter is accepted but unused — vinext auto-detects.
  const plugins: any[] = [vinext({ appDir: fixtureDir })];

  const server = await createServer({
    root: fixtureDir,
    configFile: false,
    plugins,
    // Vite may discover additional deps after the first request (especially
    // with @vitejs/plugin-rsc environments) and trigger a re-optimization.
    // In non-browser test clients, we can't "reload" and would otherwise
    // see Vite's "outdated pre-bundle" error responses.
    optimizeDeps: {
      holdUntilCrawlEnd: true,
    },
    server: {
      port: 0,
      cors: false,
      ...opts?.server,
    },
    logLevel: "silent",
  });

  let baseUrl = "";
  if (opts?.listen !== false) {
    await server.listen();
    const addr = server.httpServer?.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://localhost:${addr.port}`;
    }
  }

  return { server, baseUrl };
}

// ── Fetch helpers ─────────────────────────────────────────────

/**
 * Fetch a page and return both the Response and the HTML text.
 */
export async function fetchHtml(
  baseUrl: string,
  urlPath: string,
  init?: RequestInit,
): Promise<{ res: Response; html: string }> {
  const res = await fetch(`${baseUrl}${urlPath}`, init);
  const html = await res.text();
  return { res, html };
}

/**
 * Fetch a JSON endpoint and return both the Response and parsed data.
 */
export async function fetchJson(
  baseUrl: string,
  urlPath: string,
  init?: RequestInit,
): Promise<{ res: Response; data: any }> {
  const res = await fetch(`${baseUrl}${urlPath}`, init);
  const data = await res.json();
  return { res, data };
}

export interface NodeHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export async function createIsolatedFixture(
  fixtureDir: string,
  prefix: string,
  filter?: (src: string) => boolean,
  nodeModulesDir?: string,
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  // Skip node_modules during copy — we'll replace it with a symlink to either
  // the fixture's own node_modules (when it has one) or the workspace root
  // node_modules so fixtures don't need their own install.
  await fs.cp(fixtureDir, tmpDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules`) && (filter == null || filter(src)),
  });

  const resolvedNodeModules =
    nodeModulesDir ?? path.resolve(import.meta.dirname, "../node_modules");
  await fs.symlink(resolvedNodeModules, path.join(tmpDir, "node_modules"), "junction");

  return tmpDir;
}

export async function requestNodeServerWithHost(
  port: number,
  requestPath: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<NodeHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
        headers: {
          Host: host,
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Build a Pages Router fixture's SSR server bundle into a fresh tmpdir.
 *
 * Returns the path to the built bundle (`entry.js`).
 */
export async function buildPagesFixture(fixtureDir: string): Promise<string> {
  const serverOutDir = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-build-")),
    "server",
  );

  // Use disableAppRouter: true so the RSC/App Router pipeline is not activated.
  // This is required when the fixture has both app/ and pages/ directories
  // (hybrid); we only want the Pages Router SSR bundle here.
  await build({
    root: fixtureDir,
    configFile: false,
    plugins: [vinext({ disableAppRouter: true })],
    logLevel: "silent",
    build: {
      outDir: serverOutDir,
      emptyOutDir: true,
      ssr: "virtual:vinext-server-entry",
      rollupOptions: {
        output: { entryFileNames: "entry.js" },
      },
    },
  });

  return path.join(serverOutDir, "entry.js");
}

/**
 * Build an App Router fixture's RSC/SSR/client bundles into a fresh isolated
 * output directory. The fixture source stays in place — only the output lands
 * in a per-call tmpdir so sequential test suites never clobber each other.
 *
 * Returns the path to the built RSC bundle (`<tmp>/server/index.js`).
 */
export async function buildAppFixture(fixtureDir: string): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-app-build-"));

  const rscOutDir = path.join(outDir, "server");
  const ssrOutDir = path.join(outDir, "server", "ssr");
  const clientOutDir = path.join(outDir, "client");

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureDir,
    configFile: false,
    plugins: [vinext({ appDir: fixtureDir, rscOutDir, ssrOutDir, clientOutDir })],
    logLevel: "silent",
  });
  await builder.buildApp();

  // The SSR bundle externalizes React packages (react, react-dom) so that
  // Node loads them natively. When the bundle lives in a temp dir, Node can't
  // find react-dom via normal node_modules traversal. Symlink the project's
  // node_modules into the temp dir so the external imports resolve correctly.
  const projectNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  await fs.symlink(projectNodeModules, path.join(outDir, "node_modules"));

  return path.join(outDir, "server", "index.js");
}

/**
 * Build the `tests/fixtures/cf-app-basic` fixture as a Cloudflare Workers
 * bundle in-process using `createBuilder` + `@cloudflare/vite-plugin`.
 *
 * The CF plugin is loaded via a path-based import resolved from the fixture's
 * own node_modules (it is not installed at the workspace root).
 *
 * Both the App Router and Pages Router are served by the same Workers bundle —
 * there is no separate plain-Node SSR bundle for Pages Router. All prerendering
 * for both routers goes through `wrangler unstable_startWorker`.
 *
 * Returns `{ root, rscBundlePath, wranglerConfigPath }`.
 */
export async function buildCloudflareAppFixture(fixtureDir: string): Promise<{
  root: string;
  rscBundlePath: string;
  wranglerConfigPath: string;
}> {
  const tmpDir = await createIsolatedFixture(
    fixtureDir,
    "vinext-cf-build-",
    undefined,
    path.join(fixtureDir, "node_modules"),
  );
  const cfPluginPath = path.join(tmpDir, "node_modules/@cloudflare/vite-plugin/dist/index.mjs");
  const { cloudflare } = (await import(pathToFileURL(cfPluginPath).href)) as unknown as {
    cloudflare: (opts?: {
      viteEnvironment?: { name: string; childEnvironments?: string[] };
    }) => import("vite").Plugin;
  };

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: tmpDir,
    configFile: false,
    plugins: [
      vinext({ appDir: tmpDir }),
      cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
    ],
    logLevel: "silent",
  });
  await builder.buildApp();

  return {
    root: tmpDir,
    rscBundlePath: path.join(tmpDir, "dist", "server", "index.js"),
    wranglerConfigPath: path.join(tmpDir, "dist", "server", "wrangler.json"),
  };
}
