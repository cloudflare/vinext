import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const backend = process.env.VINEXT_E2E_CACHE_BACKEND;

test("deployment pre-warming and force-dynamic bypass work with the configured cache", async ({
  baseURL,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");
  test.setTimeout(90_000);

  const testStartedAt = Date.now();
  const buildId = fs
    .readFileSync("examples/response-store-demo/dist/server/BUILD_ID", "utf-8")
    .trim();
  const rscBuildId = fs
    .readFileSync("examples/response-store-demo/dist/server/RSC_BUILD_ID", "utf-8")
    .trim();
  const deadline = Date.now() + 60_000;
  let consecutiveReady = 0;

  do {
    const readiness = await request.get(`${baseURL}/api/prewarm-version?readiness=${randomUUID()}`);
    if (readiness.ok() && readiness.headers()["x-vinext-seed-worker"] !== "1") {
      const body = (await readiness.json()) as { buildId?: string };
      consecutiveReady = body.buildId === buildId ? consecutiveReady + 1 : 0;
    } else {
      consecutiveReady = 0;
    }
    await readiness.dispose();
    if (consecutiveReady === 5) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);

  expect(consecutiveReady, `${backend} Worker did not finish promotion`).toBe(5);

  const warmed = await request.get(`${baseURL}/cached/intro`, {
    headers: { accept: "text/html" },
  });
  const warmedHeaders = warmed.headers();
  expect(warmed.ok(), JSON.stringify(warmedHeaders)).toBe(true);
  if (backend === "workers-cache") {
    expect(["HIT", "MISS"], JSON.stringify(warmedHeaders)).toContain(
      warmedHeaders["cf-cache-status"],
    );
  } else {
    expect(warmedHeaders["x-vinext-cache"], JSON.stringify(warmedHeaders)).toBe("HIT");
  }
  const warmedBody = await warmed.text();
  const warmedDataId = /data-cache-id[^>]*>([^<]+)</.exec(warmedBody)?.[1];
  expect(warmedDataId).toBeTruthy();
  const cachedAt = Number(/data-cache-created-at[^>]*>([^<]+)</.exec(warmedBody)?.[1]);
  expect(cachedAt).toBeLessThan(testStartedAt + 1_000);

  if (backend === "workers-cache" && warmedHeaders["cf-cache-status"] === "MISS") {
    const reused = await request.get(`${baseURL}/cached/intro`, {
      headers: { accept: "text/html" },
    });
    expect(reused.headers()["cf-cache-status"], JSON.stringify(reused.headers())).toBe("HIT");
    await reused.dispose();
  }

  // This route is explicitly no-store, so neither response-cache implementation
  // can satisfy it. It calls the same cached function as the page and therefore
  // proves that deployment warmup populated the configured data adapter.
  const probe = await request.get(
    `${baseURL}/api/cache-prewarm-probe/intro?cache-e2e=${randomUUID()}`,
  );
  const probeHeaders = probe.headers();
  expect(probe.ok(), JSON.stringify(probeHeaders)).toBe(true);
  expect(probeHeaders["x-vinext-build-id"]).toBe(rscBuildId);
  expect(probeHeaders["cache-control"]).toContain("no-store");
  const probeBody = (await probe.json()) as { cacheId: string; cachedAt: number; slug: string };
  expect(probeBody).toEqual({
    cacheId: warmedDataId,
    cachedAt,
    slug: "intro",
  });

  // The demo is deployed with each cache adapter. A statically observed App
  // page reuses its artifact across user queries; query-dependent output must
  // retain the query that produced it.
  const suffix = randomUUID();
  const independentFirst = await request.get(`${baseURL}/query-independent?q=first-${suffix}`);
  const firstIndependentBody = await independentFirst.text();
  expect(independentFirst.ok()).toBe(true);
  const independentSecond = await request.get(`${baseURL}/query-independent?q=second-${suffix}`);
  const secondIndependentBody = await independentSecond.text();
  expect(independentSecond.ok()).toBe(true);
  expect(secondIndependentBody).toBe(firstIndependentBody);
  expect(
    independentSecond.headers()[backend === "workers-cache" ? "cf-cache-status" : "x-vinext-cache"],
  ).toBe("HIT");

  for (const path of ["query-dependent", "query-client-dependent", "query-public"]) {
    for (const value of [`first-${suffix}`, `second-${suffix}`]) {
      const response = await request.get(`${baseURL}/${path}?q=${value}`);
      expect(response.ok(), `${path}: ${JSON.stringify(response.headers())}`).toBe(true);
      expect(await response.text()).toContain(`data-testid="${path}-value">${value}</output>`);
    }
  }

  const dynamicUrl = `${baseURL}/force-dynamic?cache-e2e=${randomUUID()}`;
  const firstDynamic = await request.get(dynamicUrl);
  const secondDynamic = await request.get(dynamicUrl);
  const firstDynamicHeaders = firstDynamic.headers();
  const secondDynamicHeaders = secondDynamic.headers();
  expect(firstDynamic.ok(), JSON.stringify(firstDynamicHeaders)).toBe(true);
  expect(secondDynamic.ok(), JSON.stringify(secondDynamicHeaders)).toBe(true);
  expect(firstDynamicHeaders["cache-control"]).toContain("no-store");
  expect(secondDynamicHeaders["cache-control"]).toContain("no-store");
  expect(firstDynamicHeaders["x-vinext-cache"]).not.toBe("HIT");
  expect(secondDynamicHeaders["x-vinext-cache"]).not.toBe("HIT");
  expect(firstDynamicHeaders["cf-cache-status"]).not.toBe("HIT");
  expect(secondDynamicHeaders["cf-cache-status"]).not.toBe("HIT");
  const renderId = /force-dynamic-render-id[^>]*>([^<]+)</.exec(await firstDynamic.text())?.[1];
  const nextRenderId = /force-dynamic-render-id[^>]*>([^<]+)</.exec(
    await secondDynamic.text(),
  )?.[1];
  expect(renderId).toBeTruthy();
  expect(nextRenderId).toBeTruthy();
  expect(nextRenderId).not.toBe(renderId);
});
