import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/app-route-client-preloads",
);

// A process serves one production build: the SSR entry's client reference
// loader and the inline CSS manifest are globals.
describe("App Router production SSR streamed client references with inline CSS", () => {
  let baseUrl = "";
  let fixtureDir = "";
  let server: import("node:http").Server | undefined;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(
      FIXTURE_SOURCE_DIR,
      "vinext-route-client-preloads-inline-css-",
    );
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    fs.writeFileSync(
      path.join(fixtureDir, "next.config.mjs"),
      "export default { experimental: { inlineCss: true } };\n",
    );
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      outDir: path.join(fixtureDir, "dist"),
      noCompression: true,
    }));
    const address = server.address();
    expect(address && typeof address === "object").toBeTruthy();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }, 120_000);

  afterAll(() => {
    server?.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("inlines a streamed reference's stylesheet the shell links last", async () => {
    // Nothing else on the page renders after the panel, so its stylesheet
    // links after the shell's.
    const response = await fetch(`${baseUrl}/streamed/also`);
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain('data-testid="streamed-panel"');
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(/<style data-vinext-inline-css[^>]*>[^<]*\.streamed-panel/);
    expect(html).not.toMatch(/<link\b[^>]*\brel="stylesheet"[^>]*>/);
  });

  // Issue #4735: Next.js renders a segment's CSS as a React <style> resource
  // under inlineCss, so the page's below a pending layout reaches the
  // boundary's reveal inline, as React writes it, not fetched.
  it("inlines a page's stylesheet below an async layout in the boundary's reveal", async () => {
    const response = await fetch(`${baseUrl}/loading-css/async-layout/inner?no-csp`);
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain('data-testid="loading-css-async-layout-panel"');
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(/<style data-vinext-inline-css[^>]*>[^<]*--loading-css-async-layout-note/);
    expect(head).not.toContain("--loading-css-async-layout-panel");
    // React's late style resource, which the reveal moves into <head>.
    const panelHref = html
      .slice(head.length)
      .match(
        /<style media="not all" data-precedence="vite-rsc\/client-reference" data-href="([^"]+\.css)">[^<]*--loading-css-async-layout-panel/,
      )?.[1];
    expect(panelHref).toBeDefined();
    // Neither linked nor fetched for the reveal.
    expect(html).not.toMatch(new RegExp(`<link\\b[^>]*\\bhref="${panelHref}"`));
    expect(html).toMatch(/\$RR\("[^"]*","[^"]*",\[\]\)/);
  });

  // React writes a late <style> resource without the CSP nonce, which it
  // takes as a script nonce only, so the reveal links the stylesheet with it.
  it("links a page's stylesheet below an async layout with the CSP nonce in the reveal", async () => {
    const response = await fetch(`${baseUrl}/loading-css/async-layout/inner`);
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain('data-testid="loading-css-async-layout-panel"');
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(
      /<style data-vinext-inline-css nonce="vinext-test-nonce"[^>]*>[^<]*--loading-css-async-layout-note/,
    );
    expect(html).not.toContain("--loading-css-async-layout-panel");
    const reveal = html.match(/\$RR\("[^"]*","[^"]*",(\[\[.*?\]\])\)/)?.[1];
    expect(reveal).toBeDefined();
    expect(JSON.parse(reveal!)).toEqual([
      [
        expect.stringMatching(/\.css$/),
        "vite-rsc/client-reference",
        "crossorigin",
        "",
        "nonce",
        "vinext-test-nonce",
      ],
    ]);
  });
});
