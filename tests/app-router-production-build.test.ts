import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it, vi } from "vitest";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR } from "./helpers.js";

type BuiltAppHandler = (request: Request) => Promise<Response | string | null | undefined>;

function isBuiltAppHandler(value: unknown): value is BuiltAppHandler {
  return typeof value === "function";
}

/** Concatenate every `.js` file under `dir` (recursively) for substring checks. */
function readAllJs(dir: string): string {
  let out = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out += readAllJs(full);
    else if (entry.name.endsWith(".js")) out += fs.readFileSync(full, "utf-8");
  }
  return out;
}

describe("App Router Production build", () => {
  const outDir = path.resolve(APP_FIXTURE_DIR, "dist");

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("produces RSC/SSR/client bundles via vite build", async () => {
    const builder = await createBuilder({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: APP_FIXTURE_DIR })],
      logLevel: "silent",
    });
    await builder.buildApp();

    // RSC entry should exist (at dist/server/index.js)
    expect(fs.existsSync(path.join(outDir, "server", "index.js"))).toBe(true);
    // SSR entry should exist (at dist/server/ssr/index.js)
    expect(fs.existsSync(path.join(outDir, "server", "ssr", "index.js"))).toBe(true);
    // Client bundle should exist
    expect(fs.existsSync(path.join(outDir, "client"))).toBe(true);

    // Client should have hashed JS assets under Next.js's canonical
    // `_next/static/` directory (matches `resolveAssetsDir("")`).
    const clientAssets = fs.readdirSync(path.join(outDir, "client", "_next", "static"));
    expect(clientAssets.some((f: string) => f.endsWith(".js"))).toBe(true);

    // RSC bundle should contain route handling code
    const rscEntry = fs.readFileSync(path.join(outDir, "server", "index.js"), "utf-8");
    expect(rscEntry).toContain("handler");

    // Asset manifest should be generated
    expect(fs.existsSync(path.join(outDir, "server", "__vite_rsc_assets_manifest.js"))).toBe(true);

    // BUILD_ID must be written to dist/server so post-build tools (TPR,
    // seed-cache) and the e2e deploy harness can read the build identifier
    // without parsing the (minified) server bundle. Regression guard: the
    // vinext:build-id plugin previously used closeBundle, which does not fire
    // during the multi-environment buildApp() pipeline, so the file was
    // silently never written for pure App Router apps.
    const buildIdPath = path.join(outDir, "server", "BUILD_ID");
    expect(fs.existsSync(buildIdPath)).toBe(true);
    expect(fs.readFileSync(buildIdPath, "utf-8").trim().length).toBeGreaterThan(0);
  }, 30000);

  it("adopts __VINEXT_SHARED_BUILD_ID so the runtime and BUILD_ID file agree", async () => {
    // The `vinext build` CLI resolves the build ID once and shares it via
    // __VINEXT_SHARED_BUILD_ID so that every plugin instance in a build (App
    // Router buildApp + the separate hybrid Pages Router vite.build) uses the
    // same ID. Without it, each instance mints its own random UUID and the
    // runtime buildId, prerender manifest, and dist/server/BUILD_ID diverge.
    const sharedBuildId = "shared-test-build-id-1234";
    const previous = process.env.__VINEXT_SHARED_BUILD_ID;
    process.env.__VINEXT_SHARED_BUILD_ID = sharedBuildId;
    try {
      const builder = await createBuilder({
        root: APP_FIXTURE_DIR,
        configFile: false,
        plugins: [vinext({ appDir: APP_FIXTURE_DIR })],
        logLevel: "silent",
      });
      await builder.buildApp();

      // The emitted BUILD_ID file uses the shared ID.
      expect(fs.readFileSync(path.join(outDir, "server", "BUILD_ID"), "utf-8").trim()).toBe(
        sharedBuildId,
      );
      // The shared ID is baked into the App Router runtime bundle (the value
      // process.env.__VINEXT_BUILD_ID is defined as), so cache keys and data
      // routes line up with the BUILD_ID file.
      const rscEntry = fs.readFileSync(path.join(outDir, "server", "index.js"), "utf-8");
      expect(rscEntry).toContain(sharedBuildId);
    } finally {
      if (previous === undefined) delete process.env.__VINEXT_SHARED_BUILD_ID;
      else process.env.__VINEXT_SHARED_BUILD_ID = previous;
    }
  }, 30000);

  it("adopts the shared build ID even when generateBuildId is set", async () => {
    // The shared ID must win over a per-instance generateBuildId, because the
    // CLI already resolved it through the user's generateBuildId once. A
    // non-deterministic generateBuildId (e.g. returning null → a fresh random
    // UUID per instance, per resolveBuildId()) would otherwise re-diverge across
    // the buildApp() and hybrid Pages vite.build() instances — the exact bug
    // this coordination exists to prevent.
    const sharedBuildId = "shared-wins-over-generate-5678";
    const previous = process.env.__VINEXT_SHARED_BUILD_ID;
    process.env.__VINEXT_SHARED_BUILD_ID = sharedBuildId;
    try {
      const builder = await createBuilder({
        root: APP_FIXTURE_DIR,
        configFile: false,
        // generateBuildId returning null falls back to a random UUID per
        // instance; the shared ID must still be adopted.
        plugins: [vinext({ appDir: APP_FIXTURE_DIR, nextConfig: { generateBuildId: () => null } })],
        logLevel: "silent",
      });
      await builder.buildApp();

      expect(fs.readFileSync(path.join(outDir, "server", "BUILD_ID"), "utf-8").trim()).toBe(
        sharedBuildId,
      );
      const rscEntry = fs.readFileSync(path.join(outDir, "server", "index.js"), "utf-8");
      expect(rscEntry).toContain(sharedBuildId);
    } finally {
      if (previous === undefined) delete process.env.__VINEXT_SHARED_BUILD_ID;
      else process.env.__VINEXT_SHARED_BUILD_ID = previous;
    }
  }, 30000);

  it("adopts __VINEXT_SHARED_RSC_COMPATIBILITY_ID across the App Router build", async () => {
    // Companion to the build-ID coordination: createRscCompatibilityId() mints a
    // random UUID per plugin instance when no deploymentId is pinned, so a hybrid
    // app+pages build would otherwise bake two different RSC-compat tokens. The
    // CLI resolves it once and shares it via __VINEXT_SHARED_RSC_COMPATIBILITY_ID;
    // the plugin always adopts it when set. Both the App Router server bundle and
    // the client bundle (which compares its baked token against the server's
    // X-Vinext-RSC-Compatibility-Id header) must carry the shared value.
    const sharedCompatId = "shared-rsc-compat-id-9012";
    const previous = process.env.__VINEXT_SHARED_RSC_COMPATIBILITY_ID;
    process.env.__VINEXT_SHARED_RSC_COMPATIBILITY_ID = sharedCompatId;
    try {
      const builder = await createBuilder({
        root: APP_FIXTURE_DIR,
        configFile: false,
        plugins: [vinext({ appDir: APP_FIXTURE_DIR })],
        logLevel: "silent",
      });
      await builder.buildApp();

      // The compat token is baked via Vite `define`; depending on chunking it
      // can land in the RSC entry or a shared server/client chunk, so scan the
      // whole server and client output trees. Both sides must carry the same
      // adopted token — that is what lets the client reject mismatched RSC
      // payloads (the X-Vinext-RSC-Compatibility-Id header check).
      expect(readAllJs(path.join(outDir, "server"))).toContain(sharedCompatId);
      expect(readAllJs(path.join(outDir, "client"))).toContain(sharedCompatId);
    } finally {
      if (previous === undefined) delete process.env.__VINEXT_SHARED_RSC_COMPATIBILITY_ID;
      else process.env.__VINEXT_SHARED_RSC_COMPATIBILITY_ID = previous;
    }
  }, 30000);

  it("builds proxy.ts that reads __filename before redirecting", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/proxy-nfc-traced/proxy-nfc-traced.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/proxy-nfc-traced/proxy-nfc-traced.test.ts
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-proxy-cjs-globals-"));

    try {
      fs.writeFileSync(path.join(tmpDir, "package.json"), `{"type":"module"}`);
      fs.symlinkSync(
        path.resolve(import.meta.dirname, "../node_modules"),
        path.join(tmpDir, "node_modules"),
        "junction",
      );
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "app", "layout.tsx"),
        `export default function Root({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "app", "page.tsx"),
        `export default function Page() {
  return <p>hello world</p>;
}
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "proxy.ts"),
        `import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export default function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/home") {
    return NextResponse.redirect(new URL("/", request.url));
  }
  console.log(__filename);
  return NextResponse.next();
}
`,
      );

      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const built: { default?: unknown } = await import(
        pathToFileURL(path.join(tmpDir, "dist", "server", "index.js")).href
      );
      expect(isBuiltAppHandler(built.default)).toBe(true);
      if (!isBuiltAppHandler(built.default)) return;

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const redirectResponse = await built.default(new Request("http://localhost/home"));
        expect(redirectResponse).toBeInstanceOf(Response);
        if (!(redirectResponse instanceof Response)) return;
        expect(redirectResponse.status).toBe(307);
        expect(redirectResponse.headers.get("location")).toBe("/");

        const rootResponse = await built.default(new Request("http://localhost/"));
        expect(rootResponse).toBeInstanceOf(Response);
        if (!(rootResponse instanceof Response)) return;
        expect(await rootResponse.text()).toContain("hello world");
        expect(logSpy).toHaveBeenCalledWith(fs.realpathSync.native(path.join(tmpDir, "proxy.ts")));
      } finally {
        logSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120000);

  it("serves production build via preview server", async () => {
    const { preview } = await import("vite");

    const previewServer = await preview({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: APP_FIXTURE_DIR })],
      preview: { port: 0 },
      logLevel: "silent",
    });

    const addr = previewServer.httpServer.address();
    const previewUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : null;
    expect(previewUrl).not.toBeNull();

    try {
      // Home page renders SSR HTML
      const homeRes = await fetch(`${previewUrl}/`);
      expect(homeRes.status).toBe(200);
      const homeHtml = await homeRes.text();
      expect(homeHtml).toContain("Welcome to App Router");
      expect(homeHtml).toContain("<script");
      // Production bootstrap is emitted as a real <script type="module" src=…>
      // tag (via React's bootstrapModules option) referencing hashed assets.
      expect(homeHtml).toMatch(/<script[^>]+type="module"[^>]+src="\/_next\/static\/[^"]+\.js"/);

      // Dynamic route works
      const blogRes = await fetch(`${previewUrl}/blog/test-post`);
      expect(blogRes.status).toBe(200);
      const blogHtml = await blogRes.text();
      expect(blogHtml).toContain("Blog Post");
      expect(blogHtml).toContain("test-post");

      // Nested layout works
      const dashRes = await fetch(`${previewUrl}/dashboard`);
      expect(dashRes.status).toBe(200);
      const dashHtml = await dashRes.text();
      expect(dashHtml).toContain("Dashboard");
      expect(dashHtml).toContain("dashboard-layout");

      // 404 for nonexistent routes
      const notFoundRes = await fetch(`${previewUrl}/no-such-page`);
      expect(notFoundRes.status).toBe(404);

      // RSC endpoint works
      const rscRes = await fetch(`${previewUrl}/about.rsc`);
      expect(rscRes.status).toBe(200);
      expect(rscRes.headers.get("content-type")).toContain("text/x-component");
    } finally {
      previewServer.httpServer.close();
    }
  }, 30000);
});
