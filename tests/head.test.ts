/**
 * next/head shim unit tests.
 *
 * Mirrors test cases from Next.js test/unit/next-head-rendering.test.ts,
 * plus comprehensive coverage for vinext's Head SSR collection, HTML
 * generation, allowed tags, and escaping.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Head, {
  resetSSRHead,
  getSSRHeadHTML,
  escapeAttr,
  reduceHeadChildren,
  _applyHeadPropsToElement,
  _reconcileClientHead,
  isEqualHeadNode,
  type HeadDocumentLike,
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

// ─── Head client reconciliation (dedupe on re-render) ───────────────────
//
// Regression coverage for issue #1473: the Pages Router head manager must
// dedupe by attribute identity so `<script>` and `<link>` tags inside
// `<Head>` are preserved across re-renders (instead of being removed and
// re-appended, which re-executes scripts / re-fetches resources). Mirrors
// `.nextjs-ref/packages/next/src/client/head-manager.ts:updateElements`
// and the e2e test at `.nextjs-ref/test/e2e/nonce-head-manager/index.test.ts`.

describe("Head client reconciliation", () => {
  type FakeAttrEntry = { name: string; value: string };

  let nextFakeElementId = 0;
  class FakeElement {
    public readonly tagName: string;
    public readonly attributes: FakeAttrEntry[] = [];
    public innerHTML = "";
    public textContent = "";
    public parentNode: FakeHead | null = null;
    // Surfaced so we can detect re-execution: if the test observes the same
    // FakeElement instance pre- and post-render, the underlying DOM node was
    // preserved (no script re-execution). A different instance would mean the
    // reconciler removed-then-recreated, which is the bug we are guarding
    // against.
    public readonly id: number;

    constructor(tag: string) {
      this.tagName = tag.toUpperCase();
      this.id = ++nextFakeElementId;
    }

    setAttribute(name: string, value: string): void {
      const existing = this.attributes.find((a) => a.name === name);
      if (existing) existing.value = value;
      else this.attributes.push({ name, value });
    }

    getAttribute(name: string): string | null {
      return this.attributes.find((a) => a.name === name)?.value ?? null;
    }

    hasAttribute(name: string): boolean {
      return this.attributes.some((a) => a.name === name);
    }

    isEqualNode(other: FakeElement): boolean {
      if (this.tagName !== other.tagName) return false;
      // Compare attribute sets order-independently so reconciliation matches
      // the spec-level definition (HTML attributes are unordered).
      if (this.attributes.length !== other.attributes.length) return false;
      const otherMap = new Map(other.attributes.map((a) => [a.name, a.value]));
      for (const { name, value } of this.attributes) {
        if (otherMap.get(name) !== value) return false;
      }
      return this.innerHTML === other.innerHTML && this.textContent === other.textContent;
    }
  }

  class FakeHead {
    public readonly children: FakeElement[] = [];

    appendChild(el: FakeElement): FakeElement {
      el.parentNode = this;
      this.children.push(el);
      return el;
    }

    prepend(el: FakeElement): FakeElement {
      el.parentNode = this;
      this.children.unshift(el);
      return el;
    }

    removeChild(el: FakeElement): FakeElement {
      const idx = this.children.indexOf(el);
      if (idx !== -1) this.children.splice(idx, 1);
      el.parentNode = null;
      return el;
    }

    querySelectorAll(selector: string): FakeElement[] {
      if (selector !== "[data-next-head]") {
        throw new Error(`FakeHead.querySelectorAll only supports [data-next-head]`);
      }
      return this.children.filter((c) => c.hasAttribute("data-next-head"));
    }

    querySelector(selector: string): FakeElement | null {
      if (selector !== "meta[charset]") {
        throw new Error(`FakeHead.querySelector only supports meta[charset]`);
      }
      return this.children.find((c) => c.tagName === "META" && c.hasAttribute("charset")) ?? null;
    }
  }

  type FakeDoc = HeadDocumentLike & { readonly head: FakeHead };

  function createFakeDocument(): FakeDoc {
    const head = new FakeHead();
    // The internal reconciler is typed against a real DOM Element/Document
    // shape; cast through `unknown` because FakeElement is intentionally a
    // narrower duck-type (just enough for the reconciler's calls).
    const doc = {
      head,
      createElement(tag: string): Element {
        return new FakeElement(tag) as unknown as Element;
      },
    };
    return doc as unknown as FakeDoc;
  }

  function makeScript(props: Record<string, unknown>): React.ReactElement {
    return React.createElement("script", props);
  }

  it("preserves identical script tags across re-renders (no re-execution)", () => {
    // The canonical issue #1473 scenario: a <script src="..."> inside <Head>
    // must NOT be removed-and-re-appended when the host component re-renders.
    // The reconciler returns the exact same DOM node instance for matching
    // tags, which the browser then leaves in place — preserving the loaded
    // state of the script.
    const doc = createFakeDocument();

    _reconcileClientHead(doc, [makeScript({ src: "/src-1.js" })]);
    expect(doc.head.children).toHaveLength(1);
    const firstNode = doc.head.children[0]!;
    expect(firstNode.getAttribute("src")).toBe("/src-1.js");

    // Re-render with the exact same projection — equivalent to a parent
    // component re-rendering without changing any head content.
    _reconcileClientHead(doc, [makeScript({ src: "/src-1.js" })]);
    expect(doc.head.children).toHaveLength(1);
    // Same node instance survives — no DOM churn, so the browser won't
    // re-execute the script.
    expect(doc.head.children[0]).toBe(firstNode);
  });

  it("appends a new tag when the script src actually changes", () => {
    const doc = createFakeDocument();

    _reconcileClientHead(doc, [makeScript({ src: "/src-1.js" })]);
    const firstNode = doc.head.children[0]!;

    _reconcileClientHead(doc, [makeScript({ src: "/src-2.js" })]);
    expect(doc.head.children).toHaveLength(1);
    expect(doc.head.children[0]!.getAttribute("src")).toBe("/src-2.js");
    // The previous /src-1.js node was removed (different src) — the new
    // /src-2.js is a distinct node.
    expect(doc.head.children[0]).not.toBe(firstNode);
  });

  it("preserves the script node even when a CSP nonce is present", () => {
    // Mirrors the `/csp` variant of the upstream nonce-head-manager test.
    // Browsers strip the `nonce` attribute from serialised HTML once the
    // element is in the document, so `isEqualNode` would naively report
    // unequal — the reconciler must compensate.
    const doc = createFakeDocument();

    _reconcileClientHead(doc, [makeScript({ src: "/src-1.js", nonce: "abc123" })]);
    const firstNode = doc.head.children[0]!;
    expect(firstNode.getAttribute("nonce")).toBe("abc123");

    // Simulate the browser stripping `nonce` from the live attribute (it
    // remains on the element's `.nonce` property in real DOM). We only have
    // attributes in this double, so for the equality test the "stripped"
    // form just means the attribute string match still works because both
    // sides carry the same nonce attribute.
    _reconcileClientHead(doc, [makeScript({ src: "/src-1.js", nonce: "abc123" })]);
    expect(doc.head.children).toHaveLength(1);
    expect(doc.head.children[0]).toBe(firstNode);
  });

  it("removes managed tags that are no longer desired", () => {
    const doc = createFakeDocument();

    _reconcileClientHead(doc, [
      makeScript({ src: "/keep.js" }),
      React.createElement("link", { rel: "stylesheet", href: "/drop.css" }),
    ]);
    expect(doc.head.children).toHaveLength(2);

    _reconcileClientHead(doc, [makeScript({ src: "/keep.js" })]);
    expect(doc.head.children).toHaveLength(1);
    expect(doc.head.children[0]!.tagName).toBe("SCRIPT");
    expect(doc.head.children[0]!.getAttribute("src")).toBe("/keep.js");
  });

  it("leaves unmanaged head children alone", () => {
    // Tags without `data-next-head` (e.g. a `<meta charset>` written into the
    // HTML template) must never be touched by the reconciler. This guards
    // against accidentally widening the selector.
    const doc = createFakeDocument();
    const unmanaged = new FakeElement("meta");
    unmanaged.setAttribute("charset", "utf-8");
    doc.head.appendChild(unmanaged);

    _reconcileClientHead(doc, [
      React.createElement("meta", { name: "description", content: "hello" }),
    ]);

    // Original unmanaged tag is still present, plus the newly managed one.
    expect(doc.head.children).toContain(unmanaged);
    expect(doc.head.children).toHaveLength(2);
  });

  it("matches Next.js nonce-head-manager sequence: render, re-render, change, change back", () => {
    // End-to-end shape of the upstream e2e test (without a real browser):
    //   1. Render with src-1.js
    //   2. Re-render with identical content (force-rerender click)
    //   3. Change to src-2.js
    //   4. Change back to src-1.js
    //
    // Expectation: step 2 preserves the node (no churn). Steps 3 and 4 each
    // produce a fresh node (different src). The reconciler must never leave
    // duplicate tags behind.
    const doc = createFakeDocument();

    _reconcileClientHead(doc, [makeScript({ src: "/src-1.js", nonce: "abc123" })]);
    const node1 = doc.head.children[0]!;

    _reconcileClientHead(doc, [makeScript({ src: "/src-1.js", nonce: "abc123" })]);
    expect(doc.head.children).toHaveLength(1);
    expect(doc.head.children[0]).toBe(node1);

    _reconcileClientHead(doc, [makeScript({ src: "/src-2.js", nonce: "abc123" })]);
    expect(doc.head.children).toHaveLength(1);
    expect(doc.head.children[0]).not.toBe(node1);
    expect(doc.head.children[0]!.getAttribute("src")).toBe("/src-2.js");

    _reconcileClientHead(doc, [makeScript({ src: "/src-1.js", nonce: "abc123" })]);
    expect(doc.head.children).toHaveLength(1);
    expect(doc.head.children[0]!.getAttribute("src")).toBe("/src-1.js");
  });

  it("dedupes template-injected meta[charset] when <Head> declares its own", () => {
    // Next.js-parity behaviour: a template `<meta charset>` (no
    // `data-next-head`) is adopted into the meta bucket when `<Head>`
    // declares its own charSet, so we replace rather than duplicate.
    const doc = createFakeDocument();
    const templateCharset = new FakeElement("meta");
    templateCharset.setAttribute("charset", "utf-8");
    doc.head.appendChild(templateCharset);

    _reconcileClientHead(doc, [React.createElement("meta", { charSet: "utf-8" })]);

    // Only one charset meta survives, and it is first in head (prepended).
    const charsets = doc.head.children.filter((c) => c.tagName === "META");
    expect(charsets).toHaveLength(1);
    expect(doc.head.children[0]!.getAttribute("data-next-head")).toBe("");
  });

  it("prepends a managed meta[charset] so it stays first in <head>", () => {
    // The HTML parser only honours `<meta charset>` if it appears in the
    // first 1024 bytes of `<head>`. New charset metas must be prepended.
    const doc = createFakeDocument();
    // Pre-existing managed link/script to ensure prepend (not append) is
    // exercised — appendChild would land it after them.
    _reconcileClientHead(doc, [React.createElement("link", { rel: "stylesheet", href: "/a.css" })]);
    expect(doc.head.children).toHaveLength(1);

    _reconcileClientHead(doc, [
      React.createElement("link", { rel: "stylesheet", href: "/a.css" }),
      React.createElement("meta", { charSet: "utf-8" }),
    ]);

    expect(doc.head.children).toHaveLength(2);
    expect(doc.head.children[0]!.tagName).toBe("META");
    expect(doc.head.children[1]!.tagName).toBe("LINK");
  });
});

// ─── isEqualHeadNode (nonce stripping) ──────────────────────────────────
//
// Direct unit coverage for the nonce-compensation branch of `isEqualHeadNode`.
// The reconciler tests above use a structural-equality FakeElement that
// never enters the `instanceof HTMLElement` branch, so we drive the helper
// here with focused doubles that simulate Chrome/Firefox stripping the
// `nonce` HTML attribute once an element is in the document (the `.nonce`
// JS property is preserved).
//
// Vitest's default `node` environment doesn't provide `HTMLElement`, so we
// install a minimal global stub. The helper's only requirements on the
// `HTMLElement` constructor are that `instanceof` succeeds and the standard
// `getAttribute` / `setAttribute` / `cloneNode` / `isEqualNode` / `.nonce`
// surface is reachable.

describe("isEqualHeadNode", () => {
  type Attr = { name: string; value: string };
  class StubHTMLElement {
    public attrs: Attr[] = [];
    public stripNonceAttribute = false;
    public nonce: string | undefined;
    public equalsTarget: StubHTMLElement | null = null;

    getAttribute(name: string): string | null {
      if (name === "nonce" && this.stripNonceAttribute) return "";
      return this.attrs.find((a) => a.name === name)?.value ?? null;
    }

    setAttribute(name: string, value: string): void {
      const existing = this.attrs.find((a) => a.name === name);
      if (existing) existing.value = value;
      else this.attrs.push({ name, value });
    }

    cloneNode(_deep?: boolean): StubHTMLElement {
      const clone = new StubHTMLElement();
      clone.attrs = this.attrs.map((a) => ({ ...a }));
      return clone;
    }

    isEqualNode(other: StubHTMLElement | null): boolean {
      return other === this.equalsTarget;
    }
  }

  // Capture the original HTMLElement once (before our beforeEach ever runs)
  // so afterAll restores the env even after multiple installs.
  const originalHTMLElement = (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;

  beforeEach(() => {
    // Vitest globals snapshot has HTMLElement undefined under the node env.
    // Install our stub before each test so `instanceof HTMLElement` matches.
    (globalThis as { HTMLElement?: unknown }).HTMLElement = StubHTMLElement;
  });

  it("treats two nonced elements as equal when the browser stripped oldTag's nonce attribute", () => {
    // Scenario:
    //  - oldTag is in the document: its `nonce` HTML attribute was stripped
    //    (Chrome/Firefox behaviour under CSP), but `.nonce` still holds the
    //    real value.
    //  - newTag is freshly created and still has the `nonce` attribute.
    // Expected: `isEqualHeadNode` enters the nonce-stripping branch, clones
    // newTag with nonce="" and `.nonce` preserved, then compares.
    const oldTag = new StubHTMLElement();
    oldTag.setAttribute("src", "/app.js");
    oldTag.setAttribute("nonce", "abc123");
    oldTag.stripNonceAttribute = true;
    oldTag.nonce = "abc123";

    const newTag = new StubHTMLElement();
    newTag.setAttribute("src", "/app.js");
    newTag.setAttribute("nonce", "abc123");

    // The branch calls oldTag.isEqualNode(cloneTag). Capture the clone so we
    // can assert its shape (nonce attribute stripped, .nonce preserved).
    let capturedClone: StubHTMLElement | null = null;
    oldTag.isEqualNode = function (other: StubHTMLElement | null): boolean {
      capturedClone = other;
      return true;
    };

    expect(isEqualHeadNode(oldTag as unknown as Element, newTag as unknown as Element)).toBe(true);
    expect(capturedClone).not.toBe(newTag);
    // The clone's nonce attribute must be the stripped sentinel.
    expect(capturedClone!.getAttribute("nonce")).toBe("");
    // ...but the typed .nonce property must be preserved so the live element
    // can still satisfy CSP after replacement.
    expect(capturedClone!.nonce).toBe("abc123");
  });

  it("requires .nonce on oldTag to match the new tag's attribute nonce", () => {
    // If a stale element claims to be CSP-compliant via attribute-stripping
    // but its `.nonce` property doesn't match, the comparison must fail.
    const oldTag = new StubHTMLElement();
    oldTag.setAttribute("nonce", "abc123");
    oldTag.stripNonceAttribute = true;
    oldTag.nonce = "different-nonce";

    const newTag = new StubHTMLElement();
    newTag.setAttribute("nonce", "abc123");

    // Even if structural isEqualNode would say true, the .nonce mismatch
    // short-circuits to false.
    oldTag.isEqualNode = (): boolean => true;

    expect(isEqualHeadNode(oldTag as unknown as Element, newTag as unknown as Element)).toBe(false);
  });

  it("falls through to plain isEqualNode when neither tag carries a nonce", () => {
    // The optimization only matters when a nonce is present. Without one,
    // the helper must defer entirely to the native isEqualNode result.
    const oldTag = new StubHTMLElement();
    const newTag = new StubHTMLElement();
    oldTag.equalsTarget = newTag;

    expect(isEqualHeadNode(oldTag as unknown as Element, newTag as unknown as Element)).toBe(true);

    // Inequality propagates too: a different target makes isEqualNode return false.
    const otherTag = new StubHTMLElement();
    expect(isEqualHeadNode(oldTag as unknown as Element, otherTag as unknown as Element)).toBe(
      false,
    );
  });

  it("falls through to plain isEqualNode when oldTag's nonce attribute is still present", () => {
    // If oldTag still has its `nonce` attribute (CSP isn't stripping it),
    // the nonce-stripping branch must NOT be taken — we fall straight
    // through to plain `isEqualNode`.
    const oldTag = new StubHTMLElement();
    oldTag.setAttribute("nonce", "abc123");
    // stripNonceAttribute stays false: getAttribute returns the real value.

    const newTag = new StubHTMLElement();
    newTag.setAttribute("nonce", "abc123");

    let usedFallback = false;
    oldTag.isEqualNode = function (other: StubHTMLElement | null): boolean {
      usedFallback = other === newTag;
      return usedFallback;
    };

    expect(isEqualHeadNode(oldTag as unknown as Element, newTag as unknown as Element)).toBe(true);
    expect(usedFallback).toBe(true);
  });

  it("falls through to plain isEqualNode when neither side is an HTMLElement", () => {
    // Important: the FakeElement used by the reconciler tests above is NOT
    // an HTMLElement, so isEqualHeadNode must skip the strip branch entirely
    // and defer to whatever `oldTag.isEqualNode` returns.
    const oldTag = { isEqualNode: (other: unknown): boolean => other === newTag };
    const newTag = {};
    expect(isEqualHeadNode(oldTag as unknown as Element, newTag as unknown as Element)).toBe(true);
  });

  // Restore HTMLElement after this describe so other tests aren't polluted.
  // Using `afterEach` would restore between tests; we want restore after all.
  afterAll(() => {
    if (originalHTMLElement === undefined) {
      delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
    } else {
      (globalThis as { HTMLElement?: unknown }).HTMLElement = originalHTMLElement;
    }
  });
});
