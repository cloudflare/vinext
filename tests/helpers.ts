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
import { createServer, type ViteDevServer } from "vite-plus";
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
  filter?: (src: string, dest: string) => boolean,
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.cp(fixtureDir, tmpDir, { recursive: true, filter });

  const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

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
