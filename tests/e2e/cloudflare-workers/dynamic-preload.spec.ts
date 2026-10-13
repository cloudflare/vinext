import { expect, test } from "../fixtures";
import {
  FIXTURE_HOOK_TIMEOUT_MS,
  startFixtureDevServer,
  stopFixtureDevServer,
  type FixtureDevServer,
} from "../../fixture-dev-server.js";

const FIXTURE_DIR = `${process.cwd()}/tests/e2e/cloudflare-workers/fixture`;
const BASE_URL = "http://localhost:4192";

let server: FixtureDevServer;

test.describe("Cloudflare Workers dynamic preloads", () => {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
    testInfo.setTimeout(FIXTURE_HOOK_TIMEOUT_MS);
    server = await startFixtureDevServer({
      name: "pure App Worker",
      root: FIXTURE_DIR,
      port: 4192,
      command: {
        bin: "sh",
        args: [
          "-c",
          "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../../examples/app-router-cloudflare/node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; npx vp build && npx wrangler dev --config dist/server/wrangler.json --port 4192",
        ],
      },
    });
  });

  test.afterAll(() => {
    stopFixtureDevServer(server?.process);
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
      'link[rel="modulepreload"][as="script"][fetchpriority="low"]',
    );
    await expect(dynamicScriptPreloads).not.toHaveCount(0);
    await expect(page.locator('link[rel="preload"][as="script"][fetchpriority="low"]')).toHaveCount(
      0,
    );
    for (const preload of await dynamicScriptPreloads.all()) {
      expect(await preload.getAttribute("crossorigin")).toBe("");
      expect(await preload.evaluate((element) => (element as HTMLLinkElement).nonce)).toBe(
        "vinext-test-nonce",
      );
    }

    await page.click('[data-testid="dynamic-count"]');
    await expect(page.locator('[data-testid="dynamic-count"]')).toHaveText("Dynamic count: 1");

    void consoleErrors;
  });

  test("preserves request.cf in App Router route handlers without ISR caching", async ({
    request,
  }) => {
    for (const marker of ["first", "second"]) {
      const response = await request.get(`${BASE_URL}/api/request-cf?marker=${marker}`);

      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({
        marker,
        clonedMarker: marker,
      });
    }

    const forceStaticResponse = await request.get(
      `${BASE_URL}/api/request-cf-force-static?marker=hidden`,
    );
    expect(forceStaticResponse.status()).toBe(200);
    expect(await forceStaticResponse.json()).toEqual({
      hidesCfAfterDelete: true,
      hidesCfAfterLock: true,
    });
  });

  // Workers sends async iterable fetch bodies, so cached POSTs that differ only
  // in that body must not share a data cache entry.
  test("keys cached fetches by their async iterable bodies", async ({ request }) => {
    type CachedOrigin = {
      body: { caseId: string; visibility: string };
      originRequestId: string;
    };
    const caseId = crypto.randomUUID();
    const readCase = async (visibility: string): Promise<CachedOrigin> => {
      const response = await request.get(
        `${BASE_URL}/api/fetch-cache-iterable-body?case=${caseId}&visibility=${visibility}`,
      );
      expect(response.status()).toBe(200);
      return (await response.json()) as CachedOrigin;
    };

    // Read until the private response is served from the data cache, so the
    // public read below would find it if both bodies shared a key.
    let privateEntry: CachedOrigin | undefined;
    await expect
      .poll(async () => {
        const read = await readCase("private");
        expect(read.body).toEqual({ caseId, visibility: "private" });
        const servedFromCache = read.originRequestId === privateEntry?.originRequestId;
        privateEntry = read;
        return servedFromCache;
      })
      .toBe(true);

    const publicRead = await readCase("public");
    expect(publicRead.body).toEqual({ caseId, visibility: "public" });
    expect(publicRead.originRequestId).not.toBe(privateEntry?.originRequestId);
  });

  // Workers sends the bytes of DataView and ArrayBuffer chunks in a stream
  // fetch body. Those bytes aren't keyed, so such a cached POST is fetched
  // uncached rather than sharing an entry with an equal-length body.
  for (const chunk of ["dataview", "arraybuffer"]) {
    test(`fetches cached POSTs with ${chunk} stream chunks uncached`, async ({ request }) => {
      type OriginRead = {
        body: { caseId: string; variant: string };
        originRequestId: string;
      };
      const caseId = crypto.randomUUID();
      const readCase = async (variant: string): Promise<OriginRead> => {
        const response = await request.get(
          `${BASE_URL}/api/fetch-cache-stream-chunk-body?case=${caseId}&variant=${variant}&chunk=${chunk}`,
        );
        expect(response.status()).toBe(200);
        return (await response.json()) as OriginRead;
      };

      const reads = [await readCase("a"), await readCase("a"), await readCase("b")];
      expect(reads.map((read) => read.body)).toEqual([
        { caseId, variant: "a" },
        { caseId, variant: "a" },
        { caseId, variant: "b" },
      ]);
      expect(new Set(reads.map((read) => read.originRequestId)).size).toBe(3);
    });
  }
});
