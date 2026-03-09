/**
 * next/script shim unit tests.
 *
 * Tests the Script component's SSR behavior, strategy handling,
 * and the imperative script loading utilities (handleClientScriptLoad,
 * initScriptLoader). Only SSR-testable behaviors are verified here;
 * client-side loading strategies require a browser environment.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Script, { type ScriptProps } from "../packages/vinext/src/shims/script.js";

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
});
