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

type SharedEvaluationMarker = { __vinextSharedClientEvaluated?: boolean };

/** The hrefs of a document's stylesheet links, in document order. */
function stylesheetHrefs(html: string): string[] {
  return (html.match(/<link\b[^>]*\brel="stylesheet"[^>]*>/g) ?? []).map(
    (tag) => tag.match(/\bhref="([^"]+)"/)![1]!,
  );
}

/** A document's modulepreload links, in document order. */
function modulepreloadTags(html: string): string[] {
  return html.match(/<link\b[^>]*\brel="modulepreload"[^>]*>/g) ?? [];
}

/** The hrefs of a document's modulepreload links, sorted. */
function modulepreloadHrefs(html: string): string[] {
  return modulepreloadTags(html)
    .map((tag) => tag.match(/\bhref="([^"]+)"/)![1]!)
    .sort();
}

/** The modulepreload links without the fixture's CSP nonce. */
function unnoncedModulepreloads(html: string): string[] {
  return modulepreloadTags(html).filter((tag) => !tag.includes('nonce="vinext-test-nonce"'));
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

  // Client CSS file names are hash-only (`css/[hash].css`), so find files by
  // content.
  const clientCssFiles = () => {
    const clientDir = path.join(fixtureDir, "dist", "client");
    return fs
      .readdirSync(clientDir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".css"))
      .map((file) => ({
        href: `/${file.split(path.sep).join("/")}`,
        css: fs.readFileSync(path.join(clientDir, file), "utf8"),
      }));
  };
  const clientFileHref = (extension: string, content: string): string => {
    const clientDir = path.join(fixtureDir, "dist", "client");
    const file = fs
      .readdirSync(clientDir, { recursive: true, encoding: "utf8" })
      .find(
        (name) =>
          name.endsWith(extension) &&
          fs.readFileSync(path.join(clientDir, name), "utf8").includes(content),
      );
    expect(file, `${content} missing from client output`).toBeDefined();
    return `/${file!.split(path.sep).join("/")}`;
  };
  const cssHref = (rule: string): string => clientFileHref(".css", rule);
  // The `--css-group-winner` value of the last rule for `selector` across the
  // linked stylesheets, in document order: the one the browser applies.
  const winningRule = (html: string, selector: string): string | undefined => {
    const files = new Map(clientCssFiles().map(({ href, css }) => [href, css]));
    const rule = new RegExp(
      `${selector.replace(".", "\\.")}\\s*\\{[^}]*--css-group-winner:\\s*(\\w+)`,
      "g",
    );
    let winner: string | undefined;
    for (const href of stylesheetHrefs(html)) {
      for (const match of (files.get(href) ?? "").matchAll(rule)) winner = match[1];
    }
    return winner;
  };

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

    const warm = await (await fetch(`${baseUrl}/dynamic`)).text();
    const warmStylesheets = (warm.match(/<link\b[^>]*\brel="stylesheet"[^>]*>/g) ?? []).filter(
      (tag) => tag.includes(widgetHref),
    );
    expect(warmStylesheets).toEqual(stylesheets);
  });

  it("streams a client component that awaits at its top level, as Next.js does", async () => {
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
    expect(stylesheetHrefs(cold.first)).toEqual(stylesheetHrefs(warm.first));
    // The first chunk hints the panel's script, loaded or not.
    const panelJs = clientFileHref(".js", "streamed-panel");
    expect(modulepreloadHrefs(cold.first)).toContain(panelJs);
    expect(modulepreloadHrefs(cold.first)).toEqual(modulepreloadHrefs(warm.first));
    expect(unnoncedModulepreloads(cold.html)).toEqual([]);
    expect(unnoncedModulepreloads(warm.html)).toEqual([]);
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
    const hrefs = stylesheetHrefs(cold.first);
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

  it("streams a layout's top-level-await client component while the page's renders", async () => {
    const cold = await readStream(`${baseUrl}/layout-streamed`);

    expect(cold.first).toContain('data-testid="layout-fallback"');
    expect(cold.first).not.toContain('data-testid="layout-panel"');
    expect(cold.first).toContain('data-testid="page-note"');
    expect(cold.html).toContain('data-testid="layout-panel"');

    const warm = await readStream(`${baseUrl}/layout-streamed`);
    expect(warm.first).toContain('data-testid="layout-panel"');
    expect(stylesheetHrefs(cold.first)).toEqual(stylesheetHrefs(warm.first));
    // The layout's references come before the page's, as in both Next.js
    // bundlers.
    const hrefs = stylesheetHrefs(cold.first);
    const panelIndex = hrefs.indexOf(cssHref(".layout-panel"));
    const noteIndex = hrefs.indexOf(cssHref(".page-note"));
    expect(panelIndex).toBeGreaterThanOrEqual(0);
    expect(noteIndex).toBeGreaterThan(panelIndex);
  });

  it("links a streamed component's stylesheet in import order, not render order, on concurrent first requests", async () => {
    const colds = await Promise.all([1, 2, 3].map(() => readStream(`${baseUrl}/import-order`)));
    const warm = await readStream(`${baseUrl}/import-order`);

    const slowHref = cssHref(".import-order-slow");
    const fastHref = cssHref(".import-order-fast");
    expect(slowHref).not.toBe(fastHref);
    for (const cold of colds) {
      expect(cold.first).toContain('data-testid="import-order-fallback"');
      expect(cold.first).not.toContain('data-testid="import-order-slow"');
      expect(cold.first).toContain('data-testid="import-order-fast"');
      expect(cold.html).toContain('data-testid="import-order-slow"');
      const hrefs = stylesheetHrefs(cold.first);
      expect(new Set(hrefs).size).toBe(hrefs.length);
      expect(hrefs).toEqual(stylesheetHrefs(warm.first));
    }
    // Slow renders first but is imported second. Next.js's Turbopack build
    // links in import order (its webpack build would link Slow first).
    const hrefs = stylesheetHrefs(warm.first);
    expect(hrefs.indexOf(fastHref)).toBeGreaterThanOrEqual(0);
    expect(hrefs.indexOf(slowHref)).toBeGreaterThan(hrefs.indexOf(fastHref));
  });

  it.each([
    // Turbopack's order: the component imported last wins (webpack's build
    // lets the top-level-await one win here).
    ["slow-first", "fast"],
    ["slow-second", "slow"],
  ])(
    "applies the rule of the component imported last when two in one group share a selector (%s)",
    async (route, winner) => {
      const cold = await readStream(`${baseUrl}/css-group/${route}`);
      const warm = await readStream(`${baseUrl}/css-group/${route}`);

      expect(cold.first).toContain('data-testid="css-group-fallback"');
      expect(winningRule(cold.first, `.css-group-${route}`)).toBe(winner);
      expect(winningRule(warm.first, `.css-group-${route}`)).toBe(winner);
    },
  );

  it("passes a top-level-await client module's function export as a prop", async () => {
    for (const label of ["cold", "warm"]) {
      const { html } = await readStream(`${baseUrl}/value-prop`);
      expect(html, label).toContain(">formatted:42<");
    }
  });

  it("loads another route's client code on that route's first request", async () => {
    const response = await fetch(`${baseUrl}/other`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-testid="unrelated"');
    expect(unrelatedClientEvaluated()).toBe(true);
  });

  it("evaluates a client module two routes share on the first request that renders it", async () => {
    // Every route above has rendered by now; none of them renders the note.
    expect((globalThis as SharedEvaluationMarker).__vinextSharedClientEvaluated).toBeUndefined();

    const response = await fetch(`${baseUrl}/shared/two`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-testid="shared-note"');
    expect((globalThis as SharedEvaluationMarker).__vinextSharedClientEvaluated).toBe(true);
  });

  it("hints every script once, with the CSP nonce", async () => {
    // plugin-rsc hints a client component's scripts without the nonce, which
    // the fixture's `script-src 'nonce-…'` policy blocks.
    for (const route of [
      "/",
      "/dynamic",
      "/streamed/also",
      "/layout-streamed/nested",
      "/shared/one",
    ]) {
      for (const pass of ["first", "second"]) {
        const html = await (await fetch(`${baseUrl}${route}`)).text();
        const hrefs = modulepreloadHrefs(html);
        expect(hrefs.length, `${route} (${pass})`).toBeGreaterThan(1);
        expect(unnoncedModulepreloads(html), `${route} (${pass})`).toEqual([]);
        // next/dynamic links the widget's chunk again, as plugin-rsc hints it.
        if (route !== "/dynamic")
          expect(new Set(hrefs).size, `${route} (${pass})`).toBe(hrefs.length);
      }
    }
  });

  it("preloads the RouteManifest chunk the browser entry imports, at low priority", async () => {
    // A dynamic import() is fetched at high priority; the preload keeps the
    // browser entry's import of the manifest off the document's bandwidth.
    const href = clientFileHref(".js", '"routes":[');
    for (const route of ["/", "/streamed/also"]) {
      const html = await (await fetch(`${baseUrl}${route}`)).text();
      const preload = modulepreloadTags(html).filter((tag) => tag.includes(`href="${href}"`));
      expect(preload, route).toHaveLength(1);
      expect(preload[0], route).toContain('fetchPriority="low"');
    }
  });

  it("loads every module script at low priority, like Next.js's async scripts", async () => {
    // Browsers fetch module scripts at high priority unless told otherwise.
    // The shell-error document is built by hand, without React's hints.
    for (const route of ["/", "/dynamic", "/streamed/also", "/shared/one", "/shell-error"]) {
      const html = await (await fetch(`${baseUrl}${route}`)).text();
      const lowPreloads = new Set(
        modulepreloadTags(html)
          .filter((tag) => tag.includes('fetchPriority="low"'))
          .map((tag) => tag.match(/\bhref="([^"]+)"/)![1]!),
      );
      const scripts = (html.match(/<script\b[^>]*>/gi) ?? []).filter(
        (tag) => tag.includes('type="module"') && tag.includes(" src="),
      );
      if (route === "/shell-error") {
        // Only the bootstrap module script.
        expect(html, route).toContain("__next_error__");
        expect(scripts.length, route).toBe(1);
      } else {
        // React's bootstrap script and the client entry's preinitialized chunks.
        expect(scripts.length, route).toBeGreaterThan(1);
      }
      for (const tag of scripts) {
        const src = tag.match(/\bsrc="([^"]+)"/)![1]!;
        // React's bootstrap module script reuses its low-priority preload.
        expect(
          tag.includes('fetchPriority="low"') || lowPreloads.has(src),
          `${route}: ${tag}`,
        ).toBe(true);
      }
      expect(
        modulepreloadTags(html).filter((tag) => !tag.includes('fetchPriority="low"')),
        route,
      ).toEqual([]);
    }
  });
});
