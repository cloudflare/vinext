import fs from "node:fs";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { startFixtureServer } from "./helpers.js";

// Issue #4810, Pages Router: each page's document carries the next/font rules
// and preloads of `_app` and of its own page, whatever the process served
// before. Next.js' next-font-manifest lists each page entry's fonts beside
// `/_app`'s. vinext once imported every page up front and gave each document
// every page's fonts.
const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-font-route-isolation");
const outDir = path.resolve(FIXTURE_DIR, "dist");
const nodeModulesLink = path.join(FIXTURE_DIR, "node_modules");
const FONTS = ["font-app", "font-a", "font-b", "font-error"];

beforeAll(() => {
  fs.rmSync(nodeModulesLink, { recursive: true, force: true });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules"), nodeModulesLink);
});

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(nodeModulesLink, { recursive: true, force: true });
});

async function fontsOf(baseUrl: string, pathname: string, status = 200) {
  const res = await fetch(`${baseUrl}${pathname}`);
  expect(res.status).toBe(status);
  const html = await res.text();
  const style = html.match(/<style data-vinext-fonts[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
  const preloads = [...html.matchAll(/<link rel="preload"[^>]*as="font"[^>]*>/g)].join("\n");
  const link = res.headers.get("link") ?? "";
  // Match file names (`font-a-<hash>.woff2` built, `font-a.woff2` in dev), not
  // `font-app` for `font-a`.
  const pick = (text: string) => FONTS.filter((font) => new RegExp(`${font}[.-]`).test(text));
  return { pathname, style: pick(style), preloads: pick(preloads), link: pick(link) };
}

async function fontsInOrder(baseUrl: string) {
  const observed = [];
  for (const pathname of ["/", "/b", "/c", "/"]) {
    observed.push(await fontsOf(baseUrl, pathname));
  }
  return observed;
}

const fonts = (pathname: string, list: string[]) => ({
  pathname,
  style: list,
  preloads: list,
  link: list,
});

const EXPECTED = [
  fonts("/", ["font-app", "font-a"]),
  // A font loaded by a component the page imports.
  fonts("/b", ["font-app", "font-b"]),
  fonts("/c", ["font-app"]),
  fonts("/", ["font-app", "font-a"]),
];

describe("Pages Router next/font is scoped to the requested page (production)", () => {
  let server: import("node:http").Server | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    const shared = {
      root: FIXTURE_DIR,
      configFile: false as const,
      logLevel: "silent" as const,
    };
    await build({
      ...shared,
      plugins: [vinext()],
      build: {
        assetsInlineLimit: 0,
        outDir: path.join(outDir, "server"),
        ssr: "virtual:vinext-server-entry",
        rolldownOptions: { output: { entryFileNames: "entry.js" } },
      },
    });
    await build({
      ...shared,
      plugins: [vinext()],
      build: {
        assetsInlineLimit: 0,
        outDir: path.join(outDir, "client"),
        manifest: true,
        ssrManifest: true,
        rolldownOptions: { input: "virtual:vinext-client-entry" },
      },
    });

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
      noCompression: true,
    }));
    const addr = server!.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  }, 120000);

  afterAll(() => {
    server?.close();
  });

  it("answers each page with _app's and its own fonts in any request order", async () => {
    expect(await fontsInOrder(baseUrl)).toEqual(EXPECTED);
  });

  // No pages/404: a route miss renders the custom `_error` page, whose
  // document carries `_app`'s fonts and its own, like Next.js' `/_error` entry.
  it("answers a route miss with _app's and the custom _error page's fonts", async () => {
    expect(await fontsOf(baseUrl, "/missing", 404)).toEqual(
      fonts("/missing", ["font-app", "font-error"]),
    );
  });
});

describe("Pages Router next/font is scoped to the requested page (dev)", () => {
  let server: ViteDevServer | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, { appDir: null }));
  }, 120000);

  afterAll(async () => {
    await server?.close();
  });

  it("answers each page with _app's and its own fonts in any request order", async () => {
    expect(await fontsInOrder(baseUrl)).toEqual(EXPECTED);
  });
});
