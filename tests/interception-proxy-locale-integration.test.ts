import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

// Extends Next.js: test/e2e/app-dir/interception-dynamic-segment-middleware/
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/interception-dynamic-segment-middleware
// Next.js navigates from `/`. This fixture adds a source below the locale root:
// unprefixed, `/feed` also matches `/[locale]` itself (with locale "feed"),
// while middleware rewrites it to `/en/feed`. The modal must open from both.
const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/interception-proxy-locale");
const MODAL_MARKER = "INTERCEPTED-MODAL";
const FULL_PAGE_MARKER = "FULL-PAGE";
const SOURCE_MARKERS = {
  root: "ROOT-SOURCE",
  feed: "FEED-SOURCE",
  cafe: "CAFE-SOURCE",
  tag: "TAG-SOURCE",
} as const;

type StartedServer = {
  baseUrl: string;
  close(): Promise<void>;
};

async function startDevServer(root: string): Promise<StartedServer> {
  const { server, baseUrl } = await startFixtureServer(root, { appRouter: true });
  return {
    baseUrl,
    close: () => server.close(),
  };
}

async function startProductionServer(root: string): Promise<StartedServer> {
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(root, "dist"),
    noCompression: true,
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Production server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function fetchSoftNavigation(baseUrl: string, source: string) {
  const response = await fetch(`${baseUrl}/foo/p/1`, {
    headers: {
      Accept: "text/x-component",
      RSC: "1",
      "X-Vinext-Interception-Context": source,
    },
  });
  const body = await response.text();
  return {
    status: response.status,
    modal: body.includes(MODAL_MARKER),
    fullPage: body.includes(FULL_PAGE_MARKER),
    // The source page rendered under the modal. It must be the page the
    // client navigated from, so the client can keep it mounted.
    source: Object.entries(SOURCE_MARKERS)
      .filter(([, marker]) => body.includes(marker))
      .map(([name]) => name),
    body,
  };
}

describe.each([
  ["development", startDevServer],
  ["production", startProductionServer],
] as const)("interception behind a locale-prefixing proxy rewrite (%s)", (_mode, startServer) => {
  let fixtureRoot = "";
  let server: StartedServer | undefined;

  beforeAll(async () => {
    fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, "vinext-interception-proxy-locale-");
    server = await startServer(fixtureRoot);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  // The client sends the public pathname when it matches the interception
  // source pattern, and the matched (rewritten) pathname otherwise. From `/`
  // it sends `/en`; from `/feed` it sends `/feed`, which `[locale]` accepts.
  it.each([
    ["the locale root, sent as its matched pathname", "/en", "root", "/en"],
    ["an already-prefixed source", "/en/feed", "feed", "/en/feed"],
    ["an unprefixed source below the locale root", "/feed", "feed", "/en/feed"],
    // The rewritten source is already percent-encoded, like the raw context.
    ["an unprefixed encoded static source", "/caf%C3%A9", "cafe", "/en/café"],
    ["an unprefixed encoded dynamic source", "/tags/caf%C3%A9", "tag", "/en/tags/café"],
  ])(
    "intercepts from %s (%s)",
    async (_label, source, sourcePage, sourceMatchedUrl) => {
      if (!server) throw new Error("Interception fixture server did not start");
      const { body, ...result } = await fetchSoftNavigation(server.baseUrl, source);
      expect(result).toEqual({
        status: 200,
        modal: true,
        fullPage: false,
        source: [sourcePage],
      });
      // The client accepts an intercepted payload only when its proof names
      // the source it is showing: the matched (rewritten) source pathname.
      expect(body).toContain(`"sourceMatchedUrl":"${sourceMatchedUrl}"`);
    },
    30_000,
  );
});
