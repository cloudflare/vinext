/**
 * next/document shim tests.
 *
 * These components render placeholder markers that the Pages Router dev-server
 * replaces with real content via string substitution. The tests verify the
 * contracts the dev-server depends on — not that React can render a div.
 */
import { describe, it, expect } from "vitest";
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
  it("injects default charset and viewport meta tags", () => {
    const html = render(React.createElement(Head));
    expect(html).toContain('charSet="utf-8"');
    expect(html).toContain('content="width=device-width, initial-scale=1"');
  });

  it("preserves custom children alongside defaults", () => {
    const html = render(
      React.createElement(Head, null, React.createElement("title", null, "My App")),
    );
    // Custom content rendered
    expect(html).toContain("<title>My App</title>");
    // Defaults still present
    expect(html).toContain('charSet="utf-8"');
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
