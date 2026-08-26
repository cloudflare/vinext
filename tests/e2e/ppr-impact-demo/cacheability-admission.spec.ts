import { expect, test } from "@playwright/test";

function cacheabilityResult(body: string): string {
  const match = body.match(/id="cacheability-result">([^<]+)</);
  if (!match) throw new Error("response did not contain a cacheability result");
  return match[1];
}

test("admits only exact manifest-backed App Page responses after clean EOF", async ({
  request,
}) => {
  const certified = await request.get("/cacheability/static", {
    headers: { Accept: "text/html" },
  });
  expect(certified.status()).toBe(200);
  expect(await certified.text()).toContain("static page");
  expect(certified.headers()["cdn-cache-control"]).toContain("public");
  expect(certified.headers()["cache-control"]).toContain("must-revalidate");

  const runtimeCheck = await request.get("/cacheability/static?runtime=1", {
    headers: { Accept: "text/html" },
  });
  expect(runtimeCheck.status()).toBe(200);
  expect(runtimeCheck.headers()["cdn-cache-control"]).toContain("public");

  const unlistedQuery = await request.get("/cacheability/static?unlisted=1", {
    headers: { Accept: "text/html" },
  });
  expect(unlistedQuery.status()).toBe(200);
  expect(unlistedQuery.headers()["cache-control"]).toContain("no-store");
  expect(unlistedQuery.headers()["cdn-cache-control"]).toBeUndefined();

  const knownDynamic = await request.get("/cacheability/dynamic", {
    headers: { Accept: "text/html" },
  });
  expect(knownDynamic.status()).toBe(200);
  expect(knownDynamic.headers()["cache-control"]).toContain("no-store");
  expect(knownDynamic.headers()["cdn-cache-control"]).toBeUndefined();

  const publicUseCache = await request.get("/cacheability/use-cache-public-no-store", {
    headers: { Accept: "text/html" },
  });
  expect(publicUseCache.status()).toBe(200);
  const publicUseCacheValue = cacheabilityResult(await publicUseCache.text());
  expect(publicUseCacheValue).toMatch(/^owned-by-public-use-cache-\d+$/);
  expect(publicUseCache.headers()["cdn-cache-control"]).toContain("public");

  const publicUseCacheAgain = await request.get("/cacheability/use-cache-public-no-store", {
    headers: { Accept: "text/html" },
  });
  expect(cacheabilityResult(await publicUseCacheAgain.text())).toBe(publicUseCacheValue);

  const directNoStore = await request.get("/cacheability/direct-no-store");
  const directNoStoreAgain = await request.get("/cacheability/direct-no-store");
  expect(cacheabilityResult(await directNoStoreAgain.text())).not.toBe(
    cacheabilityResult(await directNoStore.text()),
  );

  const privateUseCache = await request.get("/cacheability/use-cache-private", {
    headers: { Accept: "text/html" },
  });
  expect(privateUseCache.status()).toBe(200);
  expect(await privateUseCache.text()).toContain("owned-by-private-use-cache");
  expect(privateUseCache.headers()["cache-control"]).toContain("no-store");
  expect(privateUseCache.headers()["cdn-cache-control"]).toBeUndefined();

  const staticToDynamic = await request.get("/cacheability/static-to-dynamic/runtime", {
    headers: { Accept: "text/html", "X-Probe-Value": "private-value" },
  });
  expect(staticToDynamic.status()).toBe(500);
  expect(await staticToDynamic.text()).toContain("changed from static to dynamic");
  expect(staticToDynamic.headers()["cache-control"]).toContain("no-store");
  expect(staticToDynamic.headers()["cdn-cache-control"]).toBeUndefined();

  const uncertifiedRsc = await request.get("/cacheability/static?_rsc", {
    headers: { Accept: "text/x-component", RSC: "1" },
  });
  expect(uncertifiedRsc.status()).toBe(200);
  expect(uncertifiedRsc.headers()["cache-control"]).toContain("no-store");
  expect(uncertifiedRsc.headers()["cdn-cache-control"]).toBeUndefined();
});
