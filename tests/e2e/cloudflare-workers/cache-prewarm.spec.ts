import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const backend = process.env.VINEXT_E2E_CACHE_BACKEND;

test("deployment pre-warming populates the configured data cache", async ({ baseURL, request }) => {
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
  if (backend === "kv") {
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

  if (backend === "kv" && warmedHeaders["cf-cache-status"] === "MISS") {
    const reused = await request.get(`${baseURL}/cached/intro`, {
      headers: { accept: "text/html" },
    });
    expect(reused.headers()["cf-cache-status"], JSON.stringify(reused.headers())).toBe("HIT");
    await reused.dispose();
  }

  // A unique query misses either response cache while the nested "use cache"
  // call retains the same data-cache key because it only receives the slug.
  const originUrl = new URL("/cached/intro", baseURL);
  originUrl.searchParams.set("cache-e2e", randomUUID());
  const origin = await request.get(originUrl.href, {
    headers: { accept: "text/html" },
  });
  const originHeaders = origin.headers();
  expect(origin.ok(), JSON.stringify(originHeaders)).toBe(true);
  expect(originHeaders["x-vinext-build-id"]).toBe(rscBuildId);
  if (backend === "kv") {
    expect(originHeaders["cf-cache-status"], JSON.stringify(originHeaders)).toBe("MISS");
  } else {
    expect(originHeaders["x-vinext-cache"], JSON.stringify(originHeaders)).toBe("MISS");
  }
  const originBody = await origin.text();
  expect(originBody).toContain("Post: intro");
  expect(/data-cache-id[^>]*>([^<]+)</.exec(originBody)?.[1]).toBe(warmedDataId);
});
