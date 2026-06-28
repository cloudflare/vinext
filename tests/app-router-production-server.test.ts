import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";
import {
  getPagesClientAssets,
  setPagesClientAssets,
} from "../packages/vinext/src/server/pages-client-assets.js";
import { APP_FIXTURE_DIR } from "./helpers.js";

function getStylesheetHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const linkPattern = /<link\b[^>]*>/g;
  let linkMatch: RegExpExecArray | null;

  while ((linkMatch = linkPattern.exec(html)) !== null) {
    const link = linkMatch[0];
    if (!/\brel=["']stylesheet["']/.test(link)) continue;

    const href = link.match(/\bhref=["']([^"']+)["']/)?.[1];
    if (href) hrefs.push(href);
  }

  return hrefs;
}

async function getLinkedStylesheetText(baseUrl: string, html: string): Promise<string> {
  return fetchStylesheetText(baseUrl, getStylesheetHrefs(html));
}

// RSC flight payloads reference CSS chunks as serialized stylesheet hints
// (e.g. `"href":"/assets/page-XXXX.css"`) rather than HTML `<link>` tags, so
// the `<link>` parser above does not see them. Pull every `.css` asset path out
// of the raw payload instead.
function getFlightStylesheetHrefs(payload: string): string[] {
  const hrefs = new Set<string>();
  const cssPattern = /["'](\/[^"']+?\.css)["']/g;
  let match: RegExpExecArray | null;
  while ((match = cssPattern.exec(payload)) !== null) {
    hrefs.add(match[1]);
  }
  return [...hrefs];
}

async function fetchStylesheetText(baseUrl: string, hrefs: string[]): Promise<string> {
  if (hrefs.length === 0) return "";

  const stylesheets = await Promise.all(
    hrefs.map(async (href) => {
      const res = await fetch(new URL(href, baseUrl));
      expect(res.status).toBe(200);
      return res.text();
    }),
  );

  return stylesheets.join("\n");
}

function getInlineStyleText(html: string): string {
  const styles: string[] = [];
  const stylePattern = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let match: RegExpExecArray | null;
  while ((match = stylePattern.exec(html)) !== null) {
    styles.push(match[1]);
  }
  return styles.join("\n");
}

async function withCountingFetchTarget<T>(
  fn: (targetUrl: string, getRequestCount: () => number) => Promise<T>,
): Promise<T> {
  let requestCount = 0;
  const upstream = http.createServer((_req, res) => {
    requestCount += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ count: requestCount }));
  });

  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.off("error", reject);
      resolve();
    });
  });

  const address = upstream.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
    throw new Error("Counting fetch target did not bind to a TCP port");
  }

  try {
    return await fn(`http://127.0.0.1:${address.port}/tick`, () => requestCount);
  } finally {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

type StartedTextSequenceTarget = {
  close: () => Promise<void>;
  url: string;
};

async function startTextSequenceTarget(): Promise<StartedTextSequenceTarget> {
  let responseCount = 0;
  const upstream = http.createServer((_req, res) => {
    responseCount += 1;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`random-${responseCount}`);
  });

  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.off("error", reject);
      resolve();
    });
  });

  const address = upstream.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
    throw new Error("Text sequence target did not bind to a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/random`,
    close() {
      return new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options?: { intervalMs?: number; timeoutMs?: number },
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 100;
  const deadline = Date.now() + (options?.timeoutMs ?? 3000);

  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("App Router Production server (startProdServer)", () => {
  const outDir = path.resolve(APP_FIXTURE_DIR, "dist");
  let server: import("node:http").Server | undefined;
  let baseUrl: string;
  let revalidatePathFetchTarget: StartedTextSequenceTarget | undefined;

  function extractRequestId(html: string): string | undefined {
    return (
      html.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1]
    );
  }

  function extractRandomData(html: string): string | undefined {
    return html.match(/id="random-data"[^>]*>(?:<!--.*?-->)*([^<]+)/)?.[1];
  }

  async function fetchRandomData(pathname: string, url = baseUrl): Promise<string> {
    const response = await fetch(`${url}${pathname}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const data = extractRandomData(html);
    expect(data).toBeTruthy();
    return data ?? "";
  }

  async function expectRewrittenPathRevalidates(
    pathname: "/static" | "/dynamic",
    url = baseUrl,
  ): Promise<void> {
    const initial = await fetchRandomData(pathname, url);
    const refreshed = await fetchRandomData(pathname, url);
    expect(refreshed).toBe(initial);

    const revalidateRes = await fetch(`${url}/api/revalidate?path=${pathname}`);
    expect(revalidateRes.status).toBe(200);
    expect(await revalidateRes.json()).toEqual({ revalidated: true });

    await waitForCondition(async () => {
      const revalidated = await fetchRandomData(pathname, url);
      return revalidated !== initial;
    });
  }

  beforeAll(async () => {
    revalidatePathFetchTarget = await startTextSequenceTarget();
    process.env.TEST_REVALIDATE_PATH_REWRITES_TARGET = revalidatePathFetchTarget.url;

    try {
      // Build the app-basic fixture to the default dist/ directory
      const builder = await createBuilder({
        root: APP_FIXTURE_DIR,
        configFile: false,
        plugins: [vinext({ appDir: APP_FIXTURE_DIR })],
        logLevel: "silent",
      });
      await builder.buildApp();

      // Start the production server on a random available port
      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      ({ server } = await startProdServer({ port: 0, outDir, noCompression: false }));
      const addr = server!.address();
      const port = typeof addr === "object" && addr ? addr.port : 4210;
      baseUrl = `http://localhost:${port}`;
    } catch (error) {
      server?.close();
      try {
        await revalidatePathFetchTarget.close();
      } finally {
        revalidatePathFetchTarget = undefined;
        delete process.env.TEST_REVALIDATE_PATH_REWRITES_TARGET;
      }
      throw error;
    }
  }, 60000);

  afterAll(async () => {
    server?.close();
    await revalidatePathFetchTarget?.close();
    delete process.env.TEST_REVALIDATE_PATH_REWRITES_TARGET;
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("serves the home page with SSR HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Welcome to App Router");
    expect(html).toContain("<script");
  });

  // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-static/app-static.test.ts
  it("contains dynamic = 'error' failures without terminating later App Router requests", async () => {
    const errorRes = await fetch(
      `${baseUrl}/nextjs-compat/app-static-dynamic-error/static-bailout-1`,
    );
    expect(errorRes.status).toBe(500);

    const forceStaticRes = await fetch(
      `${baseUrl}/nextjs-compat/app-static-force-static/static-bailout-1`,
      {
        headers: {
          cookie: "app-static-dynamic=hidden",
          "x-app-static": "hidden",
        },
      },
    );
    expect(forceStaticRes.status).toBe(200);
    const forceStaticHtml = await forceStaticRes.text();
    expect(forceStaticHtml).toContain("/nextjs-compat/app-static-force-static");
    expect(forceStaticHtml).toContain("static-bailout-1");
    expect(forceStaticHtml).toContain('<p id="headers">[]</p>');
    expect(forceStaticHtml).toContain('<p id="cookies">[]</p>');

    const homeRes = await fetch(`${baseUrl}/`);
    expect(homeRes.status).toBe(200);
    expect(await homeRes.text()).toContain("Welcome to App Router");
  });

  // Next.js v16.2.6 only selects NOT_FOUND fallback when dynamicParams is explicitly false:
  // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/build/static-paths/app.ts
  it("matches dynamic = 'error' dynamicParams admission semantics", async () => {
    for (const route of ["dynamic-error", "dynamic-error-true"]) {
      const unknown = await fetch(`${baseUrl}/layout-segment-config/${route}/unknown`);
      expect(unknown.status).toBe(200);
    }

    const known = await fetch(`${baseUrl}/layout-segment-config/dynamic-error-false/known`);
    expect(known.status).toBe(200);

    const unknown = await fetch(`${baseUrl}/layout-segment-config/dynamic-error-false/unknown`);
    expect(unknown.status).toBe(404);
  });

  // Ported from Next.js: test/e2e/app-dir/navigation/navigation.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
  //
  // Next.js route-level global CSS is scoped to the matched App Router route's
  // CSS chunks. A sibling route that imports `scroll-padding-top: 20px` must not
  // contribute CSS to this page; otherwise native hash scrolling lands exactly
  // 20px short, which is what the upstream navigation deploy-suite observed.
  it("keeps production route-level global CSS isolated between sibling hash routes", async () => {
    const noOffsetRes = await fetch(`${baseUrl}/nextjs-compat/hash-scroll-css-isolation`);
    expect(noOffsetRes.status).toBe(200);
    const noOffsetHtml = await noOffsetRes.text();
    const noOffsetCss = await getLinkedStylesheetText(baseUrl, noOffsetHtml);
    expect(noOffsetCss).not.toContain("scroll-padding-top");

    const offsetRes = await fetch(`${baseUrl}/nextjs-compat/hash-scroll-css-isolation-with-offset`);
    expect(offsetRes.status).toBe(200);
    const offsetHtml = await offsetRes.text();
    const offsetCss = await getLinkedStylesheetText(baseUrl, offsetHtml);
    expect(offsetCss).toContain("scroll-padding-top:20px");
  });

  it("keeps production route-level global CSS isolated for intercepted modal pages", async () => {
    // Direct feed visit: the modal page module is lazy, so its CSS must
    // not be emitted when the intercept is not active.
    const feedRes = await fetch(`${baseUrl}/feed`);
    expect(feedRes.status).toBe(200);
    const feedHtml = await feedRes.text();
    const feedLinkedCss = await getLinkedStylesheetText(baseUrl, feedHtml);
    expect(feedLinkedCss).not.toContain("scroll-padding-top");
    const feedInlineCss = getInlineStyleText(feedHtml);
    expect(feedInlineCss).not.toContain("scroll-padding-top");
  });

  it("emits intercepted modal CSS on RSC navigation from feed", async () => {
    // Positive direction for the lazy intercept-page load: navigating from
    // /feed to /photos/[id] fires the intercept, so the modal page module — and
    // therefore its `scroll-padding-top` CSS chunk — must be loaded and
    // referenced in the flight payload. Without this guard, a regression where
    // the lazy modal page fails to load its CSS would pass the negative test
    // above silently. Mirrors the dev-server intercept request shape.
    const res = await fetch(`${baseUrl}/photos/43.rsc`, {
      headers: {
        Accept: "text/x-component",
        "X-Vinext-Interception-Context": "/feed",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-component");

    const payload = await res.text();
    // Confirm the intercept actually fired before asserting on its CSS.
    expect(payload).toContain("photo-modal");

    const interceptCss = await fetchStylesheetText(baseUrl, getFlightStylesheetHrefs(payload));
    expect(interceptCss).toContain("scroll-padding-top:20px");
  });

  it("does not reuse cached HTML across requests with different CSP nonces", async () => {
    const firstRes = await fetch(`${baseUrl}/revalidate-test?csp-nonce=first`);
    expect(firstRes.status).toBe(200);
    expect(firstRes.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(firstRes.headers.get("content-security-policy")).toBe(
      "script-src 'nonce-first' 'strict-dynamic';",
    );
    const firstHtml = await firstRes.text();
    expect(firstHtml).toContain(
      '<script nonce="first">Object.assign(((self[Symbol.for("vinext.navigationRuntime")]',
    );

    const secondRes = await fetch(`${baseUrl}/revalidate-test?csp-nonce=second`);
    expect(secondRes.status).toBe(200);
    expect(secondRes.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(secondRes.headers.get("content-security-policy")).toBe(
      "script-src 'nonce-second' 'strict-dynamic';",
    );
    const secondHtml = await secondRes.text();
    expect(secondHtml).toContain(
      '<script nonce="second">Object.assign(((self[Symbol.for("vinext.navigationRuntime")]',
    );
    expect(secondHtml).not.toContain('nonce="first"');
  });

  it("preloads rendered next/dynamic chunks with the CSP nonce", async () => {
    // Ported from Next.js: test/e2e/app-dir/next-dynamic-csp-nonce/next-dynamic-csp-nonce.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-dynamic-csp-nonce/next-dynamic-csp-nonce.test.ts
    const res = await fetch(`${baseUrl}/nextjs-compat/dynamic?csp-nonce=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    const html = await res.text();
    const dynamicScriptPreloads =
      html.match(
        /<link\b(?=[^>]*\brel="preload")(?=[^>]*\bas="script")(?=[^>]*\bhref="[^"]*\/_next\/static\/chunks\/[^"]*\.js")[^>]*>/g,
      ) ?? [];

    expect(dynamicScriptPreloads.length).toBeGreaterThan(0);
    for (const tag of dynamicScriptPreloads) {
      expect(tag).toContain('nonce="vinext-test-nonce"');
    }
  });

  // Edge case: the next/dynamic() CALL SITE is a Server Component (no
  // "use client") that lazy-loads a client component. The sibling
  // /nextjs-compat/dynamic page only calls dynamic() from "use client" modules,
  // which render in the SSR pass where the script-nonce context is set — so it
  // does not cover this path.
  //
  // Next.js parity: <PreloadChunks> is a 'use client' component, so it renders
  // in the SSR pass and the preload links carry the nonce regardless of whether
  // the dynamic() call site is a Server or Client Component. vinext matches
  // this: DynamicPreloadChunks is ALSO a 'use client' component (see
  // shims/dynamic-preload-chunks.tsx), so it renders in the SSR pass — where
  // withScriptNonce installs the provider — and the nonce is applied even for a
  // Server-Component call site. This test guards exactly that. (Before that fix
  // it was rendered in the RSC environment, where useScriptNonce() returns
  // undefined and the nonce was dropped.)
  it("preloads next/dynamic chunks with the CSP nonce when the call site is a Server Component", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/dynamic/rsc-imports-client?csp-nonce=1`);
    expect(res.status).toBe(200);
    // Sanity: middleware ran and applied the nonce-based CSP for this route.
    expect(res.headers.get("content-security-policy")).toBe(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    const html = await res.text();
    // Sanity: the dynamically-imported client widget actually rendered, so a
    // client chunk exists and a preload link is expected.
    expect(html).toContain("rsc-imports-client-widget");

    const dynamicScriptPreloads =
      html.match(
        /<link\b(?=[^>]*\brel="preload")(?=[^>]*\bas="script")(?=[^>]*\bhref="[^"]*\/_next\/static\/chunks\/[^"]*\.js")[^>]*>/g,
      ) ?? [];

    // Parity expectation: a Server-Component call site must still emit a
    // nonce-bearing preload for the dynamically-loaded client chunk.
    expect(dynamicScriptPreloads.length).toBeGreaterThan(0);
    for (const tag of dynamicScriptPreloads) {
      expect(tag).toContain('nonce="vinext-test-nonce"');
    }
  });

  it("preloads next/dynamic CSS with the CSP nonce from a Server Component call site", async () => {
    // The dynamically-loaded client widget imports CSS. Next.js's <PreloadChunks>
    // preloads dynamic CSS server-side "to avoid flash of unstyled content", so
    // the stylesheet link must be emitted with the request nonce. React Float
    // renders the `precedence` prop as the `data-precedence` attribute.
    const res = await fetch(`${baseUrl}/nextjs-compat/dynamic/rsc-imports-client?csp-nonce=1`);
    expect(res.status).toBe(200);

    const html = await res.text();
    const dynamicStylesheets = (html.match(/<link\b[^>]*>/g) ?? []).filter(
      (tag) => /\brel="stylesheet"/.test(tag) && /\bdata-precedence="dynamic"/.test(tag),
    );

    expect(dynamicStylesheets.length).toBeGreaterThan(0);
    for (const tag of dynamicStylesheets) {
      expect(tag).toContain('nonce="vinext-test-nonce"');
      // The PR deliberately drops `as="style"` — `as` is only valid on
      // rel="preload" per the HTML spec, not on rel="stylesheet".
      expect(tag).not.toContain('as="style"');
    }
  });

  it("emits next/dynamic chunk preloads without a nonce when no CSP is set", async () => {
    // No ?csp-nonce → middleware applies no CSP header, so no nonce is threaded.
    // The preload optimization is independent of CSP: the links must still be
    // emitted, but must not carry a stray/empty nonce attribute.
    const res = await fetch(`${baseUrl}/nextjs-compat/dynamic`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeNull();

    const html = await res.text();
    const dynamicScriptPreloads =
      html.match(
        /<link\b(?=[^>]*\brel="preload")(?=[^>]*\bas="script")(?=[^>]*\bhref="[^"]*\/_next\/static\/chunks\/[^"]*\.js")[^>]*>/g,
      ) ?? [];

    expect(dynamicScriptPreloads.length).toBeGreaterThan(0);
    for (const tag of dynamicScriptPreloads) {
      expect(tag).not.toContain("nonce=");
    }
  });

  it("does not emit a server preload for an ssr:false next/dynamic boundary", async () => {
    // Next.js parity (lazy-dynamic/loadable.tsx): <PreloadChunks> renders only on
    // the ssr:true path; an ssr:false boundary bails out to CSR and emits no
    // server-side preload.
    const res = await fetch(`${baseUrl}/nextjs-compat/dynamic/ssr-false-only?csp-nonce=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    const html = await res.text();
    // Positive sanity: the page actually rendered (otherwise the negative
    // assertion below could pass for the wrong reason — a blank/errored page).
    // Assert the visible text, not just the id, to also catch a structural-but-
    // empty render.
    expect(html).toContain("This is static content");

    // The DynamicPreloadChunks signature is rel="preload" as="script"
    // fetchPriority="low" — route bootstrap uses modulepreload instead, so this
    // matches only dynamic-boundary preloads. Match the attribute name
    // case-INSENSITIVELY: React currently serializes the `fetchPriority` prop
    // verbatim (camelCase), but if it ever lowercased it to `fetchpriority` a
    // case-sensitive matcher would match nothing and this negative assertion
    // would pass vacuously even if a preload leaked.
    const dynamicScriptPreloads = (html.match(/<link\b[^>]*>/g) ?? []).filter(
      (tag) =>
        /\brel="preload"/i.test(tag) &&
        /\bas="script"/i.test(tag) &&
        /\bfetchpriority="low"/i.test(tag),
    );
    expect(dynamicScriptPreloads).toEqual([]);
  });

  it("preloads rendered next/dynamic chunks with assetPrefix and the CSP nonce", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-app-dynamic-asset-prefix-"));
    const fixtureRoot = path.join(tmpDir, "fixture");
    const prefixedOutDir = path.join(fixtureRoot, "dist");
    let assetPrefixServer: import("node:http").Server | undefined;
    const previousPagesClientAssets = getPagesClientAssets();
    const prodGlobalKeys = [
      "__vite_rsc_client_require__",
      "__vite_rsc_require__",
      "__vite_rsc_server_require__",
      "__webpack_chunk_load__",
      "__webpack_require__",
    ];
    // startProdServer installs build/runtime globals process-wide. This test
    // starts a second prod server while the shared server is still alive, so
    // restore the shared server's globals before later tests run.
    const previousGlobals = new Map(
      prodGlobalKeys.map((key) => [
        key,
        {
          exists: Reflect.has(globalThis, key),
          value: Reflect.get(globalThis, key),
        },
      ]),
    );

    try {
      fs.cpSync(APP_FIXTURE_DIR, fixtureRoot, { recursive: true });
      fs.rmSync(prefixedOutDir, { recursive: true, force: true });
      const fixtureNodeModules = path.join(fixtureRoot, "node_modules");
      if (!fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(
          path.resolve(__dirname, "..", "node_modules"),
          fixtureNodeModules,
          "junction",
        );
      }

      const nextConfigPath = path.join(fixtureRoot, "next.config.ts");
      const nextConfig = fs.readFileSync(nextConfigPath, "utf-8");
      fs.writeFileSync(
        nextConfigPath,
        nextConfig.replace(
          "const nextConfig: NextConfig = {",
          'const nextConfig: NextConfig = {\n  assetPrefix: "/cdn",',
        ),
      );

      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        plugins: [vinext({ appDir: fixtureRoot })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      ({ server: assetPrefixServer } = await startProdServer({
        port: 0,
        outDir: prefixedOutDir,
        noCompression: true,
      }));
      const addr = assetPrefixServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const tmpBaseUrl = `http://localhost:${port}`;

      const res = await fetch(`${tmpBaseUrl}/nextjs-compat/dynamic?csp-nonce=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(
        "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
      );

      const html = await res.text();
      // DynamicPreloadChunks emits ReactDOM.preload(..., { fetchPriority: "low" });
      // use that signal to avoid matching route bootstrap modulepreload links.
      const dynamicScriptPreloads = (html.match(/<link\b[^>]*>/g) ?? []).filter(
        (tag) =>
          /\bfetchpriority="low"/i.test(tag) &&
          tag.includes('nonce="vinext-test-nonce"') &&
          tag.includes("/_next/static/chunks/"),
      );

      expect(dynamicScriptPreloads.length).toBeGreaterThan(0);
      for (const tag of dynamicScriptPreloads) {
        expect(tag).toMatch(/\bhref="\/cdn\/_next\/static\/chunks\/[^"]+\.js"/);
      }
    } finally {
      assetPrefixServer?.close();
      setPagesClientAssets(previousPagesClientAssets);
      for (const [key, previous] of previousGlobals) {
        if (previous.exists) {
          Reflect.set(globalThis, key, previous.value);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it("preloads rendered next/dynamic chunks with absolute assetPrefix and the CSP nonce", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vinext-app-dynamic-absolute-asset-prefix-"),
    );
    const fixtureRoot = path.join(tmpDir, "fixture");
    const prefixedOutDir = path.join(fixtureRoot, "dist");
    let assetPrefixServer: import("node:http").Server | undefined;
    const previousPagesClientAssets = getPagesClientAssets();
    const prodGlobalKeys = [
      "__vite_rsc_client_require__",
      "__vite_rsc_require__",
      "__vite_rsc_server_require__",
      "__webpack_chunk_load__",
      "__webpack_require__",
    ];
    const previousGlobals = new Map(
      prodGlobalKeys.map((key) => [
        key,
        {
          exists: Reflect.has(globalThis, key),
          value: Reflect.get(globalThis, key),
        },
      ]),
    );

    try {
      fs.cpSync(APP_FIXTURE_DIR, fixtureRoot, { recursive: true });
      fs.rmSync(prefixedOutDir, { recursive: true, force: true });
      const fixtureNodeModules = path.join(fixtureRoot, "node_modules");
      if (!fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(
          path.resolve(__dirname, "..", "node_modules"),
          fixtureNodeModules,
          "junction",
        );
      }

      const nextConfigPath = path.join(fixtureRoot, "next.config.ts");
      const nextConfig = fs.readFileSync(nextConfigPath, "utf-8");
      fs.writeFileSync(
        nextConfigPath,
        nextConfig.replace(
          "const nextConfig: NextConfig = {",
          'const nextConfig: NextConfig = {\n  assetPrefix: "https://cdn.example.com",',
        ),
      );

      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        plugins: [vinext({ appDir: fixtureRoot })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      ({ server: assetPrefixServer } = await startProdServer({
        port: 0,
        outDir: prefixedOutDir,
        noCompression: true,
      }));
      const addr = assetPrefixServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const tmpBaseUrl = `http://localhost:${port}`;

      const res = await fetch(`${tmpBaseUrl}/nextjs-compat/dynamic?csp-nonce=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(
        "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
      );

      const html = await res.text();
      const dynamicScriptPreloads = (html.match(/<link\b[^>]*>/g) ?? []).filter(
        (tag) =>
          /\bfetchpriority="low"/i.test(tag) &&
          tag.includes('nonce="vinext-test-nonce"') &&
          tag.includes("https://cdn.example.com/_next/static/chunks/"),
      );

      expect(dynamicScriptPreloads.length).toBeGreaterThan(0);
      for (const tag of dynamicScriptPreloads) {
        expect(tag).toMatch(
          /\bhref="https:\/\/cdn\.example\.com\/_next\/static\/chunks\/[^"]+\.js"/,
        );
      }
    } finally {
      assetPrefixServer?.close();
      setPagesClientAssets(previousPagesClientAssets);
      for (const [key, previous] of previousGlobals) {
        if (previous.exists) {
          Reflect.set(globalThis, key, previous.value);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it("does not collapse encoded slashes onto nested routes in production", async () => {
    const encodedRes = await fetch(`${baseUrl}/headers%2Foverride-from-middleware`);
    expect(encodedRes.status).toBe(404);
    expect(encodedRes.headers.get("e2e-headers")).not.toBe("middleware");

    const nestedRes = await fetch(`${baseUrl}/headers/override-from-middleware`);
    expect(nestedRes.status).toBe(200);
    expect(nestedRes.headers.get("e2e-headers")).toBe("middleware");
  });

  // Regression test for issue 1487 — App Router page-segment `revalidate`
  // should produce a stable cached response. Two requests inside the
  // revalidate window must return identical HTML bytes (same Date.now()
  // embedded), not re-render on every request. /revalidate-test exports
  // `revalidate = 60` and renders Date.now() into the HTML.
  it("export const revalidate: second request inside the cache window is a HIT with identical HTML", async () => {
    const res1 = await fetch(`${baseUrl}/revalidate-test`);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(?:<!--[^>]*-->)*\s*(\d+)\s*</)?.[1];
    expect(ts1).toBeTruthy();

    const res2 = await fetch(`${baseUrl}/revalidate-test`);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(?:<!--[^>]*-->)*\s*(\d+)\s*</)?.[1];

    // The HIT response must return the same timestamp baked into the HTML on
    // the MISS render. If vinext re-renders on every request, ts2 will be a
    // fresher Date.now() than ts1.
    expect(res2.headers.get("x-vinext-cache")).toBe("HIT");
    expect(ts2).toBe(ts1);
  });

  // Regression test for issue 1487 — App Router page-segment `revalidate = Infinity`
  // (and `revalidate = false`) should produce a stable cached response. Two
  // requests must return identical HTML bytes; the first MISS render writes
  // to the cache and the second is a HIT. This was historically broken
  // because `resolveAppPageCacheWritePolicy` rejected non-finite revalidate
  // intervals, so indefinite-cache pages re-rendered on every request.
  it("export const revalidate = Infinity: second request is a HIT with identical HTML", async () => {
    const res1 = await fetch(`${baseUrl}/revalidate-infinity-test`);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(?:<!--[^>]*-->)*\s*(\d+)\s*</)?.[1];
    expect(ts1).toBeTruthy();

    const res2 = await fetch(`${baseUrl}/revalidate-infinity-test`);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(?:<!--[^>]*-->)*\s*(\d+)\s*</)?.[1];

    expect(res2.headers.get("x-vinext-cache")).toBe("HIT");
    expect(ts2).toBe(ts1);
  });

  it("applies middleware request header overrides before App->Pages fallback rendering in production", async () => {
    const res = await fetch(`${baseUrl}/pages-header-override-delete`, {
      headers: {
        authorization: "Bearer secret",
        cookie: "a=1; b=2",
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pages Header Override Delete");
    expect(html).toContain('<p id="authorization"></p>');
    expect(html).toContain('<p id="cookie"></p>');
    expect(html).toContain('id="middleware-header">hello-from-middleware<');
    expect(html).toContain('"authorization":null');
    expect(html).toContain('"cookie":null');
  });

  it("serves Pages Router edge API ImageResponse routes in hybrid production", async () => {
    // Ported from Next.js: test/e2e/og-api/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/og-api/index.test.ts
    const res = await fetch(`${baseUrl}/api/pages-og`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(res.headers.get("x-mw-ran")).toBe("true");
    expect((await res.blob()).size).toBeGreaterThan(0);
  });

  it("serves dynamic routes", async () => {
    const res = await fetch(`${baseUrl}/blog/test-post`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("test-post");
  });

  // Ported from Next.js: test/e2e/app-dir/app-prefetch-static/app-prefetch-static.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-prefetch-static/app-prefetch-static.test.ts
  it("serves lowercase paths generated from uppercase static params", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/case-insensitive-static-params/se`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="case-insensitive-static-param"');
  });

  it("serves nested layouts", async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("dashboard-layout");
  });

  it("returns RSC stream for .rsc requests", async () => {
    const res = await fetch(`${baseUrl}/about.rsc`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-component");
  });

  it("returns HTML for header-only RSC requests at canonical page URLs", async () => {
    const res = await fetch(`${baseUrl}/about`, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves route handlers (GET /api/hello)", async () => {
    const res = await fetch(`${baseUrl}/api/hello`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("message");
  });

  // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-static/app-static.test.ts
  it("lets route handlers synchronously catch updateTag errors without crashing", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/update-tag-error`);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("updateTag can only be called from within a Server Action"),
    });

    const healthRes = await fetch(`${baseUrl}/api/hello`);
    expect(healthRes.status).toBe(200);
  });

  it("runs an exact API middleware matcher for a trailing-slash route handler request", async () => {
    const res = await fetch(`${baseUrl}/api/header-override-delete/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-mw-ran")).toBe("true");
    expect(res.headers.get("x-mw-pathname")).toBe("/api/header-override-delete/");
  });

  it("returns 404 for nonexistent routes", async () => {
    const res = await fetch(`${baseUrl}/no-such-page`);
    expect(res.status).toBe(404);
  });

  // Ported from Next.js: test/e2e/app-dir/rsc-redirect/rsc-redirect.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-redirect/rsc-redirect.test.ts
  //
  // Document request (no `Rsc` header) to a page that calls `redirect()` must
  // respond with HTTP 307 + Location. The RSC variant (`.rsc` URL or Rsc:1
  // header) returns 200 with a flight payload — that path is covered by the
  // sibling `.rsc` redirect tests above and by issue #1347.
  //
  // See: https://github.com/cloudflare/vinext/issues/1530
  it("redirect() from Server Component returns 307 on document load (production)", async () => {
    const res = await fetch(`${baseUrl}/redirect-test`, { redirect: "manual" });
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toContain("/about");
  });

  // Issue #1529: an RSC client navigation that hits a next.config.js redirect
  // must keep the cache-busting `_rsc` query on the redirect Location so the
  // browser's auto-followed request to the destination is still treated as an
  // RSC fetch. The vinext client addresses RSC navigations via the `RSC: 1`
  // header + `?_rsc=` query, so we replicate that request shape here.
  it("preserves the _rsc query on config-redirect Location for RSC navigations (#1529)", async () => {
    const res = await fetch(`${baseUrl}/old-about?_rsc=abc123`, {
      redirect: "manual",
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    expect(res.status).toBe(308);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toContain("/about");
    // The App Router RSC handler canonicalizes the redirect Location by
    // recomputing the cache-busting `_rsc` param from the request headers
    // (rather than echoing the literal client value), so assert presence.
    expect(location).toContain("_rsc");
  });

  it("serves static assets with cache headers", async () => {
    // Find an actual hashed JS asset from the build.
    const assetsDir = path.join(outDir, "client", "_next", "static", "chunks");
    const assets = fs.readdirSync(assetsDir);
    const jsFile = assets.find((f: string) => f.endsWith(".js"));
    expect(jsFile).toBeDefined();

    const res = await fetch(`${baseUrl}/_next/static/chunks/${jsFile}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("serves public files from the build output", async () => {
    // Ported from Next.js: test/production/export/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/production/export/index.test.ts
    const res = await fetch(`${baseUrl}/logo/logo.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(await res.text()).toContain("vinext");
  });

  it("serves public files under basePath and 404s without it", async () => {
    // Ported from Next.js: test/e2e/basepath/basepath.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/basepath/basepath.test.ts
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-app-public-basepath-"));
    const fixtureRoot = path.join(tmpDir, "fixture");
    let basePathServer: import("node:http").Server | undefined;

    try {
      fs.cpSync(APP_FIXTURE_DIR, fixtureRoot, { recursive: true });
      const fixtureNodeModules = path.join(fixtureRoot, "node_modules");
      if (!fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(
          path.resolve(__dirname, "..", "node_modules"),
          fixtureNodeModules,
          "junction",
        );
      }

      const nextConfigPath = path.join(fixtureRoot, "next.config.ts");
      const nextConfig = fs.readFileSync(nextConfigPath, "utf-8");
      fs.writeFileSync(
        nextConfigPath,
        nextConfig.replace(
          "const nextConfig: NextConfig = {",
          'const nextConfig: NextConfig = {\n  basePath: "/app",',
        ),
      );

      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        plugins: [vinext({ appDir: fixtureRoot })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      ({ server: basePathServer } = await startProdServer({
        port: 0,
        outDir: path.join(fixtureRoot, "dist"),
        noCompression: true,
      }));
      const addr = basePathServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const tmpBaseUrl = `http://localhost:${port}`;

      const withBasePathRes = await fetch(`${tmpBaseUrl}/app/logo/logo.svg`);
      expect(withBasePathRes.status).toBe(200);
      expect(withBasePathRes.headers.get("content-type")).toContain("image/svg+xml");

      const withoutBasePathRes = await fetch(`${tmpBaseUrl}/logo/logo.svg`);
      expect(withoutBasePathRes.status).toBe(404);
    } finally {
      basePathServer?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports gzip compression for HTML", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    // Node.js fetch auto-decompresses, but we can check the header
    // was set by looking at the original response headers
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("supports brotli compression for HTML", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { "Accept-Encoding": "br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
  });

  it("streams HTML (response is a ReadableStream)", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    // Verify we can read the body as text (proves streaming works)
    const html = await res.text();
    expect(html.length).toBeGreaterThan(0);
  });

  it("reports server component render errors via instrumentation in production", async () => {
    const resetRes = await fetch(`${baseUrl}/api/instrumentation-test`, {
      method: "DELETE",
    });
    expect(resetRes.status).toBe(200);

    const errorRes = await fetch(`${baseUrl}/error-server-test`);
    expect(errorRes.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const stateRes = await fetch(`${baseUrl}/api/instrumentation-test`);
    expect(stateRes.status).toBe(200);
    const state = await stateRes.json();

    expect(state.errors.length).toBeGreaterThanOrEqual(1);

    const err = state.errors[state.errors.length - 1];
    expect(err.message).toBe("Server component error");
    expect(err.path).toBe("/error-server-test");
    expect(err.method).toBe("GET");
    expect(err.routerKind).toBe("App Router");
    expect(err.routePath).toBe("/error-server-test");
    expect(err.routeType).toBe("render");
  });

  it("returns 400 for malformed percent-encoded path (not crash)", async () => {
    const res = await fetch(`${baseUrl}/%E0%A4%A`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Bad Request");
  });

  it("returns 400 for bare percent sign in path (not crash)", async () => {
    const res = await fetch(`${baseUrl}/%`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Bad Request");
  });

  it("revalidateTag invalidates App Router ISR page entries by fetch tag", async () => {
    const res1 = await fetch(`${baseUrl}/revalidate-tag-test`);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    const reqId1 = extractRequestId(html1);
    expect(reqId1).toBeTruthy();

    const res2 = await fetch(`${baseUrl}/revalidate-tag-test`);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    const reqId2 = extractRequestId(html2);
    expect(reqId2).toBe(reqId1);
    expect(res2.headers.get("x-vinext-cache")).toBe("HIT");

    const tagRes = await fetch(`${baseUrl}/api/revalidate-tag`);
    expect(tagRes.status).toBe(200);
    expect(await tagRes.text()).toBe("ok");

    const res3 = await fetch(`${baseUrl}/revalidate-tag-test`);
    expect(res3.status).toBe(200);
    const html3 = await res3.text();
    const reqId3 = extractRequestId(html3);
    expect(reqId3).toBeTruthy();
    expect(reqId3).not.toBe(reqId1);
    expect(res3.headers.get("x-vinext-cache")).toBe("MISS");
  });

  it("revalidatePath invalidates App Router ISR page entries by path tag", async () => {
    const res1 = await fetch(`${baseUrl}/revalidate-tag-test`);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    const reqId1 = extractRequestId(html1);
    expect(reqId1).toBeTruthy();

    const res2 = await fetch(`${baseUrl}/revalidate-tag-test`);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    const reqId2 = extractRequestId(html2);
    expect(reqId2).toBe(reqId1);
    expect(res2.headers.get("x-vinext-cache")).toBe("HIT");

    const pathRes = await fetch(`${baseUrl}/api/revalidate-path`);
    expect(pathRes.status).toBe(200);
    expect(await pathRes.text()).toBe("ok");

    const res3 = await fetch(`${baseUrl}/revalidate-tag-test`);
    expect(res3.status).toBe(200);
    const html3 = await res3.text();
    const reqId3 = extractRequestId(html3);
    expect(reqId3).toBeTruthy();
    expect(reqId3).not.toBe(reqId1);
    expect(res3.headers.get("x-vinext-cache")).toBe("MISS");
  });

  describe("revalidatePath with rewrites", () => {
    // Ported from Next.js: test/e2e/app-dir/revalidate-path-with-rewrites/revalidate-path-with-rewrites.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/revalidate-path-with-rewrites/revalidate-path-with-rewrites.test.ts
    //
    // The upstream fixture fetches https://next-data-api-endpoint.vercel.app/api/random.
    // This fixture uses a local text endpoint so the same force-cache/revalidatePath
    // contract is exercised without an external network dependency.
    it("static page should revalidate a static page that was rewritten", async () => {
      await expectRewrittenPathRevalidates("/static");
    });

    it("dynamic page should revalidate a dynamic page that was rewritten", async () => {
      await expectRewrittenPathRevalidates("/dynamic");
    });

    // Coverage for the cacheComponents: true path — the sibling tests above exercise
    // the default disabled case. The define contract must stay consistent between the
    // config-load-time environment (used by next.config rewrites) and the bundled
    // boolean expression (used by the route handler).
    it("static page should revalidate a rewritten page with cacheComponents enabled", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-app-cache-components-rewrite-"));
      const fixtureRoot = path.join(tmpDir, "fixture");
      const ccOutDir = path.join(fixtureRoot, "dist");
      let ccServer: import("node:http").Server | undefined;
      const previousPagesClientAssets = getPagesClientAssets();
      const prodGlobalKeys = [
        "__vite_rsc_client_require__",
        "__vite_rsc_require__",
        "__vite_rsc_server_require__",
        "__webpack_chunk_load__",
        "__webpack_require__",
      ];
      const previousGlobals = new Map(
        prodGlobalKeys.map((key) => [
          key,
          {
            exists: Reflect.has(globalThis, key),
            value: Reflect.get(globalThis, key),
          },
        ]),
      );

      try {
        fs.cpSync(APP_FIXTURE_DIR, fixtureRoot, {
          recursive: true,
          filter: (src) => {
            const rel = path.relative(APP_FIXTURE_DIR, src);
            return rel !== "dist" && !rel.startsWith(`dist${path.sep}`);
          },
        });
        fs.rmSync(ccOutDir, { recursive: true, force: true });
        const fixtureNodeModules = path.join(fixtureRoot, "node_modules");
        if (!fs.existsSync(fixtureNodeModules)) {
          fs.symlinkSync(
            path.resolve(__dirname, "..", "node_modules"),
            fixtureNodeModules,
            "junction",
          );
        }

        const nextConfigPath = path.join(fixtureRoot, "next.config.ts");
        const nextConfig = fs.readFileSync(nextConfigPath, "utf-8");
        fs.writeFileSync(
          nextConfigPath,
          nextConfig.replace(
            "const nextConfig: NextConfig = {",
            "const nextConfig: NextConfig = {\n  cacheComponents: true,",
          ),
        );

        // Set the env var so next.config.ts rewrites resolve to the cache-components
        // prefix (the config is evaluated at load time, before the Vite define replaces
        // process.env.__NEXT_CACHE_COMPONENTS with the bundled boolean).
        process.env.__NEXT_CACHE_COMPONENTS = "true";

        const builder = await createBuilder({
          root: fixtureRoot,
          configFile: false,
          plugins: [vinext({ appDir: fixtureRoot })],
          logLevel: "silent",
        });
        await builder.buildApp();

        const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
        ({ server: ccServer } = await startProdServer({
          port: 0,
          outDir: ccOutDir,
          noCompression: true,
        }));
        const addr = ccServer.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const tmpBaseUrl = `http://localhost:${port}`;

        await expectRewrittenPathRevalidates("/static", tmpBaseUrl);
        await expectRewrittenPathRevalidates("/dynamic", tmpBaseUrl);
      } finally {
        delete process.env.__NEXT_CACHE_COMPONENTS;
        ccServer?.close();
        setPagesClientAssets(previousPagesClientAssets);
        for (const [key, previous] of previousGlobals) {
          if (previous.exists) {
            Reflect.set(globalThis, key, previous.value);
          } else {
            Reflect.deleteProperty(globalThis, key);
          }
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 60000);
  });

  it("dedupes identical no-store fetches across metadata and page render during ISR background regeneration", async () => {
    await withCountingFetchTarget(async (targetUrl, getRequestCount) => {
      process.env.TEST_FETCH_DEDUPE_TARGET = targetUrl;
      try {
        const warmRes = await fetch(`${baseUrl}/fetch-dedupe-isr-metadata`);
        expect(warmRes.status).toBe(200);
        expect(await warmRes.text()).toContain("<title>ISR Product 1</title>");
        expect(getRequestCount()).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 1500));

        const staleRes = await fetch(`${baseUrl}/fetch-dedupe-isr-metadata`);
        expect(staleRes.status).toBe(200);
        await staleRes.arrayBuffer();

        await waitForCondition(() => getRequestCount() > 1, {
          intervalMs: 100,
          timeoutMs: 3000,
        });
        // Poll for count stabilization rather than assuming a fixed window —
        // a stray third fetch would betray dedupe leaking across the
        // metadata + page boundary in background regeneration.
        let stableCount = getRequestCount();
        let stableSince = Date.now();
        while (Date.now() - stableSince < 500) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const current = getRequestCount();
          if (current !== stableCount) {
            stableCount = current;
            stableSince = Date.now();
          }
        }

        expect(stableCount).toBe(2);
      } finally {
        delete process.env.TEST_FETCH_DEDUPE_TARGET;
      }
    });
  });

  it("page ISR + searchParams: RSC requests stay dynamic instead of serving cached query data", async () => {
    const res1 = await fetch(`${baseUrl}/isr-dynamic-search.rsc?filter=crimson`, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toContain("text/x-component");
    expect(res1.headers.get("x-vinext-cache")).toBeNull();
    const rsc1 = await res1.text();
    expect(rsc1).toContain("crimson");

    const res2 = await fetch(`${baseUrl}/isr-dynamic-search.rsc?filter=indigo`, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-vinext-cache")).toBeNull();
    const rsc2 = await res2.text();
    expect(rsc2).toContain("indigo");
    expect(rsc2).not.toContain("crimson");
  });

  it("page ISR + searchParams: HTML requests also skip ISR caching", async () => {
    const res1 = await fetch(`${baseUrl}/isr-dynamic-search?filter=alpha`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("x-vinext-cache")).toBeNull();
    const html1 = await res1.text();
    expect(html1).toContain("alpha");

    const res2 = await fetch(`${baseUrl}/isr-dynamic-search?filter=beta`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-vinext-cache")).toBeNull();
    const html2 = await res2.text();
    expect(html2).toContain("beta");
    expect(html2).not.toContain('"filter">alpha<');
  });

  // Route handler ISR caching tests
  // These tests are ORDER-DEPENDENT: they share a single production server and
  // /api/static-data cache state persists across tests. HIT depends on MISS
  // having run first, STALE re-warms explicitly. Take care when adding new tests.
  // Fixture: /api/static-data exports revalidate = 1 and returns { timestamp: Date.now() }
  it("route handler ISR: first GET returns MISS", async () => {
    const res = await fetch(`${baseUrl}/api/static-data`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vinext-cache")).toBe("MISS");
  });

  it("route handler ISR: second GET returns cached response (HIT)", async () => {
    // First request populates cache
    const res1 = await fetch(`${baseUrl}/api/static-data`);
    const body1 = await res1.json();
    expect(res1.status).toBe(200);

    // Second request should be a cache hit with identical response
    const res2 = await fetch(`${baseUrl}/api/static-data`);
    const body2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(body2.timestamp).toBe(body1.timestamp);
    expect(res2.headers.get("x-vinext-cache")).toBe("HIT");
  });

  it("route handler ISR: POST bypasses cache", async () => {
    // POST should never be cached even with revalidate set on GET
    const res = await fetch(`${baseUrl}/api/static-data`, { method: "POST" });
    // /api/static-data only exports GET, POST should be 405
    expect(res.status).toBe(405);
    expect(res.headers.get("x-vinext-cache")).toBeNull();
  });

  it("route handler ISR: dynamic handler (reads headers()) is not cached", async () => {
    // /api/dynamic-request-data exports revalidate=60 but reads headers() and cookies()
    const res1 = await fetch(`${baseUrl}/api/dynamic-request-data`, {
      headers: { "x-test-ping": "a" },
    });
    const res2 = await fetch(`${baseUrl}/api/dynamic-request-data`, {
      headers: { "x-test-ping": "b" },
    });
    // Dynamic usage should prevent ISR caching
    expect(res1.headers.get("x-vinext-cache")).toBeNull();
    expect(res2.headers.get("x-vinext-cache")).toBeNull();
  });

  it("route handler ISR: direct request.headers access is not cached", async () => {
    const res1 = await fetch(`${baseUrl}/api/dynamic-request-headers`, {
      headers: { "x-test-ping": "a" },
    });
    const res2 = await fetch(`${baseUrl}/api/dynamic-request-headers`, {
      headers: { "x-test-ping": "b" },
    });

    expect(await res1.json()).toEqual({ ping: "a" });
    expect(await res2.json()).toEqual({ ping: "b" });
    expect(res1.headers.get("x-vinext-cache")).toBeNull();
    expect(res2.headers.get("x-vinext-cache")).toBeNull();
  });

  it("route handler ISR: request.url query access is not cached", async () => {
    const res1 = await fetch(`${baseUrl}/api/dynamic-request-url?ping=a`);
    const res2 = await fetch(`${baseUrl}/api/dynamic-request-url?ping=b`);

    expect(await res1.json()).toEqual({ ping: "a" });
    expect(await res2.json()).toEqual({ ping: "b" });
    expect(res1.headers.get("x-vinext-cache")).toBeNull();
    expect(res2.headers.get("x-vinext-cache")).toBeNull();
  });

  it("route handler ISR: handler-set Cache-Control skips ISR caching", async () => {
    // /api/custom-cache exports revalidate=60 but sets its own Cache-Control
    const res1 = await fetch(`${baseUrl}/api/custom-cache`);
    const res2 = await fetch(`${baseUrl}/api/custom-cache`);
    // Handler controls caching — ISR should not interfere
    expect(res1.headers.get("x-vinext-cache")).toBeNull();
    expect(res2.headers.get("x-vinext-cache")).toBeNull();
  });

  it("route handler ISR: force-dynamic handler is not cached", async () => {
    // /api/force-dynamic-revalidate exports revalidate=60 AND dynamic="force-dynamic"
    const res1 = await fetch(`${baseUrl}/api/force-dynamic-revalidate`);
    const res2 = await fetch(`${baseUrl}/api/force-dynamic-revalidate`);
    expect(res1.headers.get("x-vinext-cache")).toBeNull();
    expect(res2.headers.get("x-vinext-cache")).toBeNull();
  });

  it("route handler ISR: STALE serves stale data and triggers background regen", async () => {
    // /api/static-data has revalidate=1
    // Cache may already be warm from earlier tests — ensure we have a known timestamp
    const warm = await fetch(`${baseUrl}/api/static-data`);
    const warmBody = await warm.json();
    const cachedTimestamp = warmBody.timestamp;

    // Wait for cache entry to become stale (revalidate=1, generous margin for slow CI)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // STALE — serves stale data, triggers background regen.
    // The stale response must return quickly: it must NOT block on the
    // background regeneration. Measure total duration to catch regressions.
    const staleStart = Date.now();
    const staleRes = await fetch(`${baseUrl}/api/static-data`);
    const staleDuration = Date.now() - staleStart;
    expect(staleRes.headers.get("x-vinext-cache")).toBe("STALE");
    const staleBody = await staleRes.json();
    expect(staleBody.timestamp).toBe(cachedTimestamp); // Still the old data

    // The stale response must arrive promptly; background regen runs
    // out-of-band via ctx.waitUntil(). Allow 500ms for cold-start latency.
    expect(staleDuration).toBeLessThan(500);

    // Poll until background regen completes (up to 5s)
    const deadline = Date.now() + 5000;
    let freshRes: Response;
    let freshBody: { timestamp: number };
    do {
      await new Promise((resolve) => setTimeout(resolve, 500));
      freshRes = await fetch(`${baseUrl}/api/static-data`);
      freshBody = await freshRes.json();
    } while (freshRes.headers.get("x-vinext-cache") !== "HIT" && Date.now() < deadline);

    // HIT — fresh data from background regen
    expect(freshRes.headers.get("x-vinext-cache")).toBe("HIT");
    expect(freshBody.timestamp).not.toBe(cachedTimestamp); // New data
  });

  // Test pattern ported from Next.js:
  // test/e2e/app-dir/use-cache-swr/use-cache-swr.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-swr/use-cache-swr.test.ts
  // (adapted from "use cache" SWR to route handler ISR with export const revalidate)
  it("route handler ISR: STALE completes quickly without blocking on background regen", async () => {
    // /api/slow-isr has revalidate=1 and a 1s handler delay.
    // Populate the cache (cold request, takes ~1s).
    const coldStart = Date.now();
    const cold = await fetch(`${baseUrl}/api/slow-isr`);
    expect(cold.status).toBe(200);
    const coldBody = await cold.json();
    const coldDuration = Date.now() - coldStart;
    expect(coldDuration).toBeGreaterThanOrEqual(700); // roughly 1s handler delay

    // Wait for the 1s revalidate window to expire.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Stale request: must return the cached value quickly (< 500ms), not
    // the full 1s handler duration. If the response is blocked on background
    // regeneration, this will take ≥ 1s and fail.
    const staleStart = Date.now();
    const stale = await fetch(`${baseUrl}/api/slow-isr`);
    const staleDuration = Date.now() - staleStart;
    expect(stale.headers.get("x-vinext-cache")).toBe("STALE");
    const staleBody = await stale.json();
    expect(staleBody.timestamp).toBe(coldBody.timestamp); // Still the old data
    expect(staleDuration).toBeLessThan(500);

    // Wait for background regen to complete, then verify fresh data.
    const deadline = Date.now() + 5000;
    let freshRes: Response;
    let freshBody: { timestamp: number };
    do {
      await new Promise((resolve) => setTimeout(resolve, 500));
      freshRes = await fetch(`${baseUrl}/api/slow-isr`);
      freshBody = await freshRes.json();
    } while (freshRes.headers.get("x-vinext-cache") !== "HIT" && Date.now() < deadline);

    expect(freshRes.headers.get("x-vinext-cache")).toBe("HIT");
    expect(freshBody.timestamp).not.toBe(coldBody.timestamp);
  });

  it("route handler ISR: auto-HEAD returns cached headers with empty body", async () => {
    // Ensure cache is warm
    const getRes = await fetch(`${baseUrl}/api/static-data`);
    await getRes.text();
    const cacheHeader = getRes.headers.get("x-vinext-cache");
    expect(cacheHeader === "MISS" || cacheHeader === "HIT" || cacheHeader === "STALE").toBe(true);

    // HEAD against a GET-only route should return cached headers, no body
    const headRes = await fetch(`${baseUrl}/api/static-data`, { method: "HEAD" });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("x-vinext-cache")).toBe("HIT");
    const body = await headRes.text();
    expect(body).toBe("");
  });

  // Regression for issue #1453 (route-handler revalidate sub-part): a route
  // handler whose body comes from a `"use cache"` function tagged with
  // `cacheTag()` must be evictable via `revalidateTag()`. `cacheTag()` tags
  // declared inside `"use cache"` were attached only to the inner data cache
  // entry and never propagated to the surrounding route-handler ISR entry, so
  // `revalidateTag()` left the cached route-handler response in place.
  // Fixtures: /api/use-cache-tagged (no revalidate window, tagged via
  // cacheTag("use-cache-rh-tag")) + /api/revalidate-use-cache-rh-tag.
  it("route handler ISR: revalidateTag evicts a 'use cache' cacheTag()-tagged route handler", async () => {
    // Cold request populates the cache.
    const res1 = await fetch(`${baseUrl}/api/use-cache-tagged`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("x-vinext-cache")).toBe("MISS");
    const body1 = await res1.json();

    // Second request HITs the cache — there is no revalidate window, so the
    // timestamp is stable until the tag is invalidated.
    const res2 = await fetch(`${baseUrl}/api/use-cache-tagged`);
    expect(res2.headers.get("x-vinext-cache")).toBe("HIT");
    const body2 = await res2.json();
    expect(body2.timestamp).toBe(body1.timestamp);

    // Invalidate the cacheTag declared inside the "use cache" function.
    const tagRes = await fetch(`${baseUrl}/api/revalidate-use-cache-rh-tag`);
    expect(tagRes.status).toBe(200);
    expect(await tagRes.text()).toBe("ok");

    // The next request must miss the cache and produce a fresh timestamp.
    const res3 = await fetch(`${baseUrl}/api/use-cache-tagged`);
    expect(res3.headers.get("x-vinext-cache")).toBe("MISS");
    const body3 = await res3.json();
    expect(body3.timestamp).not.toBe(body1.timestamp);
  });

  it("middleware request header overrides still apply after middleware calls headers() first", async () => {
    // Regression for a bug where a middleware that reads `next/headers` →
    // `headers()` *before* returning `NextResponse.next({ request: { headers } })`
    // leaked the pre-override snapshot into the Server Component.
    //
    // The `headers()` call cached the sealed read-only Headers view on the
    // shared HeadersContext (`ctx.readonlyHeaders = _sealHeaders(ctx.headers)`).
    // `applyMiddlewareRequestHeaders()` then replaced `ctx.headers` with the
    // override view but did not invalidate the cached sealed snapshot, so the
    // Server Component's subsequent `headers()` call returned the original
    // pre-override request headers.
    //
    // Discovered with @clerk/nextjs, whose `clerkClient()` calls
    // `await headers()` via its internal `buildRequestLike()` helper during
    // middleware execution. Clerk's `auth()` in a Server Component then threw
    //
    //   "auth() was called but Clerk can't detect usage of clerkMiddleware()"
    //
    // because Clerk's own x-clerk-auth-* request header overrides never
    // reached the render. The fixture middleware reproduces the same prime-
    // then-override sequence without a Clerk dependency by calling
    // `await headers()` first and then returning the override response.
    //
    // The test runs against the production server (startProdServer) because
    // the bug only manifests on the inline RSC entry path that wraps the
    // entire request — including middleware execution — in the headers
    // context. The dev-mode middleware path runs middleware before the
    // headers context exists, so calling `headers()` from middleware is
    // instead an immediate error there.
    const res = await fetch(`${baseUrl}/header-override-after-prior-access`, {
      headers: {
        authorization: "Bearer secret",
        cookie: "a=1; b=2",
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="authorization">null<');
    expect(html).toContain('id="cookie">null<');
    expect(html).toContain('id="middleware-header">hello-from-middleware<');
    expect(html).toContain('id="cookie-count">0<');
  });

  // Regression for cloudflare/vinext#1480: a node-runtime middleware that
  // matches the action path and reads the request body on POST (then falls
  // through with `NextResponse.next()`) must not prevent the server-action
  // POST from being intercepted and executed. The app-basic middleware matches
  // `/nextjs-compat/action-node-mw` and consumes the body for POSTs, mirroring
  // Next.js' `middleware-node.js`. This runs against the production server
  // because the upstream failure surfaced in the deploy suite.
  it("dispatches a server action POST under a body-reading node middleware", async () => {
    const html = await (await fetch(`${baseUrl}/nextjs-compat/action-node-mw`)).text();
    // Production action ids are hashed; extract the id from the bound form's
    // `$ACTION_1:0` reference payload rather than hardcoding it.
    const refValue = html.match(/name="\$ACTION_[^"]*:0"\s+value="([^"]+)"/)?.[1];
    expect(refValue).toBeDefined();
    const decoded = refValue!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const actionId = JSON.parse(decoded).id as string;
    expect(actionId).toBeTruthy();

    const res = await fetch(`${baseUrl}/nextjs-compat/action-node-mw.rsc`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "x-rsc-action": actionId,
      },
      body: JSON.stringify(["world"]),
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("x-nextjs-action-not-found")).toBeNull();
    expect(text).not.toContain("Server action not found");
    expect(text).toContain("echo:world");
  });

  // Ported from Next.js:
  // test/e2e/app-dir/actions/app-action-size-limit-invalid.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/actions/app-action-size-limit-invalid.test.ts
  it("returns a Flight error for a streamed server action body overflow", async () => {
    const html = await (await fetch(`${baseUrl}/nextjs-compat/action-node-mw`)).text();
    const refValue = html.match(/name="\$ACTION_[^"]*:0"\s+value="([^"]+)"/)?.[1];
    expect(refValue).toBeDefined();
    const decoded = refValue!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const actionId = JSON.parse(decoded).id as string;

    const oversizedPayload = JSON.stringify(["x".repeat(2 * 1024 * 1024)]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoded = new TextEncoder().encode(oversizedPayload);
        for (let offset = 0; offset < encoded.byteLength; offset += 64 * 1024) {
          controller.enqueue(encoded.subarray(offset, offset + 64 * 1024));
        }
        controller.close();
      },
    });

    const res = await fetch(`${baseUrl}/nextjs-compat/action-node-mw.rsc`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "x-rsc-action": actionId,
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/x-component");
    expect(text).not.toContain("echo:");
  });
});

describe("App Router production server entry module identity", () => {
  // Regression test for cloudflare/vinext#1923.
  //
  // Chunks emitted by default Vite builds — Rollup on Vite 7 and Rolldown on
  // Vite 8 — import the server entry back by its bare path: modules shared
  // between the entry's static graph (middleware, instrumentation) and lazy
  // route chunks are hoisted into the entry chunk, and the lazy chunks then
  // import them via "../../index.js" (e.g. a plain `vite@8.0.16` SSR build
  // of an entry-shared module emits `import { t as shared } from
  // "../entry.js"` in the lazy chunk).
  // Node keys its ESM cache on the full URL *including the query string*, so
  // while the production server imported the entry as `index.js?t=<mtime>`,
  // a chunk's bare back-import evaluated the entire server bundle a second
  // time. Module-level singletons (db pools, service registries) then
  // silently diverged between the two copies: boot-time initialisation ran
  // on the server's instance while route handlers read the duplicate.
  //
  // The Vite+ toolchain this repo builds with enables rolldown's
  // shared-chunk extraction, so this fixture build does not naturally emit
  // the back-import. Recreate the default-Vite layout by prepending a bare
  // entry import to the lazy route chunk before starting the server.
  it("evaluates the server bundle once even when a chunk imports the entry back by bare path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prod-entry-identity-"));
    const fixtureRoot = path.join(tmpDir, "fixture");
    const outDir = path.join(fixtureRoot, "dist");
    let server: import("node:http").Server | undefined;
    const EVAL_COUNT_KEY = "__vinext_test_entry_evaluations__";
    const previousPagesClientAssets = getPagesClientAssets();
    const prodGlobalKeys = [
      "__vite_rsc_client_require__",
      "__vite_rsc_require__",
      "__vite_rsc_server_require__",
      "__webpack_chunk_load__",
      "__webpack_require__",
    ];
    const previousGlobals = new Map(
      prodGlobalKeys.map((key) => [
        key,
        {
          exists: Reflect.has(globalThis, key),
          value: Reflect.get(globalThis, key),
        },
      ]),
    );

    try {
      fs.cpSync(APP_FIXTURE_DIR, fixtureRoot, { recursive: true });
      fs.rmSync(outDir, { recursive: true, force: true });
      const fixtureNodeModules = path.join(fixtureRoot, "node_modules");
      if (!fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(
          path.resolve(__dirname, "..", "node_modules"),
          fixtureNodeModules,
          "junction",
        );
      }

      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        plugins: [vinext({ appDir: fixtureRoot })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const serverDir = path.join(outDir, "server");
      const entryPath = path.join(serverDir, "index.js");

      // Count evaluations of the server entry chunk itself. Imports hoist, so
      // the prepended statement runs first in the entry's own body each time
      // the module is evaluated.
      fs.writeFileSync(
        entryPath,
        `globalThis.${EVAL_COUNT_KEY} = [...(globalThis.${EVAL_COUNT_KEY} ?? []), import.meta.url];\n` +
          fs.readFileSync(entryPath, "utf-8"),
      );

      // Recreate the Rollup chunk layout: the lazy chunk for
      // /api/prod-singleton imports the entry back by bare path.
      const staticDir = path.join(serverDir, "_next", "static");
      const routeChunkNames = fs
        .readdirSync(staticDir)
        .filter(
          (name) =>
            name.endsWith(".js") &&
            fs
              .readFileSync(path.join(staticDir, name), "utf-8")
              .includes("x-vinext-prod-singleton"),
        );
      expect(routeChunkNames).toHaveLength(1);
      const routeChunkPath = path.join(staticDir, routeChunkNames[0]);
      fs.writeFileSync(
        routeChunkPath,
        `import "../../index.js";\n` + fs.readFileSync(routeChunkPath, "utf-8"),
      );

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      ({ server } = await startProdServer({ port: 0, outDir, noCompression: true }));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      expect(Reflect.get(globalThis, EVAL_COUNT_KEY)).toHaveLength(1);

      const res = await fetch(`http://localhost:${port}/api/prod-singleton`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-vinext-prod-singleton")).toBe("1");
      const body = await res.json();

      // Loading the lazy route chunk pulled in the bare "../../index.js"
      // import; the server bundle must still have been evaluated only once.
      // (The recorded values are the import.meta.url of each evaluation, so
      // a failure shows which URLs the two module instances were keyed on.)
      expect(Reflect.get(globalThis, EVAL_COUNT_KEY)).toHaveLength(1);

      // The route handler reads the same module-level singleton instance
      // that boot-time instrumentation register() initialised. A duplicate
      // bundle instance would report null.
      expect(body).toEqual({ initializedBy: "instrumentation-register" });
    } finally {
      server?.close();
      Reflect.deleteProperty(globalThis, EVAL_COUNT_KEY);
      setPagesClientAssets(previousPagesClientAssets);
      for (const [key, previous] of previousGlobals) {
        if (previous.exists) {
          Reflect.set(globalThis, key, previous.value);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120000);
});
