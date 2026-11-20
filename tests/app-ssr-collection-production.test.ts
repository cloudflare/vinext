import fs from "node:fs";
import path from "node:path";
import { createBuilder, createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { devServerRegistry } from "../packages/vinext/src/plugins/react-server-dom-async-hook.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_SOURCE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-ssr-collection");
const CELL_COUNT = 60;
const LARGE_CELL_COUNT = 12_000;

async function renderedCells(url: URL): Promise<{ count: number; table: string }> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const html = await response.text();
  const table = html.match(/<table id="collection">([\s\S]*?)<\/table>/)?.[1] ?? "";
  return { count: table.match(/<tr>/g)?.length ?? 0, table };
}

// #4770: react-aria-components collections (Table, ListBox, ...) render a hidden
// copy of their children first and build the visible markup from what it
// registered. React writes the page's Flight rows as several chunks at once;
// when SSR rendered between those chunks, the hidden pass suspended partway
// and the visible markup was cut short.
describe("App Router production SSR of a collection built from its children", () => {
  let baseUrl = "";
  let fixtureDir = "";
  let server: import("node:http").Server | undefined;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-ssr-collection-");
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
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }, 120_000);

  afterAll(() => {
    server?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("server-renders every item of the collection", async () => {
    const { count, table } = await renderedCells(new URL("/", baseUrl));
    expect(count).toBe(CELL_COUNT);
    expect(table).toContain(`cell-${CELL_COUNT - 1}-`);
  });

  it("server-renders every item of a collection whose payload is several MB", async () => {
    const { count, table } = await renderedCells(new URL("/large", baseUrl));
    expect(count).toBe(LARGE_CELL_COUNT);
    expect(table).toContain(`cell-${LARGE_CELL_COUNT - 1}-`);
  });

  // A boundary's content comes in a later flush, after the shell, or while
  // React is still writing the first one. Several requests, so a warm server
  // is covered: the first one can be slow enough to hide the race.
  it.each([
    ["streamed after the shell", "/streamed"],
    ["awaited in the first flush", "/awaited"],
  ])("server-renders every item of a collection in a Suspense boundary, %s", async (_, route) => {
    for (let request = 0; request < 3; request += 1) {
      const { count, table } = await renderedCells(new URL(route, baseUrl));
      expect(count).toBe(CELL_COUNT);
      expect(table).toContain(`cell-${CELL_COUNT - 1}-`);
    }
  });
});

// In dev, too, the Flight server is React's Node build, the one Fizz uses.
describe("App Router dev SSR of a collection built from its children", () => {
  let baseUrl = "";
  let fixtureDir = "";
  let server: ViteDevServer | undefined;
  // Taken after the production tests above: their server wraps console.error
  // once for the process.
  let consoleMethods: Record<string, unknown> = {};

  async function startDevServer(): Promise<{ server: ViteDevServer; baseUrl: string }> {
    const devServer = await createServer({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    await devServer.listen();
    const address = devServer.httpServer?.address();
    return {
      server: devServer,
      baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
    };
  }

  beforeAll(async () => {
    consoleMethods = { ...console };
    fixtureDir = await createIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-ssr-collection-dev-");
    ({ server, baseUrl } = await startDevServer());
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it.each([
    ["at the root", "/"],
    ["in a Suspense boundary streamed after the shell", "/streamed"],
    ["in a Suspense boundary awaited in the first flush", "/awaited"],
  ])("server-renders every item of a collection %s", async (_, route) => {
    for (let request = 0; request < 3; request += 1) {
      const { count, table } = await renderedCells(new URL(route, baseUrl));
      expect(count).toBe(CELL_COUNT);
      expect(table).toContain(`cell-${CELL_COUNT - 1}-`);
    }
  });

  // React's Node development Flight server enables an async_hooks hook and
  // wraps console's methods each time a dev server evaluates it, and never
  // undoes either. Each running server keeps its own, and a closed server's
  // hook is disabled and its console methods put back.
  it("keeps one Flight async hook per running dev server", async () => {
    const registry = devServerRegistry();
    const hooksOf = (owner: typeof registry.live extends Set<infer T> ? T : never) =>
      [...owner.hooks.values()].map((hook) => hook.of);
    await renderedCells(new URL("/", baseUrl));
    expect(registry.live.size).toBe(1);
    const [first] = registry.live;
    expect(hooksOf(first)).toHaveLength(1);
    const firstConsoleError = console.error;
    expect(firstConsoleError).not.toBe(consoleMethods.error);

    // A full reload, as when a route is added, evaluates the build and the
    // modules that wrap console after it again, outside a request.
    const firstHook = hooksOf(first)[0];
    const firstLayers = registry.consoleLayers.length;
    server!.environments.rsc.hot.send({ type: "full-reload" });
    await expect.poll(() => hooksOf(first)[0], { timeout: 30_000 }).not.toBe(firstHook);
    expect(hooksOf(first)).toHaveLength(1);
    await expect.poll(() => console.error, { timeout: 30_000 }).not.toBe(firstConsoleError);
    expect(registry.consoleLayers).toHaveLength(firstLayers);
    expect(registry.consoleLayers.every((layer) => !layer.retired)).toBe(true);
    expect((await renderedCells(new URL("/", baseUrl))).count).toBe(CELL_COUNT);
    const reloadedConsoleError = console.error;

    // Same root, so the same pre-bundled build. plugin-rsc's SSR import is
    // the latest server's, so the first one renders again only once it has
    // restarted.
    const second = await startDevServer();
    const secondOwner = [...registry.live].find((owner) => owner !== first)!;
    try {
      const { count } = await renderedCells(new URL("/", second.baseUrl));
      expect(count).toBe(CELL_COUNT);
      expect(hooksOf(secondOwner)).toHaveLength(1);
      expect(hooksOf(secondOwner)[0]).not.toBe(hooksOf(first)[0]);
    } finally {
      await second.server.close();
    }
    expect(secondOwner.closed).toBe(true);
    expect(hooksOf(secondOwner)).toHaveLength(0);
    expect([...registry.live]).toEqual([first]);
    expect(hooksOf(first)).toHaveLength(1);
    expect(console.error).toBe(reloadedConsoleError);

    // A restart closes the server it replaces.
    await server!.restart();
    const { count } = await renderedCells(new URL("/", baseUrl));
    expect(count).toBe(CELL_COUNT);
    expect(first.closed).toBe(true);
    expect(hooksOf(first)).toHaveLength(0);
    expect(registry.live.size).toBe(1);
    expect(hooksOf([...registry.live][0])).toHaveLength(1);
    expect(registry.consoleLayers).toHaveLength(firstLayers);
    expect(registry.consoleLayers.every((layer) => !layer.retired)).toBe(true);

    await server!.close();
    server = undefined;
    expect(registry.live.size).toBe(0);
    expect(registry.consoleLayers).toHaveLength(0);
    expect({ ...console }).toEqual(consoleMethods);
  }, 120_000);
});
