/**
 * next/document shim tests.
 *
 * These components render placeholder markers that the Pages Router dev-server
 * replaces with real content via string substitution. The tests verify the
 * contracts the dev-server depends on — not that React can render a div.
 */
import { describe, it, expect } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Document, { Html, Head, Main, NextScript } from "../packages/vinext/src/shims/document.js";

function render(el: React.ReactElement): string {
  return ReactDOMServer.renderToString(el);
}

describe("Main", () => {
  it("renders the __NEXT_MAIN__ placeholder inside a #__next container", () => {
    const html = render(React.createElement(Main));
    // Dev-server looks for id="__next" and replaces __NEXT_MAIN__ with rendered page content
    expect(html).toContain('id="__next"');
    expect(html).toContain("__NEXT_MAIN__");
  });
});

describe("NextScript", () => {
  it("renders the __NEXT_SCRIPTS__ comment that dev-server replaces with hydration scripts", () => {
    const html = render(React.createElement(NextScript));
    // Dev-server replaces this HTML comment with __NEXT_DATA__ + module script tags
    expect(html).toContain("<!-- __NEXT_SCRIPTS__ -->");
  });
});

describe("Head", () => {
  // Charset and viewport defaults are intentionally NOT emitted by the
  // `_document` Head shim. They are seeded into `next/head`'s collector via
  // `defaultHead()` and serialised by `getSSRHeadHTML()` — see the comment in
  // `shims/document.tsx`. This mirrors Next.js's pipeline, where the defaults
  // flow through the same `data-next-head=""` dedupe step as user tags.
  it("renders an empty <head> when given no children (defaults flow via next/head)", () => {
    const html = render(React.createElement(Head));
    expect(html).toBe("<head></head>");
  });

  it("renders only user-provided children — defaults are not duplicated here", () => {
    const html = render(
      React.createElement(Head, null, React.createElement("title", null, "My App")),
    );
    // Custom content rendered
    expect(html).toContain("<title>My App</title>");
    // The shim must NOT also emit charset/viewport — those flow through
    // next/head's defaultHead() instead, so they go through the same dedupe
    // pipeline as user-supplied tags.
    expect(html).not.toContain("charSet=");
    expect(html).not.toContain('name="viewport"');
  });
});

describe("Default Document", () => {
  it("assembles all sub-components in the nesting order the dev-server expects", () => {
    const html = render(React.createElement(Document));

    // The dev-server does string replacement on this output.
    // If the nesting order breaks, SSR output will be malformed.
    const headOpen = html.indexOf("<head>");
    const bodyOpen = html.indexOf("<body>");
    const mainDiv = html.indexOf('id="__next"');
    const placeholder = html.indexOf("__NEXT_MAIN__");
    const scripts = html.indexOf("__NEXT_SCRIPTS__");
    const bodyClose = html.indexOf("</body>");

    // All markers must be present
    expect(headOpen).toBeGreaterThan(-1);
    expect(bodyOpen).toBeGreaterThan(-1);
    expect(mainDiv).toBeGreaterThan(-1);
    expect(placeholder).toBeGreaterThan(-1);
    expect(scripts).toBeGreaterThan(-1);

    // Order matters: head < body < main < placeholder < scripts < /body
    expect(headOpen).toBeLessThan(bodyOpen);
    expect(bodyOpen).toBeLessThan(mainDiv);
    expect(mainDiv).toBeLessThan(placeholder);
    expect(placeholder).toBeLessThan(scripts);
    expect(scripts).toBeLessThan(bodyClose);
  });
});

describe("Html", () => {
  it("forwards lang prop to the root <html> element", () => {
    const html = render(React.createElement(Html, { lang: "fr" }));
    expect(html).toMatch(/<html[^>]*lang="fr"/);
  });

  it("wraps the entire document as the root element", () => {
    const html = render(React.createElement(Document));
    // Default Document uses Html as root — output must start with <html
    expect(html).toMatch(/^<html/);
  });
});

// Regression test for the contract motivating PR #1381 (issue #1361):
// user `pages/_document.tsx` files commonly use the class form
// `class MyDocument extends Document`. If the shim's default export is a
// function, the extends chain produces a class React refuses to construct
// (`Class constructor cannot be invoked without 'new'`), which 500s SSR and
// surfaces as empty pages in deploy-suite e2e tests.
//
// Ported from Next.js: test/e2e/async-modules/pages/_document.jsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/async-modules/pages/_document.jsx
describe("Document base class", () => {
  it("can be extended by a user class that React can construct", () => {
    class MyDocument extends Document {
      render() {
        return React.createElement(
          Html,
          { lang: "ja" },
          React.createElement(Head),
          React.createElement(
            "body",
            null,
            React.createElement("div", { id: "doc-marker" }, "ok"),
            React.createElement(Main),
            React.createElement(NextScript),
          ),
        );
      }
    }
    const html = render(React.createElement(MyDocument));
    expect(html).toMatch(/<html[^>]*lang="ja"/);
    expect(html).toContain('id="doc-marker"');
    expect(html).toContain("__NEXT_MAIN__");
    expect(html).toContain("__NEXT_SCRIPTS__");
  });

  it("exposes a static getInitialProps that resolves to a DocumentInitialProps-shaped value", async () => {
    // The runtime contract: subclasses commonly delegate via
    // `await Document.getInitialProps(ctx)` and destructure `html` from the
    // result. The stub returns an empty html shell — the test pins the shape
    // so wiring up the full Pages Router renderPage flow later doesn't
    // silently regress consumers that destructure `html`.
    const result = await Document.getInitialProps({});
    expect(typeof result.html).toBe("string");
  });
});

// Regression coverage for issue #1361 follow-up: user `_document.tsx` files
// that override `static async getInitialProps` (as the Next.js async-modules
// fixture does) must have those props forwarded to the rendered Document.
// `loadUserDocumentInitialProps` is the SSR-side helper that both the Pages
// Router dev-server and the production response builder call.
//
// Ported from Next.js: test/e2e/async-modules/pages/_document.jsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/async-modules/pages/_document.jsx
describe("loadUserDocumentInitialProps", () => {
  it("invokes overridden Document.getInitialProps and returns the resolved props", async () => {
    const { loadUserDocumentInitialProps } =
      await import("../packages/vinext/src/server/pages-document-initial-props.js");
    class MyDocument extends Document {
      static async getInitialProps(_ctx: unknown) {
        const base = await Document.getInitialProps(_ctx as never);
        return { ...base, docValue: await Promise.resolve("doc value") };
      }
    }
    const props = await loadUserDocumentInitialProps(MyDocument as React.ComponentType);
    expect(props).not.toBeNull();
    expect(props!.docValue).toBe("doc value");
    // The base Document.getInitialProps contract is to return { html: "" } so
    // `await Document.getInitialProps(ctx)` spreads `{ html: "" }` into the
    // resulting props. This pins that contract — the dev-server / prod
    // response builder render `<Document {...docProps} />` and consumers may
    // read either field.
    expect(typeof props!.html).toBe("string");
  });

  it("returns null when the user did not override the base getInitialProps", async () => {
    const { loadUserDocumentInitialProps } =
      await import("../packages/vinext/src/server/pages-document-initial-props.js");
    class MyDocument extends Document {
      // No getInitialProps override — inherits the base shim's stub.
      render() {
        return React.createElement("html");
      }
    }
    const props = await loadUserDocumentInitialProps(MyDocument as React.ComponentType);
    expect(props).toBeNull();
  });

  it("lets errors from the user getInitialProps propagate, matching Next.js render.tsx", async () => {
    const { loadUserDocumentInitialProps } =
      await import("../packages/vinext/src/server/pages-document-initial-props.js");
    class BadDocument extends Document {
      static async getInitialProps(_ctx: unknown): Promise<never> {
        throw new Error("boom");
      }
    }
    // Next.js's `loadGetInitialProps` does NOT catch — a throw surfaces as a
    // 500 to the caller. vinext matches that contract so user bugs in
    // `_document.tsx`'s getInitialProps are visible instead of silently
    // erasing docProps from every render.
    await expect(loadUserDocumentInitialProps(BadDocument as React.ComponentType)).rejects.toThrow(
      "boom",
    );
  });
});
