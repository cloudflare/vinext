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

  const lateCookie = await request.get("/cacheability/static?late-policy=set-cookie", {
    headers: { Accept: "text/html" },
  });
  expect(lateCookie.status()).toBe(200);
  expect(lateCookie.headers()["set-cookie"]).toContain("late-config=cookie");
  expect(lateCookie.headers()["cache-control"]).toContain("no-store");
  expect(lateCookie.headers()["cdn-cache-control"]).toBeUndefined();
  expect(lateCookie.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();

  for (const policy of ["cache-control", "cdn-cache-control", "cloudflare-cdn-cache-control"]) {
    const latePrivatePolicy = await request.get(`/cacheability/static?late-policy=${policy}`, {
      headers: { Accept: "text/html" },
    });
    expect(latePrivatePolicy.status()).toBe(200);
    expect(latePrivatePolicy.headers()["cache-control"]).toContain("no-store");
    expect(latePrivatePolicy.headers()["cdn-cache-control"]).toBeUndefined();
    expect(latePrivatePolicy.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  }

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

  const configPublicDynamic = await request.get("/cacheability/config-public-dynamic", {
    headers: { Accept: "text/html" },
  });
  expect(configPublicDynamic.status()).toBe(200);
  expect(configPublicDynamic.headers()["cdn-cache-control"]).toContain("max-age=32");

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

  const certifiedRouteHandler = await request.get("/cacheability/route-handler-static");
  expect(certifiedRouteHandler.status()).toBe(200);
  await expect(certifiedRouteHandler.json()).resolves.toEqual({ kind: "static-route-handler" });
  expect(certifiedRouteHandler.headers()["cdn-cache-control"]).toContain("public");

  const unlistedRouteHandlerQuery = await request.get(
    "/cacheability/route-handler-static?user=one",
  );
  expect(unlistedRouteHandlerQuery.status()).toBe(200);
  expect(unlistedRouteHandlerQuery.headers()["cache-control"]).toContain("no-store");
  expect(unlistedRouteHandlerQuery.headers()["cdn-cache-control"]).toBeUndefined();

  const dynamicRouteHandler = await request.get("/cacheability/route-handler-dynamic", {
    headers: { "X-Probe-Value": "private" },
  });
  await expect(dynamicRouteHandler.json()).resolves.toEqual({ value: "private" });
  expect(dynamicRouteHandler.headers()["cache-control"]).toContain("no-store");
  expect(dynamicRouteHandler.headers()["cdn-cache-control"]).toBeUndefined();

  const lateConfigPublicFailure = await request.get(
    "/cacheability/route-handler-config-public-late-error",
  );
  expect(lateConfigPublicFailure.status()).toBe(500);
  expect(lateConfigPublicFailure.headers()["cache-control"]).toContain("no-store");
  expect(lateConfigPublicFailure.headers()["cdn-cache-control"]).toBeUndefined();
});
