import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures";

const FIXTURE_DIR = `${process.cwd()}/tests/fixtures/cf-app-basic`;
const BASE_URL = "http://localhost:4195";

let server: ChildProcess;

function stopWorker(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    child.kill();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`cf-app-basic Worker exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for cf-app-basic Worker");
}

async function setDraftMode(request: APIRequestContext, enabled: boolean): Promise<void> {
  const response = await request.get(`${BASE_URL}/api/draft-${enabled ? "enable" : "disable"}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["cdn-cache-control"]).toBeUndefined();
  expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  expect(response.headers()["cache-tag"]).toBeUndefined();
}

async function readDraftIsrRoute(request: APIRequestContext, scenario: string) {
  const response = await request.get(`${BASE_URL}/api/draft-isr/${scenario}`);
  expect(response.status()).toBe(200);
  return {
    cacheControl: response.headers()["cache-control"],
    cacheTag: response.headers()["cache-tag"],
    cacheState: response.headers()["x-vinext-cache"],
    cdnCacheControl: response.headers()["cdn-cache-control"],
    payload: (await response.json()) as { draftMode: boolean; token: string },
  };
}

async function readPersonalized(request: APIRequestContext, pathname: string, visitorId: string) {
  const response = await request.get(`${BASE_URL}${pathname}`, {
    headers: { "x-test-visitor-id": visitorId },
  });
  expect(response.status()).toBe(200);
  return {
    body: await response.text(),
    visitor: response.headers()["x-cdn-stage-visitor"],
  };
}

// The reporter's pass-through proxy and private-only cases, verified against
// Next.js 16.2.7 build/start. Next keeps explicitly authored Cache-Control:
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/templates/app-route.ts
function browserPolicyRegressions(baseURL: string, prefix: string) {
  for (const [suffix, policy] of [
    ["bot-blocked", "max-age=10"],
    ["proxy", "public, max-age=300"],
    ["private", "private, max-age=300"],
  ]) {
    test(`preserves Next.js policy for ${prefix}-${suffix}`, async ({ request }) => {
      for (const method of ["GET", "HEAD"]) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await request.fetch(`${baseURL}/api/${prefix}-${suffix}`, {
            method,
            headers:
              suffix === "private" ? { "x-private-visitor": `visitor-${attempt}` } : undefined,
          });
          expect(response.status()).toBe(200);
          expect(response.headers()["cache-control"]).toBe(policy);
          if (suffix === "private")
            expect(response.headers()["x-private-visitor"]).toBe(`visitor-${attempt}`);
          expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
          expect(response.headers()["cdn-cache-control"]).toBeUndefined();
          if (method === "GET") expect(await response.json()).toEqual({ browserCache: true });
        }
        if (suffix === "bot-blocked") {
          const blocked = await request.fetch(`${baseURL}/api/${prefix}-${suffix}`, {
            method,
            headers: { "User-Agent": "GPTBot/1.2" },
          });
          expect(blocked.status()).toBe(403);
        }
      }
    });
  }
}

test.describe("Cloudflare route-handler draft-mode cache isolation", () => {
  browserPolicyRegressions(BASE_URL, "browser-cache");
  test.beforeAll(async () => {
    server = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; ../../../node_modules/.bin/vp build --config vite.cdn-cache.config.ts && npx wrangler dev --config dist/server/wrangler.json --port 4195",
      { cwd: FIXTURE_DIR, shell: true, stdio: "inherit", detached: process.platform !== "win32" },
    );
    await waitForServer();
  });

  test.afterAll(() => {
    stopWorker(server);
  });

  // Next.js preserves user Cache-Control in build/templates/app-route.ts.
  // The browser/edge split and gateway personalization are Workers-specific.
  for (const [pathname, cacheControl] of [
    ["/api/browser-cache", "max-age=10"],
    ["/api/browser-cache-swr", "max-age=10, stale-while-revalidate=60"],
    ["/api/browser-cache-generated-edge", "max-age=10, stale-while-revalidate=60"],
    ["/api/browser-cache-shared", "public, max-age=300, s-maxage=600, stale-while-revalidate=60"],
    ["/api/browser-cache-static", "public, max-age=300, s-maxage=600, stale-while-revalidate=60"],
    ["/api/browser-cache-config", "public, max-age=300"],
  ]) {
    test(`preserves browser cache policy for ${pathname}`, async ({ request }) => {
      const response = await request.get(`${BASE_URL}${pathname}`);
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ browserCache: true });
      expect(response.headers()["cache-control"]).toBe(cacheControl);
      expect(response.headers()["cdn-cache-control"]).toBeUndefined();
      expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    });
  }

  test("keeps draft and anonymous route-handler ISR responses isolated", async ({ request }) => {
    const forged = await request.get(`${BASE_URL}/api/draft-isr/forged-${Date.now()}`, {
      headers: { Cookie: "__prerender_bypass=forged" },
    });
    expect(forged.status()).toBe(200);
    expect(await forged.json()).toMatchObject({ draftMode: false });
    // An invalid draft cookie cannot enable draft mode or shared storage.
    // The untrusted cookie also keeps the framework response out of browser storage.
    expect(forged.headers()["cache-control"]).toBe("no-store, must-revalidate");
    expect(forged.headers()["cdn-cache-control"]).toBeUndefined();
    // Local workerd does not expose a Workers Cache status. Do not preserve
    // the inner ISR state as though it were a CF-Cache-Status mirror.
    expect(forged.headers()["x-vinext-cache"]).toBeUndefined();
    expect(forged.headers()["x-nextjs-cache"]).toBeUndefined();

    await setDraftMode(request, true);
    const draftFirstScenario = `draft-first-${Date.now()}`;
    const draftFirst = await readDraftIsrRoute(request, draftFirstScenario);
    await setDraftMode(request, false);
    const anonymousAfterDraft = await readDraftIsrRoute(request, draftFirstScenario);

    expect(draftFirst.payload.draftMode).toBe(true);
    expect(draftFirst.cacheState).not.toBe("HIT");
    expect(draftFirst.cacheControl).not.toContain("s-maxage");
    expect(draftFirst.cacheControl).toContain("no-store");
    expect(draftFirst.cdnCacheControl).toBeUndefined();
    expect(draftFirst.cacheTag).toBeUndefined();
    expect(anonymousAfterDraft.payload.draftMode).toBe(false);
    expect(anonymousAfterDraft.payload.token).not.toBe(draftFirst.payload.token);
    expect(anonymousAfterDraft.cacheControl).toBe("private, max-age=0, must-revalidate");
    expect(anonymousAfterDraft.cacheState).toBeUndefined();

    const publicFirstScenario = `public-first-${Date.now()}`;
    const anonymousFirst = await readDraftIsrRoute(request, publicFirstScenario);
    await setDraftMode(request, true);
    try {
      const draftAfterAnonymous = await readDraftIsrRoute(request, publicFirstScenario);
      expect(draftAfterAnonymous.payload.draftMode).toBe(true);
      expect(draftAfterAnonymous.payload.token).not.toBe(anonymousFirst.payload.token);
      expect(draftAfterAnonymous.cacheState).not.toBe("HIT");
      expect(draftAfterAnonymous.cacheControl).not.toContain("s-maxage");
      expect(draftAfterAnonymous.cacheControl).toContain("no-store");
      expect(draftAfterAnonymous.cdnCacheControl).toBeUndefined();
      expect(draftAfterAnonymous.cacheTag).toBeUndefined();
    } finally {
      await setDraftMode(request, false);
    }
  });

  test("preserves browser policy when conditional middleware is eligible", async ({ request }) => {
    for (const visitor of [undefined, "alice"]) {
      const response = await request.get(`${BASE_URL}/api/browser-cache-middleware`, {
        headers: visitor ? { "x-test-visitor-id": visitor } : undefined,
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ browserCache: true });
      expect(response.headers()["x-cdn-stage-visitor"]).toBe(visitor);
      expect(response.headers()["cache-control"]).toBe("max-age=10");
    }
  });

  for (const kind of ["redirect", "rewrite"] as const) {
    test(`preserves browser policy for conditional config routing: ${kind}`, async ({
      request,
    }) => {
      const response = await request.get(`${BASE_URL}/api/browser-cache-${kind}`);
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ browserCache: true });
      expect(response.headers()["cache-control"]).toBe("max-age=10");

      const routed = await request.get(`${BASE_URL}/api/browser-cache-${kind}`, {
        headers: kind === "redirect" ? { "x-plan": "pro" } : { Cookie: "plan=pro" },
        maxRedirects: 0,
      });
      if (kind === "redirect") {
        expect(routed.status()).toBe(307);
        expect(routed.headers()["location"]).toBe("/api/browser-cache");
      } else {
        expect(await routed.json()).toEqual({ visitor: "pro" });
        // The matched cookie condition already prevents shared admission.
        expect(routed.headers()["cache-control"]).toContain("no-store");
      }
    });
  }

  test("preserves browser policy after a query-only middleware rewrite", async ({ request }) => {
    const anonymous = await request.get(`${BASE_URL}/api/browser-cache-query?visitor=alice`);
    expect(anonymous.headers()["cache-control"]).toBe("public, max-age=300, s-maxage=600");
    for (const visitor of ["alice", "bob"]) {
      const response = await request.get(`${BASE_URL}/api/browser-cache-query?visitor=alice`, {
        headers: { "x-test-visitor-id": visitor },
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ visitor });
      expect(response.headers()["cache-control"]).toBe("public, max-age=300, s-maxage=600");
    }
  });

  test("preserves browser policy after a hybrid Pages query rewrite", async ({ request }) => {
    for (const visitor of ["alice", "bob"]) {
      const response = await request.get(
        `${BASE_URL}/api/browser-cache-pages-query?visitor=alice`,
        {
          headers: { "x-test-visitor-id": visitor },
        },
      );
      expect(response.status()).toBe(200);
      // Keep vinext's existing query-rewrite isolation check. Next 16.2.7
      // preserves the authored header here, but retains the original query.
      expect(await response.json()).toEqual({ visitor });
      expect(response.headers()["cache-control"]).toBe("public, max-age=300, s-maxage=600");
    }
  });

  test("preserves browser policy for conditional config policies", async ({ request }) => {
    for (const plan of ["pro", "basic"]) {
      const response = await request.get(`${BASE_URL}/api/browser-cache-conditional`, {
        headers: { "x-plan": plan },
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ browserCache: true });
      expect(response.headers()["cache-control"]).toBe(
        plan === "pro" ? "max-age=300" : "max-age=10",
      );
    }
  });

  // Next.js app-route.ts applies the ISR draft veto after middleware's headers.
  test("keeps ISR draft responses uncacheable when proxy sets a browser TTL", async ({
    request,
  }) => {
    await setDraftMode(request, true);
    try {
      for (const method of ["GET", "HEAD"]) {
        const response = await request.fetch(`${BASE_URL}/api/draft-isr/proxy-policy`, {
          method,
          headers: { "x-browser-policy": "1" },
        });
        expect(response.status()).toBe(200);
        expect(response.headers()["cache-control"]).toBe(
          "private, no-cache, no-store, max-age=0, must-revalidate",
        );
        expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
        if (method === "GET") expect(await response.json()).toMatchObject({ draftMode: true });
      }
    } finally {
      await setDraftMode(request, false);
    }
  });

  test("does not cache a middleware draft transition on an ISR MISS", async ({ request }) => {
    await setDraftMode(request, false);
    const scenario = `middleware-miss-${Date.now()}`;

    const draft = await request.get(`${BASE_URL}/api/draft-isr/${scenario}?draft=true`);
    expect(draft.status()).toBe(200);
    const draftPayload = (await draft.json()) as { draftMode: boolean; token: string };
    expect(draftPayload.draftMode).toBe(true);
    expect(draft.headers()["set-cookie"]).toContain("__prerender_bypass=");
    expect(draft.headers()["cache-control"]).toContain("no-store");
    expect(draft.headers()["x-vinext-cache"]).toBeUndefined();

    await setDraftMode(request, false);
    const anonymous = await readDraftIsrRoute(request, scenario);
    expect(anonymous.payload.draftMode).toBe(false);
    expect(anonymous.payload.token).not.toBe(draftPayload.token);
  });

  test("preserves a middleware draft transition instead of serving a prewarmed HIT", async ({
    request,
  }) => {
    await setDraftMode(request, false);
    const scenario = `middleware-hit-${Date.now()}`;
    const prewarmed = await readDraftIsrRoute(request, scenario);

    const draft = await request.get(`${BASE_URL}/api/draft-isr/${scenario}?draft=true`);
    expect(draft.status()).toBe(200);
    const draftPayload = (await draft.json()) as { draftMode: boolean; token: string };
    expect(draftPayload.draftMode).toBe(true);
    expect(draftPayload.token).not.toBe(prewarmed.payload.token);
    expect(draft.headers()["set-cookie"]).toContain("__prerender_bypass=");
    expect(draft.headers()["cache-control"]).toContain("no-store");
    expect(draft.headers()["x-vinext-cache"]).toBeUndefined();

    await setDraftMode(request, false);
  });

  test("does not cache a force-static route handler that enables draft mode", async ({
    request,
  }) => {
    await setDraftMode(request, false);

    const first = await request.get(`${BASE_URL}/api/draft-force-static`);
    expect(first.status()).toBe(200);
    const firstPayload = (await first.json()) as { draftMode: boolean; token: string };
    expect(firstPayload.draftMode).toBe(true);
    expect(first.headers()["set-cookie"]).toContain("__prerender_bypass=");
    expect(first.headers()["cache-control"]).toContain("no-store");
    expect(first.headers()["x-vinext-cache"]).toBeUndefined();

    await setDraftMode(request, false);
    const second = await request.get(`${BASE_URL}/api/draft-force-static`);
    const secondPayload = (await second.json()) as { draftMode: boolean; token: string };
    expect(secondPayload.draftMode).toBe(true);
    expect(secondPayload.token).not.toBe(firstPayload.token);
    expect(second.headers()["cache-control"]).toContain("no-store");

    await setDraftMode(request, false);
  });

  test("completes static-candidate route handler streams before CDN admission", async ({
    request,
  }) => {
    // Next.js drains a statically eligible Route Handler response before
    // finalizing static generation. Ported from:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/app-route/module.ts#L700-L734
    const dynamicResponse = await request.get(`${BASE_URL}/api/late-dynamic-stream`, {
      headers: { "x-tenant": "tenant-a" },
    });
    expect(dynamicResponse.status()).toBe(200);
    expect(await dynamicResponse.text()).toBe("tenant-a");
    // The app's completed response keeps its explicit policy at the gateway.
    expect(dynamicResponse.headers()["cache-control"]).toBe("public, s-maxage=60");
    expect(dynamicResponse.headers()["cdn-cache-control"]).toBeUndefined();
    expect(dynamicResponse.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(dynamicResponse.headers()["cache-tag"]).toBeUndefined();
    expect(dynamicResponse.headers()["x-vinext-cache"]).toBeUndefined();

    const errorResponse = await request.get(`${BASE_URL}/api/late-error-stream`);
    expect(errorResponse.status()).toBe(500);
    expect(errorResponse.headers()["cache-control"] ?? "").not.toContain("public");
    expect(errorResponse.headers()["cdn-cache-control"]).toBeUndefined();
    expect(errorResponse.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(errorResponse.headers()["cache-tag"]).toBeUndefined();
    expect(errorResponse.headers()["x-vinext-cache"]).toBeUndefined();
  });

  test("streams oversized static candidates privately instead of buffering without a bound", async ({
    request,
  }) => {
    const response = await request.get(`${BASE_URL}/api/large-static-stream`);
    expect(response.status()).toBe(200);
    expect((await response.body()).byteLength).toBe(16 * 1024 * 1024 + 1);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cache-tag"]).toBeUndefined();
    expect(response.headers()["x-vinext-cache"]).toBeUndefined();
  });

  test("fails hybrid Pages handoffs closed for non-browser Accept variants", async ({
    request,
  }) => {
    for (const accept of [undefined, "*/*", "application/json"]) {
      const response = await request.get(`${BASE_URL}/pages-home`, {
        headers: accept ? { Accept: accept } : undefined,
      });
      expect(response.status(), accept ?? "missing Accept").toBe(200);
      expect(response.headers()["cache-control"], accept ?? "missing Accept").not.toContain(
        "public",
      );
      expect(response.headers()["cdn-cache-control"], accept ?? "missing Accept").toBeUndefined();
      expect(
        response.headers()["cloudflare-cdn-cache-control"],
        accept ?? "missing Accept",
      ).toBeUndefined();
    }
  });

  test("runs middleware above App and Pages response stages", async ({ request }) => {
    // Local Miniflare executes the named response entrypoint but does not emulate
    // the deployed Worker-front cache. Deployed HIT reuse is covered by
    // rsc-prewarm.spec.ts in the workers-cache preview workflow.
    for (const route of ["cdn-stage-app", "cdn-stage-pages"]) {
      const slug = `${route}-${Date.now()}`;
      const first = await readPersonalized(request, `/${route}/${slug}`, "visitor-a");
      const second = await readPersonalized(request, `/${route}/${slug}`, "visitor-b");

      expect(first.visitor).toBe("visitor-a");
      expect(second.visitor).toBe("visitor-b");
      expect(first.body).toContain(
        `${route === "cdn-stage-app" ? "App" : "Pages"} CDN response stage`,
      );
      expect(second.body).toContain(
        `${route === "cdn-stage-app" ? "App" : "Pages"} CDN response stage`,
      );
    }
  });

  test("routes revalidatePath through the cache-bearing response entrypoint", async ({
    request,
  }) => {
    const slug = `purge-${Date.now()}`;
    const pathname = `/cdn-stage-app/${slug}`;
    const purge = await request.post(`${BASE_URL}/api/cdn-stage-revalidate`, {
      data: { pathname },
    });
    expect(purge.status()).toBe(200);
    expect(await purge.json()).toEqual({ revalidated: pathname });
  });

  test("bypasses the shared response stage for middleware cookie overlays", async ({ request }) => {
    const slug = `cookie-${Date.now()}`;
    const first = await readPersonalized(request, `/cdn-stage-cookie/${slug}`, "visitor-a");
    const second = await readPersonalized(request, `/cdn-stage-cookie/${slug}`, "visitor-b");

    expect(first.body).toContain("middleware-cookie:visitor-a");
    expect(second.body).toContain("middleware-cookie:visitor-b");
  });

  test("bypasses the shared response stage for middleware request-header overrides", async ({
    request,
  }) => {
    const slug = `request-header-${Date.now()}`;
    for (const visitorId of ["visitor-a", "visitor-b"]) {
      const response = await request.get(`${BASE_URL}/api/cdn-stage-middleware-header/${slug}`, {
        headers: { "x-test-visitor-id": visitorId },
      });
      expect(response.status()).toBe(200);
      expect(await response.text()).toBe(visitorId);
    }
  });

  test("does not cache late request-dependent App responses", async ({ request }) => {
    for (const route of ["cdn-stage-late", "api/cdn-stage-late-route"]) {
      const slug = `${route.replaceAll("/", "-")}-${Date.now()}`;
      const first = await readPersonalized(request, `/${route}/${slug}`, "visitor-a");
      const second = await readPersonalized(request, `/${route}/${slug}`, "visitor-b");

      expect(first.body).toContain("visitor-a");
      expect(second.body).toContain("visitor-b");
      expect(second.body).not.toBe(first.body);
    }
  });
});

test.describe("Cloudflare Pages-only completed-response admission", () => {
  const pagesBaseUrl = "http://localhost:4196";
  browserPolicyRegressions(pagesBaseUrl, "browser-cache-pages");
  let pagesServer: ChildProcess;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    pagesServer = spawn(
      "../../../node_modules/.bin/vp build --config vite.pages-cdn-cache.config.ts && npx wrangler dev --config dist/cf_app_basic/wrangler.json --port 4196",
      { cwd: FIXTURE_DIR, shell: true, stdio: "inherit", detached: process.platform !== "win32" },
    );
    for (let attempt = 0; attempt < 240; attempt++) {
      if (pagesServer.exitCode !== null) {
        throw new Error(`cf-app-basic Pages Worker exited with code ${pagesServer.exitCode}`);
      }
      try {
        const response = await fetch(`${pagesBaseUrl}/pages-home`);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Timed out waiting for cf-app-basic Pages Worker");
  });

  test.afterAll(() => {
    stopWorker(pagesServer);
  });

  test("clears inner CDN policy when outer config keeps a response private", async ({
    request,
  }) => {
    expect(
      fs.readFileSync(`${FIXTURE_DIR}/dist/cf_app_basic/__vinext_cacheability_manifest.js`, "utf8"),
    ).toBe("export default null;\n");

    const response = await request.get(`${pagesBaseUrl}/pages-about`, {
      headers: { Accept: "text/html" },
    });
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("About (Pages)");
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cache-tag"]).toBeUndefined();
  });

  test("fails closed without an HTML Accept header", async ({ request }) => {
    for (const accept of [undefined, "*/*", "application/json"]) {
      const response = await request.get(`${pagesBaseUrl}/pages-home`, {
        headers: accept ? { Accept: accept } : undefined,
      });
      expect(response.status(), accept ?? "missing Accept").toBe(200);
      expect(response.headers()["cache-control"], accept ?? "missing Accept").not.toContain(
        "public",
      );
      expect(response.headers()["cdn-cache-control"], accept ?? "missing Accept").toBeUndefined();
      expect(
        response.headers()["cloudflare-cdn-cache-control"],
        accept ?? "missing Accept",
      ).toBeUndefined();
    }
  });

  test("admits explicitly public Pages API responses", async ({ request }) => {
    const response = await request.get(`${pagesBaseUrl}/api/cdn-public`);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ public: true });
    expect(response.headers()["cache-control"]).toBe("public, s-maxage=60");
    expect(response.headers()["cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  });

  test("preserves browser cache policy for Pages API responses", async ({ request }) => {
    const response = await request.get(`${pagesBaseUrl}/api/browser-cache-pages`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ browserCache: true });
    expect(response.headers()["cache-control"]).toBe("max-age=10");
    expect(response.headers()["cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  });

  test("preserves an independent Pages browser stale window", async ({ request }) => {
    const response = await request.get(`${pagesBaseUrl}/api/browser-cache-pages-swr`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ browserCache: true });
    expect(response.headers()["cache-control"]).toBe("max-age=10, stale-while-revalidate=60");
  });

  test("preserves browser policy when conditional middleware is eligible", async ({ request }) => {
    for (const visitor of [undefined, "alice"]) {
      const response = await request.get(`${pagesBaseUrl}/api/browser-cache-pages-middleware`, {
        headers: visitor ? { "x-test-visitor-id": visitor } : undefined,
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ browserCache: true });
      expect(response.headers()["x-cdn-stage-visitor"]).toBe(visitor);
      expect(response.headers()["cache-control"]).toBe("max-age=10");
    }
  });

  for (const kind of ["redirect", "rewrite"] as const) {
    test(`preserves browser policy for conditional config routing: ${kind}`, async ({
      request,
    }) => {
      const response = await request.get(`${pagesBaseUrl}/api/browser-cache-pages-${kind}`);
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ browserCache: true });
      expect(response.headers()["cache-control"]).toBe("max-age=10");

      const routed = await request.get(`${pagesBaseUrl}/api/browser-cache-pages-${kind}`, {
        headers: kind === "redirect" ? { "x-plan": "pro" } : { Cookie: "plan=pro" },
        maxRedirects: 0,
      });
      if (kind === "redirect") {
        expect(routed.status()).toBe(307);
        expect(routed.headers()["location"]).toBe("/api/browser-cache");
      } else {
        expect(await routed.json()).toEqual({ visitor: "pro" });
        // The matched cookie condition already prevents shared admission.
        expect(routed.headers()["cache-control"]).toBe("public, max-age=300, s-maxage=600");
      }
    });
  }

  test("preserves browser policy after a Pages query-only middleware rewrite", async ({
    request,
  }) => {
    const anonymous = await request.get(
      `${pagesBaseUrl}/api/browser-cache-pages-query?visitor=alice`,
    );
    expect(anonymous.headers()["cache-control"]).toBe("public, max-age=300, s-maxage=600");
    for (const visitor of ["alice", "bob"]) {
      const response = await request.get(
        `${pagesBaseUrl}/api/browser-cache-pages-query?visitor=alice`,
        {
          headers: { "x-test-visitor-id": visitor },
        },
      );
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ visitor });
      expect(response.headers()["cache-control"]).toBe("public, max-age=300, s-maxage=600");
    }
  });

  test("keeps public Pages Edge API responses private after request.cf access", async ({
    request,
  }) => {
    const response = await request.get(`${pagesBaseUrl}/api/cdn-request-cf`);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ hasCf: true });
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cache-tag"]).toBeUndefined();
  });

  test("preserves Pages browser policy for conditional config policies", async ({ request }) => {
    for (const plan of ["pro", "basic"]) {
      const response = await request.get(`${pagesBaseUrl}/api/browser-cache-pages-conditional`, {
        headers: { "x-plan": plan },
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ browserCache: true });
      expect(response.headers()["cache-control"]).toBe("max-age=10");
    }
  });
});
