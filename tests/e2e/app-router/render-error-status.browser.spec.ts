// A render error that rejects the shell answers with Next.js's status and
// document: a 500 with the `__next_error__` document, which the browser renders
// from the page's own payload, so the error boundary that catches the error
// renders there, a layout's error included. A special error keeps its own
// status, and an error streamed after the shell keeps the 200.
// https://github.com/cloudflare/vinext/issues/4394
// https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/app-render/app-render.tsx
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { expect, test } from "../fixtures";
import {
  startChildProductionServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../production-server";

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/app-render-error-status");
const NEVER_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

type ProductionApp = {
  baseUrl: string;
  server: ChildProductionServer;
};

let fixtureRoot: string | undefined;
let app: ProductionApp | undefined;

function getApp(): ProductionApp {
  if (!app) throw new Error("The production app did not start");
  return app;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-render-error-status-"));
  await fs.cp(FIXTURE_DIR, fixtureRoot, { recursive: true });
  await fs.symlink(
    path.resolve(process.cwd(), "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );
  const vinext = (await import("../../../packages/vinext/src/index.js")).default;
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: false,
    plugins: [vinext({ appDir: fixtureRoot })],
    logLevel: "silent",
  });
  await builder.buildApp();
  const server = await startChildProductionServer(fixtureRoot);
  app = { baseUrl: `http://127.0.0.1:${server.port}`, server };
});

test.afterAll(async () => {
  if (app) await stopChildProductionServer(app.server);
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
});

test.describe("render error status (#4394)", () => {
  // Requesting consoleErrors starts collecting the page's errors. The fixture
  // has no favicon, which the browser requests anyway.
  test.beforeEach(async ({ consoleErrors, page }) => {
    void consoleErrors;
    await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  });

  // The browser reports the error it renders the boundary for, and the 500 of
  // the error document. Any other error fails the test.
  test.afterEach(({ consoleErrors }) => {
    const unexpectedErrors = consoleErrors.filter(
      (message) =>
        !message.includes("Minified React error #441") &&
        !message.includes("client page error") &&
        !message.includes("global-error.tsx failed") &&
        !message.includes("the server responded with a status of 500") &&
        // React's note after an error a boundary caught.
        !message.startsWith("The above error occurred in "),
    );
    expect(unexpectedErrors).toEqual([]);
    consoleErrors.length = 0;
  });

  for (const { route, boundary, text } of [
    { route: "/throw-page", boundary: "#error-boundary", text: "error.tsx rendered, digest: " },
    {
      route: "/nested/inner",
      boundary: "#nested-error-boundary",
      text: "nested error.tsx rendered",
    },
    // The boundary above the layout catches its error, outside that layout.
    { route: "/badlayout", boundary: "#error-boundary", text: "error.tsx rendered, digest: " },
  ]) {
    test(`a shell error at ${route} sends a 500 and renders its error.tsx`, async ({ page }) => {
      const response = await page.goto(`${getApp().baseUrl}${route}`);
      expect(response?.status()).toBe(500);
      expect(response?.headers()["content-type"]).toBe("text/html; charset=utf-8");
      expect(response?.headers()["cache-control"]).toBe(NEVER_CACHE_CONTROL);
      expect(await response?.text()).toMatch(/^<!DOCTYPE html><html id="__next_error__">/);
      await expect(page.locator(boundary)).toContainText(text);
      if (boundary === "#nested-error-boundary") {
        await expect(page.locator("#error-boundary")).toHaveCount(0);
      }
      if (boundary === "#error-boundary") {
        await expect(page.locator(boundary)).toHaveText(/digest: \d+$/);
        // The payload carries the sanitized error, never its message.
        await expect(page.locator("#error-message")).toContainText("Minified React error #441");
      }
    });
  }

  test("a client component's shell error renders its own message in error.tsx", async ({
    page,
  }) => {
    const response = await page.goto(`${getApp().baseUrl}/client-throw`);
    expect(response?.status()).toBe(500);
    expect(await response?.text()).toMatch(/^<!DOCTYPE html><html id="__next_error__">/);
    // The browser throws the error again itself, so it has no digest.
    await expect(page.locator("#error-boundary")).toHaveText("error.tsx rendered, digest:");
    await expect(page.locator("#error-message")).toHaveText("client page error");
  });

  test("a root layout error sends a 500 and renders global-error.tsx", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "x-throw-root-layout": "1" });
    const response = await page.goto(`${getApp().baseUrl}/`);
    expect(response?.status()).toBe(500);
    expect(response?.headers()["content-type"]).toBe("text/html; charset=utf-8");
    expect(response?.headers()["cache-control"]).toBe(NEVER_CACHE_CONTROL);
    expect(await response?.text()).toMatch(/^<!DOCTYPE html><html id="__next_error__">/);
    await expect(page.locator("#global-error")).toHaveText("global-error.tsx rendered");
    await expect(page.locator("#global-error-digest")).toHaveText(/^\d+$/);
    await expect(page.locator("#global-error-message")).toContainText("Minified React error #441");
  });

  test("a global-error.tsx that throws falls back to the built-in default", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "x-throw-root-layout": "1" });
    const response = await page.goto(`${getApp().baseUrl}/?throw-global-error`);
    expect(response?.status()).toBe(500);
    expect(await response?.text()).toMatch(/^<!DOCTYPE html><html id="__next_error__">/);
    await expect(page.getByRole("heading", { name: "This page couldn’t load" })).toBeVisible();
    await expect(page.locator("#global-error")).toHaveCount(0);
  });

  test("an error streamed after the shell keeps the 200", async ({ page }) => {
    const response = await page.goto(`${getApp().baseUrl}/suspense-throw`);
    expect(response?.status()).toBe(200);
    expect(await response?.text()).toContain('<p id="shell">shell</p>');
    // The error reaches the page's error.tsx, which takes the page's place.
    await expect(page.locator("#error-boundary")).toContainText("error.tsx rendered");
  });

  test("notFound() and redirect() keep their own statuses", async ({ request }) => {
    const missing = await request.get(`${getApp().baseUrl}/missing`);
    expect(missing.status()).toBe(404);
    const redirecting = await request.get(`${getApp().baseUrl}/redirecting`, { maxRedirects: 0 });
    expect(redirecting.status()).toBe(307);
    expect(redirecting.headers().location).toBe("/");
  });
});
