/**
 * `assetPrefix` integration tests.
 *
 * Mirrors Next.js's `assetPrefix` behaviour:
 *  - Path prefix (e.g. `/custom-asset-prefix`): every emitted script/CSS URL
 *    starts with that prefix and lives under `_next/static/` to match
 *    Next.js's URL convention. Fetching those URLs from the prod server
 *    must succeed.
 *  - Absolute URL (e.g. `https://cdn.example.com`): emitted URLs are fully
 *    qualified — runtime serving on the deployment origin is a no-op.
 *  - Combined with `basePath`: routes stay under `basePath`, assets under
 *    `assetPrefix`. They are independent.
 *  - Unset (default): URLs continue to live under `/assets/` for backward
 *    compatibility.
 *
 * Ported from Next.js: test/e2e/app-dir/asset-prefix/asset-prefix.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/asset-prefix/asset-prefix.test.ts
 *
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/assetPrefix
 */

import { describe, it, expect, afterAll } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import {
  isAbsoluteAssetPrefix,
  resolveAssetUrlPrefix,
  resolveAssetsDir,
  assetPrefixPathname,
  ASSET_PREFIX_URL_DIR,
} from "../packages/vinext/src/utils/asset-prefix.js";
import { resolveAppRouterAssetPath } from "../packages/vinext/src/server/prod-server.js";
import { normalizeAssetPrefix } from "../packages/vinext/src/config/next-config.js";

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-basic");
const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

// ── Unit tests on the asset-prefix helpers ────────────────────────────────────

describe("normalizeAssetPrefix", () => {
  it("returns an empty string when unset, null, or empty", () => {
    expect(normalizeAssetPrefix(undefined)).toBe("");
    expect(normalizeAssetPrefix(null)).toBe("");
    expect(normalizeAssetPrefix("")).toBe("");
    expect(normalizeAssetPrefix("   ")).toBe("");
  });

  it("trims trailing slashes and preserves a path prefix", () => {
    expect(normalizeAssetPrefix("/cdn")).toBe("/cdn");
    expect(normalizeAssetPrefix("/cdn/")).toBe("/cdn");
    expect(normalizeAssetPrefix("/cdn//")).toBe("/cdn");
    expect(normalizeAssetPrefix("/custom-asset-prefix")).toBe("/custom-asset-prefix");
  });

  it("adds a leading slash to bare path prefixes", () => {
    // Next.js accepts both `cdn` and `/cdn`; normalize to the leading-slash form.
    expect(normalizeAssetPrefix("cdn")).toBe("/cdn");
  });

  it("preserves absolute URLs verbatim (sans trailing slash)", () => {
    expect(normalizeAssetPrefix("https://cdn.example.com")).toBe("https://cdn.example.com");
    expect(normalizeAssetPrefix("https://cdn.example.com/")).toBe("https://cdn.example.com");
    expect(normalizeAssetPrefix("https://cdn.example.com/sub")).toBe("https://cdn.example.com/sub");
    expect(normalizeAssetPrefix("HTTP://cdn.example.com")).toBe("HTTP://cdn.example.com");
  });

  it("throws on non-string values to surface config typos early", () => {
    expect(() => normalizeAssetPrefix(42 as unknown as string)).toThrow(/must be a string/);
    expect(() => normalizeAssetPrefix({} as unknown as string)).toThrow(/must be a string/);
  });

  it("throws on unparseable absolute URLs", () => {
    // A URL that begins with the http(s) scheme but cannot be parsed —
    // the colon-only host triggers `URL.canParse` to return false.
    expect(() => normalizeAssetPrefix("https://:::")).toThrow(/parseable URL/);
  });
});

describe("isAbsoluteAssetPrefix", () => {
  it("is true for http/https URLs and false for path prefixes or empty", () => {
    expect(isAbsoluteAssetPrefix("https://cdn.example.com")).toBe(true);
    expect(isAbsoluteAssetPrefix("http://cdn.example.com")).toBe(true);
    expect(isAbsoluteAssetPrefix("HTTPS://cdn.example.com")).toBe(true);
    expect(isAbsoluteAssetPrefix("/custom-asset-prefix")).toBe(false);
    expect(isAbsoluteAssetPrefix("")).toBe(false);
  });
});

describe("resolveAssetsDir", () => {
  it("keeps the historical `assets/` default when no prefix is configured", () => {
    expect(resolveAssetsDir("")).toBe("assets");
  });

  it("returns `<prefix>/_next/static` for path prefixes so disk and URL align", () => {
    expect(resolveAssetsDir("/custom-asset-prefix")).toBe("custom-asset-prefix/_next/static");
    expect(resolveAssetsDir("/cdn")).toBe(`cdn/${ASSET_PREFIX_URL_DIR}`);
  });

  it("returns `_next/static` for absolute-URL prefixes — the CDN owns the URL prefix", () => {
    expect(resolveAssetsDir("https://cdn.example.com")).toBe(ASSET_PREFIX_URL_DIR);
    expect(resolveAssetsDir("https://cdn.example.com/sub")).toBe(ASSET_PREFIX_URL_DIR);
  });
});

describe("resolveAssetUrlPrefix", () => {
  it("returns `/_next/static/` when no prefix is configured", () => {
    expect(resolveAssetUrlPrefix("")).toBe("/_next/static/");
  });

  it("concatenates the prefix with the static dir for path prefixes", () => {
    expect(resolveAssetUrlPrefix("/cdn")).toBe("/cdn/_next/static/");
    expect(resolveAssetUrlPrefix("/custom-asset-prefix")).toBe(
      "/custom-asset-prefix/_next/static/",
    );
  });

  it("preserves the full URL for absolute-URL prefixes", () => {
    expect(resolveAssetUrlPrefix("https://cdn.example.com")).toBe(
      "https://cdn.example.com/_next/static/",
    );
    expect(resolveAssetUrlPrefix("https://cdn.example.com/sub")).toBe(
      "https://cdn.example.com/sub/_next/static/",
    );
  });
});

describe("assetPrefixPathname", () => {
  it("returns empty for unset prefix and absolute URLs without a path component", () => {
    expect(assetPrefixPathname("")).toBe("");
    expect(assetPrefixPathname("https://cdn.example.com")).toBe("");
    expect(assetPrefixPathname("https://cdn.example.com/")).toBe("");
  });

  it("returns the path component for path-prefix and pathful URL prefixes", () => {
    expect(assetPrefixPathname("/custom-asset-prefix")).toBe("/custom-asset-prefix");
    expect(assetPrefixPathname("https://cdn.example.com/sub")).toBe("/sub");
  });
});

describe("resolveAppRouterAssetPath", () => {
  it("falls back to /assets/ when no prefix is configured", () => {
    expect(resolveAppRouterAssetPath("/assets/foo-abc.js", "", "")).toBe("/assets/foo-abc.js");
    expect(resolveAppRouterAssetPath("/about", "", "")).toBeNull();
  });

  it("recognises `<prefix>/_next/static/<file>` for path-prefix configs", () => {
    expect(
      resolveAppRouterAssetPath(
        "/custom-asset-prefix/_next/static/foo-abc.js",
        "/custom-asset-prefix",
        "/custom-asset-prefix",
      ),
    ).toBe("/custom-asset-prefix/_next/static/foo-abc.js");
  });

  it("strips the path component for absolute-URL prefixes with a path", () => {
    // Disk layout for absolute-URL prefixes is `_next/static/...` (no
    // extra prefix dir on disk), so a same-origin proxy that forwards the
    // full URL path lands on the right file once the URL prefix is stripped.
    expect(
      resolveAppRouterAssetPath(
        "/sub/_next/static/foo-abc.js",
        "/sub",
        "https://cdn.example.com/sub",
      ),
    ).toBe("/_next/static/foo-abc.js");
  });

  it("accepts `/_next/static/<file>` for absolute-URL prefixes without a path", () => {
    expect(
      resolveAppRouterAssetPath("/_next/static/foo-abc.js", "", "https://cdn.example.com"),
    ).toBe("/_next/static/foo-abc.js");
  });

  it("returns null for unrelated paths when a prefix is configured", () => {
    expect(
      resolveAppRouterAssetPath(
        "/some-other-path/foo.js",
        "/custom-asset-prefix",
        "/custom-asset-prefix",
      ),
    ).toBeNull();
  });

  it("keeps the historical /assets/ branch working alongside an asset prefix", () => {
    // Backward compatibility: a project that turns on assetPrefix and still
    // has plugins emitting under /assets/ (e.g. legacy outputs) should keep
    // working in the same server process.
    expect(
      resolveAppRouterAssetPath(
        "/assets/foo-abc.js",
        "/custom-asset-prefix",
        "/custom-asset-prefix",
      ),
    ).toBe("/assets/foo-abc.js");
  });
});

// ── End-to-end build tests ────────────────────────────────────────────────────

/**
 * Build the app-basic fixture into an isolated tmp dir, optionally patching
 * `next.config.ts` with extra config keys.
 *
 * The fixture is copied so tests can mutate next.config.ts independently
 * without polluting each other or the shared on-disk fixture. node_modules
 * is symlinked to the workspace root to avoid a real install.
 *
 * `registerCleanup` is invoked synchronously right after `mkdtempSync` so
 * the tmp dir is always tracked, even if `createBuilder` or `buildApp`
 * throws before this function returns.
 */
async function buildFixtureWithConfig(
  extraConfigJson: string,
  registerCleanup: (cleanup: () => void) => void,
): Promise<{
  fixtureRoot: string;
  outDir: string;
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-asset-prefix-"));
  // Register the cleanup BEFORE any work that can throw. If the copy/symlink/
  // build step fails, the afterAll hook still removes the tmp dir.
  registerCleanup(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const fixtureRoot = path.join(tmpDir, "fixture");
  fs.cpSync(APP_FIXTURE_DIR, fixtureRoot, { recursive: true });
  // Symlink the workspace node_modules so the fixture can resolve React,
  // vinext, and @vitejs/plugin-rsc.
  const fixtureNodeModules = path.join(fixtureRoot, "node_modules");
  if (!fs.existsSync(fixtureNodeModules)) {
    fs.symlinkSync(ROOT_NODE_MODULES, fixtureNodeModules, "junction");
  }

  // Patch next.config.ts to add the extra keys. We splice them in right after
  // the opening `{` to avoid clobbering the existing async functions.
  const nextConfigPath = path.join(fixtureRoot, "next.config.ts");
  const original = fs.readFileSync(nextConfigPath, "utf-8");
  const patched = original.replace(
    "const nextConfig: NextConfig = {",
    `const nextConfig: NextConfig = {\n  ${extraConfigJson}`,
  );
  fs.writeFileSync(nextConfigPath, patched);

  const outDir = path.join(fixtureRoot, "dist");

  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: false,
    plugins: [vinext({ appDir: fixtureRoot })],
    logLevel: "silent",
  });
  await builder.buildApp();

  return { fixtureRoot, outDir };
}

describe("assetPrefix end-to-end build", () => {
  // Track tmp dirs so we can clean up even if a build throws. `cleanups` is
  // populated by `buildFixtureWithConfig` synchronously right after the tmp
  // dir is created, so a thrown `createBuilder`/`buildApp` still leaves the
  // tmp dir registered for the afterAll teardown.
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const c of cleanups) c();
  });
  const register = (cleanup: () => void) => cleanups.push(cleanup);

  it("path-prefix: emits assets under <prefix>/_next/static/ on disk and in HTML", async () => {
    const built = await buildFixtureWithConfig(`assetPrefix: "/custom-asset-prefix",`, register);

    // Files land on disk where the URLs say they should — Cloudflare's
    // ASSETS binding (and any static file server) can serve them directly
    // without a runtime rewrite.
    const onDiskStatic = path.join(
      built.outDir,
      "client",
      "custom-asset-prefix",
      "_next",
      "static",
    );
    expect(fs.existsSync(onDiskStatic), `expected on-disk layout under ${onDiskStatic}`).toBe(true);
    const entries = fs.readdirSync(onDiskStatic);
    expect(entries.some((f) => f.endsWith(".js"))).toBe(true);

    // Serve the build via startProdServer and verify SSR HTML references
    // the assetPrefix-anchored URLs, and that those URLs return 200.
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      outDir: built.outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;

      const homeRes = await fetch(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      const html = await homeRes.text();
      // Helpful when this test starts to drift — uncomment to inspect HTML.
      // console.log("--- HTML ---\n" + html + "\n--- /HTML ---");

      // Bootstrap script URL must be prefixed AND live under _next/static.
      // Mirrors the Next.js fixture assertion:
      //   src?.includes('/custom-asset-prefix/_next/static') ||
      //   src?.includes('/custom-asset-prefix/_next/static/immutable')
      const bootstrapMatch = html.match(/import\("([^"]+\.js)"\)/);
      expect(
        bootstrapMatch,
        "expected a bootstrap `import(...)` script in the HTML",
      ).not.toBeNull();
      expect(bootstrapMatch![1]).toMatch(/^\/custom-asset-prefix\/_next\/static\//);

      // Any `<script src="...">` tag with a non-inline src must also be
      // under the configured prefix. Vite/RSC may inject modulepreload
      // links too — we don't strictly require them here, but they must
      // not leak the old /assets/ default.
      const scriptSrcRe = /<script[^>]+src="([^"]+)"/g;
      const scriptSrcs: string[] = [];
      for (const m of html.matchAll(scriptSrcRe)) {
        scriptSrcs.push(m[1]);
      }
      for (const src of scriptSrcs) {
        expect(src.startsWith("/custom-asset-prefix/_next/static/")).toBe(true);
      }

      // Fetching the bootstrap URL must return 200 with the JS body.
      const bundleRes = await fetch(`${baseUrl}${bootstrapMatch![1]}`);
      expect(bundleRes.status).toBe(200);
      expect(bundleRes.headers.get("content-type")).toContain("javascript");
    } finally {
      server.close();
    }
  }, 180_000);

  it("absolute URL: emits fully-qualified asset URLs and never includes /assets/", async () => {
    const built = await buildFixtureWithConfig(`assetPrefix: "https://cdn.example.com",`, register);

    // Disk layout is just _next/static/ — the CDN owns the URL prefix.
    const onDiskStatic = path.join(built.outDir, "client", "_next", "static");
    expect(fs.existsSync(onDiskStatic), `expected on-disk layout under ${onDiskStatic}`).toBe(true);

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      outDir: built.outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;

      const homeRes = await fetch(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      const html = await homeRes.text();

      const bootstrapMatch = html.match(/import\("([^"]+\.js)"\)/);
      expect(bootstrapMatch).not.toBeNull();
      // Fully qualified — no protocol-relative or path-only URLs.
      expect(bootstrapMatch![1]).toMatch(/^https:\/\/cdn\.example\.com\/_next\/static\//);

      // No emitted asset URL should leak the historical /assets/ default.
      expect(html).not.toMatch(/<script[^>]+src="\/assets\//);
    } finally {
      server.close();
    }
  }, 180_000);

  it("basePath + assetPrefix: routes under basePath, assets under assetPrefix", async () => {
    const built = await buildFixtureWithConfig(
      `basePath: "/app",\n  assetPrefix: "/cdn-prefix",`,
      register,
    );

    // On-disk path mirrors the assetPrefix path — independent of basePath.
    const onDiskStatic = path.join(built.outDir, "client", "cdn-prefix", "_next", "static");
    expect(fs.existsSync(onDiskStatic), `expected on-disk layout under ${onDiskStatic}`).toBe(true);

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      outDir: built.outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;

      // Routes live under basePath only.
      const homeRes = await fetch(`${baseUrl}/app/`);
      expect(homeRes.status).toBe(200);
      const html = await homeRes.text();

      const bootstrapMatch = html.match(/import\("([^"]+\.js)"\)/);
      expect(bootstrapMatch).not.toBeNull();
      // Asset URLs must NOT be under basePath — they are under assetPrefix only.
      expect(bootstrapMatch![1]).toMatch(/^\/cdn-prefix\/_next\/static\//);
      expect(bootstrapMatch![1].startsWith("/app/")).toBe(false);

      // Fetching the asset URL succeeds (no basePath redirect).
      const bundleRes = await fetch(`${baseUrl}${bootstrapMatch![1]}`);
      expect(bundleRes.status).toBe(200);
    } finally {
      server.close();
    }
  }, 180_000);

  it("unset: continues to emit URLs under /assets/ (backward compatibility)", async () => {
    // Smoke-check the baseline — no assetPrefix is set, so behaviour must
    // be unchanged from before this feature landed.
    const built = await buildFixtureWithConfig(`// no assetPrefix`, register);

    // Historical layout preserved.
    const onDiskAssets = path.join(built.outDir, "client", "assets");
    expect(
      fs.existsSync(onDiskAssets),
      `expected historical on-disk layout under ${onDiskAssets}`,
    ).toBe(true);

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      outDir: built.outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;

      const homeRes = await fetch(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      const html = await homeRes.text();

      const bootstrapMatch = html.match(/import\("([^"]+\.js)"\)/);
      expect(bootstrapMatch).not.toBeNull();
      expect(bootstrapMatch![1]).toMatch(/^\/assets\//);
      const bundleRes = await fetch(`${baseUrl}${bootstrapMatch![1]}`);
      expect(bundleRes.status).toBe(200);
    } finally {
      server.close();
    }
  }, 180_000);
});
