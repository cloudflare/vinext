import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";
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

async function waitForCondition(
  condition: () => boolean,
  options?: { intervalMs?: number; timeoutMs?: number },
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 100;
  const deadline = Date.now() + (options?.timeoutMs ?? 3000);

  while (!condition()) {
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

  function extractRequestId(html: string): string | undefined {
    return (
      html.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1]
    );
  }

  beforeAll(async () => {
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
  }, 60000);

  afterAll(() => {
    server?.close();
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

  it("serves static assets with cache headers", async () => {
    // Find an actual hashed asset from the build (on disk under
    // `_next/static/`, matching `resolveAssetsDir("")`).
    const assetsDir = path.join(outDir, "client", "_next", "static");
    const assets = fs.readdirSync(assetsDir);
    const jsFile = assets.find((f: string) => f.endsWith(".js"));
    expect(jsFile).toBeDefined();

    const res = await fetch(`${baseUrl}/_next/static/${jsFile}`);
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
});
