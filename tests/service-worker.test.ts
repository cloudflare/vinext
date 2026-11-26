// `navigator.serviceWorker.register(new URL(..., import.meta.url))` support.
// Ported from Next.js:
// test/e2e/app-dir/service-worker/service-worker-register.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/service-worker/service-worker-register.test.ts
// test/e2e/app-dir/service-worker-scopes/service-worker-scopes.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/service-worker-scopes/service-worker-scopes.test.ts
// test/e2e/app-dir/service-worker-multiple/service-worker-multiple.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/service-worker-multiple/service-worker-multiple.test.ts
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { createBuilder, createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  analyzeServiceWorkerCalls,
  serviceWorkerFileName,
  serviceWorkerRegisterArguments,
} from "../packages/vinext/src/plugins/service-worker.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-service-worker");
const CONFLICT_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/app-service-worker-conflict",
);

function rewrite(code: string, basePath = ""): string {
  const { calls } = analyzeServiceWorkerCalls(code, "/app/page.js");
  let output = code;
  for (const call of [...calls].reverse()) {
    output =
      output.slice(0, call.argsStart) +
      serviceWorkerRegisterArguments(code, call, basePath) +
      output.slice(call.argsEnd);
  }
  return output;
}

describe("service worker register() analysis", () => {
  it("serves the root scope at sw.js and other scopes at scope-derived names", () => {
    expect(serviceWorkerFileName("/")).toBe("sw.js");
    expect(serviceWorkerFileName("/offline/mode")).toMatch(/^sw-offline-mode-[0-9a-f]{16}\.js$/);
    // The slug is lossy, so the hash keeps distinct scopes apart.
    expect(serviceWorkerFileName("/foo/bar")).not.toBe(serviceWorkerFileName("/foo-bar"));
  });

  it("rewrites the script URL and pins the scope, keeping the user's options", () => {
    expect(
      rewrite(
        `navigator.serviceWorker.register(new URL("../lib/pwa", import.meta.url), { updateViaCache: "none" })`,
      ),
    ).toBe(
      `navigator.serviceWorker.register("/_next/static/service-worker/sw.js", ({ ...{ updateViaCache: "none" }, scope: "/" }))`,
    );
    expect(rewrite(`navigator.serviceWorker.register(new URL("./sw", import.meta.url))`)).toBe(
      `navigator.serviceWorker.register("/_next/static/service-worker/sw.js", ({ scope: "/" }))`,
    );
  });

  it("prefixes the script URL and scope with basePath", () => {
    expect(
      rewrite(`navigator.serviceWorker.register(new URL("./sw", import.meta.url))`, "/base"),
    ).toBe(
      `navigator.serviceWorker.register("/base/_next/static/service-worker/sw.js", ({ scope: "/base" }))`,
    );
    const nested = rewrite(
      `navigator.serviceWorker.register(new URL("./sw", import.meta.url), { scope: "/offline" })`,
      "/base",
    );
    expect(nested).toContain(
      `"/base/_next/static/service-worker/${serviceWorkerFileName("/offline")}"`,
    );
    expect(nested).toContain(`scope: "/base/offline"`);
  });

  it("registers a non-object options argument at the default scope", () => {
    expect(
      rewrite(`navigator.serviceWorker.register(new URL("./sw", import.meta.url), options)`),
    ).toBe(
      `navigator.serviceWorker.register("/_next/static/service-worker/sw.js", ({ ...options, scope: "/" }))`,
    );
  });

  it("leaves calls with a relative or dynamic scope untouched and warns", () => {
    const relative = analyzeServiceWorkerCalls(
      `navigator.serviceWorker.register(new URL("./sw", import.meta.url), { scope: "offline" })`,
      "/app/page.js",
    );
    expect(relative.calls).toEqual([]);
    expect(relative.warnings[0]).toContain("does not start with `/`");

    const dynamic = analyzeServiceWorkerCalls(
      `navigator.serviceWorker.register(new URL("./sw", import.meta.url), { scope: getScope() })`,
      "/app/page.js",
    );
    expect(dynamic.calls).toEqual([]);
    expect(dynamic.warnings[0]).toContain("not statically analyze-able");
  });

  it("ignores registrations that do not name a worker module", () => {
    for (const code of [
      `navigator.serviceWorker.register("/sw.js")`,
      `navigator.serviceWorker.register(new URL("https://example.com/sw.js", import.meta.url))`,
      `navigator.serviceWorker.register(new URL(name, import.meta.url))`,
      `other.serviceWorker.register(new URL("./sw", import.meta.url))`,
    ]) {
      expect(analyzeServiceWorkerCalls(code, "/app/page.js").calls).toEqual([]);
    }
  });
});

describe("service worker production build", () => {
  let fixtureDir = "";
  let baseUrl = "";
  let server: Server | undefined;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_DIR, "vinext-service-worker-");
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      outDir: path.join(fixtureDir, "dist"),
      noCompression: true,
    }));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }, 120_000);

  afterAll(() => {
    server?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("compiles each worker into one self-contained script per scope", () => {
    const workerDir = path.join(fixtureDir, "dist", "client", "_next", "static", "service-worker");
    const offlineFile = serviceWorkerFileName("/offline/mode");
    expect(fs.readdirSync(workerDir).sort()).toEqual([offlineFile, "sw.js"].sort());

    const worker = fs.readFileSync(path.join(workerDir, "sw.js"), "utf8");
    // The imported module is bundled in, and the classic script loads nothing.
    expect(worker).toContain("intercepted-by-vinext-sw");
    expect(worker).not.toMatch(/^\s*(?:import|export)\b/m);
    expect(worker).toContain("addEventListener");
  });

  it("rewrites the registering client module", () => {
    const chunksDir = path.join(fixtureDir, "dist", "client", "_next", "static");
    const clientCode = fs
      .readdirSync(chunksDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
      .find((code) => code.includes("/_next/static/service-worker/sw.js"));
    expect(clientCode).toBeDefined();
    expect(clientCode).toContain(
      `/_next/static/service-worker/${serviceWorkerFileName("/offline/mode")}`,
    );
    expect(clientCode).toMatch(/updateViaCache:\s*["'`]none["'`]/);
    expect(clientCode).toMatch(/scope:\s*["'`]\/offline\/mode["'`]/);
    // The raw worker source is no longer emitted as an asset.
    expect(clientCode).not.toMatch(/pwa[-.][\w-]+\.ts/);
  });

  it("serves the worker as a revalidated, mutable asset with Service-Worker-Allowed", async () => {
    const response = await fetch(`${baseUrl}/_next/static/service-worker/sw.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("service-worker-allowed")).toBe("/");
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();

    const conditional = await fetch(`${baseUrl}/_next/static/service-worker/sw.js`, {
      headers: { "If-None-Match": etag! },
      // undici sends `Cache-Control: no-cache` with conditional headers
      // unless told otherwise, which defeats the ETag check.
      cache: "force-cache",
    });
    expect(conditional.status).toBe(304);

    const offline = await fetch(
      `${baseUrl}/_next/static/service-worker/${serviceWorkerFileName("/offline/mode")}`,
    );
    expect(offline.status).toBe(200);
    expect(offline.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });
});

describe("service worker dev server", () => {
  let fixtureDir = "";
  let server: ViteDevServer | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_DIR, "vinext-service-worker-dev-");
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    server = await createServer({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
      server: { port: 0 },
    });
    await server.listen();
    baseUrl = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("serves the registered worker bundle with the service worker headers", async () => {
    const page = await server!.environments.client.transformRequest("/app/page.tsx");
    expect(page?.code).toContain(`"/_next/static/service-worker/sw.js"`);

    const response = await fetch(`${baseUrl}/_next/static/service-worker/sw.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("service-worker-allowed")).toBe("/");
    const body = await response.text();
    expect(body).toContain("intercepted-by-vinext-sw");
    expect(body).not.toMatch(/^\s*(?:import|export)\b/m);

    const conditional = await fetch(`${baseUrl}/_next/static/service-worker/sw.js`, {
      headers: { "If-None-Match": response.headers.get("etag")! },
      cache: "force-cache",
    });
    expect(conditional.status).toBe(304);
  });
});

describe("conflicting service worker registrations", () => {
  let fixtureDir = "";

  afterAll(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("fails the build when different workers register for the same scope", async () => {
    fixtureDir = await createIsolatedFixture(
      CONFLICT_FIXTURE_DIR,
      "vinext-service-worker-conflict-",
    );
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await expect(builder.buildApp()).rejects.toThrow(
      /Multiple service workers with different source files were registered for scope '\/'/,
    );
  }, 120_000);
});
