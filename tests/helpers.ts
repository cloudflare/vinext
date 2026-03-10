/**
 * Test helpers for vinext integration tests.
 *
 * Eliminates boilerplate for:
 * - Creating Pages Router / App Router dev servers
 * - Fetching pages and asserting on responses
 * - Static export setup
 */

import { createServer, type ViteDevServer } from "vite";
import vinext from "../packages/vinext/src/index.js";
import path from "node:path";

// ── Fixture paths ─────────────────────────────────────────────
export const PAGES_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-basic");
export const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-basic");

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
  opts?: { appRouter?: boolean; listen?: boolean },
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
    server: { port: 0, cors: false },
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
