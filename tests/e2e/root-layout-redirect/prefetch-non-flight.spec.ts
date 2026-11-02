/**
 * A full Link prefetch of a Route Handler that answers with something other
 * than Flight. Link prefetching is production-only, and a hybrid app never
 * prefetches Route Handlers, so this runs against this App Router-only
 * production server.
 *
 * The download's bytes are attacker-influenced text that happens to look like
 * Flight, starting with a `:HX` script resource hint. Decoding them would make
 * ReactDOM insert and run a `data:` script on the page without a click.
 *
 * Next.js parity: `fetchPrefetchResponse` in
 * packages/next/src/client/components/segment-cache/cache.ts discards a
 * successful prefetch response whose Content-Type is not `text/x-component`
 * (outside `output: "export"`), and the click's navigation fetch falls back to
 * a document navigation, which downloads the attachment.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/segment-cache/cache.ts
 */

import { expect, test, type Page } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const ROOT = "/prefetch-non-flight";
const DOWNLOAD = `${ROOT}/download`;
const MARKER = "__VINEXT_PREFETCH_NON_FLIGHT_MARKER__";
const NOTE = `:HX"data:text/javascript,window.${MARKER}=true"\n0:null\n`;

function readMarker(page: Page): Promise<unknown> {
  return page.evaluate((marker) => Reflect.get(window, marker), MARKER);
}

function readDataScripts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.scripts, (script) => script.src).filter((src) => src.startsWith("data:")),
  );
}

async function openPageWithPrefetchedNote(page: Page): Promise<void> {
  const prefetched = page.waitForResponse((response) =>
    isAppRouterRscRequestForPath(response.request(), DOWNLOAD),
  );
  await page.goto(`${ROOT}?doc=${encodeURIComponent(NOTE)}`);
  await waitForAppRouterHydration(page);
  const prefetchResponse = await prefetched;
  expect(prefetchResponse.status()).toBe(200);
  expect(await prefetchResponse.headerValue("content-type")).toBe("text/plain; charset=utf-8");
  await page.waitForLoadState("networkidle");
}

test("does not decode a prefetched plain-text download as Flight", async ({ page }) => {
  await openPageWithPrefetchedNote(page);

  expect(await readDataScripts(page)).toEqual([]);
  expect(await readMarker(page)).toBeUndefined();
});

test("downloads the attachment when the non-Flight prefetch target is clicked", async ({
  page,
}) => {
  await openPageWithPrefetchedNote(page);

  const download = page.waitForEvent("download");
  await page.click("#prefetch-non-flight-download");
  expect((await download).suggestedFilename()).toBe("note.txt");

  expect(await readDataScripts(page)).toEqual([]);
  expect(await readMarker(page)).toBeUndefined();
});
