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
  type ScriptProps,
} from "../packages/vinext/src/shims/script.js";
import { ScriptNonceProvider } from "../packages/vinext/src/shims/script-nonce-context.js";

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalHTMLElement = globalThis.HTMLElement;

function setGlobalValue(key: "document" | "window" | "HTMLElement", value: unknown): void {
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
  setGlobalValue("document", originalDocument);
  setGlobalValue("window", originalWindow);
  setGlobalValue("HTMLElement", originalHTMLElement);
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
});
