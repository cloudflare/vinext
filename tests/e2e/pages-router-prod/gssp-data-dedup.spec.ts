import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

// Ported from Next.js: test/e2e/getserversideprops/test/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/getserversideprops/test/index.test.ts
// Covers "should dedupe server data requests" and cancellation without errors.

const BASE = "http://localhost:4175";

test.describe("Pages Router concurrent gSSP data navigation", () => {
  test("identical pushes share one request and a superseded request stays silent", async ({
    page,
    consoleErrors,
  }) => {
    const dataRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.includes("/_next/data/") && url.pathname.endsWith("/gssp-dedup-slow.json")) {
        dataRequests.push(url.pathname + url.search);
      }
    });

    await page.goto(`${BASE}/gssp-dedup-test`);
    await waitForHydration(page);

    await page.getByTestId("push-identical").click();
    await expect(page.getByTestId("hit")).toHaveText("hit: 1");
    await expect(page.getByTestId("key")).toHaveText("key: same");
    expect(dataRequests.filter((url) => url.endsWith("?key=same"))).toHaveLength(1);

    await page.goto(`${BASE}/gssp-dedup-test`);
    await waitForHydration(page);
    await page.getByTestId("push-distinct-query").click();
    await expect(page.getByTestId("key")).toHaveText("key: query-two");
    expect(dataRequests.filter((url) => url.endsWith("?key=query-one"))).toHaveLength(1);
    expect(dataRequests.filter((url) => url.endsWith("?key=query-two"))).toHaveLength(1);

    await page.goto(`${BASE}/gssp-dedup-test`);
    await waitForHydration(page);
    await page.getByTestId("push-cancelled").click();
    await expect(page.getByTestId("normal-text")).toHaveText("a normal page");
    expect(dataRequests.filter((url) => url.endsWith("?key=cancelled"))).toHaveLength(1);

    void consoleErrors;
  });
});
