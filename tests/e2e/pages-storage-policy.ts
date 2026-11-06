import { expect, test } from "@playwright/test";

// Verified against next@16.2.7 production, HTML and _next/data requests.
// https://github.com/vercel/next.js/blob/v16.2.7/test/e2e/getserversideprops/test/index.test.ts
export function testPagesStoragePolicies(fallbackBaseURL?: string): void {
  test("Pages API storage ignores browser policy", async ({ baseURL, request }) => {
    const base = baseURL ?? fallbackBaseURL;
    const url = `${base}/api/pages-storage-policy/header-only`;
    const read = async () => {
      const response = await request.get(url);
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("public, max-age=3600");
      return (await response.json()).renderId as string;
    };
    expect(await read()).not.toBe(await read());
  });
  for (const [scenario, policy] of [
    ["short-browser", "public, max-age=1"],
    ["long-browser", "private, max-age=300"],
    ["no-store", "no-store"],
    ["gssp", "public, max-age=3600"],
  ] as const) {
    test(`Pages storage ignores browser policy: ${scenario}`, async ({
      baseURL,
      request,
      page,
    }) => {
      test.setTimeout(90_000);
      const base = baseURL ?? fallbackBaseURL;
      test.skip(
        process.env.VINEXT_E2E_CACHE_BACKEND === "workers-cache" && !base?.startsWith("https://"),
        "Workers Cache storage requires the deployed edge",
      );
      const url = `${base}/storage-policy/${scenario}`;
      const read = async () => {
        const response = await request.get(url);
        expect(response.status()).toBe(200);
        expect(response.headers()["cache-control"]).toBe(policy);
        const html = await response.text();
        const json = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
        expect(json).toBeTruthy();
        const data = JSON.parse(json!);
        expect(data.props.pageProps.renderId).toEqual(expect.any(String));
        return {
          renderId: data.props.pageProps.renderId as string,
          buildId: data.buildId as string,
          hit: [
            response.headers()["x-vinext-cache"],
            response.headers()["cf-cache-status"],
          ].includes("HIT"),
        };
      };
      const first = await read();
      const dataURL = `${base}/_next/data/${first.buildId}/storage-policy/${scenario}.json`;
      const readData = async () => {
        const response = await request.get(dataURL);
        expect(response.status()).toBe(200);
        // Next's raw data URL does not match the GSP config-header sources.
        // GSSP sets its header from user code for both representations.
        if (scenario === "gssp") expect(response.headers()["cache-control"]).toBe(policy);
        return {
          renderId: (await response.json()).pageProps.renderId as string,
          hit: [
            response.headers()["x-vinext-cache"],
            response.headers()["cf-cache-status"],
          ].includes("HIT"),
        };
      };
      for (const readRepresentation of [read, readData]) {
        const prior = await readRepresentation();
        if (scenario === "gssp") {
          expect((await readRepresentation()).renderId).not.toBe(prior.renderId);
          continue;
        }
        // Test HTML and data independently. Warming may have happened more
        // than 60 seconds ago, so retry a window that crosses a legitimate
        // stale/regeneration boundary. A one-second backing TTL cannot pass
        // the full 3.2-second HIT-to-HIT window with the same generation.
        if (scenario !== "long-browser") {
          await expect(async () => {
            const anchor = await readRepresentation();
            expect(anchor.hit).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 3200));
            const retained = await readRepresentation();
            expect(retained.hit).toBe(true);
            expect(retained.renderId).toBe(anchor.renderId);
          }).toPass({ timeout: 20000, intervals: [100, 250, 500, 1000] });
        } else {
          let anchor = prior;
          await expect
            .poll(
              async () => {
                anchor = await readRepresentation();
                return anchor.hit;
              },
              { timeout: 15000 },
            )
            .toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 3200));
          await expect
            .poll(async () => (await readRepresentation()).renderId, { timeout: 15000 })
            .not.toBe(anchor.renderId);
        }
      }

      const browserResponse = await page.goto(url);
      expect(browserResponse?.headers()["cache-control"]).toBe(policy);
      await expect(page.getByTestId("storage-render-id")).toHaveText(/^[a-f0-9-]{36}$/);
    });
  }
}
