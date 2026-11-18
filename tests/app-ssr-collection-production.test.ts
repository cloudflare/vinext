import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
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
});
