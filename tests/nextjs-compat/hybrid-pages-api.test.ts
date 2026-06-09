/**
 * Next.js Compatibility Tests: hybrid App Router + Pages Router API routes
 *
 * Regression coverage for #1520.
 *
 * When an App Router app (`app/`) coexists with Pages Router API endpoints
 * (`pages/api/*`), requests to the Pages API routes must execute the handler
 * and return its JSON response — not fall through to the App Router not-found
 * page.
 *
 * The deploy suite hit this against `test/e2e/app-dir/app-middleware`, where
 * `/api/dump-headers-serverless` returned the HTML "This page could not be
 * found" page instead of JSON.
 *
 * This test exercises the production (Cloudflare Workers) build path via the
 * Node prod server, which is the same dispatch path the deploy suite uses.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import path from "node:path";
import type { Server } from "node:http";
import { buildCloudflareAppFixture } from "../helpers.js";
import { startProdServer } from "../../packages/vinext/src/server/prod-server.js";

const CF_FIXTURE = path.resolve(import.meta.dirname, "../fixtures/cf-app-basic");

describe("Next.js compat: hybrid app/ + pages/api/*", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { root } = await buildCloudflareAppFixture(CF_FIXTURE);
    const outDir = path.join(root, "dist");
    const handle = await startProdServer({ port: 0, host: "127.0.0.1", outDir });
    server = handle.server;
    baseUrl = `http://127.0.0.1:${handle.port}`;
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("executes pages/api/* route and returns JSON in a hybrid app", async () => {
    const res = await fetch(`${baseUrl}/api/ping`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("still serves the App Router route handler in the same app", async () => {
    const res = await fetch(`${baseUrl}/api/hello`);
    expect(res.status).toBe(200);
  });

  it("passes middleware-mutated request headers into pages/api/*", async () => {
    const res = await fetch(`${baseUrl}/api/dump-headers`, {
      headers: { "x-from-client": "hello-from-client" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({
      "x-from-client": "hello-from-client",
      "x-from-middleware": "hello-from-middleware",
    });
  });

  it("passes middleware-mutated request headers into edge-runtime pages/api/*", async () => {
    const res = await fetch(`${baseUrl}/api/dump-headers-edge`, {
      headers: { "x-from-client": "hello-from-client" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({
      "x-from-client": "hello-from-client",
      "x-from-middleware": "hello-from-middleware",
    });
  });

  it("supports draft mode enabled in middleware for a pages/api/* request", async () => {
    const res = await fetch(`${baseUrl}/api/dump-headers?draft=true`);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("__prerender_bypass");
  });
});
