import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "./helpers";

// Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
// https://github.com/vercel/next.js/blob/v16.2.7/test/e2e/app-dir/actions/app-action.test.ts
// Reproduced against next@16.2.7 build/start: a production action error
// reaches the browser as React's generic message, never the thrown value.
// Since React 19.3 (bundled by next@16.4.1) that message is minified error #441.
export const GENERIC_RSC_ERROR =
  "Error: Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";

const SENSITIVE_DETAILS = /s3cret|10\.0\.0\.5|DB_CONNECTION_FAILED|connectionString|actions\.ts/;

async function collectActionResponseBodies(page: Page): Promise<() => Promise<string[]>> {
  const bodies: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.request().method() === "POST") bodies.push(response.text());
  });
  return () => Promise.all(bodies);
}

export function testProductionActionErrorSanitization(pathname: string): void {
  for (const trigger of ["throw-structured", "throw-error"]) {
    test(`${trigger} action reaches the client without its thrown details`, async ({ page }) => {
      const readBodies = await collectActionResponseBodies(page);
      await page.goto(pathname);
      await waitForAppRouterHydration(page);

      const responsePromise = page.waitForResponse(
        (response) => response.request().method() === "POST",
      );
      await page.click(`#${trigger}`);
      const response = await responsePromise;

      expect(response.status()).toBe(500);
      await expect(page.locator("#error-text")).toHaveText(GENERIC_RSC_ERROR);
      // The digest is the only detail the error carries, as in Next.js.
      await expect(page.locator("#error-digest")).toHaveText(/^\S+$/);
      await expect(page.locator("#error-keys")).toHaveText("digest");
      const bodies = await readBodies();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toMatch(SENSITIVE_DETAILS);
    });
  }

  // Next.js rethrows the error of a form action submitted without JavaScript,
  // so it answers a plain 500 that keeps the action's cookies.
  test("form action submitted without JavaScript answers a plain 500", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const readBodies = await collectActionResponseBodies(page);
      await page.goto(pathname);

      const responsePromise = page.waitForResponse(
        (response) => response.request().method() === "POST",
      );
      await page.click("#submit-form");
      const response = await responsePromise;

      expect(response.status()).toBe(500);
      const headers = await response.allHeaders();
      expect(headers["content-type"]).toMatch(/^text\/plain/);
      expect(headers["cache-control"]).toBe("no-cache, no-store, max-age=0, must-revalidate");
      expect(headers["set-cookie"]).toMatch(/^action-error-cookie=set-before-throw;/);
      expect(await readBodies()).toEqual(["Internal Server Error"]);
    } finally {
      await context.close();
    }
  });
}
