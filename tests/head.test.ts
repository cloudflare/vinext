/**
 * next/head shim unit tests.
 *
 * Mirrors test cases from Next.js test/unit/next-head-rendering.test.ts,
 * plus comprehensive coverage for vinext's Head SSR collection, HTML
 * generation, allowed tags, and escaping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Head, {
  resetSSRHead,
  getSSRHeadHTML,
  escapeAttr,
} from "../packages/vinext/src/shims/head.js";

// ─── SSR rendering (mirrors Next.js test/unit/next-head-rendering.test.ts) ──

describe("Rendering next/head", () => {
  beforeEach(() => {
    resetSSRHead();
  });

  it("should render outside of Next.js without error", () => {
    // Next.js test: renderToString(<><Head /><p>hello world</p></>)
    // Verifies Head doesn't throw when used standalone
    const html = ReactDOMServer.renderToString(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Head, null),
        React.createElement("p", null, "hello world"),
      ),
    );
    expect(html).toContain("hello world");
  });

  it("returns null (no rendered output in body)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Head, null, React.createElement("title", null, "My Page")),
    );
    // Head always returns null — elements are collected, not rendered inline
    expect(html).toBe("");
  });
});

// ─── SSR head collection ────────────────────────────────────────────────

describe("Head SSR collection", () => {
  beforeEach(() => {
    resetSSRHead();
  });

  it("collects title element", () => {
    ReactDOMServer.renderToString(
      React.createElement(Head, null, React.createElement("title", null, "My Page Title")),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain("<title");
    expect(headHtml).toContain("My Page Title");
    expect(headHtml).toContain("</title>");
    expect(headHtml).toContain('data-vinext-head="true"');
  });

  it("collects meta elements as self-closing", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("meta", { name: "description", content: "A test page" }),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain('<meta name="description" content="A test page"');
    expect(headHtml).toContain("/>"); // self-closing
    expect(headHtml).not.toContain("</meta>");
  });

  it("collects link elements as self-closing", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("link", { rel: "stylesheet", href: "/styles.css" }),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain('<link rel="stylesheet" href="/styles.css"');
    expect(headHtml).toContain("/>"); // self-closing
  });

  it("collects style elements", () => {
    ReactDOMServer.renderToString(
      React.createElement(Head, null, React.createElement("style", null, "body { color: red; }")),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain("<style");
    // Text content is HTML-escaped
    expect(headHtml).toContain("body { color: red; }");
  });

  it("collects script elements", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("script", { src: "/analytics.js", async: true }),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain('<script src="/analytics.js" async');
    expect(headHtml).toContain("</script>");
  });

  it("collects base element as self-closing", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("base", { href: "https://example.com/" }),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain('<base href="https://example.com/"');
    expect(headHtml).toContain("/>"); // self-closing
  });

  it("collects noscript elements", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("noscript", null, "JavaScript is required"),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain("<noscript");
    expect(headHtml).toContain("JavaScript is required");
    expect(headHtml).toContain("</noscript>");
  });

  it("collects multiple head elements in order", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("title", null, "First"),
        React.createElement("meta", { name: "viewport", content: "width=device-width" }),
        React.createElement("link", { rel: "icon", href: "/favicon.ico" }),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain("First");
    expect(headHtml).toContain("viewport");
    expect(headHtml).toContain("favicon.ico");
  });

  it("resets head between renders", () => {
    ReactDOMServer.renderToString(
      React.createElement(Head, null, React.createElement("title", null, "Page 1")),
    );
    expect(getSSRHeadHTML()).toContain("Page 1");

    resetSSRHead();

    ReactDOMServer.renderToString(
      React.createElement(Head, null, React.createElement("title", null, "Page 2")),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain("Page 2");
    expect(headHtml).not.toContain("Page 1");
  });

  it("returns empty string when no head elements", () => {
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toBe("");
  });
});

// ─── Disallowed tags ────────────────────────────────────────────────────

describe("Head disallowed tags", () => {
  beforeEach(() => {
    resetSSRHead();
  });

  it("ignores <div> tag (not allowed in head)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ReactDOMServer.renderToString(
      React.createElement(Head, null, React.createElement("div", null, "bad")),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).not.toContain("<div");
    expect(headHtml).toBe("");
    warn.mockRestore();
  });

  it("ignores <iframe> tag (security concern)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ReactDOMServer.renderToString(
      React.createElement(Head, null, React.createElement("iframe", { src: "https://evil.com" })),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).not.toContain("<iframe");
    expect(headHtml).toBe("");
    warn.mockRestore();
  });

  it("ignores component elements (non-string type)", () => {
    function CustomComponent() {
      return React.createElement("meta", { name: "custom" });
    }
    ReactDOMServer.renderToString(
      React.createElement(Head, null, React.createElement(CustomComponent)),
    );
    const headHtml = getSSRHeadHTML();
    // Component elements are ignored because child.type is not a string
    expect(headHtml).toBe("");
  });

  it("keeps allowed tags while ignoring disallowed ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("title", null, "Good"),
        React.createElement("div", null, "Bad"),
        React.createElement("meta", { name: "good" }),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain("Good");
    expect(headHtml).toContain('name="good"');
    expect(headHtml).not.toContain("<div");
    warn.mockRestore();
  });
});

// ─── HTML/Attribute escaping ────────────────────────────────────────────

describe("Head escaping", () => {
  beforeEach(() => {
    resetSSRHead();
  });

  it("escapes HTML in text content", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("title", null, 'Page <script>alert("xss")</script>'),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain("&lt;script&gt;");
    expect(headHtml).not.toContain("<script>alert");
  });

  it("escapes HTML in attribute values", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("meta", { name: 'test"value', content: "a<b>c&d" }),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain("&quot;");
    expect(headHtml).toContain("&lt;");
    expect(headHtml).toContain("&amp;");
  });

  it("renders dangerouslySetInnerHTML raw on SSR", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("script", {
          dangerouslySetInnerHTML: { __html: 'console.log("hello")' },
        }),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain('console.log("hello")');
  });

  it("converts className to class attribute", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("style", { className: "critical" }, "body{}"),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain('class="critical"');
    expect(headHtml).not.toContain("className");
  });

  it("renders boolean true attributes as bare attribute name", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        React.createElement("script", { src: "/app.js", async: true, defer: true }),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain(" async ");
    expect(headHtml).toContain(" defer ");
  });
});

// ─── escapeAttr utility ─────────────────────────────────────────────────

describe("escapeAttr", () => {
  it("escapes ampersand", () => {
    expect(escapeAttr("a&b")).toBe("a&amp;b");
  });

  it("escapes double quotes", () => {
    expect(escapeAttr('a"b')).toBe("a&quot;b");
  });

  it("escapes angle brackets", () => {
    expect(escapeAttr("a<b>c")).toBe("a&lt;b&gt;c");
  });

  it("returns safe strings unchanged", () => {
    expect(escapeAttr("hello world")).toBe("hello world");
  });

  it("escapes all special chars together", () => {
    expect(escapeAttr('&"<>')).toBe("&amp;&quot;&lt;&gt;");
  });
});
