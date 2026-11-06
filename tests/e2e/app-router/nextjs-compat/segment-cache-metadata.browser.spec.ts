import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const ROOT = "/nextjs-compat/segment-cache-metadata";

type RscResponseRecord = {
  body: string | null;
  ok: boolean;
  pathname: string;
  prefetchHeader: string | undefined;
  renderModeHeader: string | undefined;
  settled: boolean;
};

type ProductionApp = {
  baseUrl: string;
  fixtureRoot: string;
  server: Server;
};

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function copyFixture(): Promise<string> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-segment-cache-metadata-"));
  const sourceRoot = path.resolve(process.cwd(), "tests/fixtures/app-bfcache");
  const sourceNodeModules = path.join(sourceRoot, "node_modules");
  await fs.cp(sourceRoot, fixtureRoot, {
    recursive: true,
    filter: (source) =>
      source !== sourceNodeModules && !source.startsWith(`${sourceNodeModules}${path.sep}`),
  });
  await fs.symlink(sourceNodeModules, path.join(fixtureRoot, "node_modules"), "junction");
  return fixtureRoot;
}

async function buildAndServeFixture(): Promise<ProductionApp> {
  const fixtureRoot = await copyFixture();

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
  });
  await builder.buildApp();

  const { runPrerender } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/build/run-prerender.js")).href
  );
  await runPrerender({ root: fixtureRoot });

  const { startProdServer } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
  );
  const started = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });

  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    fixtureRoot,
    server: started.server,
  };
}

function trackRscRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.searchParams.has("_rsc") || request.headers()["rsc"] !== "1") return;
    requests.push(url.pathname);
  });
  return requests;
}

function trackRscResponses(page: Page): RscResponseRecord[] {
  const responses: RscResponseRecord[] = [];
  const recordsByRequest = new WeakMap<object, RscResponseRecord>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.searchParams.has("_rsc") || request.headers()["rsc"] !== "1") return;
    const record: RscResponseRecord = {
      body: null,
      ok: false,
      pathname: url.pathname,
      prefetchHeader: request.headers()["next-router-prefetch"],
      renderModeHeader: request.headers()["x-vinext-rsc-render-mode"],
      settled: false,
    };
    recordsByRequest.set(request, record);
    responses.push(record);
  });
  page.on("response", async (response) => {
    const record = recordsByRequest.get(response.request());
    if (!record) return;
    try {
      record.body = await response.text();
      record.ok = response.ok();
    } catch {
      // Ignore aborted responses; successful RSC responses are what the assertions observe.
    }
    record.settled = true;
  });
  page.on("requestfailed", (request) => {
    const record = recordsByRequest.get(request);
    if (record) record.settled = true;
  });
  return responses;
}

async function revealAndWaitForPrefetch(
  page: Page,
  href: string,
  responses: RscResponseRecord[],
  expected: string[],
) {
  const before = responses.length;
  await page.locator(`input[data-link-accordion="${href}"]`).click();
  // A prefetch={true} link makes vinext fetch the loading shell beside the full
  // payload. Wait for that request to succeed, so the duplicate check covers a
  // real shell, then for every request of the reveal to settle, the way
  // router-act waits for its whole batch, so the check sees all of them.
  await expect
    .poll(() =>
      responses
        .slice(before)
        .some(
          (response) =>
            response.pathname === href &&
            response.renderModeHeader === "prefetch-loading-shell" &&
            response.settled &&
            response.ok,
        ),
    )
    .toBe(true);
  await expect
    .poll(() => claimExpectedResponses(responses.slice(before), expected).claimed.length)
    .toBe(expected.length);
  await expect.poll(() => responses.slice(before).every((response) => response.settled)).toBe(true);
  const { claimed, duplicate } = claimExpectedResponses(responses.slice(before), expected);
  expect(claimed).toEqual(expected);
  expect(duplicate).toBeNull();
}

// Mirrors Next.js's router-act matching: responses are checked in request
// order, the expected strings must be claimed in order, and a response that
// only repeats an already-claimed string means the server sent it more than
// once.
function claimExpectedResponses(
  responses: RscResponseRecord[],
  expected: string[],
): { claimed: string[]; duplicate: string | null } {
  const claimed: string[] = [];
  let duplicate: string | null = null;

  for (const response of responses) {
    if (response.body === null) continue;

    let remainingBody = response.body;
    let responseWasClaimed = false;
    let firstAlreadyClaimedMatch: string | null = null;
    for (const expectedText of expected) {
      if (!claimed.includes(expectedText) && remainingBody.includes(expectedText)) {
        responseWasClaimed = true;
        remainingBody = remainingBody.slice(
          remainingBody.indexOf(expectedText) + expectedText.length,
        );
        claimed.push(expectedText);
        continue;
      }
      if (firstAlreadyClaimedMatch === null && remainingBody.includes(expectedText)) {
        firstAlreadyClaimedMatch = expectedText;
      }
    }
    if (!responseWasClaimed && firstAlreadyClaimedMatch !== null) {
      duplicate ??= firstAlreadyClaimedMatch;
    }
  }

  return { claimed, duplicate };
}

async function revealAndExpectShellPrefetchOnly(
  page: Page,
  href: string,
  responses: RscResponseRecord[],
  blocked: string[],
) {
  const before = responses.length;
  await page.locator(`input[data-link-accordion="${href}"]`).click();
  await expect
    .poll(() =>
      responses
        .slice(before)
        .some(
          (response) =>
            response.pathname === href &&
            response.prefetchHeader === "1" &&
            response.renderModeHeader === "prefetch-loading-shell",
        ),
    )
    .toBe(true);
  const newResponses = responses.slice(before).filter((response) => response.pathname === href);
  for (const text of blocked) {
    expect(newResponses.some((response) => response.body?.includes(text))).toBe(false);
  }
}

test.setTimeout(120_000);

test.describe("Next.js compat: segment-cache metadata", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/metadata/segment-cache-metadata.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/metadata/segment-cache-metadata.test.ts
  test("reuses prefetched dynamic metadata for a rewrite to the same page", async ({ page }) => {
    const app = await buildAndServeFixture();

    try {
      const requests = trackRscRequests(page);
      const responses = trackRscResponses(page);

      await page.goto(`${app.baseUrl}${ROOT}`);
      await waitForAppRouterHydration(page);

      await revealAndWaitForPrefetch(page, `${ROOT}/page-with-dynamic-head`, responses, [
        "Target page",
        "Dynamic Title",
      ]);
      expect(requests).toContain(`${ROOT}/page-with-dynamic-head`);

      await revealAndExpectShellPrefetchOnly(
        page,
        `${ROOT}/rewrite-to-page-with-dynamic-head`,
        responses,
        ["Target page", "Dynamic Title"],
      );

      await page.waitForTimeout(1_000);
      requests.length = 0;
      await page.locator(`a[href="${ROOT}/rewrite-to-page-with-dynamic-head"]`).click();
      await expect(page.locator("#target-page:visible")).toHaveText("Target page");
      await expect(page).toHaveTitle("Dynamic Title");
      expect(requests).toEqual([]);
    } finally {
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });

  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/metadata/segment-cache-metadata.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/metadata/segment-cache-metadata.test.ts
  test("reuses prefetched runtime metadata for a rewrite to the same page", async ({ page }) => {
    const app = await buildAndServeFixture();

    try {
      const requests = trackRscRequests(page);
      const responses = trackRscResponses(page);

      await page.goto(`${app.baseUrl}${ROOT}`);
      await waitForAppRouterHydration(page);

      await revealAndWaitForPrefetch(
        page,
        `${ROOT}/page-with-runtime-prefetchable-head`,
        responses,
        ["Target page", "Runtime-prefetchable title"],
      );
      expect(requests).toContain(`${ROOT}/page-with-runtime-prefetchable-head`);

      await revealAndExpectShellPrefetchOnly(
        page,
        `${ROOT}/rewrite-to-page-with-runtime-prefetchable-head`,
        responses,
        ["Target page", "Runtime-prefetchable title"],
      );

      await page.waitForTimeout(1_000);
      requests.length = 0;
      await page
        .locator(`a[href="${ROOT}/rewrite-to-page-with-runtime-prefetchable-head"]`)
        .click();
      await expect(page.locator("#target-page:visible")).toHaveText("Target page");
      await expect(page).toHaveTitle("Runtime-prefetchable title");
      expect(requests).toEqual([]);
    } finally {
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });
});
