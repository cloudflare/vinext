import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite-plus";
import { waitForHydration } from "../helpers";

// The Cloudflare counterpart of pages-router/css-adoption.spec.ts, on
// tests/fixtures/cf-pages-dev-css-order: `_app` imports a global stylesheet,
// and the page renders a component whose CSS module refines a class of it.
// Both tests pass on the same fixture without the Cloudflare plugin, and
// `next dev` (Next.js 16.2.7, webpack) gives the badge `margin-bottom: 8px`.

const fixtureSource = path.resolve(process.cwd(), "tests/fixtures/cf-pages-dev-css-order");
let fixtureRoot: string;
let server: ViteDevServer;
let baseUrl: string;

test.beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-cf-pages-dev-css-order-"));
  await fs.cp(fixtureSource, fixtureRoot, { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"type":"module"}\n');
  await fs.symlink(
    path.resolve(process.cwd(), "examples/pages-router-cloudflare/node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );
  server = await createServer({
    root: fixtureRoot,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Expected dev server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
});

// The check of pages-router/css-adoption.spec.ts, with the Worker rendering the page.
test("initial Pages stylesheets are adopted by Vite instead of injected twice", async ({
  page,
  request,
}) => {
  const initialHtml = await (await request.get(baseUrl)).text();
  const initialStyleTags = Array.from(
    initialHtml.matchAll(/<link\b[^>]*>/g),
    ([tag]) => tag,
  ).filter((tag) => /\srel="stylesheet"/.test(tag));

  // `_app`'s global stylesheet, then the component's CSS module.
  expect(initialStyleTags).toHaveLength(2);
  expect(initialStyleTags[0]).toContain("/styles/global.css");
  expect(initialStyleTags[1]).toContain("/components/badge.module.css");
  expect(initialStyleTags.every((tag) => tag.includes("data-vite-dev-id="))).toBe(true);

  await page.goto(baseUrl);
  await waitForHydration(page);

  const stylesheetState = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
    const ids = links.map((link) => link.dataset.viteDevId);
    return {
      ids,
      injectedStyles: document.querySelectorAll("style[data-vite-dev-id]").length,
    };
  });

  expect(stylesheetState.ids).toHaveLength(2);
  expect(stylesheetState.ids.every(Boolean)).toBe(true);
  expect(stylesheetState.injectedStyles).toBe(0);
});

test("a component's CSS module still wins over _app's global stylesheet after hydration", async ({
  page,
}) => {
  await page.goto(baseUrl);
  await waitForHydration(page);

  // The badge carries the global `.pill` class (`margin: 0`) and its own
  // module class (`margin-bottom: 8px`). `_app` imports the global stylesheet
  // first, so the module's rule comes later and applies.
  const badge = page.getByTestId("badge");
  await expect(badge).toHaveCSS("display", "inline-flex");
  await expect(badge).toHaveCSS("margin-bottom", "8px");
});
