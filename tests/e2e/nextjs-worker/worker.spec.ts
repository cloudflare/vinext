import { expect, test } from "../fixtures";

// Ported from Next.js: test/e2e/app-dir/worker/worker.test.ts
// https://github.com/vercel/next.js/blob/2fbeebbaca93e8f478d6b9b97a964ac09ec54faf/test/e2e/app-dir/worker/worker.test.ts

test.describe("app dir - workers", () => {
  let workerStaticRequests: string[];

  test.beforeEach(async ({ page }) => {
    workerStaticRequests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname.includes("/_next/static/workers/") ||
        /\/_next\/static\/(?:add|test-image)-/.test(url.pathname)
      ) {
        workerStaticRequests.push(url.toString());
      }
    });
  });

  test.afterEach(({ page: _page }, testInfo) => {
    // A literal public URL is intentionally not bundled into a worker graph.
    if (testInfo.title.includes("string specifiers")) {
      expect(workerStaticRequests).toHaveLength(0);
      return;
    }

    expect(workerStaticRequests.length).toBeGreaterThan(0);
    for (const requestUrl of workerStaticRequests) {
      expect(new URL(requestUrl).searchParams.get("dpl"), requestUrl).toBe("test-deployment-id");
    }
  });

  test("should support web workers with dynamic imports", async ({ page, consoleErrors }) => {
    await page.goto("/classic");
    await expect(page.locator("#worker-state")).toHaveText("default");

    await page.locator("button").click();

    await expect(page.locator("#worker-state")).toHaveText("worker.ts:worker-dep");
    void consoleErrors;
  });

  test("should support module web workers with dynamic imports", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto("/module");
    await expect(page.locator("#worker-state")).toHaveText("default");

    await page.locator("button").click();

    await expect(page.locator("#worker-state")).toHaveText("worker.ts:worker-dep");
    void consoleErrors;
  });

  test("should not bundle web workers with string specifiers", async ({ page, consoleErrors }) => {
    await page.goto("/string");
    await expect(page.locator("#worker-state")).toHaveText("default");

    await page.locator("button").click();

    await expect(page.locator("#worker-state")).toHaveText("unbundled-worker");
    void consoleErrors;
  });

  test("should have access to NEXT_DEPLOYMENT_ID in web worker", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto("/deployment-id");

    await expect(page.locator("#main-deployment-id")).toHaveText("test-deployment-id");
    await expect(page.locator("#worker-deployment-id")).toHaveText("default");

    await page.locator("button").click();

    await expect(page.locator("#worker-deployment-id")).toHaveText("test-deployment-id");
    void consoleErrors;
  });

  test("should support loading WASM files in workers", async ({ page, consoleErrors }) => {
    await page.goto("/wasm");
    await expect(page.locator("#worker-state")).toHaveText("default");

    await page.locator("button").click();

    await expect(page.locator("#worker-state")).toHaveText("result:42");
    void consoleErrors;
  });

  test("should support rendering an SVG with a WASM package in a worker", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto("/resvg");
    await expect(page.locator("#worker-state")).toHaveText("default");

    await page.locator("button").click();

    await expect(page.locator("#worker-state")).toHaveText("success");
    await expect(page.locator("#png-type")).toHaveText("image/png");
    await expect(page.locator("#png-dimensions")).toHaveText("16x8");
    expect(Number(await page.locator("#png-size").textContent())).toBeGreaterThan(0);
    void consoleErrors;
  });

  test("should support shared workers", async ({ page, consoleErrors }) => {
    await page.goto("/shared");
    await expect(page.locator("#worker-state")).toHaveText("default");

    await page.locator("button").click();

    await expect(page.locator("#worker-state")).toHaveText("shared-worker.ts:worker-dep:2");
    void consoleErrors;
  });

  test("should support loading PNG files in web workers", async ({ page, consoleErrors }) => {
    await page.goto("/png");
    await expect(page.locator("#png-url")).toHaveText("default");

    await page.locator("button").click();

    await expect(page.locator("#png-url")).toContainText("test-image");
    await expect(page.locator("#png-url")).toContainText(".png");
    await expect(page.locator("#png-width")).toHaveText("1");
    await expect(page.locator("#png-height")).toHaveText("1");
    await expect(page.locator("#fetch-status")).toHaveText("200");
    await expect(page.locator("#content-type")).toHaveText("image/png");

    void consoleErrors;
  });
});
