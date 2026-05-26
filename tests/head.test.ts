/**
 * next/head shim unit tests.
 *
 * Mirrors test cases from Next.js test/unit/next-head-rendering.test.ts,
 * plus comprehensive coverage for vinext's Head SSR collection, HTML
 * generation, allowed tags, and escaping.
 */
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Head, {
  resetSSRHead,
  getSSRHeadHTML,
  escapeAttr,
  reduceHeadChildren,
  _applyHeadPropsToElement,
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
    expect(headHtml).toContain('data-next-head=""');
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

  it("dedupes keyed tags across multiple Head instances and keeps the last one", () => {
    // Next.js documents `key` as the dedupe mechanism for next/head tags:
    // https://github.com/vercel/next.js/blob/canary/docs/02-pages/04-api-reference/01-components/head.mdx
    ReactDOMServer.renderToString(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          Head,
          null,
          React.createElement("meta", {
            property: "og:title",
            content: "Original Title",
            key: "og-title",
          }),
        ),
        React.createElement(
          Head,
          null,
          React.createElement("meta", {
            property: "og:title",
            content: "Updated Title",
            key: "og-title",
          }),
        ),
      ),
    );

    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain('content="Updated Title"');
    expect(headHtml).not.toContain('content="Original Title"');
    expect(headHtml.match(/property="og:title"/g)).toHaveLength(1);
  });

  it("dedupes keyed tags across Head instances when one Head has multiple children", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          Head,
          null,
          React.createElement("meta", {
            property: "og:title",
            content: "Title A",
            key: "og-title",
          }),
          React.createElement("meta", {
            name: "description",
            content: "Desc A",
            key: "desc",
          }),
        ),
        React.createElement(
          Head,
          null,
          React.createElement("meta", {
            property: "og:title",
            content: "Title B",
            key: "og-title",
          }),
        ),
      ),
    );

    const headHtml = getSSRHeadHTML();
    expect(headHtml).toContain('content="Title B"');
    expect(headHtml).toContain('content="Desc A"');
    expect(headHtml).not.toContain('content="Title A"');
    expect(headHtml.match(/property="og:title"/g)).toHaveLength(1);
  });
});

describe("Head reduction", () => {
  it("dedupes keyed tags and keeps the last matching element", () => {
    const reduced = reduceHeadChildren([
      React.createElement("meta", {
        property: "og:title",
        content: "Original Title",
        key: "og-title",
      }),
      React.createElement("meta", {
        property: "og:title",
        content: "Updated Title",
        key: "og-title",
      }),
    ]);

    expect(reduced).toHaveLength(1);
    const dedupedMeta = reduced[0] as React.ReactElement<{ content?: string }> | undefined;
    expect(dedupedMeta?.props.content).toBe("Updated Title");
  });

  it("dedupes meta[name] tags without explicit keys using the last value", () => {
    const reduced = reduceHeadChildren([
      [
        React.createElement("meta", {
          name: "description",
          content: "Description A",
        }),
        React.createElement("meta", {
          name: "description",
          content: "Description B",
        }),
      ],
    ]);

    expect(reduced).toHaveLength(1);
    const dedupedMeta = reduced[0] as React.ReactElement<{ content?: string }> | undefined;
    expect(dedupedMeta?.props.content).toBe("Description B");
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

  it("empty dangerouslySetInnerHTML.__html takes precedence over children on SSR", () => {
    ReactDOMServer.renderToString(
      React.createElement(
        Head,
        null,
        // oxlint-disable-next-line react/no-danger-with-children
        React.createElement("style", {
          dangerouslySetInnerHTML: { __html: "" },
          // oxlint-disable-next-line react/no-children-prop
          children: "fallback",
        }),
      ),
    );
    const headHtml = getSSRHeadHTML();
    expect(headHtml).not.toContain("fallback");
    expect(headHtml).toMatch(/<style[^>]*><\/style>/);
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

describe("Head client sync", () => {
  function createElementDouble() {
    const attributes = new Map<string, string>();
    return {
      attributes,
      innerHTML: "",
      textContent: "",
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
    };
  }

  it("applies dangerouslySetInnerHTML to client-managed head elements", () => {
    // Next.js client reference:
    // packages/next/src/client/head-manager.ts reactElementToDOM()
    // sets el.innerHTML from dangerouslySetInnerHTML.__html.
    const element = createElementDouble();

    _applyHeadPropsToElement(element, {
      dangerouslySetInnerHTML: { __html: "body { color: red; }" },
    });

    expect(element.innerHTML).toBe("body { color: red; }");
  });

  it("ignores malformed dangerouslySetInnerHTML without __html key", () => {
    // dangerouslySetInnerHTML: {} has no __html key, so getDangerouslySetInnerHTML
    // returns undefined. The client falls through to children (matching SSR behavior).
    const element = createElementDouble();
    element.innerHTML = "previous";

    _applyHeadPropsToElement(element, {
      dangerouslySetInnerHTML: {},
    });

    // No valid __html and no children — content is unchanged.
    expect(element.innerHTML).toBe("previous");
  });

  it("falls through to children when dangerouslySetInnerHTML has no __html key", () => {
    const element = createElementDouble();

    _applyHeadPropsToElement(element, {
      dangerouslySetInnerHTML: {},
      children: "fallback",
    });

    // Malformed dangerouslySetInnerHTML is ignored, children win.
    expect(element.textContent).toBe("fallback");
  });

  it("empty dangerouslySetInnerHTML.__html takes precedence over children on client", () => {
    const element = createElementDouble();
    _applyHeadPropsToElement(element, {
      children: "fallback",
      dangerouslySetInnerHTML: { __html: "" },
    });
    expect(element.innerHTML).toBe("");
    expect(element.textContent).toBe("");
  });

  it("prefers dangerouslySetInnerHTML over children on client-managed head elements", () => {
    const element = createElementDouble();

    _applyHeadPropsToElement(element, {
      children: "children content",
      dangerouslySetInnerHTML: { __html: "raw content" },
    });

    expect(element.innerHTML).toBe("raw content");
    expect(element.textContent).toBe("");
  });

  it("sets textContent from children when dangerouslySetInnerHTML is absent", () => {
    const element = createElementDouble();
    _applyHeadPropsToElement(element, { children: "hello" });
    expect(element.textContent).toBe("hello");
    expect(element.innerHTML).toBe("");
  });

  it("sets textContent from array children by joining them", () => {
    const element = createElementDouble();
    _applyHeadPropsToElement(element, { children: ["a", "b", "c"] });
    expect(element.textContent).toBe("abc");
    expect(element.innerHTML).toBe("");
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
