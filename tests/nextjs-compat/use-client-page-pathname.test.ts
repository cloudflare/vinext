/**
 * Regression test for issue #688: usePathname() returns "/" during SSR when
 * the page component itself is a "use client" component.
 *
 * Unlike the nav-context-hydration fixture (where the page is a Server
 * Component rendering a "use client" child), this fixture has the page
 * component itself marked as "use client". This exercises a different module
 * resolution path in Vite's SSR environment — the page module is resolved as
 * a client reference by the RSC entry and rendered entirely in the SSR module
 * runner.
 *
 * Without the fix, usePathname() falls back to "/" because the "use client"
 * page's module instance of navigation.ts may not have the ALS-backed state
 * accessors registered (they were only registered on the SSR entry's instance).
 *
 * Fixture: tests/fixtures/app-basic/app/use-client-page-pathname/
 *   page.tsx       — "use client" page: usePathname(), useSearchParams()
 *   [slug]/page.tsx — "use client" dynamic page: + useParams()
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

let _server: ViteDevServer;
let _baseUrl: string;

const ROUTE = "/use-client-page-pathname";

beforeAll(async () => {
  ({ server: _server, baseUrl: _baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
    appRouter: true,
  }));

  // Warm up so first test doesn't pay cold-start cost.
  const warmup = await fetch(`${_baseUrl}${ROUTE}`);
  expect(warmup.ok).toBe(true);
}, 60_000);

afterAll(async () => {
  await _server?.close();
});

// ── Static route: "use client" page with usePathname() ────────────────────

describe('"use client" page component: usePathname() SSR (issue #688)', () => {
  it("SSR HTML contains correct pathname (not /)", async () => {
    const res = await fetch(`${_baseUrl}${ROUTE}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // The page component calls usePathname() and renders it into #client-page-pathname.
    // During SSR, this must be the actual request pathname, not "/".
    expect(html).toContain(`<span id="client-page-pathname">${ROUTE}</span>`);
  });

  it("__VINEXT_RSC_NAV__ pathname matches SSR-rendered usePathname()", async () => {
    const res = await fetch(`${_baseUrl}${ROUTE}`);
    const html = await res.text();

    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match, "__VINEXT_RSC_NAV__ script tag not found").toBeTruthy();
    const nav = JSON.parse(match![1]);

    expect(nav.pathname).toBe(ROUTE);
  });

  it("SSR HTML contains correct searchParams with query string", async () => {
    const res = await fetch(`${_baseUrl}${ROUTE}?q=hello&page=2`);
    const html = await res.text();

    expect(html).toContain('<span id="client-page-search-q">hello</span>');
    expect(html).toContain('<span id="client-page-search-string">q=hello&amp;page=2</span>');
  });

  it("__VINEXT_RSC_NAV__ searchParams matches query string", async () => {
    const res = await fetch(`${_baseUrl}${ROUTE}?q=test`);
    const html = await res.text();

    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match).toBeTruthy();
    const nav = JSON.parse(match![1]);
    const sp = new URLSearchParams(nav.searchParams);

    expect(sp.get("q")).toBe("test");
  });

  // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
  it("adds CSP nonce to inline hydration and bootstrap scripts", async () => {
    const res = await fetch(`${_baseUrl}${ROUTE}?csp-nonce=1`);
    expect(res.headers.get("content-security-policy")).toBe(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    const html = await res.text();

    expect(html).toContain(
      '<script nonce="vinext-test-nonce">self.__VINEXT_RSC_PARAMS__={}</script>',
    );
    expect(html).toContain(
      `<script nonce="vinext-test-nonce">self.__VINEXT_RSC_NAV__={"pathname":"${ROUTE}","searchParams":[["csp-nonce","1"]]}</script>`,
    );
    expect(html).toContain(
      '<script nonce="vinext-test-nonce">self.__VINEXT_RSC_CHUNKS__=self.__VINEXT_RSC_CHUNKS__||[];self.__VINEXT_RSC_CHUNKS__.push(',
    );
    expect(html).toContain(
      '<script nonce="vinext-test-nonce">self.__VINEXT_RSC_DONE__=true</script>',
    );
    expect(html).toMatch(/<link rel="modulepreload" nonce="vinext-test-nonce" href="[^"]+"/);

    const scriptTags = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag).toContain('nonce="vinext-test-nonce"');
    }

    const preloadLikeTags = [
      ...html.matchAll(/<link\b[^>]*rel="(?:preload|modulepreload)"[^>]*>/g),
    ].map((match) => match[0]);
    expect(preloadLikeTags.length).toBeGreaterThan(0);
    for (const tag of preloadLikeTags) {
      expect(tag).toContain('nonce="vinext-test-nonce"');
    }
  });

  // Ported from Next.js: test/production/app-dir/subresource-integrity/subresource-integrity.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/production/app-dir/subresource-integrity/subresource-integrity.test.ts
  it("reads nonce from the incoming Content-Security-Policy request header", async () => {
    const res = await fetch(`${_baseUrl}${ROUTE}`, {
      headers: {
        "content-security-policy": "script-src 'nonce-request-header' 'strict-dynamic';",
      },
    });
    const html = await res.text();

    expect(html).toContain('<script nonce="request-header">self.__VINEXT_RSC_PARAMS__={}</script>');
  });

  it("returns 500 when the nonce contains HTML escape characters", async () => {
    const res = await fetch(`${_baseUrl}${ROUTE}`, {
      headers: {
        "content-security-policy": `script-src 'nonce-"><script></script>"'`,
      },
    });

    expect(res.status).toBe(500);
  });
});

// ── Dynamic route: "use client" page with useParams() ─────────────────────

describe('"use client" dynamic page: usePathname() + useParams() SSR', () => {
  const dynamicPath = `${ROUTE}/my-slug`;

  it("SSR HTML contains correct pathname for dynamic route", async () => {
    const res = await fetch(`${_baseUrl}${dynamicPath}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain(`<span id="client-page-dynamic-pathname">${dynamicPath}</span>`);
  });

  it("SSR HTML contains correct slug param", async () => {
    const res = await fetch(`${_baseUrl}${dynamicPath}`);
    const html = await res.text();

    expect(html).toContain('<span id="client-page-dynamic-slug">my-slug</span>');
  });

  it("__VINEXT_RSC_PARAMS__ contains slug for dynamic route", async () => {
    const res = await fetch(`${_baseUrl}${dynamicPath}`);
    const html = await res.text();

    const match = html.match(/self\.__VINEXT_RSC_PARAMS__=(\{[^<]*\})/);
    expect(match, "__VINEXT_RSC_PARAMS__ script tag not found").toBeTruthy();
    const params = JSON.parse(match![1]);

    expect(params.slug).toBe("my-slug");
  });

  it("__VINEXT_RSC_NAV__ pathname is correct for dynamic route", async () => {
    const res = await fetch(`${_baseUrl}${dynamicPath}`);
    const html = await res.text();

    const match = html.match(/self\.__VINEXT_RSC_NAV__=(\{[^<]+\})/);
    expect(match).toBeTruthy();
    const nav = JSON.parse(match![1]);

    expect(nav.pathname).toBe(dynamicPath);
  });
});
