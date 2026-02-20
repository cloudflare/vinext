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
import { describe, it, expect } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";

// We test the Link component and its internal helpers.
// Link is a "use client" component but renderToString still works for SSR output.
import Link, { useLinkStatus } from "../packages/vinext/src/shims/link.js";

// Internal helpers re-exported or accessible via the router shim
import { isExternalUrl, isHashOnlyChange } from "../packages/vinext/src/shims/router.js";

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
      React.createElement(
        Link,
        { href: { pathname: "/search", query: { q: "test" } } },
        "Search",
      ),
    );
    // resolveHref({ pathname: "/search", query: { q: "test" } }) -> "/search?q=test"
    expect(html).toContain('href="/search?q=test"');
  });

  it("renders object href with only query (defaults to /)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Link,
        { href: { query: { tab: "settings" } } },
        "Settings",
      ),
    );
    expect(html).toContain('href="/?tab=settings"');
  });

  it("renders with as prop overriding href", () => {
    // Legacy pattern: href is the route pattern, as is the actual URL
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Link,
        { href: "/user/[id]", as: "/user/42" },
        "User 42",
      ),
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
    expect(html).not.toContain('locale=');
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

// ─── resolveHref (internal helper, tested via component output) ─────────

describe("Link resolveHref", () => {
  it("string href passes through unchanged", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/about" }, "x"),
    );
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

  it("object href with only pathname", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Link,
        { href: { pathname: "/dashboard" } },
        "x",
      ),
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
  it("locale=false keeps href as-is", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/about", locale: false } as any, "x"),
    );
    expect(html).toContain('href="/about"');
  });

  it("locale=undefined keeps href as-is", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Link, { href: "/about" }, "x"),
    );
    expect(html).toContain('href="/about"');
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
});
