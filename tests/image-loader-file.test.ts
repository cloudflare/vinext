// `images.loaderFile` replaces next/image's default loader, as Next.js aliases
// next/dist/shared/lib/image-loader to it. Like any custom loader (and the
// `loader` prop) it builds every srcSet URL and gets the `quality` prop as
// written. next/legacy/image never uses it.
//
// Ported from Next.js:
// test/e2e/next-image-new/loader-config/loader-config.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/loader-config/loader-config.test.ts
// test/e2e/next-image-new/loader-config-default-loader-with-file/loader-config-default-loader-with-file.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/loader-config-default-loader-with-file/loader-config-default-loader-with-file.test.ts

import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { toSlash } from "pathslash";
import { createBuilder, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, fetchHtml, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/image-loader-file");

/** The src and srcset attributes of the `<img>` with this id. */
function imgAttributes(html: string, id: string): { src?: string; srcset?: string } {
  const tag = html.match(new RegExp(`<img[^>]*\\sid="${id}"[^>]*>`))?.[0];
  expect(tag, `<img id="${id}">`).toBeDefined();
  const attribute = (name: string) =>
    tag?.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1].replaceAll("&amp;", "&");
  return { src: attribute("src"), srcset: attribute("srcset") };
}

const LOADER_FILE_IMAGE = {
  src: "/logo.png?loader-file=1&w=828&q=50",
  srcset: "/logo.png?loader-file=1&w=640&q=50 1x, /logo.png?loader-file=1&w=828&q=50 2x",
};
const LOADER_PROP_IMAGE = {
  src: "/logo.png?wid=640&qual=35",
  srcset: "/logo.png?wid=256&qual=35 1x, /logo.png?wid=640&qual=35 2x",
};
// next/legacy/image keeps the default loader.
const LEGACY_IMAGE = {
  src: "/_next/image?url=%2Flogo.png&w=828&q=75",
  srcset: "/_next/image?url=%2Flogo.png&w=640&q=75 1x, /_next/image?url=%2Flogo.png&w=828&q=75 2x",
};

async function expectRenderedImages(baseUrl: string): Promise<void> {
  const pages = await fetchHtml(baseUrl, "/pages-image");
  expect(pages.res.status).toBe(200);
  expect(imgAttributes(pages.html, "loader-file")).toEqual(LOADER_FILE_IMAGE);
  expect(imgAttributes(pages.html, "loader-prop")).toEqual(LOADER_PROP_IMAGE);
  expect(imgAttributes(pages.html, "props-loader-file")).toEqual(LOADER_FILE_IMAGE);
  expect(imgAttributes(pages.html, "props-loader-prop")).toEqual(LOADER_PROP_IMAGE);
  expect(imgAttributes(pages.html, "legacy")).toEqual(LEGACY_IMAGE);

  const app = await fetchHtml(baseUrl, "/app-image");
  expect(app.res.status).toBe(200);
  expect(imgAttributes(app.html, "loader-file")).toEqual(LOADER_FILE_IMAGE);
  expect(imgAttributes(app.html, "props-loader-file")).toEqual(LOADER_FILE_IMAGE);
}

describe("images.loaderFile (dev)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, { appRouter: true }));
  }, 60_000);

  // Closing waits for the dep optimizer, which is slow on a loaded machine.
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it("builds image URLs with the loader file in App and Pages routes", async () => {
    await expectRenderedImages(baseUrl);
  });

  it("gives the browser the loader file", async () => {
    const imageProps = path.resolve(
      import.meta.dirname,
      "../packages/vinext/src/shims/image-props.ts",
    );
    const client = server.environments.client;
    const resolved = await client.pluginContainer.resolveId(
      "private-next-image-loader",
      imageProps,
    );
    expect(resolved?.id).toBe(toSlash(path.join(FIXTURE_DIR, "image-loader.js")));
    // Pre-bundled shims keep the import bare, so the alias still applies.
    expect(client.config.optimizeDeps.exclude).toContain("private-next-image-loader");
  });
});

describe("images.loaderFile (production)", () => {
  let fixtureDir = "";
  let server: Server | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_DIR, "vinext-image-loader-file-");
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
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

  it("builds image URLs with the loader file in App and Pages routes", async () => {
    await expectRenderedImages(baseUrl);
  });

  it("bundles the loader file for the browser", () => {
    const clientDir = path.join(fixtureDir, "dist", "client");
    const chunks = fs
      .readdirSync(clientDir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".js"))
      .map((file) => fs.readFileSync(path.join(clientDir, file), "utf8"));
    expect(chunks.some((code) => code.includes("loader-file=1"))).toBe(true);
  });
});
