import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

// Ported from Next.js:
// test/production/app-dir/cache-components-link-header/cache-components-link-header.test.ts
// https://github.com/vercel/next.js/blob/canary/test/production/app-dir/cache-components-link-header/cache-components-link-header.test.ts
//
// Next.js reproduces this with cacheComponents and "use cache". vinext stores
// the same prerender Link metadata for an App Router page with `revalidate`.

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-isr-link-header");
const CONFIG_LINK = '</llms.txt>; rel="llms-txt"';
const MIDDLEWARE_LINK = '</middleware.css>; rel="preload"; as="style"';

function countLinks(header: string | null) {
  const links = header ? header.split(/,\s*(?=<)/) : [];
  return {
    config: links.filter((link) => link === CONFIG_LINK).length,
    middleware: links.filter((link) => link === MIDDLEWARE_LINK).length,
    preload: links.filter((link) => link.startsWith("</hero.png>")).length,
  };
}

describe("prerendered Link headers", () => {
  let fixtureRoot: string;
  let baseUrl: string;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, "vinext-isr-link-header-");
    const builder = await createBuilder({
      root: fixtureRoot,
      configFile: false,
      plugins: [vinext({ appDir: fixtureRoot })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");
    const prerendered = await runPrerender({ root: fixtureRoot, concurrency: 1 });
    expect(prerendered).not.toBeNull();

    const manifest = JSON.parse(
      await fs.readFile(path.join(fixtureRoot, "dist/server/vinext-prerender.json"), "utf8"),
    ) as {
      routes: Array<{ headers?: { link?: string }; path?: string; route: string; status: string }>;
    };
    const storedLinks = manifest.routes
      .filter((route) => route.status === "rendered" && route.headers?.link)
      .map((route) => route.headers?.link ?? "");
    expect(storedLinks.length).toBeGreaterThan(0);
    for (const link of storedLinks) {
      expect(link).not.toContain("/llms.txt");
      expect(link).not.toContain("middleware.css");
      expect(link).toContain("</hero.png>");
    }

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(fixtureRoot, "dist"),
      noCompression: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("ISR Link header fixture did not bind to a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    close = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
  }, 120_000);

  afterAll(async () => {
    await close?.();
    if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function fetchPage(pathname: string) {
    const response = await fetch(`${baseUrl}${pathname}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-vinext-prerender-link")).toBeNull();
    return {
      links: countLinks(response.headers.get("link")),
      renderedAt: html.match(/id="rendered-at">([^<]*)/)?.[1] ?? "",
    };
  }

  async function expectStableLinks(
    pathname: string,
    expected: { config: number; middleware: number; preload: number },
  ) {
    const first = await fetchPage(pathname);
    expect(first.links).toEqual(expected);
    let renderedAt = first.renderedAt;

    for (let pass = 0; pass < 3; pass++) {
      const deadline = Date.now() + 10_000;
      let next = await fetchPage(pathname);
      while (next.renderedAt === renderedAt && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        next = await fetchPage(pathname);
      }
      expect(next.renderedAt).not.toBe(renderedAt);
      expect(next.links).toEqual(expected);
      renderedAt = next.renderedAt;
    }
  }

  it.each(["/", "/prerendered", "/on-demand"])(
    "emits each Link header once across revalidations of %s",
    async (pathname) => {
      await expectStableLinks(pathname, { config: 1, middleware: 0, preload: 1 });
    },
  );

  it("keeps a middleware Link beside the image preload without stacking either", async () => {
    await expectStableLinks("/middleware-link", { config: 0, middleware: 1, preload: 1 });
  });
});
