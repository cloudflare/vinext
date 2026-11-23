import fs from "node:fs";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { fetchRsc, startFixtureServer } from "./helpers.js";

// Issue #4810: each App Router page carries only the next/font rules and
// preloads of its own layouts, pages and the client components they render,
// whatever the process served before. Next.js scopes fonts per app entry
// through its next-font-manifest; vinext once collected them into
// process-wide lists that every page carried.
const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-font-route-isolation");
const outDir = path.resolve(FIXTURE_DIR, "dist");
const nodeModulesLink = path.join(FIXTURE_DIR, "node_modules");
const FONTS = ["font-a", "font-b", "font-c", "font-d"];

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
  // Match file names (`font-a.<hash>.woff2`), not CSS like `font-display`.
  const pick = (text: string) => FONTS.filter((font) => text.includes(`${font}.`));
  return { pathname, style: pick(style), preloads: pick(preloads), link: pick(link) };
}

async function fontsInOrder(baseUrl: string) {
  // A client component's font registers once the SSR graph first runs the
  // component, after that render has read its fonts, so warm `/d` first. Its
  // font must still stay out of the other pages.
  await fontsOf(baseUrl, "/d");
  const observed = [];
  for (const pathname of ["/", "/b", "/c", "/d", "/"]) {
    observed.push(await fontsOf(baseUrl, pathname));
  }
  observed.push(await fontsOf(baseUrl, "/missing", 404));
  return observed;
}

// The RSC payload of a client navigation carries the font rules of the
// route's server components, which never run in the browser. A client
// component loads its own fonts there, so `/d`'s payload has none.
async function payloadFontsInOrder(baseUrl: string) {
  const observed = [];
  for (const pathname of ["/", "/b", "/c", "/d", "/"]) {
    const res = await fetchRsc(baseUrl, pathname);
    expect(res.status).toBe(200);
    const payload = await res.text();
    observed.push({ pathname, fonts: FONTS.filter((font) => payload.includes(`${font}.`)) });
  }
  return observed;
}

const EXPECTED_PAYLOADS = [
  { pathname: "/", fonts: ["font-a"] },
  { pathname: "/b", fonts: ["font-b"] },
  { pathname: "/c", fonts: ["font-c"] },
  { pathname: "/d", fonts: [] },
  { pathname: "/", fonts: ["font-a"] },
];

const own = (pathname: string, font: string) => ({
  pathname,
  style: [font],
  preloads: [font],
  link: [font],
});

const EXPECTED = [
  own("/", "font-a"),
  own("/b", "font-b"),
  own("/c", "font-c"),
  // A client component's font loads in the SSR graph.
  own("/d", "font-d"),
  own("/", "font-a"),
  // A route-miss 404 renders only the root layout, which loads no font.
  { pathname: "/missing", style: [], preloads: [], link: [] },
];

describe("App Router next/font is scoped to the requested route (production)", () => {
  let server: import("node:http").Server | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    const builder = await createBuilder({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      logLevel: "silent",
      build: { assetsInlineLimit: 0 },
    });
    await builder.buildApp();

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

  it("answers each page with its own fonts in any request order", async () => {
    expect(await fontsInOrder(baseUrl)).toEqual(EXPECTED);
  });

  it("sends each route's server font rules with its client navigation payload", async () => {
    expect(await payloadFontsInOrder(baseUrl)).toEqual(EXPECTED_PAYLOADS);
  });
});

describe("App Router next/font is scoped to the requested route (dev)", () => {
  let server: ViteDevServer | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, { appRouter: true }));
  }, 120000);

  afterAll(async () => {
    await server?.close();
  });

  it("answers each page with its own fonts in any request order", async () => {
    expect(await fontsInOrder(baseUrl)).toEqual(EXPECTED);
  });

  it("sends each route's server font rules with its client navigation payload", async () => {
    expect(await payloadFontsInOrder(baseUrl)).toEqual(EXPECTED_PAYLOADS);
  });
});
