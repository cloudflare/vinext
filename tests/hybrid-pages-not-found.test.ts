import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/hybrid-pages-not-found");
const MARKER_COOKIE = "not-found-marker=marker-7f3a";

async function buildAndServe(fixtureRoot: string) {
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: false,
    plugins: [vinext({ appDir: fixtureRoot })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const started = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });
  const server = started.server;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Hybrid not-found production fixture did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// When the app directory is enabled, Next.js renders the App Router not-found
// entry for every 404, and falls back to pages/404 only when that entry is
// missing. A Pages route that resolves to `notFound` goes through the same path
// (base-server.ts renderErrorToResponseImpl, pages-handler.ts render404).
// Ported from Next.js:
//   test/e2e/app-dir/not-found-with-pages-i18n/not-found-with-pages.test.ts
//   test/e2e/app-dir/pages-router-app-not-found/pages-router-app-not-found.test.ts
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/not-found-with-pages-i18n
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/pages-router-app-not-found
// Production only: the dev server renders hybrid Pages through its own path.
describe("hybrid Pages notFound renders the App Router not-found in production", () => {
  let fixtureRoot: string;
  let baseUrl: string;
  let closeServer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, "vinext-hybrid-pages-not-found-");
    const started = await buildAndServe(fixtureRoot);
    baseUrl = started.baseUrl;
    closeServer = started.close;
  }, 120000);

  afterAll(async () => {
    await closeServer?.();
    if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function fetchDocument(pathname: string, method = "GET") {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { accept: "text/html", cookie: MARKER_COOKIE },
    });
    return { response, html: await response.text() };
  }

  it.each([
    ["/", "getStaticProps notFound at the root"],
    ["/foo", "getStaticProps notFound"],
    ["/en-GB/foo", "getStaticProps notFound under a non-default locale"],
    ["/ssr/missing", "getServerSideProps notFound"],
    ["/static/unlisted", "a fallback: false miss"],
  ])("%s (%s) renders app/not-found, not pages/404", async (pathname) => {
    const { response, html } = await fetchDocument(pathname);

    expect(response.status).toBe(404);
    expect(html).toContain("APP ROUTER - 404 PAGE");
    expect(html).not.toContain("PAGES ROUTER - 404 PAGE");
    // The App not-found is fully rendered, including its request-time content.
    expect(html).toContain("marker-7f3a");
    expect(response.headers.get("x-vinext-pages-not-found")).toBeNull();
  });

  it("answers HEAD for a notFound route with the 404 status and no body", async () => {
    const { response, html } = await fetchDocument("/foo", "HEAD");

    expect(response.status).toBe(404);
    expect(html).toBe("");
    expect(response.headers.get("x-vinext-pages-not-found")).toBeNull();
  });

  it("keeps the App Router not-found for an App route that calls notFound()", async () => {
    const { response, html } = await fetchDocument("/app-dir/foo");

    expect(response.status).toBe(404);
    expect(html).toContain("APP ROUTER - 404 PAGE");
  });

  it("keeps the source route's notFound revalidate as the 404's Cache-Control", async () => {
    // Next.js sets Cache-Control from the notFound revalidate before render404,
    // and the App not-found render leaves an existing Cache-Control in place.
    const { response, html } = await fetchDocument("/pages-route/anything");

    expect(response.status).toBe(404);
    expect(html).toContain("APP ROUTER - 404 PAGE");
    expect(html).toContain("marker-7f3a");
    expect(response.headers.get("cache-control")).toBe(
      "s-maxage=1, stale-while-revalidate=31535999",
    );
  });

  it("keeps the JSON notFound payload for /_next/data requests", async () => {
    // A data request is not a document: it never gets the App Router page.
    const about = await fetchDocument("/about");
    const buildId = /"buildId":"([^"]+)"/.exec(about.html)?.[1];
    expect(buildId).toBeTruthy();

    for (const pathname of [
      `/_next/data/${buildId}/foo.json`,
      `/_next/data/${buildId}/ssr/missing.json`,
      `/_next/data/${buildId}/static/unlisted.json`,
    ]) {
      const { response, html } = await fetchDocument(pathname);

      expect(`${pathname} ${response.status}`).toBe(`${pathname} 404`);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(html).not.toContain("APP ROUTER - 404 PAGE");
      expect(response.headers.get("x-vinext-pages-not-found")).toBeNull();
    }
  });

  it("does not let middleware turn a rendered page into the App not-found", async () => {
    // middleware.ts sets x-vinext-pages-not-found on /mw-marker.
    const { response, html } = await fetchDocument("/mw-marker");

    expect(response.status).toBe(200);
    expect(html).toContain("Pages mw-marker page");
    expect(html).not.toContain("APP ROUTER - 404 PAGE");
    expect(response.headers.get("x-vinext-pages-not-found")).toBeNull();
  });

  it("still renders found Pages routes", async () => {
    const about = await fetchDocument("/about");
    expect(about.response.status).toBe(200);
    expect(about.html).toContain("Pages catch-all");

    const ssr = await fetchDocument("/ssr/found");
    expect(ssr.response.status).toBe(200);
    expect(ssr.html).toContain("SSR page");

    const listed = await fetchDocument("/static/listed");
    expect(listed.response.status).toBe(200);
    expect(listed.html).toContain("Static page");
  });
});

// Next.js adds its built-in /_not-found entry to every app directory with
// pages (build/route-discovery.ts), and renderErrorToResponseImpl looks it up
// before /404, so an app without its own not-found still never reaches pages/404.
describe("hybrid Pages notFound in an app without app/not-found", () => {
  let fixtureRoot: string;
  let baseUrl: string;
  let closeServer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, "vinext-hybrid-default-not-found-");
    await fs.rm(path.join(fixtureRoot, "app/not-found.tsx"));
    const started = await buildAndServe(fixtureRoot);
    baseUrl = started.baseUrl;
    closeServer = started.close;
  }, 120000);

  afterAll(async () => {
    await closeServer?.();
    if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it.each(["/foo", "/ssr/missing", "/app-dir/missing"])(
    "%s renders the built-in App not-found, not pages/404",
    async (pathname) => {
      const response = await fetch(`${baseUrl}${pathname}`, { headers: { accept: "text/html" } });
      const html = await response.text();

      expect(response.status).toBe(404);
      expect(html).not.toContain("PAGES ROUTER - 404 PAGE");
      expect(html).toContain("could not be found");
      expect(response.headers.get("x-vinext-pages-not-found")).toBeNull();
    },
  );
});
