import type { Browser, BrowserContextOptions } from "@playwright/test";
import { test, expect } from "../fixtures";

const BASE = "http://localhost:4176";
const PAGE = `${BASE}/action-module-scope`;

// Each action module reads cookies() and headers() at module scope and is only
// referenced from a Client Component, so the first action request is what
// evaluates it in the Worker. Next.js rejects request APIs at module scope; the
// first caller's session must never be cached in the module for later callers.
// https://nextjs.org/docs/messages/next-dynamic-api-wrong-context

async function openSession(browser: Browser, session: string, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({
    ...options,
    extraHTTPHeaders: { "x-session": session },
  });
  await context.addCookies([{ name: "session", value: session, url: BASE }]);
  const page = await context.newPage();
  await page.goto(PAGE);
  return { context, page };
}

function expectedResult(live: string) {
  return JSON.stringify({ moduleScope: "rejected", live });
}

test.describe("server action module evaluation", () => {
  test("a fetch action's module does not capture the first caller's request", async ({
    browser,
  }) => {
    for (const session of ["first-caller", "later-caller"]) {
      const { context, page } = await openSession(browser, session);
      await page.getByTestId("fetch-action").click();
      await expect(page.getByTestId("fetch-result")).toHaveText(expectedResult(session));
      await context.close();
    }
  });

  test("an action module loaded as an action argument does not capture the caller's request", async ({
    browser,
  }) => {
    for (const session of ["first-caller", "later-caller"]) {
      const { context, page } = await openSession(browser, session);
      await page.getByTestId("argument-action").click();
      await expect(page.getByTestId("argument-result")).toHaveText(expectedResult(session));
      await context.close();
    }
  });

  test("a no-JS form action's module does not capture the first caller's request", async ({
    browser,
  }) => {
    for (const session of ["first-caller", "later-caller"]) {
      const { context, page } = await openSession(browser, session, { javaScriptEnabled: false });
      await page.getByTestId("form-action").click();
      await expect(page.getByTestId("form-result")).toHaveText(expectedResult(session));
      await context.close();
    }
  });
});
