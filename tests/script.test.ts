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

  it("renders nothing for afterInteractive strategy on SSR", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/tracking.js",
        strategy: "afterInteractive",
      } as ScriptProps),
    );
    expect(html).toBe("");
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

  it("defaults to afterInteractive (renders nothing on SSR)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Script, {
        src: "/default.js",
      } as ScriptProps),
    );
    expect(html).toBe("");
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
});
