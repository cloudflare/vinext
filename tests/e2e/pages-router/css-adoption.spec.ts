import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite-plus";
import { waitForHydration } from "../helpers";

const fixtureSource = path.resolve(process.cwd(), "tests/fixtures/pages-css-adoption");
let fixtureRoot: string;
let server: ViteDevServer;
let baseUrl: string;

test.beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-css-adoption-"));
  await fs.cp(fixtureSource, fixtureRoot, { recursive: true });
  await fs.symlink(
    path.resolve(process.cwd(), "tests/fixtures/pages-basic/node_modules"),
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

// Ported from Next.js's Pages Router CSS ordering coverage:
// test/integration/css/test/css-modules.test.ts
// https://github.com/vercel/next.js/blob/canary/test/integration/css/test/css-modules.test.ts
test("initial Pages stylesheets are adopted by Vite instead of injected twice", async ({
  page,
  request,
}) => {
  const nonceResponse = await request.get(`${baseUrl}/?nonce=css-adoption`);
  const initialHtml = await nonceResponse.text();
  const initialStyleTags = Array.from(
    initialHtml.matchAll(/<link\b[^>]*>/g),
    ([tag]) => tag,
  ).filter((tag) => /\srel="stylesheet"/.test(tag));

  expect(initialStyleTags).toHaveLength(2);
  expect(initialStyleTags.every((tag) => tag.includes("data-vite-dev-id="))).toBe(true);
  expect(initialStyleTags.every((tag) => tag.includes('nonce="css-adoption"'))).toBe(true);

  await page.goto(baseUrl);
  await waitForHydration(page);
  await expect(page.getByTestId("css-adoption-target")).toHaveCSS("color", "rgb(0, 128, 0)");

  const stylesheetState = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
    const ids = links.map((link) => link.dataset.viteDevId);
    return {
      ids,
      duplicateStyleIds: Array.from(
        document.querySelectorAll<HTMLStyleElement>("style[data-vite-dev-id]"),
      )
        .map((style) => style.dataset.viteDevId)
        .filter((id) => id && ids.includes(id)),
    };
  });

  expect(stylesheetState.ids).toHaveLength(2);
  expect(stylesheetState.ids.every(Boolean)).toBe(true);
  expect(stylesheetState.duplicateStyleIds).toEqual([]);
});
