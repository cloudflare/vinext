import { spawn, type ChildProcess } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Ported from Next.js v16.2.6:
// test/e2e/app-dir/worker/worker.test.ts
// https://github.com/vercel/next.js/blob/ee6e79b1792a4d401ddf2480f40a83549fe8e722/test/e2e/app-dir/worker/worker.test.ts
//
// The seven test bodies below retain the upstream names, routes, interactions,
// and assertions. The only omitted upstream behavior is `beforePageLoad`, whose
// suite-wide hook requires Turbopack's private `?dpl=` token on every `/_next/`
// request. tests/worker-e2e-provenance.test.ts compares these bodies with the
// checked-in upstream snapshot and verifies every mapped fixture file/hash.

const FIXTURE_DIR = `${process.cwd()}/tests/e2e/cloudflare-workers/worker-fixture`;
const BASE_URL = "http://localhost:4201";
const DEPLOYMENT_ID = "test-deployment-id";

let server: ChildProcess;
let testPage: Page;

class BrowserElement {
  constructor(private readonly locator: Locator) {}

  async text(): Promise<string> {
    return (await this.locator.textContent()) ?? "";
  }

  async click(): Promise<void> {
    await this.locator.click();
  }
}

class Browser {
  constructor(private readonly page: Page) {}

  elementByCss(selector: string): BrowserElement {
    return new BrowserElement(this.page.locator(selector));
  }
}

const next = {
  deploymentId: DEPLOYMENT_ID,
  async browser(pathname: string): Promise<Browser> {
    await testPage.goto(`${BASE_URL}${pathname}`);
    return new Browser(testPage);
  },
};

async function retry(assertion: () => Promise<unknown>): Promise<void> {
  await expect(assertion).toPass({ timeout: 10_000 });
}

const describe = test.describe;
const it = test;
const isNextDeploy = true;
const isNextStart = false;
const isTurbopack = true;

describe("app dir - workers", () => {
  test.beforeAll(async () => {
    server = spawn(
      `created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../../examples/app-router-cloudflare/node_modules node_modules; created_node_modules=1; fi; trap 'if test "$created_node_modules" = 1; then rm node_modules; fi' EXIT; NEXT_DEPLOYMENT_ID=${DEPLOYMENT_ID} npx vp build && npx wrangler dev --config dist/server/wrangler.json --port 4201`,
      {
        cwd: FIXTURE_DIR,
        shell: true,
        stdio: "inherit",
      },
    );
    for (let attempt = 0; attempt < 240; attempt++) {
      if (server.exitCode !== null) {
        throw new Error(`worker parity fixture exited with code ${server.exitCode}`);
      }
      try {
        const response = await fetch(`${BASE_URL}/classic`);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Timed out waiting for worker parity fixture");
  });

  test.afterAll(() => {
    server.kill();
  });

  test.beforeEach(async ({ page }) => {
    testPage = page;
  });

  it("should support web workers with dynamic imports", async () => {
    const browser = await next.browser("/classic");
    expect(await browser.elementByCss("#worker-state").text()).toBe("default");

    await browser.elementByCss("button").click();

    await retry(async () =>
      expect(await browser.elementByCss("#worker-state").text()).toBe("worker.ts:worker-dep"),
    );
  });

  it("should support module web workers with dynamic imports", async () => {
    const browser = await next.browser("/module");
    expect(await browser.elementByCss("#worker-state").text()).toBe("default");

    await browser.elementByCss("button").click();

    await retry(async () =>
      expect(await browser.elementByCss("#worker-state").text()).toBe("worker.ts:worker-dep"),
    );
  });

  it("should not bundle web workers with string specifiers", async () => {
    const browser = await next.browser("/string");
    expect(await browser.elementByCss("#worker-state").text()).toBe("default");

    await browser.elementByCss("button").click();

    await retry(async () =>
      expect(await browser.elementByCss("#worker-state").text()).toBe("unbundled-worker"),
    );
  });

  if (isNextDeploy || isNextStart) {
    it("should have access to NEXT_DEPLOYMENT_ID in web worker", async () => {
      const browser = await next.browser("/deployment-id");

      // Verify main thread has deployment ID and it's not empty
      const mainDeploymentId = await browser.elementByCss("#main-deployment-id").text();
      expect(mainDeploymentId).toBe(next.deploymentId);

      // Initial worker state should be default
      expect(await browser.elementByCss("#worker-deployment-id").text()).toBe("default");

      // Trigger worker to get deployment ID
      await browser.elementByCss("button").click();

      // Wait for worker to respond and verify it matches main thread
      await retry(async () => {
        const workerDeploymentId = await browser.elementByCss("#worker-deployment-id").text();
        expect(workerDeploymentId).toBe(next.deploymentId);
      });
    });
  }

  it("should support loading WASM files in workers", async () => {
    const browser = await next.browser("/wasm");
    expect(await browser.elementByCss("#worker-state").text()).toBe("default");

    await browser.elementByCss("button").click();

    // The WASM add_one(41) should return 42
    await retry(async () =>
      expect(await browser.elementByCss("#worker-state").text()).toBe("result:42"),
    );
  });

  it("should support shared workers", async () => {
    if (!isTurbopack) {
      // webpack requires a magic attribute for shared workers to function
      return;
    }
    const browser = await next.browser("/shared");
    expect(await browser.elementByCss("#worker-state").text()).toBe("default");

    await browser.elementByCss("button").click();

    await retry(async () =>
      expect(await browser.elementByCss("#worker-state").text()).toBe(
        "shared-worker.ts:worker-dep:2",
      ),
    );
  });

  it("should support loading PNG files in web workers", async () => {
    const browser = await next.browser("/png");
    // Initial state should be default
    expect(await browser.elementByCss("#png-url").text()).toBe("default");

    // Trigger worker to get PNG info
    await browser.elementByCss("button").click();

    // Wait for worker to respond and verify PNG info
    await retry(async () => {
      const pngUrl = await browser.elementByCss("#png-url").text();
      expect(pngUrl).toContain("test-image");
      expect(pngUrl).toContain(".png");
    });

    await retry(async () => {
      const pngWidth = await browser.elementByCss("#png-width").text();
      expect(pngWidth).toBe("1");
    });

    await retry(async () => {
      const pngHeight = await browser.elementByCss("#png-height").text();
      expect(pngHeight).toBe("1");
    });

    // Verify the worker actually fetched the PNG (proves asset URL works in worker)
    await retry(async () => {
      const fetchStatus = await browser.elementByCss("#fetch-status").text();
      expect(fetchStatus).toBe("200");
    });

    await retry(async () => {
      const contentType = await browser.elementByCss("#content-type").text();
      expect(contentType).toBe("image/png");
    });

    // Log the full verification info for visual inspection
    const fetchedFrom = await browser.elementByCss("#fetched-from").text();
    console.log("Web Worker PNG verification:", {
      fetchedFrom,
      contentType: await browser.elementByCss("#content-type").text(),
      status: await browser.elementByCss("#fetch-status").text(),
    });
  });
});
