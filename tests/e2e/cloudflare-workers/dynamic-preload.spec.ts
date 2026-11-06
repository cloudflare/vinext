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

  test("hints every script with the CSP nonce on first and later requests", async ({ request }) => {
    // plugin-rsc hints a client component's scripts without the nonce, which
    // the fixture's `script-src 'nonce-…'` policy blocks.
    for (const route of ["/dynamic-preload", "/top-level-await"]) {
      for (const pass of ["first", "second"]) {
        const response = await request.get(`${BASE_URL}${route}`);
        expect(response.status()).toBe(200);
        const preloads = (await response.text()).match(/<link\b[^>]*\brel="modulepreload"[^>]*>/g);
        expect(preloads?.length, `${route} (${pass})`).toBeGreaterThan(1);
        expect(
          preloads!.filter((tag) => !tag.includes('nonce="vinext-test-nonce"')),
          `${route} (${pass})`,
        ).toEqual([]);
      }
    }
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

  test("renders a client component that awaits at its top level", async ({
    page,
    request,
    consoleErrors,
  }) => {
    // The build streams this component: its load runs through the SSR
    // entry's wrapped client reference loader.
    const stylesheets = (html: string) =>
      (html.match(/<link\b[^>]*\brel="stylesheet"[^>]*>/g) ?? []).map(
        (tag) => tag.match(/\bhref="([^"]+)"/)![1],
      );
    const documents: string[] = [];
    for (let index = 0; index < 2; index++) {
      const response = await request.get(`${BASE_URL}/top-level-await`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-testid="top-level-await-panel"');
      // A component that fails on the server leaves a client-rendered
      // boundary (`<!--$!-->`) carrying the error digest.
      expect(html).not.toContain("<!--$!-->");
      documents.push(html);
    }
    expect(stylesheets(documents[0]!)).toHaveLength(1);
    expect(stylesheets(documents[1]!)).toEqual(stylesheets(documents[0]!));

    await page.goto(`${BASE_URL}/top-level-await`);
    await expect(page.getByTestId("top-level-await-panel")).toHaveCSS("color", "rgb(0, 128, 0)");

    void consoleErrors;
  });

  test("paints a client component below loading.js styled, fetching its stylesheet once", async ({
    page,
    consoleErrors,
  }) => {
    const stylesheetRequests: string[] = [];
    // A slow stylesheet would show an unstyled reveal, which a fast one can hide.
    await page.route(/\.css(\?|$)/, async (route) => {
      stylesheetRequests.push(route.request().url());
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await page.addInitScript(() => {
      const record = () => {
        const panel = document.querySelector('[data-testid="late-client-css-panel"]');
        if (panel && panel.getClientRects().length > 0) {
          document.documentElement.dataset.firstPaintColor = getComputedStyle(panel).color;
          return;
        }
        requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });

    await page.goto(`${BASE_URL}/late-client-css`);
    await expect(page.getByTestId("late-client-css-panel")).toHaveCSS("color", "rgb(102, 51, 153)");
    await expect(page.locator("html")).toHaveAttribute(
      "data-first-paint-color",
      "rgb(102, 51, 153)",
    );
    await page.waitForLoadState("networkidle");
    expect(stylesheetRequests).toHaveLength(new Set(stylesheetRequests).size);

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

  // Workers sends the bytes of ArrayBuffer and other typed array chunks in a
  // stream or async iterable fetch body, so cached POSTs are keyed by them.
  // Views with shadowed byte range properties are keyed by the bytes sent too.
  const chunkCases = [
    ...["stream", "iterable"].flatMap((source) =>
      ["dataview", "arraybuffer", "uint16array"].map((chunk) => ({ source, chunk, shadow: false })),
    ),
    ...["dataview", "uint16array"].map((chunk) => ({ source: "stream", chunk, shadow: true })),
  ];
  for (const { source, chunk, shadow } of chunkCases) {
    const shadowed = shadow ? " shadowed" : "";
    test(`keys cached fetches by the bytes of${shadowed} ${chunk} ${source} body chunks`, async ({
      request,
    }) => {
      type CachedOrigin = {
        body: { caseId: string; variant: string };
        originRequestId: string;
      };
      const caseId = crypto.randomUUID();
      const readCase = async (variant: string): Promise<CachedOrigin> => {
        const response = await request.get(
          `${BASE_URL}/api/fetch-cache-stream-chunk-body?case=${caseId}&variant=${variant}&chunk=${chunk}&source=${source}${shadow ? "&shadow" : ""}`,
        );
        expect(response.status()).toBe(200);
        return (await response.json()) as CachedOrigin;
      };

      // Read until the first body is served from the data cache, so the read
      // of the equal-length second body would find it if both shared a key.
      let first: CachedOrigin | undefined;
      await expect
        .poll(
          async () => {
            const read = await readCase("aa");
            expect(read.body).toEqual({ caseId, variant: "aa" });
            const servedFromCache = read.originRequestId === first?.originRequestId;
            first = read;
            return servedFromCache;
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      // The bodies differ only at an odd byte offset, which a Uint16Array
      // chunk's elements wouldn't keep if they were truncated to bytes.
      const second = await readCase("ab");
      expect(second.body).toEqual({ caseId, variant: "ab" });
      expect(second.originRequestId).not.toBe(first?.originRequestId);
    });
  }

  // A cached fetch keys and sends its request as it was when fetch was called,
  // so a change right after the call can't store one request's response under
  // another's key.
  for (const input of ["url", "headers", "request-headers", "body"]) {
    test(`keys and sends a cached fetch's ${input} as it was when fetch was called`, async ({
      request,
    }) => {
      type CachedOrigin = { received: string; originRequestId: string };
      const caseId = crypto.randomUUID();
      const readCase = async (user: string, change: boolean): Promise<CachedOrigin> => {
        const response = await request.get(
          `${BASE_URL}/api/fetch-cache-changed-request?case=${caseId}&input=${input}&user=${user}${change ? "&change" : ""}`,
        );
        expect(response.status()).toBe(200);
        return (await response.json()) as CachedOrigin;
      };

      // Read until alice's response is served from the data cache. Each read
      // changes the request to bobby's after the call.
      let alice: CachedOrigin | undefined;
      await expect
        .poll(
          async () => {
            const read = await readCase("alice", true);
            expect(read.received).toContain("alice");
            expect(read.received).not.toContain("bobby");
            const servedFromCache = read.originRequestId === alice?.originRequestId;
            alice = read;
            return servedFromCache;
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      const bobby = await readCase("bobby", false);
      expect(bobby.received).toContain("bobby");
      expect(bobby.originRequestId).not.toBe(alice?.originRequestId);
    });
  }
});
