/**
 * next/script shim unit tests.
 *
 * Tests the Script component's SSR behavior, strategy handling,
 * and the imperative script loading utilities (handleClientScriptLoad,
 * initScriptLoader). Only SSR-testable behaviors are verified here;
 * client-side loading strategies require a browser environment.
 */
import { afterEach, describe, it, expect } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Script, {
  handleClientScriptLoad,
  initScriptLoader,
  type ScriptProps,
} from "../packages/vinext/src/shims/script.js";
import {
  loadClientScript,
  loadedScripts,
  scriptCache,
} from "../packages/vinext/src/shims/script-loader.js";
import { ScriptNonceProvider } from "../packages/vinext/src/shims/script-nonce-context.js";
import {
  BeforeInteractiveContext,
  type BeforeInteractiveInlineScript,
  type BeforeInteractiveRegistration,
} from "../packages/vinext/src/shims/before-interactive-context.js";
import { renderBeforeInteractiveInlineScripts } from "../packages/vinext/src/server/before-interactive-head.js";

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalHTMLElement = globalThis.HTMLElement;
const originalRequestIdleCallback = globalThis.requestIdleCallback;

function setGlobalValue(
  key: "document" | "window" | "HTMLElement" | "requestIdleCallback",
  value: unknown,
): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }

  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  loadedScripts.clear();
  scriptCache.clear();
  setGlobalValue("document", originalDocument);
  setGlobalValue("window", originalWindow);
  setGlobalValue("HTMLElement", originalHTMLElement);
  setGlobalValue("requestIdleCallback", originalRequestIdleCallback);
});

// ─── SSR rendering ──────────────────────────────────────────────────────

describe("Script SSR rendering", () => {
  it("renders <script> tag for beforeInteractive strategy", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/analytics.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );
    expect(html).toContain("<script");
    expect(html).toContain('src="/analytics.js"');
    expect(html).toContain('data-nscript="beforeInteractive"');
  });

  it("emits a preload link for afterInteractive strategy on SSR (no <script> tag)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/tracking.js",
        strategy: "afterInteractive",
      } as ScriptProps),
    );
    // React Float hoists the ReactDOM.preload call into <link rel="preload"> in <head>.
    // The Script component itself never returns a <script> tag for afterInteractive.
    // Mirrors .nextjs-ref/packages/next/src/client/script.tsx:361-376.
    expect(html).toContain('<link rel="preload"');
    expect(html).toContain('href="/tracking.js"');
    expect(html).toContain('as="script"');
    expect(html).not.toContain("<script");
  });

  it("renders nothing for lazyOnload strategy on SSR", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/lazy.js",
        strategy: "lazyOnload",
      } as ScriptProps),
    );
    expect(html).toBe("");
  });

  it("renders nothing for worker strategy on SSR", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/worker.js",
        strategy: "worker",
      } as ScriptProps),
    );
    expect(html).toBe("");
  });

  it("defaults to afterInteractive (emits preload link on SSR)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/default.js",
      } as ScriptProps),
    );
    expect(html).toContain('<link rel="preload"');
    expect(html).toContain('href="/default.js"');
    expect(html).toContain('as="script"');
  });

  it("preserves crossOrigin and integrity on the preload link", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/secure-after.js",
        strategy: "afterInteractive",
        crossOrigin: "anonymous",
        integrity: "sha384-abc123",
      } as ScriptProps),
    );
    expect(html).toContain('<link rel="preload"');
    expect(html).toContain('href="/secure-after.js"');
    // React normalises `crossOrigin="anonymous"` to `crossorigin=""` in HTML —
    // both forms are equivalent per the HTML spec (an empty value selects
    // the "anonymous" state). Accept either.
    expect(html).toMatch(/crossorigin=("anonymous"|"")/);
    expect(html).toContain('integrity="sha384-abc123"');
  });

  it("does not emit a preload link for inline (no-src) afterInteractive scripts", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        strategy: "afterInteractive",
        children: 'console.log("inline")',
      } as ScriptProps),
    );
    expect(html).toBe("");
  });

  it("does not emit a preload link for lazyOnload scripts on SSR", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/lazy-preload.js",
        strategy: "lazyOnload",
      } as ScriptProps),
    );
    expect(html).not.toContain('rel="preload"');
  });

  it("emits both preload link and <script> tag for beforeInteractive with src", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/before.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );
    expect(html).toContain('<link rel="preload"');
    expect(html).toContain('href="/before.js"');
    expect(html).toContain('as="script"');
    expect(html).toContain("<script");
    expect(html).toContain('src="/before.js"');
  });

  it("renders beforeInteractive with id attribute", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/gtag.js",
        id: "google-analytics",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );
    expect(html).toContain('id="google-analytics"');
    expect(html).toContain('src="/gtag.js"');
    expect(html).toContain('data-nscript="beforeInteractive"');
  });

  it("suppresses a Pages beforeInteractive script already hoisted into the document", () => {
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => null,
      querySelectorAll(selector: string) {
        if (selector === "script[data-vinext-before-interactive-runtime]") return [];
        expect(selector).toBe('script[data-nscript="beforeInteractive"]');
        return [
          {
            getAttribute(name: string) {
              if (name === "data-vinext-script-key") return "id:legacy-before-interactive";
              return null;
            },
            textContent: "",
          },
        ];
      },
    });

    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        id: "legacy-before-interactive",
        src: "/legacy-before.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );

    expect(html).toBe("");
  });

  it("renders beforeInteractive with inline content", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        strategy: "beforeInteractive",
        children: 'console.log("init")',
      } as ScriptProps),
    );
    expect(html).toContain("<script");
    expect(html).toContain('console.log("init")');
  });

  it("renders beforeInteractive with dangerouslySetInnerHTML", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        strategy: "beforeInteractive",
        dangerouslySetInnerHTML: { __html: "window.x = 1" },
      } as ScriptProps),
    );
    expect(html).toContain("<script");
  });

  it("passes through additional attributes for beforeInteractive", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/secure.js",
        strategy: "beforeInteractive",
        integrity: "sha384-abc123",
        crossOrigin: "anonymous",
      } as ScriptProps),
    );
    expect(html).toContain("<script");
    expect(html).toContain('src="/secure.js"');
  });

  // Regression for cloudflare/vinext#1518.
  //
  // Ported from Next.js: test/e2e/app-dir/script-before-interactive/script-before-interactive.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/script-before-interactive/script-before-interactive.test.ts
  //
  // React DOM prop names (className, htmlFor, httpEquiv, acceptCharset) must be
  // translated to their HTML attribute equivalents (class, for, http-equiv,
  // accept-charset) when an inline `<Script strategy="beforeInteractive">` is
  // hoisted into <head> via BeforeInteractiveContext. Without the translation
  // they round-trip as `classname="..."` etc., which the browser parses as an
  // unrelated attribute — so the script lacks the requested CSS class and any
  // selector on `.example-class` fails to match.
  it("translates React DOM prop names to HTML attributes on hoisted beforeInteractive scripts", () => {
    const captured: BeforeInteractiveInlineScript[] = [];
    ReactDOMServer.renderToString(
      React.createElement(
        BeforeInteractiveContext.Provider,
        {
          value: (script: BeforeInteractiveInlineScript): BeforeInteractiveRegistration => {
            captured.push(script);
            return "hoisted";
          },
        },
        React.createElement(Script, {
          id: "example-script",
          strategy: "beforeInteractive",
          className: "example-class",
          htmlFor: "target-id",
          httpEquiv: "x-foo",
          acceptCharset: "utf-8",
          dangerouslySetInnerHTML: {
            __html: "window.beforeInteractiveExecuted = true;",
          },
        } as ScriptProps),
      ),
    );

    expect(captured).toHaveLength(1);
    const attrs = captured[0]?.attributes ?? {};
    // HTML attribute names — not the React camelCase prop names.
    expect(attrs).toMatchObject({
      class: "example-class",
      for: "target-id",
      "http-equiv": "x-foo",
      "accept-charset": "utf-8",
    });
    // The React camelCase forms must NOT round-trip as attribute keys. HTML
    // parses attribute names case-insensitively, so `className="x"` would be
    // read as `classname="x"` — see the Next.js test for this exact assertion.
    expect(attrs).not.toHaveProperty("className");
    expect(attrs).not.toHaveProperty("htmlFor");
    expect(attrs).not.toHaveProperty("httpEquiv");
    expect(attrs).not.toHaveProperty("acceptCharset");
  });

  // Even outside the App Router head-hoisting path (no provider in context),
  // React still owns the rendering of the <script> tag and must emit
  // `class="..."` not `classname="..."`.
  it("emits class= (not className=) for beforeInteractive scripts with src and className", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/before.js",
        strategy: "beforeInteractive",
        className: "example-class",
      } as ScriptProps),
    );
    expect(html).toContain('class="example-class"');
    expect(html).not.toContain('classname="example-class"');
  });

  it("uses the request nonce for beforeInteractive scripts when none is passed explicitly", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        ScriptNonceProvider,
        { nonce: "test-nonce" },
        React.createElement(Script, {
          src: "/analytics.js",
          strategy: "beforeInteractive",
        } as ScriptProps),
      ),
    );
    expect(html).toContain('nonce="test-nonce"');
  });

  it("prefers the DOM nonce property over a stripped nonce attribute on the client", () => {
    const appendedScripts: Array<{ attrs: Record<string, string> }> = [];
    class MockHTMLElement {
      nonce = "";
      getAttribute(_name: string): string | null {
        return null;
      }
    }

    const nonceElement = new MockHTMLElement();
    nonceElement.nonce = "property-nonce";
    nonceElement.getAttribute = (name: string) => (name === "nonce" ? "" : null);

    const createdScript = {
      attrs: {} as Record<string, string>,
      nonce: "property-nonce",
      getAttribute(name: string) {
        return this.attrs[name] ?? null;
      },
      setAttribute(name: string, value: string) {
        this.attrs[name] = value;
      },
      addEventListener() {},
    };

    setGlobalValue("HTMLElement", MockHTMLElement);
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector(selector: string) {
        return selector === "[nonce]" ? nonceElement : null;
      },
      createElement(tagName: string) {
        expect(tagName).toBe("script");
        return createdScript;
      },
      body: {
        appendChild(element: unknown) {
          appendedScripts.push(element as { attrs: Record<string, string> });
        },
      },
    });

    handleClientScriptLoad({ src: "/client.js" });

    expect(appendedScripts).toHaveLength(1);
    expect(appendedScripts[0]!.attrs.nonce).toBe("property-nonce");
  });

  it("clears forced async execution when async is explicitly false", () => {
    type MockScript = {
      async: boolean;
      attrs: Record<string, string>;
      src: string;
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
      getAttribute(name: string): string | null;
      addEventListener(): void;
    };

    const appendedScripts: MockScript[] = [];
    class MockHTMLElement {}

    const createdScript: MockScript = {
      async: true,
      attrs: {},
      src: "",
      setAttribute(name: string, value: string) {
        this.attrs[name] = value;
      },
      removeAttribute(name: string) {
        Reflect.deleteProperty(this.attrs, name);
      },
      getAttribute(name: string): string | null {
        return this.attrs[name] ?? null;
      },
      addEventListener() {},
    };

    setGlobalValue("HTMLElement", MockHTMLElement);
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector() {
        return null;
      },
      createElement(tagName: string) {
        expect(tagName).toBe("script");
        return createdScript;
      },
      body: {
        appendChild(element: unknown) {
          appendedScripts.push(element as typeof createdScript);
        },
      },
    });

    handleClientScriptLoad({ src: "/ordered-script.js", async: false });

    expect(appendedScripts).toHaveLength(1);
    expect(appendedScripts[0]!.async).toBe(false);
    expect(appendedScripts[0]!.attrs).not.toHaveProperty("async");
  });

  it.each(["afterInteractive", "lazyOnload", "worker"] as const)(
    "marks client-injected %s scripts with data-nscript",
    (strategy) => {
      const createdScript = {
        attrs: {} as Record<string, string>,
        src: "",
        setAttribute(name: string, value: string) {
          this.attrs[name] = value;
        },
        getAttribute(name: string): string | null {
          return this.attrs[name] ?? null;
        },
        addEventListener() {},
      };
      setGlobalValue("window", {
        addEventListener(_event: string, callback: () => void) {
          callback();
        },
      });
      setGlobalValue("requestIdleCallback", (callback: IdleRequestCallback) => {
        callback({ didTimeout: false, timeRemaining: () => 50 });
        return 1;
      });
      setGlobalValue("document", {
        querySelector: () => null,
        readyState: "complete",
        createElement: () => createdScript,
        body: { appendChild() {} },
      });

      handleClientScriptLoad({ src: `/${strategy}.js`, strategy });

      expect(createdScript.attrs["data-nscript"]).toBe(strategy);
    },
  );
});

// ─── nonce resolution ───────────────────────────────────────────────────
//
// Regression coverage for https://github.com/cloudflare/vinext/issues/1607:
// some SSR/edge runtimes polyfill `document` but stop short of defining the
// `HTMLElement` constructor. Before the guard landed, `getClientAutoNonce`
// reached `instanceof HTMLElement` and crashed the render with
// "ReferenceError: HTMLElement is not defined".

describe("Script nonce resolution", () => {
  it("does not throw during SSR when window/document exist but HTMLElement is undefined", () => {
    // Exact minimal repro shape from the upstream bug report: window and
    // document are defined, HTMLElement is not. Pre-fix this threw inside
    // `getClientAutoNonce` because the `instanceof` reference was unguarded.
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => ({ getAttribute: () => "test-nonce" }),
    });
    setGlobalValue("HTMLElement", undefined);

    expect(() =>
      ReactDOMServer.renderToString(
        React.createElement(Script, {
          strategy: "beforeInteractive",
          dangerouslySetInnerHTML: { __html: "console.log('init')" },
        } as ScriptProps),
      ),
    ).not.toThrow();
  });

  it("picks up the nonce attribute when HTMLElement is unavailable but the [nonce] element is present", () => {
    // Same runtime shape as above, plus a Script with no explicit/contextual
    // nonce: the DOM fallback must still find the nonce via `getAttribute`.
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => ({ getAttribute: () => "attr-nonce" }),
    });
    setGlobalValue("HTMLElement", undefined);

    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/x.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );

    expect(html).toContain('nonce="attr-nonce"');
  });

  it("prefers the contextual nonce over a DOM nonce and does not query the document", () => {
    // DOM auto-detection is a browser-only convenience. When the server has
    // already provided a contextual nonce we should never reach into the DOM,
    // and the contextual value must win regardless of what `[nonce]` returns.
    let querySelectorCalls = 0;
    class MockHTMLElement {
      nonce = "wrong-nonce";
      getAttribute(_name: string): string | null {
        return "wrong-nonce";
      }
    }
    setGlobalValue("HTMLElement", MockHTMLElement);
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector(_selector: string) {
        querySelectorCalls += 1;
        return new MockHTMLElement();
      },
    });

    const html = ReactDOMServer.renderToString(
      React.createElement(
        ScriptNonceProvider,
        { nonce: "context-nonce" },
        React.createElement(Script, {
          src: "/x.js",
          strategy: "beforeInteractive",
        } as ScriptProps),
      ),
    );

    expect(html).toContain('nonce="context-nonce"');
    expect(html).not.toContain("wrong-nonce");
    expect(querySelectorCalls).toBe(0);
  });

  it("uses the DOM nonce when HTMLElement is defined and no explicit/contextual nonce is provided", () => {
    // The browser-only fallback: HTMLElement is real, the element matches,
    // and the resolver reads the typed `.nonce` property first (browsers
    // strip the serialised attribute under CSP).
    class MockHTMLElement {
      nonce = "dom-nonce";
      getAttribute(_name: string): string | null {
        return null;
      }
    }
    setGlobalValue("HTMLElement", MockHTMLElement);
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector(_selector: string) {
        return new MockHTMLElement();
      },
    });

    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/x.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );

    expect(html).toContain('nonce="dom-nonce"');
  });

  it("emits no nonce in pure Node SSR when no explicit or contextual nonce is provided", () => {
    // `afterEach` already restores these to undefined; we set them explicitly
    // here so the test reads as a pure-Node assertion regardless of any host
    // polyfill that leaked into the test process.
    setGlobalValue("window", undefined);
    setGlobalValue("document", undefined);
    setGlobalValue("HTMLElement", undefined);

    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/x.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );

    expect(html).toContain('src="/x.js"');
    expect(html).not.toContain("nonce=");
  });

  it("returns no nonce when the document has no [nonce] element", () => {
    // Exercises the "querySelector returned null" branch of getClientAutoNonce.
    class MockHTMLElement {}
    setGlobalValue("HTMLElement", MockHTMLElement);
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector(_selector: string) {
        return null;
      },
    });

    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/x.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );

    expect(html).toContain('src="/x.js"');
    expect(html).not.toContain("nonce=");
  });
});

// ─── stylesheets prop ───────────────────────────────────────────────────
//
// Regression coverage for https://github.com/cloudflare/vinext/issues/1517:
// `<Script>` accepts a `stylesheets` prop that maps to associated CSS
// resources for the script. Next.js calls `ReactDOM.preinit(href, { as: 'style' })`
// during SSR (App Router) which React Float hoists into `<head>` as
// `<link rel="stylesheet" ...>`. The vinext shim was dropping the prop
// entirely — the prop wasn't even on the destructured rest, so React would
// have emitted it as a `stylesheets=` attribute on `<script>` (or warned).

describe("Script stylesheets prop", () => {
  it('emits <link rel="stylesheet"> for each entry on SSR', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/test3.js",
        strategy: "afterInteractive",
        stylesheets: ["/style3.css"],
      } as ScriptProps),
    );

    // React Float hoists ReactDOM.preinit(.., { as: 'style' }) into
    // <link rel="stylesheet"> in the rendered output.
    expect(html).toContain('<link rel="stylesheet"');
    expect(html).toContain('href="/style3.css"');
  });

  it('emits a <link rel="stylesheet"> for every stylesheet in the list', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/test1.js",
        strategy: "beforeInteractive",
        stylesheets: ["/style1a.css", "/style1b.css"],
      } as ScriptProps),
    );

    expect(html).toContain('href="/style1a.css"');
    expect(html).toContain('href="/style1b.css"');
    const linkCount = (html.match(/<link rel="stylesheet"/g) ?? []).length;
    expect(linkCount).toBeGreaterThanOrEqual(2);
  });

  it("does not leak the stylesheets prop as an attribute on the rendered <script>", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/before.js",
        strategy: "beforeInteractive",
        stylesheets: ["/before.css"],
      } as ScriptProps),
    );

    expect(html).not.toContain("stylesheets=");
  });

  it("emits no stylesheet links when stylesheets is omitted", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/plain.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );

    expect(html).not.toContain('rel="stylesheet"');
  });

  it("ignores an empty stylesheets list", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/plain.js",
        strategy: "beforeInteractive",
        stylesheets: [],
      } as ScriptProps),
    );

    expect(html).not.toContain('rel="stylesheet"');
  });

  it("does not throw when handleClientScriptLoad is invoked with a stylesheets prop", () => {
    // The imperative loader is intentionally React-free so Pages bootstrap can
    // import it without pulling the ReactDOM namespace into Vite's dev entry.
    // It inserts stylesheet links directly and must not leak the prop onto the
    // created <script> element.
    const createdScript = {
      attrs: {} as Record<string, string>,
      setAttribute(name: string, value: string) {
        this.attrs[name] = value;
      },
      getAttribute(name: string): string | null {
        return this.attrs[name] ?? null;
      },
      addEventListener() {},
    };
    const createdLink = {
      rel: "",
      type: "",
      href: "",
    };

    const appendedScripts: Array<typeof createdScript> = [];
    const appendedLinks: Array<typeof createdLink> = [];
    class MockHTMLElement {}
    setGlobalValue("HTMLElement", MockHTMLElement);
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => null,
      createElement(tagName: string) {
        return tagName === "link" ? createdLink : createdScript;
      },
      head: {
        appendChild(element: unknown) {
          appendedLinks.push(element as typeof createdLink);
        },
      },
      body: {
        appendChild(el: unknown) {
          appendedScripts.push(el as typeof createdScript);
        },
      },
    });

    expect(() =>
      handleClientScriptLoad({
        src: "/imperative.js",
        stylesheets: ["/imperative.css"],
      } as ScriptProps),
    ).not.toThrow();

    expect(appendedScripts).toHaveLength(1);
    expect(appendedLinks).toEqual([
      { rel: "stylesheet", type: "text/css", href: "/imperative.css" },
    ]);
    // The stylesheets prop must never leak onto the <script> attribute list.
    expect(appendedScripts[0]!.attrs).not.toHaveProperty("stylesheets");
  });

  it("deduplicates a shared stylesheet across imperative scripts", () => {
    const appendedLinks: Array<{ href: string }> = [];
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement(tagName: string) {
        if (tagName === "link") return { rel: "", type: "", href: "" };
        return {
          setAttribute() {},
          getAttribute: () => null,
          addEventListener() {},
        };
      },
      head: {
        appendChild(element: { href: string }) {
          appendedLinks.push(element);
        },
      },
      body: { appendChild() {} },
    });

    handleClientScriptLoad({ id: "first", stylesheets: ["/shared.css"] });
    handleClientScriptLoad({ id: "second", stylesheets: ["/shared.css"] });

    expect(appendedLinks.map((link) => link.href)).toEqual(["/shared.css"]);
  });
});

describe("Script loader bootstrap cache", () => {
  function installScriptDocument() {
    const appendedScripts: Array<{
      listeners: Record<string, (event: Event) => void>;
      src: string;
    }> = [];
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement() {
        const script = {
          listeners: {} as Record<string, (event: Event) => void>,
          src: "",
          setAttribute() {},
          getAttribute: () => null,
          addEventListener(name: string, listener: (event: Event) => void) {
            script.listeners[name] = listener;
          },
        };
        return script;
      },
      body: {
        appendChild(script: (typeof appendedScripts)[number]) {
          appendedScripts.push(script);
        },
      },
    });
    return appendedScripts;
  }

  it("retains loaded sources across scripts with different ids", async () => {
    const appendedScripts = installScriptDocument();

    handleClientScriptLoad({ id: "document-after", src: "/shared.js" });
    appendedScripts[0]!.listeners.load!(new Event("load"));
    await scriptCache.get("/shared.js");

    handleClientScriptLoad({ id: "page-after-one", src: "/shared.js" });
    handleClientScriptLoad({ id: "page-after-two", src: "/shared.js" });

    expect(appendedScripts).toHaveLength(1);
  });

  it("marks a shared-source cache key while the first script is pending", () => {
    const appendedScripts = installScriptDocument();
    const calls: string[] = [];

    handleClientScriptLoad({ id: "first", src: "/shared.js" });
    handleClientScriptLoad({
      id: "second",
      src: "/shared.js",
      onLoad: () => calls.push("load"),
      onReady: () => calls.push("ready"),
      onError: () => calls.push("error"),
    });

    expect(appendedScripts).toHaveLength(1);
    expect(loadedScripts.has("second")).toBe(true);
    expect(calls).toEqual([]);
  });

  it("fires only onLoad for a fulfilled shared-source attachment", async () => {
    const appendedScripts = installScriptDocument();
    const calls: string[] = [];

    handleClientScriptLoad({ id: "first", src: "/shared.js" });
    handleClientScriptLoad({
      id: "second",
      src: "/shared.js",
      onLoad: () => calls.push("load"),
      onReady: () => calls.push("ready"),
    });
    appendedScripts[0]!.listeners.load!(new Event("load"));
    await scriptCache.get("/shared.js");

    expect(calls).toEqual(["load"]);

    loadClientScript(
      {
        id: "second",
        src: "/shared.js",
        onReady: () => calls.push("remount-ready"),
      },
      { fireReadyWhenAlreadyLoaded: true },
    );
    expect(calls).toEqual(["load", "remount-ready"]);
  });

  it("settles a rejected source before later shared-source attachments", async () => {
    const appendedScripts = installScriptDocument();
    const calls: Array<[string, Event | undefined]> = [];

    handleClientScriptLoad({
      id: "first",
      src: "/shared.js",
      onError: (event) => calls.push(["first-error", event]),
    });
    const error = new Event("error");
    appendedScripts[0]!.listeners.error!(error);
    await scriptCache.get("/shared.js");

    handleClientScriptLoad({
      id: "second",
      src: "/shared.js",
      onLoad: (event) => calls.push(["second-load", event]),
      onReady: () => calls.push(["second-ready", undefined]),
      onError: (event) => calls.push(["second-error", event]),
    });
    await Promise.resolve();

    expect(loadedScripts.has("second")).toBe(true);
    expect(calls).toEqual([
      ["first-error", error],
      ["second-load", undefined],
    ]);
  });

  for (const strategy of ["beforeInteractive", "beforePageRender"] as const) {
    it(`seeds ${strategy} scripts by id or src`, () => {
      const appendedScripts: unknown[] = [];
      const emittedScript = {
        id: strategy === "beforeInteractive" ? `${strategy}-id` : "",
        getAttribute(name: string) {
          return name === "src" ? `/${strategy}.js` : null;
        },
      };

      setGlobalValue("window", {});
      setGlobalValue("document", {
        querySelector: () => null,
        querySelectorAll(selector: string) {
          return selector === `[data-nscript="${strategy}"]` ? [emittedScript] : [];
        },
        createElement() {
          return {
            setAttribute() {},
            getAttribute: () => null,
            addEventListener() {},
          };
        },
        body: {
          appendChild(element: unknown) {
            appendedScripts.push(element);
          },
        },
      });

      initScriptLoader([]);
      handleClientScriptLoad(
        strategy === "beforeInteractive"
          ? { id: `${strategy}-id`, src: "/different.js" }
          : { src: `/${strategy}.js` },
      );

      expect(appendedScripts).toHaveLength(0);
    });
  }
});

// ─── #2016: src beforeInteractive registration, marker, attr mapping ──────
//
// Regression coverage for https://github.com/cloudflare/vinext/issues/2016.
//
// Three coupled defects:
//   1. SSR-hoisted beforeInteractive scripts carried no marker; Next.js tags
//      server-rendered beforeInteractive scripts with
//      `data-nscript="beforeInteractive"`
//      (.nextjs-ref/packages/next/src/client/script.tsx).
//   2. beforeInteractive scripts with `src` bypassed the server registry, so
//      they were never hoisted into <head> ahead of interactive. Next.js
//      treats inline and src beforeInteractive scripts equally in the registry
//      path (the App Router `(self.__next_s=...).push([src, …])` branch).
//   3. REACT_TO_HTML_ATTR lacked `crossOrigin`/`referrerPolicy`, so they
//      round-tripped as camelCase attributes (broken CORS/referrer). Next.js
//      lowercases these in set-attributes-from-props.ts.

describe("Script beforeInteractive registry (#2016)", () => {
  it("renders beforeInteractive inline when the shell collector is sealed", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        BeforeInteractiveContext.Provider,
        { value: (): BeforeInteractiveRegistration => "inline" },
        React.createElement(
          Script,
          {
            id: "late-before-interactive",
            strategy: "beforeInteractive",
          } as ScriptProps,
          "window.lateBeforeInteractive = true",
        ),
      ),
    );

    expect(html).toContain('id="late-before-interactive"');
    expect(html).toContain('data-nscript="beforeInteractive"');
    expect(html).toContain("window.lateBeforeInteractive = true");
  });

  it("renders late App beforeInteractive scripts as executable runtime records", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        BeforeInteractiveContext.Provider,
        { value: (): BeforeInteractiveRegistration => "app-runtime" },
        React.createElement(
          Script,
          {
            id: "late-app-script",
            strategy: "beforeInteractive",
          } as ScriptProps,
          "window.lateAppScript = true",
        ),
      ),
    );

    expect(html).toContain('data-vinext-before-interactive-runtime="id:late-app-script"');
    expect(html).toContain("(self.__next_s=self.__next_s||[]).push(");
    expect(html).toContain('"data-vinext-script-key":"id:late-app-script"');
    expect(html).toContain('"children":"window.lateAppScript = true"');
    expect(html).not.toContain('data-nscript="beforeInteractive"');
  });

  it("serializes contextual nonces and numeric attributes into late App runtime records", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        ScriptNonceProvider,
        { nonce: "context-nonce" },
        React.createElement(
          BeforeInteractiveContext.Provider,
          { value: (): BeforeInteractiveRegistration => "app-runtime" },
          React.createElement(
            Script,
            {
              id: "late-app-script-attributes",
              strategy: "beforeInteractive",
              "data-version": 2,
            } as ScriptProps,
            "window.lateAppScriptAttributes = true",
          ),
        ),
      ),
    );

    expect(html).toContain('nonce="context-nonce"');
    expect(html).toContain('"nonce":"context-nonce"');
    expect(html).toContain('"data-version":2');
  });

  it("registers src beforeInteractive scripts so they are hoisted into <head>", () => {
    const captured: BeforeInteractiveInlineScript[] = [];
    const html = ReactDOMServer.renderToString(
      React.createElement(
        BeforeInteractiveContext.Provider,
        {
          value: (s: BeforeInteractiveInlineScript): BeforeInteractiveRegistration => {
            captured.push(s);
            return "hoisted";
          },
        },
        React.createElement(Script, {
          src: "/analytics.js",
          id: "analytics",
          strategy: "beforeInteractive",
        } as ScriptProps),
      ),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.src).toBe("/analytics.js");
    expect(captured[0]?.id).toBe("analytics");
    // The tag is hoisted by the SSR pipeline (returned null from React), so
    // React itself emits only the preload link, never an inline <script>.
    expect(html).not.toContain("<script");
  });

  it("maps crossOrigin/referrerPolicy to HTML attribute names on hoisted src scripts", () => {
    const captured: BeforeInteractiveInlineScript[] = [];
    ReactDOMServer.renderToString(
      React.createElement(
        BeforeInteractiveContext.Provider,
        {
          value: (s: BeforeInteractiveInlineScript): BeforeInteractiveRegistration => {
            captured.push(s);
            return "hoisted";
          },
        },
        React.createElement(Script, {
          src: "/cdn.js",
          strategy: "beforeInteractive",
          crossOrigin: "anonymous",
          referrerPolicy: "no-referrer",
        } as ScriptProps),
      ),
    );

    expect(captured).toHaveLength(1);
    const attrs = captured[0]?.attributes ?? {};
    expect(attrs).toMatchObject({
      crossorigin: "anonymous",
      referrerpolicy: "no-referrer",
    });
    expect(attrs).not.toHaveProperty("crossOrigin");
    expect(attrs).not.toHaveProperty("referrerPolicy");
  });

  it("does not re-render a hoisted src beforeInteractive script on the client", () => {
    const hoistedScript = {
      getAttribute(name: string) {
        return name === "data-vinext-script-key" ? "src:/dedupe.js" : null;
      },
    };
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => null,
      querySelectorAll: () => [hoistedScript],
      head: { contains: (node: unknown) => node === hoistedScript },
    });

    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/dedupe.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );

    expect(html).toBe("");
  });

  it("re-renders a late body script while seeding its onReady cache key", () => {
    const lateScript = {
      getAttribute(name: string) {
        return name === "data-vinext-script-key" ? "id:late-body" : null;
      },
    };
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => null,
      querySelectorAll: () => [lateScript],
      head: { contains: () => false },
    });

    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        id: "late-body",
        src: "/late-body.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );

    expect(html).toContain('id="late-body"');
    expect(html).toContain('src="/late-body.js"');
    expect(loadedScripts.has("late-body")).toBe(true);
  });

  it("does not execute a late body script again when it remounts", () => {
    loadedScripts.add("late-body");
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => null,
      querySelectorAll: () => [],
      head: { contains: () => false },
    });

    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        id: "late-body",
        src: "/late-body.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );

    expect(html).toBe("");
  });

  it("seeds the load cache from a hoisted App Router beforeInteractive script", () => {
    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => null,
      querySelectorAll: () => [
        {
          getAttribute(name: string) {
            return name === "data-vinext-script-key" ? "id:app-before-ready" : null;
          },
        },
      ],
    });

    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        id: "app-before-ready",
        src: "/beforeinteractive-ready.js",
        strategy: "beforeInteractive",
      } as ScriptProps),
    );

    expect(html).toBe("");
    expect(loadedScripts.has("app-before-ready")).toBe(true);
  });

  it("dedupes escaped inline beforeInteractive scripts by stable emitted identity", () => {
    const source = 'window.value = "</script><script>bad()</script>";';
    const captured: BeforeInteractiveInlineScript[] = [];
    ReactDOMServer.renderToString(
      React.createElement(
        BeforeInteractiveContext.Provider,
        {
          value: (script: BeforeInteractiveInlineScript): BeforeInteractiveRegistration => {
            captured.push(script);
            return "hoisted";
          },
        },
        React.createElement(Script, {
          strategy: "beforeInteractive",
          children: source,
        } as ScriptProps),
      ),
    );
    const emitted = renderBeforeInteractiveInlineScripts(captured);
    const key = captured[0]!.key;
    expect(emitted).toContain(`data-vinext-script-key="${key}"`);

    setGlobalValue("window", {});
    setGlobalValue("document", {
      querySelector: () => null,
      querySelectorAll: () => [
        {
          getAttribute(name: string) {
            return name === "data-vinext-script-key" ? key : null;
          },
          textContent: 'window.value = "\\u003c/script>";',
        },
      ],
    });

    expect(
      ReactDOMServer.renderToString(
        React.createElement(Script, {
          strategy: "beforeInteractive",
          children: source,
        } as ScriptProps),
      ),
    ).toBe("");
  });
});

describe("renderBeforeInteractiveInlineScripts (#2016)", () => {
  it('marks every hoisted script with data-nscript="beforeInteractive"', () => {
    const html = renderBeforeInteractiveInlineScripts([
      { key: "id:x", id: "x", innerHTML: "console.log(1)" },
    ]);
    expect(html).toContain('data-nscript="beforeInteractive"');
    expect(html).toContain('id="x"');
    expect(html).toContain("console.log(1)");
  });

  it("emits a <script src> tag (with no body) for registered src scripts", () => {
    const html = renderBeforeInteractiveInlineScripts([
      {
        key: "id:a",
        id: "a",
        src: "/a.js",
        attributes: { crossorigin: "anonymous", defer: true },
      },
    ]);
    expect(html).toMatch(/<script\b[^>]*src="\/a\.js"/);
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).toContain(" defer");
    expect(html).toContain('data-nscript="beforeInteractive"');
    // src-only scripts have no inline body.
    expect(html).toMatch(/<script[^>]*><\/script>/);
  });

  // Ported from Next.js: test/e2e/app-dir/script-before-interactive/script-before-interactive.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/script-before-interactive/script-before-interactive.test.ts
  // (the "/multiple" route asserting multiple beforeInteractive scripts each
  // render with the correct `class` attribute, never `classname`).
  it("renders multiple hoisted beforeInteractive scripts with correct class attributes", () => {
    const html = renderBeforeInteractiveInlineScripts([
      { key: "id:first", id: "first", innerHTML: "1", attributes: { class: "first-script" } },
      {
        key: "id:second",
        id: "second",
        src: "/second.js",
        attributes: { class: "second-script" },
      },
    ]);
    expect(html).toContain('class="first-script"');
    expect(html).toContain('class="second-script"');
    expect(html).not.toContain('classname="first-script"');
    expect(html).not.toContain('classname="second-script"');
    // Both are tagged and emitted in registration order.
    expect((html.match(/data-nscript="beforeInteractive"/g) ?? []).length).toBe(2);
    expect(html.indexOf("first-script")).toBeLessThan(html.indexOf("second-script"));
  });
});
