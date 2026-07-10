import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "../fixtures";

const FIXTURE_DIR = `${process.cwd()}/tests/e2e/cloudflare-workers/fixture`;
const BASE_URL = "http://localhost:4192";

let server: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`pure App Worker exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/dynamic-preload`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for pure App Worker");
}

test.describe("Cloudflare Workers dynamic preloads", () => {
  test.beforeAll(async () => {
    server = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../../examples/app-router-cloudflare/node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; npx vp build && npx wrangler dev --config dist/server/wrangler.json --port 4192",
      {
        cwd: FIXTURE_DIR,
        shell: true,
        stdio: "inherit",
      },
    );
    await waitForServer();
  });

  test.afterAll(() => {
    server.kill();
  });

  test("preloads dynamic assets with the CSP nonce in a pure App Worker", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto(`${BASE_URL}/dynamic-preload`);
    expect(response?.headers()["content-security-policy"]).toContain(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    const dynamicStylesheet = page.locator('link[rel="stylesheet"][data-precedence="dynamic"]');
    await expect(dynamicStylesheet).toHaveCount(1);
    expect(await dynamicStylesheet.evaluate((element) => (element as HTMLLinkElement).nonce)).toBe(
      "vinext-test-nonce",
    );

    const dynamicScriptPreloads = page.locator(
      'link[rel="preload"][as="script"][fetchpriority="low"]',
    );
    await expect(dynamicScriptPreloads).not.toHaveCount(0);
    for (const preload of await dynamicScriptPreloads.all()) {
      expect(await preload.evaluate((element) => (element as HTMLLinkElement).nonce)).toBe(
        "vinext-test-nonce",
      );
    }

    await page.click('[data-testid="dynamic-count"]');
    await expect(page.locator('[data-testid="dynamic-count"]')).toHaveText("Dynamic count: 1");

    void consoleErrors;
  });

  test("keeps dynamic-error client queries out of shared Worker HTML", async ({
    page,
    request,
    consoleErrors,
  }) => {
    const slug = `worker-query-${Date.now()}`;
    const pathname = `/query-dynamic-error/${slug}`;

    const first = await request.get(`${BASE_URL}${pathname}?q=WORKER_FIRST`);
    expect(first.status()).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain("worker query fallback");
    expect(firstHtml).not.toContain("WORKER_FIRST");

    await page.waitForTimeout(1_100);
    const second = await page.goto(`${BASE_URL}${pathname}?q=WORKER_SECOND`);
    expect(second?.status()).toBe(200);
    expect(second?.headers()["x-vinext-cache"]).toBe("STALE");
    const secondHtml = await second?.text();
    expect(secondHtml).toContain("worker query fallback");
    expect(secondHtml).not.toContain("WORKER_SECOND");
    await expect(page.getByTestId("worker-query")).toHaveText("worker query:WORKER_SECOND");
    await expect(page.locator("body")).not.toContainText("WORKER_FIRST");

    await expect
      .poll(
        async () => {
          const response = await request.get(`${BASE_URL}${pathname}`);
          return response.headers()["x-vinext-cache"];
        },
        { timeout: 10_000 },
      )
      .toBe("HIT");

    const third = await page.goto(`${BASE_URL}${pathname}?q=WORKER_THIRD`);
    expect(third?.status()).toBe(200);
    expect(third?.headers()["x-vinext-cache"]).toBe("HIT");
    const thirdHtml = await third?.text();
    expect(thirdHtml).toContain("worker query fallback");
    expect(thirdHtml).not.toContain("WORKER_THIRD");
    await expect(page.getByTestId("worker-query")).toHaveText("worker query:WORKER_THIRD");
    void consoleErrors;
  });

  test("rejects unbounded and server-inserted query hooks in a pure App Worker", async ({
    request,
  }) => {
    const slug = `worker-reject-${Date.now()}`;

    const unbounded = await request.get(
      `${BASE_URL}/query-dynamic-error-unbounded/${slug}?q=WORKER_ATTACKER`,
    );
    expect(unbounded.status()).toBe(500);
    expect(await unbounded.text()).not.toContain("WORKER_ATTACKER");

    const inserted = await request.get(
      `${BASE_URL}/query-inserted-error/${slug}?q=WORKER_INSERTED_ATTACKER`,
    );
    expect(inserted.status()).toBe(500);
    expect(await inserted.text()).not.toContain("WORKER_INSERTED_ATTACKER");
  });

  test("keeps rewrite destination query out of Worker client hooks", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto(`${BASE_URL}/rewrite-query-visible?shown=yes`);
    expect(response?.status()).toBe(200);
    const html = await response?.text();
    expect(html).toContain("server:shown=<!-- -->yes<!-- -->&amp;hidden=<!-- -->secret");
    expect(html).toContain("client:<!-- -->shown=yes");
    expect(html).not.toContain("client:<!-- -->shown=yes&amp;hidden=secret");

    await expect(page.getByTestId("worker-rewrite-server")).toHaveText(
      "server:shown=yes&hidden=secret",
    );
    await expect(page.getByTestId("worker-rewrite-client")).toHaveText("client:shown=yes");
    void consoleErrors;
  });
});
