/**
 * next/link shim unit tests.
 *
 * Mirrors test cases from Next.js test/unit/link-rendering.test.ts and
 * test/unit/link-warnings.test.tsx, plus additional coverage for vinext's
 * Link internals: resolveHref(), withBasePath(), applyLocaleToHref(), and
 * isHashOnlyChange().
 *
 * These tests verify SSR output matches Next.js expectations and that
 * pure helper functions work correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";

// We test the Link component and its internal helpers.
// Link is a "use client" component but renderToString still works for SSR output.
import Link, {
  canAutoPrefetchFullAppRoute,
  resolveAutoAppRoutePrefetch,
  resolveLinkPrefetchMode,
  useLinkStatus,
} from "../packages/vinext/src/shims/link.js";
import { navigatePagesRouterLink } from "../packages/vinext/src/client/pages-router-link-navigation.js";

// Internal helpers re-exported or accessible via the router shim
import { isExternalUrl, isHashOnlyChange } from "../packages/vinext/src/shims/router.js";

// Import server-only i18n state to register ALS-backed accessors before any
// rendering occurs (same as dev-server.ts and pages-server-entry.ts do).
import { runWithI18nState } from "../packages/vinext/src/shims/i18n-state.js";
import { setI18nContext } from "../packages/vinext/src/shims/i18n-context.js";

import {
  isAbsoluteOrProtocolRelativeUrl,
  isAbsoluteUrl,
  normalizePathTrailingSlash,
  resolveRelativeHref,
  toBrowserNavigationHref,
  toSameOriginAppPath,
  toSameOriginPath,
} from "../packages/vinext/src/shims/url-utils.js";

// ─── SSR rendering (mirrors Next.js test/unit/link-rendering.test.ts) ────

describe("Link rendering", () => {
  it("should render Link on its own", () => {
    // Next.js test: <Link href="/my-path">to another page</Link>
    // Expected: <a href="/my-path">to another page</a>
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/my-path" }, "to another page"),
    );
    expect(html).toContain('href="/my-path"');
    expect(html).toContain("to another page");
    // Should be an <a> tag
    expect(html).toMatch(/^<a\s/);
  });

  it("renders children as anchor content", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/about" }, "About Us"),
    );
    expect(html).toContain("About Us");
    expect(html).toContain('href="/about"');
  });

  it("renders with object href", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: { pathname: "/search", query: { q: "test" } } }, "Search"),
    );
    // resolveHref({ pathname: "/search", query: { q: "test" } }) -> "/search?q=test"
    expect(html).toContain('href="/search?q=test"');
  });

  it("renders object href with only query (defaults to /)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: { query: { tab: "settings" } } }, "Settings"),
    );
    expect(html).toContain('href="/?tab=settings"');
  });

  it("renders with as prop overriding href", () => {
    // Legacy pattern: href is the route pattern, as is the actual URL
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/user/[id]", as: "/user/42" }, "User 42"),
    );
    expect(html).toContain('href="/user/42"');
  });

  it("does not render passHref as an HTML attribute", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/test", passHref: true }, "Test"),
    );
    expect(html).not.toContain("passHref");
    expect(html).toContain('href="/test"');
  });

  it("does not render locale as an HTML attribute", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/test", locale: "fr" } as any, "Test"),
    );
    expect(html).not.toContain("locale=");
  });

  it("does not render shallow as an HTML attribute", () => {
    // Regression for #1332 sub-problem 3: the `shallow` boolean is consumed
    // by the click handler and must not leak onto the rendered <a>.
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/test", shallow: true }, "Test"),
    );
    expect(html).not.toContain("shallow");
    expect(html).toContain('href="/test"');
  });

  it("passes through standard anchor attributes", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Link,
        { href: "/test", className: "nav-link", id: "my-link", "aria-label": "Test link" },
        "Test",
      ),
    );
    expect(html).toContain('class="nav-link"');
    expect(html).toContain('id="my-link"');
    expect(html).toContain('aria-label="Test link"');
  });

  it("renders with React element children", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Link,
        { href: "/nested" },
        React.createElement("span", null, "Nested child"),
      ),
    );
    expect(html).toContain("<span>Nested child</span>");
    expect(html).toContain('href="/nested"');
  });
});

// ─── useLinkStatus ──────────────────────────────────────────────────────

describe("useLinkStatus", () => {
  it("returns { pending: false } by default", () => {
    let status: { pending: boolean } | undefined;
    function TestComponent() {
      status = useLinkStatus();
      return null;
    }
    ReactDOMServer.renderToString(React.createElement(TestComponent));
    expect(status).toEqual({ pending: false });
  });
});

describe("Link App Router prefetch mode", () => {
  it("distinguishes automatic prefetch from explicit full prefetch", () => {
    expect(resolveLinkPrefetchMode(undefined, false)).toBe("auto");
    expect(resolveLinkPrefetchMode(null, false)).toBe("auto");
    expect(resolveLinkPrefetchMode("auto", false)).toBe("auto");
    expect(resolveLinkPrefetchMode(true, false)).toBe("full");
    expect(resolveLinkPrefetchMode(false, false)).toBe("disabled");
    expect(resolveLinkPrefetchMode(true, true)).toBe("disabled");
  });

  it("allows automatic full RSC prefetch only for known static App Router routes", () => {
    const originalWindow = globalThis.window;
    (globalThis as any).window = {
      location: {
        href: "http://localhost/blog",
        origin: "http://localhost",
      },
      __VINEXT_LINK_PREFETCH_ROUTES__: [
        { canPrefetchLoadingShell: false, patternParts: ["about"], isDynamic: false },
        { canPrefetchLoadingShell: true, patternParts: ["blog", ":slug"], isDynamic: true },
        { canPrefetchLoadingShell: true, patternParts: ["docs", ":slug+"], isDynamic: true },
      ],
    };

    try {
      expect(canAutoPrefetchFullAppRoute("/about")).toBe(true);
      expect(canAutoPrefetchFullAppRoute("/blog/hello-world")).toBe(false);
      expect(canAutoPrefetchFullAppRoute("/docs/a/b")).toBe(false);
      expect(canAutoPrefetchFullAppRoute("/missing")).toBe(false);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    }
  });

  it("allows automatic dynamic App Router prefetches only as loading-boundary learning requests", () => {
    const originalWindow = globalThis.window;
    (globalThis as any).window = {
      location: {
        href: "http://localhost/blog",
        origin: "http://localhost",
      },
      __VINEXT_LINK_PREFETCH_ROUTES__: [
        { canPrefetchLoadingShell: false, patternParts: ["about"], isDynamic: false },
        { canPrefetchLoadingShell: true, patternParts: ["blog", ":slug"], isDynamic: true },
        { canPrefetchLoadingShell: false, patternParts: ["products", ":id"], isDynamic: true },
      ],
    };

    try {
      expect(resolveAutoAppRoutePrefetch("/about")).toEqual({
        cacheForNavigation: true,
        shouldPrefetch: true,
      });
      expect(resolveAutoAppRoutePrefetch("/blog/hello-world")).toEqual({
        cacheForNavigation: false,
        shouldPrefetch: true,
      });
      expect(resolveAutoAppRoutePrefetch("/products/1")).toEqual({
        cacheForNavigation: false,
        shouldPrefetch: false,
      });
      expect(resolveAutoAppRoutePrefetch("/missing")).toEqual({
        cacheForNavigation: false,
        shouldPrefetch: false,
      });
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    }
  });
});

// ─── resolveHref (internal helper, tested via component output) ─────────

describe("Link resolveHref", () => {
  it("string href passes through unchanged", () => {
    const html = ReactDOMServer.renderToString(React.createElement(Link, { href: "/about" }, "x"));
    expect(html).toContain('href="/about"');
  });

  it("object href with pathname and query", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Link,
        { href: { pathname: "/items", query: { page: "2", sort: "name" } } },
        "x",
      ),
    );
    // URLSearchParams preserves insertion order
    expect(html).toMatch(/href="\/items\?page=2&(?:amp;)?sort=name"/);
  });

  it("object href preserves array query values as repeated params", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Link,
        { href: { pathname: "/search", query: { tag: ["a", "b"], q: "x" } } },
        "x",
      ),
    );
    expect(html).toContain('href="/search?tag=a&amp;tag=b&amp;q=x"');
  });

  it("object href stringifies scalar query values like Next.js", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Link,
        {
          href: {
            pathname: "/search",
            query: { page: 2, draft: false, empty: null, missing: undefined, tag: ["a", "b"] },
          },
        },
        "x",
      ),
    );
    expect(html).toContain(
      'href="/search?page=2&amp;draft=false&amp;empty=&amp;missing=&amp;tag=a&amp;tag=b"',
    );
  });

  it("object href preserves an existing query string in pathname", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Link,
        { href: { pathname: "/items?lang=en", query: { page: "2", sort: "name" } } },
        "x",
      ),
    );
    expect(html).toMatch(/href="\/items\?lang=en&(?:amp;)?page=2&(?:amp;)?sort=name"/);
  });

  it("object href preserves hash fragments when pathname already has a query string", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Link,
        { href: { pathname: "/items?lang=en#results", query: { page: "2" } } },
        "x",
      ),
    );
    expect(html).toContain('href="/items?lang=en&amp;page=2#results"');
  });

  it("object href with only pathname", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: { pathname: "/dashboard" } }, "x"),
    );
    expect(html).toContain('href="/dashboard"');
  });
});

// ─── isExternalUrl ──────────────────────────────────────────────────────

describe("isExternalUrl", () => {
  it("detects http:// as external", () => {
    expect(isExternalUrl("http://example.com")).toBe(true);
  });

  it("detects https:// as external", () => {
    expect(isExternalUrl("https://example.com")).toBe(true);
  });

  it("detects protocol-relative // as external", () => {
    expect(isExternalUrl("//cdn.example.com/image.png")).toBe(true);
  });

  it("internal paths are not external", () => {
    expect(isExternalUrl("/about")).toBe(false);
    expect(isExternalUrl("/")).toBe(false);
    expect(isExternalUrl("about")).toBe(false);
  });

  it("hash-only is not external", () => {
    expect(isExternalUrl("#section")).toBe(false);
  });
});

// ─── isHashOnlyChange ───────────────────────────────────────────────────

describe("isHashOnlyChange", () => {
  it("returns true for #fragment", () => {
    expect(isHashOnlyChange("#foo")).toBe(true);
    expect(isHashOnlyChange("#")).toBe(true);
  });

  // Server-side (no window) — should return false for non-hash-only
  it("returns false for absolute paths on server", () => {
    expect(isHashOnlyChange("/other")).toBe(false);
  });
});

// ─── applyLocaleToHref (tested via component output) ────────────────────

describe("Link locale handling", () => {
  const originalWindow = globalThis.window;
  const originalNextData = (globalThis as any).__NEXT_DATA__;
  const originalDomainLocales = (globalThis as any).__VINEXT_DOMAIN_LOCALES__;
  const originalHostname = (globalThis as any).__VINEXT_HOSTNAME__;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
    if (originalNextData === undefined) {
      delete (globalThis as any).__NEXT_DATA__;
    } else {
      (globalThis as any).__NEXT_DATA__ = originalNextData;
    }
    if (originalDomainLocales === undefined) {
      delete (globalThis as any).__VINEXT_DOMAIN_LOCALES__;
    } else {
      (globalThis as any).__VINEXT_DOMAIN_LOCALES__ = originalDomainLocales;
    }
    if (originalHostname === undefined) {
      delete (globalThis as any).__VINEXT_HOSTNAME__;
    } else {
      (globalThis as any).__VINEXT_HOSTNAME__ = originalHostname;
    }
  });

  it("locale=false keeps href as-is", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/about", locale: false } as any, "x"),
    );
    expect(html).toContain('href="/about"');
  });

  it("locale=undefined keeps href as-is", () => {
    const html = ReactDOMServer.renderToString(React.createElement(Link, { href: "/about" }, "x"));
    expect(html).toContain('href="/about"');
  });

  it("locale=undefined uses the current non-default locale", async () => {
    delete (globalThis as any).window;

    const html = await runWithI18nState(async () => {
      setI18nContext({
        locale: "id",
        locales: ["en", "id"],
        defaultLocale: "en",
      });
      return ReactDOMServer.renderToString(React.createElement(Link, { href: "/" }, "x"));
    });

    expect(html).toContain('href="/id"');
  });

  it("locale string prepends locale prefix", () => {
    // When locale is a non-default locale string, it prepends /{locale}
    // Note: default locale check uses __VINEXT_DEFAULT_LOCALE__ which is undefined in tests
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/about", locale: "fr" } as any, "x"),
    );
    expect(html).toContain('href="/fr/about"');
  });

  it("locale string does not double-prefix", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/fr/about", locale: "fr" } as any, "x"),
    );
    // Should not become /fr/fr/about
    expect(html).toContain('href="/fr/about"');
  });

  it("locale does not mangle absolute same-origin URLs", () => {
    // An absolute URL like https://example.com/about should not become
    // /fr/https://example.com/about — locale prefix only applies to paths
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "https://example.com/about", locale: "fr" } as any, "x"),
    );
    expect(html).toContain('href="https://example.com/about"');
  });

  it("locale does not mangle protocol-relative URLs", () => {
    // //example.com/about should not become /fr///example.com/about
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "//example.com/about", locale: "fr" } as any, "x"),
    );
    expect(html).toContain('href="//example.com/about"');
  });

  it("locale does not mangle http:// URLs", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "http://example.com/path", locale: "de" } as any, "x"),
    );
    expect(html).toContain('href="http://example.com/path"');
  });

  it("locale does not mangle native URI schemes", () => {
    const cases = ["mailto:hello@example.com", "tel:+123456789", "sms:+123456789"];

    for (const href of cases) {
      const html = ReactDOMServer.renderToString(
        React.createElement(Link, { href, locale: "fr" } as any, "x"),
      );
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("locale string uses configured locale domains for cross-domain links", () => {
    (globalThis as any).window = {
      __VINEXT_DEFAULT_LOCALE__: "en",
      __NEXT_DATA__: {
        domainLocales: [
          { domain: "example.com", defaultLocale: "en" },
          { domain: "example.fr", defaultLocale: "fr", http: true },
        ],
        locale: "en",
        defaultLocale: "en",
      },
      location: {
        protocol: "https:",
        hostname: "example.com",
        host: "example.com",
      },
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/about", locale: "fr" } as any, "x"),
    );

    expect(html).toContain('href="http://example.fr/about"');
  });

  it("uses configured locale domains during SSR output", () => {
    delete (globalThis as any).window;
    setI18nContext({
      defaultLocale: "en",
      domainLocales: [
        { domain: "example.com", defaultLocale: "en" },
        { domain: "example.fr", defaultLocale: "fr", http: true },
      ],
      hostname: "example.com",
    });

    try {
      const html = ReactDOMServer.renderToString(
        React.createElement(Link, { href: "/about", locale: "fr" } as any, "x"),
      );

      expect(html).toContain('href="http://example.fr/about"');
    } finally {
      setI18nContext(null);
    }
  });

  it("uses configured locale domains with basePath for cross-domain links", async () => {
    const originalBasePath = process.env.__NEXT_ROUTER_BASEPATH;
    process.env.__NEXT_ROUTER_BASEPATH = "/app";
    vi.resetModules();

    try {
      const { default: LinkWithBasePath } = await import("../packages/vinext/src/shims/link.js");
      (globalThis as any).window = {
        __VINEXT_DEFAULT_LOCALE__: "en",
        __NEXT_DATA__: {
          domainLocales: [
            { domain: "example.com", defaultLocale: "en" },
            { domain: "example.fr", defaultLocale: "fr", http: true },
          ],
        },
        location: {
          hostname: "example.com",
        },
      };

      const html = ReactDOMServer.renderToString(
        React.createElement(LinkWithBasePath, { href: "/about", locale: "fr" } as any, "x"),
      );

      expect(html).toContain('href="http://example.fr/app/about"');
    } finally {
      if (originalBasePath === undefined) {
        delete process.env.__NEXT_ROUTER_BASEPATH;
      } else {
        process.env.__NEXT_ROUTER_BASEPATH = originalBasePath;
      }
      vi.resetModules();
    }
  });

  it("passes locale=false through the Pages Router Link handoff", async () => {
    const push = vi.fn(async () => true);
    const replace = vi.fn(async () => true);

    await navigatePagesRouterLink(
      { push, replace },
      { href: "/", replace: false, scroll: true, locale: false },
    );

    expect(push).toHaveBeenCalledWith("/", undefined, { scroll: true, locale: false });
    expect(replace).not.toHaveBeenCalled();
  });

  it("passes explicit locale through the Pages Router Link handoff", async () => {
    const push = vi.fn(async () => true);
    const replace = vi.fn(async () => true);

    await navigatePagesRouterLink(
      { push, replace },
      { href: "/fr/about", replace: false, scroll: true, locale: "fr" },
    );

    expect(push).toHaveBeenCalledWith("/fr/about", undefined, { scroll: true, locale: "fr" });
    expect(replace).not.toHaveBeenCalled();
  });

  // Regression for #1332 sub-problem 3: `<Link shallow>` must reach
  // Router.push with `shallow: true` so the Pages Router skips the
  // _next/data fetch and only updates the URL. Mirrors Next.js's
  // test/e2e/middleware-trailing-slash shallow-link assertion at
  // packages/next/src/client/link.tsx.
  it("forwards shallow=true through the Pages Router Link handoff (push)", async () => {
    const push = vi.fn(async () => true);
    const replace = vi.fn(async () => true);

    await navigatePagesRouterLink(
      { push, replace },
      { href: "/sha?hello=world", replace: false, scroll: true, shallow: true },
    );

    expect(push).toHaveBeenCalledWith("/sha?hello=world", undefined, {
      scroll: true,
      locale: undefined,
      shallow: true,
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("forwards shallow=true through the Pages Router Link handoff (replace)", async () => {
    const push = vi.fn(async () => true);
    const replace = vi.fn(async () => true);

    await navigatePagesRouterLink(
      { push, replace },
      { href: "/sha?hello=world", replace: true, scroll: true, shallow: true },
    );

    expect(replace).toHaveBeenCalledWith("/sha?hello=world", undefined, {
      scroll: true,
      locale: undefined,
      shallow: true,
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("forwards shallow=false explicitly when the default is used", async () => {
    const push = vi.fn(async () => true);
    const replace = vi.fn(async () => true);

    await navigatePagesRouterLink(
      { push, replace },
      { href: "/sha", replace: false, scroll: true, shallow: false },
    );

    expect(push).toHaveBeenCalledWith("/sha", undefined, {
      scroll: true,
      locale: undefined,
      shallow: false,
    });
  });

  it("omits shallow from router options when the caller does not pass it", async () => {
    const push = vi.fn(async () => true);
    const replace = vi.fn(async () => true);

    await navigatePagesRouterLink({ push, replace }, { href: "/", replace: false, scroll: true });

    expect(push).toHaveBeenCalledWith("/", undefined, { scroll: true, locale: undefined });
  });
});

// ─── i18n ALS isolation ─────────────────────────────────────────────────
// Verifies that concurrent SSR renders with different i18n contexts
// don't leak locale state between requests.

describe("Link i18n ALS isolation", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  });

  it("concurrent renders in different ALS scopes see their own locale context", async () => {
    delete (globalThis as any).window;

    // Simulate two concurrent requests with different locales.
    // Each runs in its own ALS scope. If the state leaked via globalThis,
    // the second request's locale would overwrite the first's.
    const results = await Promise.all([
      runWithI18nState(async () => {
        setI18nContext({
          defaultLocale: "en",
          domainLocales: [
            { domain: "example.com", defaultLocale: "en" },
            { domain: "example.fr", defaultLocale: "fr", http: true },
          ],
          hostname: "example.com",
        });
        // Yield to let the other scope set its context
        await new Promise((r) => setTimeout(r, 5));
        return ReactDOMServer.renderToString(
          React.createElement(Link, { href: "/about", locale: "fr" } as any, "x"),
        );
      }),
      runWithI18nState(async () => {
        setI18nContext({
          defaultLocale: "de",
          domainLocales: [
            { domain: "example.de", defaultLocale: "de" },
            { domain: "example.jp", defaultLocale: "ja", http: true },
          ],
          hostname: "example.de",
        });
        await new Promise((r) => setTimeout(r, 5));
        return ReactDOMServer.renderToString(
          React.createElement(Link, { href: "/about", locale: "ja" } as any, "x"),
        );
      }),
    ]);

    // Request 1 (en domain, switching to fr) should link to example.fr
    expect(results[0]).toContain('href="http://example.fr/about"');
    // Request 2 (de domain, switching to ja) should link to example.jp
    expect(results[1]).toContain('href="http://example.jp/about"');
  });

  it("SSR locale prefix uses ALS-scoped defaultLocale, not stale globalThis", async () => {
    delete (globalThis as any).window;

    const results = await Promise.all([
      runWithI18nState(async () => {
        // defaultLocale "en" → locale "fr" should get /fr prefix
        setI18nContext({ defaultLocale: "en" });
        await new Promise((r) => setTimeout(r, 5));
        return ReactDOMServer.renderToString(
          React.createElement(Link, { href: "/about", locale: "fr" } as any, "x"),
        );
      }),
      runWithI18nState(async () => {
        // defaultLocale "fr" → locale "fr" should NOT get prefix (it's the default)
        setI18nContext({ defaultLocale: "fr" });
        await new Promise((r) => setTimeout(r, 5));
        return ReactDOMServer.renderToString(
          React.createElement(Link, { href: "/about", locale: "fr" } as any, "x"),
        );
      }),
    ]);

    // First scope: fr is non-default, so it gets /fr prefix
    expect(results[0]).toContain('href="/fr/about"');
    // Second scope: fr IS the default, so no prefix
    expect(results[1]).toContain('href="/about"');
  });
});

// ─── toSameOriginPath ────────────────────────────────────────────────────
// Tests for the shared same-origin URL normalization utility.
// Related to: https://github.com/cloudflare/vinext/issues/335

describe("toSameOriginPath", () => {
  it("returns null on the server (no window)", () => {
    // In vitest (Node.js), typeof window === 'undefined' by default
    // unless jsdom is configured. Our tests run in node env.
    expect(toSameOriginPath("https://example.com/path")).toBe(null);
  });

  it("returns null for invalid URLs", () => {
    expect(toSameOriginPath("not a url")).toBe(null);
  });

  describe("with window (client-side)", () => {
    const originalWindow = globalThis.window;

    beforeEach(() => {
      // Simulate a browser window with a known origin
      (globalThis as any).window = {
        location: {
          origin: "http://localhost:3000",
          href: "http://localhost:3000/current",
        },
      };
    });

    afterEach(() => {
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    });

    it("returns pathname for same-origin http:// URL", () => {
      expect(toSameOriginPath("http://localhost:3000/about")).toBe("/about");
    });

    it("returns pathname + search + hash for same-origin URL", () => {
      expect(toSameOriginPath("http://localhost:3000/search?q=test#results")).toBe(
        "/search?q=test#results",
      );
    });

    it("returns null for cross-origin URL", () => {
      expect(toSameOriginPath("https://example.com/path")).toBe(null);
    });

    it("returns pathname for same-origin protocol-relative URL", () => {
      // //localhost:3000/about resolves to the page's protocol + localhost:3000
      expect(toSameOriginPath("//localhost:3000/about")).toBe("/about");
    });

    it("returns null for cross-origin protocol-relative URL", () => {
      expect(toSameOriginPath("//other.com/path")).toBe(null);
    });

    it("preserves the root path /", () => {
      expect(toSameOriginPath("http://localhost:3000/")).toBe("/");
    });

    it("returns null for different port (different origin)", () => {
      expect(toSameOriginPath("http://localhost:5173/about")).toBe(null);
    });

    it("returns null for same host but different scheme (different origin)", () => {
      expect(toSameOriginPath("https://localhost:3000/about")).toBe(null);
    });
  });
});

describe("absolute URL classification", () => {
  it("matches Next.js scheme classification for native URI schemes", () => {
    expect(isAbsoluteUrl("mailto:hello@example.com")).toBe(true);
    expect(isAbsoluteUrl("tel:+123456789")).toBe(true);
    expect(isAbsoluteUrl("sms:+123456789")).toBe(true);
    expect(isAbsoluteUrl("ftp://example.com/file")).toBe(true);
    expect(isAbsoluteUrl("/local")).toBe(false);
    expect(isAbsoluteUrl("?page=2")).toBe(false);
    expect(isAbsoluteUrl("#section")).toBe(false);
    expect(isAbsoluteUrl("//example.com/path")).toBe(false);
  });

  it("treats protocol-relative URLs as browser-owned absolute-like hrefs", () => {
    expect(isAbsoluteOrProtocolRelativeUrl("//example.com/path")).toBe(true);
    expect(isAbsoluteOrProtocolRelativeUrl("mailto:hello@example.com")).toBe(true);
    expect(isAbsoluteOrProtocolRelativeUrl("/local")).toBe(false);
  });
});

describe("resolveRelativeHref", () => {
  it("resolves relative search params against the current page", () => {
    expect(resolveRelativeHref("?page=2", "http://localhost:3000/posts/1")).toBe("/posts/1?page=2");
  });

  it("preserves the current pathname and search when resolving hash-only hrefs", () => {
    expect(resolveRelativeHref("#comments", "http://localhost:3000/posts/1?page=2")).toBe(
      "/posts/1?page=2#comments",
    );
  });

  it("resolves dot-segment relative paths against the current page", () => {
    expect(resolveRelativeHref("../archive?year=2026", "http://localhost:3000/blog/post-1")).toBe(
      "/archive?year=2026",
    );
  });

  it("leaves absolute paths unchanged", () => {
    expect(resolveRelativeHref("/about", "http://localhost:3000/posts/1")).toBe("/about");
  });

  it("leaves native URI schemes unchanged", () => {
    expect(resolveRelativeHref("mailto:hello@example.com", "http://localhost:3000/posts/1")).toBe(
      "mailto:hello@example.com",
    );
  });

  it("strips the current basePath before returning the app-relative href", () => {
    expect(resolveRelativeHref("?page=2", "http://localhost:3000/base/fr/posts/1", "/base")).toBe(
      "/fr/posts/1?page=2",
    );
  });
});

describe("toBrowserNavigationHref", () => {
  it("keeps relative hrefs aligned with basePath and locale-prefixed browser URLs", () => {
    expect(
      toBrowserNavigationHref("?page=2", "http://localhost:3000/base/fr/posts/1", "/base"),
    ).toBe("/base/fr/posts/1?page=2");
  });

  it("does not add a trailing slash for query/hash-only navigations from the bare basePath root", () => {
    expect(toBrowserNavigationHref("?page=2", "http://localhost:3000/base", "/base")).toBe(
      "/base?page=2",
    );
    expect(toBrowserNavigationHref("#comments", "http://localhost:3000/base", "/base")).toBe(
      "/base#comments",
    );
  });

  it("does not double-prefix same-origin absolute URLs that already include the basePath", () => {
    const originalWindow = globalThis.window;
    (globalThis as any).window = {
      location: {
        origin: "http://localhost:3000",
        href: "http://localhost:3000/base/posts/1",
      },
    };

    try {
      const normalized = toSameOriginAppPath("http://localhost:3000/base/about", "/base");
      expect(normalized).toBe("/about");
      expect(
        toBrowserNavigationHref(normalized!, "http://localhost:3000/base/posts/1", "/base"),
      ).toBe("/base/about");
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    }
  });

  it("still prefixes app-relative paths that happen to start with the basePath segment", () => {
    expect(
      toBrowserNavigationHref("/docs/getting-started", "http://localhost:3000/docs", "/docs"),
    ).toBe("/docs/docs/getting-started");
  });
});

// ─── Link with same-origin absolute URL (SSR rendering) ─────────────────
// Verifies that <Link href="http://..."> renders the absolute URL as the
// href attribute (the normalization happens at click time, not render time).

describe("Link with absolute URL", () => {
  it("renders absolute http:// URL as href", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "http://example.com/path" }, "External"),
    );
    // The <a> tag should have the full absolute URL as href
    expect(html).toContain('href="http://example.com/path"');
  });

  it("renders absolute https:// URL as href", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "https://example.com/path" }, "Secure External"),
    );
    expect(html).toContain('href="https://example.com/path"');
  });

  it("preserves relative href rendering under basePath while still prefixing absolute paths", async () => {
    const previousBasePath = process.env.__NEXT_ROUTER_BASEPATH;
    process.env.__NEXT_ROUTER_BASEPATH = "/base";
    vi.resetModules();

    try {
      const { default: BasePathLink } = await import("../packages/vinext/src/shims/link.js");

      const relativeHtml = ReactDOMServer.renderToString(
        React.createElement(BasePathLink, { href: "?page=2" }, "Relative Query"),
      );
      expect(relativeHtml).toContain('href="?page=2"');

      const absoluteHtml = ReactDOMServer.renderToString(
        React.createElement(BasePathLink, { href: "/about" }, "About"),
      );
      expect(absoluteHtml).toContain('href="/base/about"');

      const sharedPrefixHtml = ReactDOMServer.renderToString(
        React.createElement(BasePathLink, { href: "/base/getting-started" }, "Shared Prefix"),
      );
      expect(sharedPrefixHtml).toContain('href="/base/base/getting-started"');
    } finally {
      if (previousBasePath === undefined) {
        delete process.env.__NEXT_ROUTER_BASEPATH;
      } else {
        process.env.__NEXT_ROUTER_BASEPATH = previousBasePath;
      }
      vi.resetModules();
    }
  });
});

describe("toSameOriginAppPath", () => {
  it("strips the configured basePath from same-origin absolute URLs", () => {
    const originalWindow = globalThis.window;
    (globalThis as any).window = {
      location: {
        origin: "http://localhost:3000",
        href: "http://localhost:3000/base/posts/1",
      },
    };

    try {
      expect(toSameOriginAppPath("http://localhost:3000/base/about", "/base")).toBe("/about");
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    }
  });

  it("treats same-origin URLs outside the configured basePath as external", () => {
    const originalWindow = globalThis.window;
    (globalThis as any).window = {
      location: {
        origin: "http://localhost:3000",
        href: "http://localhost:3000/base/posts/1",
      },
    };

    try {
      expect(toSameOriginAppPath("http://localhost:3000/other", "/base")).toBeNull();
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    }
  });
});

// ─── normalizePathTrailingSlash ─────────────────────────────────────────
//
// Ports the behaviour of Next.js's client `normalizePathTrailingSlash`:
//   packages/next/src/client/normalize-trailing-slash.ts
// Validates Link `href` rewriting expectations from upstream e2e:
//   test/e2e/trailing-slashes/with-trailing-slash.test.ts
//   test/e2e/trailing-slashes/without-trailing-slash.test.ts

describe("normalizePathTrailingSlash", () => {
  describe("trailingSlash: true", () => {
    it("adds a trailing slash to a path without one", () => {
      expect(normalizePathTrailingSlash("/about", true)).toBe("/about/");
    });

    it("is idempotent for already-canonical paths", () => {
      expect(normalizePathTrailingSlash("/about/", true)).toBe("/about/");
    });

    it("leaves the bare root unchanged", () => {
      expect(normalizePathTrailingSlash("/", true)).toBe("/");
    });

    it("preserves query strings", () => {
      expect(normalizePathTrailingSlash("/about?hello=world", true)).toBe("/about/?hello=world");
      expect(normalizePathTrailingSlash("/about/?hello=world", true)).toBe("/about/?hello=world");
    });

    it("preserves hash fragments", () => {
      expect(normalizePathTrailingSlash("/about#section", true)).toBe("/about/#section");
      expect(normalizePathTrailingSlash("/about/#section", true)).toBe("/about/#section");
    });

    it("preserves query + hash", () => {
      expect(normalizePathTrailingSlash("/about?x=1#y", true)).toBe("/about/?x=1#y");
    });

    it("strips trailing slash from filename-looking paths", () => {
      // Matches Next.js's routes-manifest rule: paths ending in `.ext` are
      // treated as files and keep the no-trailing-slash form.
      expect(normalizePathTrailingSlash("/catch-all/hello.world/", true)).toBe(
        "/catch-all/hello.world",
      );
      expect(normalizePathTrailingSlash("/catch-all/hello.world", true)).toBe(
        "/catch-all/hello.world",
      );
    });

    it("returns absolute URLs unchanged", () => {
      // Only paths that start with `/` are touched; absolute URLs with a
      // scheme are skipped entirely (matches Next.js behaviour).
      expect(normalizePathTrailingSlash("https://nextjs.org", true)).toBe("https://nextjs.org");
      expect(normalizePathTrailingSlash("https://nextjs.org/", true)).toBe("https://nextjs.org/");
    });
  });

  describe("trailingSlash: false", () => {
    it("strips a trailing slash from a non-root path", () => {
      expect(normalizePathTrailingSlash("/about/", false)).toBe("/about");
    });

    it("is idempotent for already-canonical paths", () => {
      expect(normalizePathTrailingSlash("/about", false)).toBe("/about");
    });

    it("leaves the bare root unchanged", () => {
      expect(normalizePathTrailingSlash("/", false)).toBe("/");
    });

    it("preserves query strings", () => {
      expect(normalizePathTrailingSlash("/about/?hello=world", false)).toBe("/about?hello=world");
      expect(normalizePathTrailingSlash("/about?hello=world", false)).toBe("/about?hello=world");
    });

    it("preserves hash fragments", () => {
      expect(normalizePathTrailingSlash("/about/#section", false)).toBe("/about#section");
      expect(normalizePathTrailingSlash("/about#section", false)).toBe("/about#section");
    });

    it("returns absolute URLs unchanged", () => {
      expect(normalizePathTrailingSlash("https://nextjs.org/", false)).toBe("https://nextjs.org/");
      expect(normalizePathTrailingSlash("https://nextjs.org", false)).toBe("https://nextjs.org");
    });
  });
});

// ─── Link href trailing-slash rendering ─────────────────────────────────
//
// Ports cases from upstream `testLinkShouldRewriteTo` in:
//   test/e2e/trailing-slashes/with-trailing-slash.test.ts
//   test/e2e/trailing-slashes/without-trailing-slash.test.ts
//
// Note: the build-time define `process.env.__VINEXT_TRAILING_SLASH` is what
// drives this in real builds. Tests run with the unbuilt source and therefore
// observe the `trailingSlash: false` default (env var is unset). That is the
// inverse half of the upstream matrix — the `with-trailing-slash` direction
// is covered by `normalizePathTrailingSlash` above and exercised end-to-end
// in CI.

describe("Link href trailing-slash (trailingSlash: false default)", () => {
  it("strips a trailing slash from the rendered href", () => {
    const html = ReactDOMServer.renderToString(React.createElement(Link, { href: "/about/" }, "x"));
    expect(html).toContain('href="/about"');
  });

  it("preserves query when stripping the trailing slash", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/about/?hello=world" }, "x"),
    );
    expect(html).toContain('href="/about?hello=world"');
  });

  it("preserves the bare root", () => {
    const html = ReactDOMServer.renderToString(React.createElement(Link, { href: "/" }, "x"));
    expect(html).toContain('href="/"');
  });

  it("leaves filename-looking paths untouched", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/catch-all/hello.world" }, "x"),
    );
    expect(html).toContain('href="/catch-all/hello.world"');
  });

  it("leaves absolute URLs unchanged", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "https://nextjs.org" }, "x"),
    );
    expect(html).toContain('href="https://nextjs.org"');

    const trailing = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "https://nextjs.org/" }, "x"),
    );
    expect(trailing).toContain('href="https://nextjs.org/"');
  });
});
