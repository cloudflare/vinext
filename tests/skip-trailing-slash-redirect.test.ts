import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

// use-params-app-pages enables skipTrailingSlashRedirect and hosts the ported
// Pages routes under /skip-trailing-slash/ and the App routes under /with-app-dir/.
const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/use-params-app-pages");

async function startServer(
  fixtureRoot: string,
  mode: "development" | "production",
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  if (mode === "development") {
    const started = await startFixtureServer(fixtureRoot, { appRouter: true });
    return { baseUrl: started.baseUrl, close: () => started.server.close() };
  }

  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: false,
    plugins: [vinext({ appDir: fixtureRoot })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("skipTrailingSlashRedirect production fixture did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// Ported from Next.js: test/e2e/skip-trailing-slash-redirect/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/skip-trailing-slash-redirect/index.test.ts
describe.each(["development", "production"] as const)("skipTrailingSlashRedirect (%s)", (mode) => {
  let fixtureRoot: string;
  let baseUrl: string;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    fixtureRoot = await createIsolatedFixture(
      FIXTURE_DIR,
      `vinext-skip-trailing-slash-redirect-${mode}-`,
    );
    ({ baseUrl, close } = await startServer(fixtureRoot, mode));
  }, 120000);

  afterAll(async () => {
    await close?.();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  // Next.js runs these against both routers to ensure the behavior is the same.
  describe.each([
    ["pages dir", "/skip-trailing-slash/"],
    ["app dir", "/with-app-dir/"],
  ])("%s", (_name, basePath) => {
    it("should not apply trailing slash redirect (with slash)", async () => {
      const res = await fetch(`${baseUrl}${basePath}another/`, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("another page");
    });

    it("should not apply trailing slash redirect (without slash)", async () => {
      const res = await fetch(`${baseUrl}${basePath}another`, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("another page");
    });

    it("should preserve original trailing slashes in rendered links", async () => {
      const res = await fetch(`${baseUrl}${basePath}`, { redirect: "manual" });
      const html = await res.text();
      expect(html).toContain(`href="${basePath}another"`);
      expect(html).toContain(`href="${basePath}another/"`);
    });

    it("should keep the request's trailing slash on middleware's nextUrl", async () => {
      for (const pathname of [`${basePath}another/`, `${basePath}another`]) {
        const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
        expect(res.status, pathname).toBe(200);
        expect(res.headers.get("x-next-url-pathname"), pathname).toBe(pathname);
      }
    });

    it("should respond to index correctly", async () => {
      const res = await fetch(`${baseUrl}${basePath}`, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("index page");
    });

    it("should respond to dynamic route correctly", async () => {
      const res = await fetch(`${baseUrl}${basePath}blog/first`, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("blog page");
    });
  });

  // Next.js's NextURL takes the slash from the request pathname
  // (getNextPathnameInfo), so handlers see the form the request arrived in.
  it.each([
    ["app route handler", "/with-app-dir/route-url"],
    ["pages edge API route", "/api/edge-url"],
  ])("should keep the request's trailing slash in a %s", async (_name, route) => {
    for (const pathname of [`${route}/`, route]) {
      const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
      expect(res.status, pathname).toBe(200);
      await expect(res.json(), pathname).resolves.toEqual({ url: pathname, nextUrl: pathname });
    }
  });

  it("should apply config redirect correctly", async () => {
    const res = await fetch(`${baseUrl}/skip-trailing-slash/redirect-me`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "", "http://n").pathname).toBe(
      "/skip-trailing-slash/another",
    );
  });

  it("should keep middleware redirect trailing slashes", async () => {
    for (const [source, destination] of [
      ["/skip-trailing-slash/middleware-redirect-with", "/skip-trailing-slash/another/"],
      ["/skip-trailing-slash/middleware-redirect-without", "/skip-trailing-slash/another"],
    ]) {
      const res = await fetch(`${baseUrl}${source}`, { redirect: "manual" });
      expect(res.status, source).toBe(307);
      expect(new URL(res.headers.get("location") ?? "", "http://n").pathname, source).toBe(
        destination,
      );
    }
  });

  it("should apply config rewrites correctly", async () => {
    const res = await fetch(`${baseUrl}/skip-trailing-slash/rewrite-me`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("another page");
  });
});
