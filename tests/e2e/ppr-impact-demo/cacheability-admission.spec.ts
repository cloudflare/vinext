import { expect, test } from "@playwright/test";

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

  const certifiedFullRsc = await request.get("/cacheability/static?_rsc", {
    headers: { Accept: "text/x-component", RSC: "1" },
  });
  expect(certifiedFullRsc.status()).toBe(200);
  expect(certifiedFullRsc.headers()["content-type"]).toContain("text/x-component");
  expect(certifiedFullRsc.headers()["cdn-cache-control"]).toContain("public");

  const certifiedLoadingShell = await request.get("/cacheability/static?_rsc=9qLBDIU2NgN178cB", {
    headers: {
      Accept: "text/x-component",
      RSC: "1",
      "Next-Router-Prefetch": "1",
      "Next-Router-Segment-Prefetch": "1",
      "X-Vinext-Rsc-Render-Mode": "prefetch-loading-shell",
    },
  });
  expect(certifiedLoadingShell.status()).toBe(200);
  expect(certifiedLoadingShell.headers()["content-type"]).toContain("text/x-component");
  expect(certifiedLoadingShell.headers()["cdn-cache-control"]).toContain("public");

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

  const staticToDynamic = await request.get("/cacheability/static-to-dynamic/runtime", {
    headers: { Accept: "text/html", "X-Probe-Value": "private-value" },
  });
  expect(staticToDynamic.status()).toBe(500);
  expect(await staticToDynamic.text()).toContain("changed from static to dynamic");
  expect(staticToDynamic.headers()["cache-control"]).toContain("no-store");
  expect(staticToDynamic.headers()["cdn-cache-control"]).toBeUndefined();

  const uncertifiedRsc = await request.get("/cacheability/prerender-phase/known?_rsc", {
    headers: { Accept: "text/x-component", RSC: "1" },
  });
  expect(uncertifiedRsc.status()).toBe(200);
  expect(uncertifiedRsc.headers()["cache-control"]).toContain("no-store");
  expect(uncertifiedRsc.headers()["cdn-cache-control"]).toBeUndefined();
});
