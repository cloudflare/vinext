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

type ClientEvaluationMarker = { __vinextUnrelatedClientEvaluated?: boolean };

function unrelatedClientEvaluated(): boolean | undefined {
  return (globalThis as ClientEvaluationMarker).__vinextUnrelatedClientEvaluated;
}

/** A response's first chunk and its whole body. */
async function readStream(url: string): Promise<{ first: string; html: string }> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value, { stream: true });
  let html = first;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    html += decoder.decode(chunk.value, { stream: true });
  }
  return { first, html };
}

// SSR loads only the client references of the route it renders, and waits for
// them before rendering, so the first request after `vinext start` renders
// the same document as every later one.
describe("App Router production SSR route client reference preloads", () => {
  let baseUrl = "";
  let fixtureDir = "";
  let server: import("node:http").Server | undefined;
  let coldHome = "";

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-route-client-preloads-");
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    delete (globalThis as ClientEvaluationMarker).__vinextUnrelatedClientEvaluated;
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

  it("renders concurrent first requests in full", async () => {
    const responses = await Promise.all([fetch(`${baseUrl}/`), fetch(`${baseUrl}/`)]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-testid="providers"');
      expect(html).toContain('data-testid="slow-counter"');
      expect(html).toContain('data-testid="first"');
      expect(html).toContain('data-testid="second"');
      coldHome ||= html;
    }
  });

  it("does not load the client code of a page the request does not render", () => {
    expect(unrelatedClientEvaluated()).toBeUndefined();
  });

  it("renders the same document once warm", async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toBe(coldHome);
    // The siblings link separate stylesheets, in render order either way.
    expect(html.match(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)).toHaveLength(2);
  });

  it("renders a route-miss 404's client components on a first request", async () => {
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('data-testid="not-found-note"');
    expect(unrelatedClientEvaluated()).toBeUndefined();
  });

  it("links a next/dynamic stylesheet with the dynamic precedence and nonce on a first request", async () => {
    const response = await fetch(`${baseUrl}/dynamic`);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="dynamic-widget"');
    // Client CSS file names are hash-only (`css/[hash].css`), so find the
    // widget's stylesheet by content.
    const clientDir = path.join(fixtureDir, "dist", "client");
    const widgetCss = fs
      .readdirSync(clientDir, { recursive: true, encoding: "utf8" })
      .find(
        (file) =>
          file.endsWith(".css") &&
          fs.readFileSync(path.join(clientDir, file), "utf8").includes("dynamic-widget"),
      );
    expect(widgetCss, "widget CSS missing from client output").toBeDefined();
    const widgetHref = `/${path.basename(widgetCss!)}"`;
    const stylesheets = (html.match(/<link\b[^>]*\brel="stylesheet"[^>]*>/g) ?? []).filter((tag) =>
      tag.includes(widgetHref),
    );
    // plugin-rsc links the same CSS (no nonce) when the widget renders; Fizz
    // keeps the first registration of an href, so the nonce-bearing
    // next/dynamic link has to come first.
    expect(stylesheets).toHaveLength(1);
    expect(stylesheets[0]).toContain('data-precedence="dynamic"');
    expect(stylesheets[0]).toContain('nonce="vinext-test-nonce"');
    expect(unrelatedClientEvaluated()).toBeUndefined();
  });

  it("streams a client component that awaits at its top level, as Next.js does", async () => {
    const stylesheets = (html: string) =>
      (html.match(/<link\b[^>]*\brel="stylesheet"[^>]*>/g) ?? []).map(
        (tag) => tag.match(/\bhref="([^"]+)"/)![1],
      );
    const read = () => readStream(`${baseUrl}/streamed`);

    const cold = await read();
    // The shell carries the fallback; the panel streams in once it loads.
    expect(cold.first).toContain('data-testid="streamed-fallback"');
    expect(cold.first).not.toContain('data-testid="streamed-panel"');
    expect(cold.first).toContain('data-testid="badge"');
    expect(cold.html).toContain('data-testid="streamed-panel"');

    const warm = await read();
    expect(warm.first).toContain('data-testid="streamed-panel"');
    // The panel's stylesheet links in import order, as Turbopack's do, just
    // ahead of the badge's, loaded or not, so both renders link the same.
    expect(stylesheets(cold.first)).toEqual(stylesheets(warm.first));
    const clientDir = path.join(fixtureDir, "dist", "client");
    const cssFile = (rule: string) =>
      fs
        .readdirSync(clientDir, { recursive: true, encoding: "utf8" })
        .find(
          (file) =>
            file.endsWith(".css") &&
            fs.readFileSync(path.join(clientDir, file), "utf8").includes(rule),
        );
    const panelCss = cssFile(".streamed-panel");
    const badgeCss = cssFile(".streamed-badge");
    expect(panelCss, "panel CSS missing from client output").toBeDefined();
    expect(badgeCss, "badge CSS missing from client output").toBeDefined();
    // /streamed/also renders the panel too, so it isn't grouped with the badge.
    expect(panelCss).not.toBe(badgeCss);
    const hrefs = stylesheets(cold.first);
    const panelIndex = hrefs.findIndex((href) => href.endsWith(`/${path.basename(panelCss!)}`));
    const badgeIndex = hrefs.findIndex((href) => href.endsWith(`/${path.basename(badgeCss!)}`));
    expect(panelIndex).toBeGreaterThanOrEqual(0);
    expect(badgeIndex).toBeGreaterThan(panelIndex);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("streams a client component importing a top-level-await module from a package without sideEffects", async () => {
    const cold = await readStream(`${baseUrl}/side-effects/undeclared`);

    expect(cold.first).toContain('data-testid="side-effects-fallback"');
    expect(cold.first).not.toContain('data-testid="side-effects-label"');
    expect(cold.html).toContain('data-testid="side-effects-label"');
  });

  it("waits for a client component importing a top-level-await module from a sideEffects: false package", async () => {
    // The emitted output can't tell whether Rolldown dropped this import of a
    // module its package declares free of side effects, so the build doesn't
    // count that module's await, and the render waits for the component.
    // Next.js streams it; this pins the conservative fallback.
    const cold = await readStream(`${baseUrl}/side-effects/declared`);

    expect(cold.first).toContain('data-testid="side-effects-label"');
    expect(cold.first).not.toContain('data-testid="side-effects-fallback"');
  });

  it("loads another route's client code on that route's first request", async () => {
    const response = await fetch(`${baseUrl}/other`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-testid="unrelated"');
    expect(unrelatedClientEvaluated()).toBe(true);
  });
});
