import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it, vi } from "vitest";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR } from "./helpers.js";

type BuiltAppHandler = (request: Request) => Promise<Response | string | null | undefined>;

type ClientManifestEntry = {
  imports?: string[];
  isEntry?: boolean;
  name?: string;
  src?: string;
};

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

    // Client JS should land under Next.js's canonical `_next/static/chunks/`
    // directory.
    const clientAssets = fs.readdirSync(path.join(outDir, "client", "_next", "static", "chunks"));
    expect(clientAssets.some((f: string) => f.endsWith(".js"))).toBe(true);
    const clientJs = readAllJs(path.join(outDir, "client"));

    // Ported from Next.js:
    // test/production/app-dir/browser-chunks/browser-chunks.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/production/app-dir/browser-chunks/browser-chunks.test.ts
    //
    // Dev overlay and HMR plumbing must not create a production client chunk
    // edge. Keep this list focused on symbols/module ids that only belong to
    // vinext's App Router dev overlay path.
    for (const devOnlyNeedle of [
      "dev-error-overlay",
      "vinext-dev-error-overlay",
      "installDevErrorOverlay",
      "installViteHmrErrorHandler",
      "rsc:update",
    ]) {
      expect(clientJs).not.toContain(devOnlyNeedle);
    }

    // Ported from the client-reference chunk ownership covered by Next.js:
    // test/e2e/app-dir/client-reference-chunking/client-reference-chunking.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/client-reference-chunking/client-reference-chunking.test.ts
    //
    // `next/link` is a client reference used by selected routes. It must remain
    // a lazy chunk instead of being pulled into the eager App Router bootstrap
    // by vinext's manual chunk policy.
    const clientManifest = JSON.parse(
      fs.readFileSync(path.join(outDir, "client", ".vite", "manifest.json"), "utf-8"),
    ) as Record<string, ClientManifestEntry>;
    const browserEntryKey = Object.keys(clientManifest).find(
      (key) => clientManifest[key]?.isEntry === true,
    );
    const linkEntryKey = Object.keys(clientManifest).find((key) => {
      const entry = clientManifest[key];
      const source = entry?.src?.replaceAll("\\", "/") ?? key.replaceAll("\\", "/");
      return entry?.name === "link" || /\/shims\/link\.(?:js|tsx)$/.test(source);
    });
    const serverActionClientKey = Object.keys(clientManifest).find((key) => {
      const source = clientManifest[key]?.src?.replaceAll("\\", "/") ?? key.replaceAll("\\", "/");
      return source.includes("/server/app-browser-server-action-client.");
    });
    expect(browserEntryKey).toBeDefined();
    expect(linkEntryKey).toBeDefined();
    expect(serverActionClientKey).toBeDefined();

    const eagerKeys = new Set<string>();
    const visitEagerImports = (key: string): void => {
      if (eagerKeys.has(key)) return;
      eagerKeys.add(key);
      for (const importedKey of clientManifest[key]?.imports ?? []) {
        visitEagerImports(importedKey);
      }
    };
    if (browserEntryKey) visitEagerImports(browserEntryKey);
    expect(linkEntryKey ? eagerKeys.has(linkEntryKey) : true).toBe(false);

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

  it("omits the browser server-action client when the app has no server actions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-action-free-client-"));

    try {
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
  return <p>action-free</p>;
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

      const clientDir = path.join(tmpDir, "dist", "client");
      const manifest = fs.readFileSync(path.join(clientDir, ".vite", "manifest.json"), "utf-8");
      expect(manifest).not.toContain("app-browser-server-action-client");
      expect(readAllJs(clientDir)).not.toContain("UnrecognizedActionError");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it("serves TypeScript language service from a production route handler", async () => {
    // Ported from Next.js: test/e2e/twoslash/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/twoslash/index.test.ts
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-twoslash-typescript-"));

    try {
      fs.writeFileSync(path.join(tmpDir, "package.json"), `{"type":"module"}`);
      fs.symlinkSync(
        path.resolve(import.meta.dirname, "../node_modules"),
        path.join(tmpDir, "node_modules"),
        "junction",
      );
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "app", "route.ts"),
        `import ts from "typescript";

const code = "type X = Promise<number>;\\n'hello'.toUpperCase()";

export function GET(request) {
  const compilerOptions = request.nextUrl.searchParams.has("esnext")
    ? { target: ts.ScriptTarget.ESNext, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"] }
    : {};
  const fileName = "input.ts";
  const host = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => [fileName],
    getScriptVersion: () => "0",
    getScriptSnapshot: (name) => {
      if (name === fileName) return ts.ScriptSnapshot.fromString(code);
      if (!ts.sys.fileExists(name)) return undefined;
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(name));
    },
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  };
  const service = ts.createLanguageService(host);
  const promise = service.getQuickInfoAtPosition(fileName, 9);
  const upper = service.getQuickInfoAtPosition(fileName, 34);
  return Response.json({
    defaultLib: ts.getDefaultLibFilePath(compilerOptions),
    promise: promise && ts.displayPartsToString(promise.displayParts),
    upper: upper && ts.displayPartsToString(upper.displayParts),
  });
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

      const externals = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "dist", "server", "vinext-externals.json"), "utf-8"),
      ) as string[];
      expect(externals).toContain("typescript");

      const built: { default?: unknown } = await import(
        `${pathToFileURL(path.join(tmpDir, "dist", "server", "index.js")).href}?t=${Date.now()}`
      );
      expect(isBuiltAppHandler(built.default)).toBe(true);
      if (!isBuiltAppHandler(built.default)) return;

      for (const mode of ["default", "esnext"]) {
        const response = await built.default(new Request(`http://localhost/?${mode}`));
        expect(response).toBeInstanceOf(Response);
        if (!(response instanceof Response)) return;
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          promise: "interface Promise<T>",
          upper: "(method) String.toUpperCase(): string",
        });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120000);

  it("fails the production build when proxy.ts has an invalid export", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-app-proxy-invalid-build-"));
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
        `export default function Page() { return <p>hello world</p>; }\n`,
      );
      fs.writeFileSync(path.join(tmpDir, "proxy.ts"), `export function middleware() {}\n`);

      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        logLevel: "silent",
      });
      await expect(builder.buildApp()).rejects.toThrow(
        'The file "./proxy.ts" must export a function, either as a default export or as a named "proxy" export.',
      );
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
      expect(homeHtml).toMatch(
        /<script[^>]+type="module"[^>]+src="\/_next\/static\/chunks\/[^"]+\.js"/,
      );

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

  it("emits and serves Pages client entry in hybrid builds with basePath + assetPrefix", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-hybrid-basepath-assetprefix-"));

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
  return <p>App Router</p>;
}
`,
      );
      fs.mkdirSync(path.join(tmpDir, "pages"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "pages", "legacy.tsx"),
        `export default function Legacy() {
  return <p>Pages Router</p>;
}
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "next.config.mjs"),
        `export default { basePath: "/app", assetPrefix: "/cdn" };`,
      );

      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const clientDir = path.join(tmpDir, "dist", "client");
      const clientEntryManifestPath = path.join(clientDir, "vinext-client-entry-manifest.json");
      expect(fs.existsSync(clientEntryManifestPath)).toBe(true);

      const clientEntryManifest = JSON.parse(fs.readFileSync(clientEntryManifestPath, "utf-8"));
      expect(clientEntryManifest.pagesClientEntry).toBeTruthy();
      expect(clientEntryManifest.appBrowserEntry).toBeTruthy();

      // The Pages client entry should be written under the assetPrefix path
      // (cdn/_next/static/...) because assetPrefix is a path prefix.
      const pagesEntryPath = clientEntryManifest.pagesClientEntry;
      expect(pagesEntryPath.startsWith("cdn/_next/static/")).toBe(true);
      expect(pagesEntryPath).toContain("vinext-client-entry");

      // The App browser entry should also be under the assetPrefix path
      const appEntryPath = clientEntryManifest.appBrowserEntry;
      expect(appEntryPath.startsWith("cdn/_next/static/")).toBe(true);
      expect(appEntryPath).toContain("index-");

      // Import the RSC handler and verify the baked constants
      const rscEntryPath = path.join(tmpDir, "dist", "server", "index.js");
      const rscMtime = fs.statSync(rscEntryPath).mtimeMs;
      const rscModule = await import(`${pathToFileURL(rscEntryPath).href}?t=${rscMtime}`);
      expect(rscModule.__basePath).toBe("/app");
      expect(rscModule.__assetPrefix).toBe("/cdn");
      expect(rscModule.__hasPagesDir).toBe(true);

      // Verify the RSC handler can serve the App route under basePath
      const appResponse = await rscModule.default(new Request("http://localhost/app/"));
      expect(appResponse.status).toBe(200);
      const appHtml = await appResponse.text();
      expect(appHtml).toContain("App Router");

      // The App HTML should include the App browser entry script
      // addressed through the assetPrefix (CDN) path, not basePath.
      const appScriptMatch = appHtml.match(/<script[^>]+type="module"[^>]+src="\/cdn\/[^"]+\.js"/);
      expect(appScriptMatch).toBeTruthy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120000);
});
