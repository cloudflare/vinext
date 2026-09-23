import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const backend = process.env.VINEXT_E2E_CACHE_BACKEND;

test("deployment pre-warming and force-dynamic bypass work with the configured cache", async ({
  baseURL,
  page,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");
  test.setTimeout(180_000);

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
  expect(secondIndependentBody).not.toContain(`first-${suffix}`);
  expect(secondIndependentBody).toContain("searchParamsFromBrowser:true");
  expect(
    independentSecond.headers()[backend === "workers-cache" ? "cf-cache-status" : "x-vinext-cache"],
  ).toBe("HIT");
  await page.goto(`${baseURL}/query-independent?q=second-${suffix}`);
  await expect(page.getByTestId("query-independent-client-value")).toHaveText(`second-${suffix}`);

  const cacheStatusHeader = backend === "workers-cache" ? "cf-cache-status" : "x-vinext-cache";
  // Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
  // Merely being a Client Page must not disable default caching when it never
  // reads the searchParams prop. The first request intentionally has no query.
  const clientPath = "/query-client-independent";
  const clientFirst = await request.get(`${baseURL}${clientPath}`);
  expect(clientFirst.ok(), JSON.stringify(clientFirst.headers())).toBe(true);
  const clientFirstBody = await clientFirst.text();
  expect(clientFirstBody).toContain(
    'data-testid="query-client-independent-value">No searchParams used</output>',
  );
  let clientHitBody = "";
  await expect
    .poll(
      async () => {
        const hit = await request.get(`${baseURL}${clientPath}?q=first-${suffix}`);
        const status = hit.headers()[cacheStatusHeader];
        if (status === "HIT") clientHitBody = await hit.text();
        await hit.dispose();
        return status;
      },
      { message: `${backend} did not cache the unused-searchParams Client Page`, timeout: 30_000 },
    )
    .toBe("HIT");
  const clientOther = await request.get(`${baseURL}${clientPath}?q=second-${suffix}`);
  const clientOtherBody = await clientOther.text();
  expect(clientOther.ok(), JSON.stringify(clientOther.headers())).toBe(true);
  expect(clientOther.headers()[cacheStatusHeader]).toBe("HIT");
  expect(clientOtherBody).toBe(clientHitBody);
  expect(clientOtherBody).not.toContain(`first-${suffix}`);

  const clientRscFirst = await request.get(
    `${baseURL}${clientPath}?q=rsc-first-${suffix}&_rsc=first-${suffix}`,
    { headers: { accept: "text/x-component", RSC: "1" } },
  );
  const clientRscFirstBody = await clientRscFirst.text();
  const clientRscSecond = await request.get(
    `${baseURL}${clientPath}?q=rsc-second-${suffix}&_rsc=second-${suffix}`,
    { headers: { accept: "text/x-component", RSC: "1" } },
  );
  const clientRscSecondBody = await clientRscSecond.text();
  expect(clientRscFirst.ok(), JSON.stringify(clientRscFirst.headers())).toBe(true);
  expect(clientRscSecond.ok(), JSON.stringify(clientRscSecond.headers())).toBe(true);
  expect(clientRscSecond.headers()["content-type"]).toContain("text/x-component");
  if (clientRscSecond.headers()[cacheStatusHeader] === "HIT") {
    expect(clientRscSecondBody).not.toContain(`rsc-first-${suffix}`);
  }
  expect(clientRscFirstBody).not.toContain(`rsc-second-${suffix}`);

  await page.goto(`${baseURL}${clientPath}?q=second-${suffix}`);
  await expect(page.getByTestId("query-client-independent-value")).toHaveText(
    "No searchParams used",
  );
  await expect
    .poll(
      async () => {
        const button = page.getByRole("button", { name: /^Clicked \d+ times$/ });
        if ((await button.textContent()) === "Clicked 0 times") await button.click();
        return button.textContent();
      },
      { message: "Client Page did not hydrate on the preview", timeout: 20_000 },
    )
    .toBe("Clicked 1 times");
  await page.getByRole("link", { name: "Open query-dependent Client Page" }).click();
  await expect(page.getByTestId("query-client-dependent-value")).toHaveText("from-navigation");

  // A parallel-slot Client Page receives searchParams through the slot wiring.
  // Even when it never reads the prop during render, the unused query must not
  // survive in the pathname-shared HTML's inlined Flight payload.
  const parallelPath = `/query-parallel-client/${suffix}`;
  const parallelFirstQuery = `first-${suffix}`;
  const parallelSecondQuery = `second-${suffix}`;
  const parallelFirstUrl = `${baseURL}${parallelPath}?q=${parallelFirstQuery}`;
  const parallelSecondUrl = `${baseURL}${parallelPath}?q=${parallelSecondQuery}`;
  const parallelFirst = await request.get(parallelFirstUrl);
  const parallelFirstBody = await parallelFirst.text();
  expect(parallelFirst.ok(), JSON.stringify(parallelFirst.headers())).toBe(true);
  expect(parallelFirstBody).toContain("No searchParams used during render");
  expect(parallelFirstBody).not.toContain(parallelFirstQuery);
  const parallelSecond = await request.get(parallelSecondUrl);
  const parallelSecondBody = await parallelSecond.text();
  expect(parallelSecond.ok(), JSON.stringify(parallelSecond.headers())).toBe(true);
  expect(parallelSecondBody).not.toContain(parallelFirstQuery);
  expect(parallelSecondBody).not.toContain(parallelSecondQuery);
  if (backend === "response-store") {
    await expect
      .poll(
        async () => {
          const first = await request.get(parallelFirstUrl);
          const second = await request.get(parallelSecondUrl);
          try {
            const statuses = `${first.headers()[cacheStatusHeader]}/${second.headers()[cacheStatusHeader]}`;
            if (statuses !== "HIT/HIT") return statuses;
            const firstBody = await first.text();
            const secondBody = await second.text();
            expect(firstBody).not.toContain(parallelFirstQuery);
            expect(secondBody).not.toContain(parallelSecondQuery);
            return firstBody === secondBody ? "HIT/HIT/same" : "HIT/HIT/different";
          } finally {
            await first.dispose();
            await second.dispose();
          }
        },
        { message: "Response Store did not share the parallel-slot HTML", timeout: 30_000 },
      )
      .toBe("HIT/HIT/same");
  } else if (backend === "workers-cache") {
    // An on-demand route has no pre-lookup static certificate for Workers Cache.
    expect(parallelSecond.headers()[cacheStatusHeader]).not.toBe("HIT");
  }
  await page.goto(parallelSecondUrl);
  await expect(page.getByTestId("query-parallel-client-late-value")).toHaveText("(unread)");
  // A streamed Client Page can show its button before its JS hydrates on the
  // remote preview. Repeating this idempotent click distinguishes that race
  // from a genuinely stale/missing current-query promise.
  await expect
    .poll(
      async () => {
        await page.getByRole("button", { name: "Read searchParams" }).click();
        return page.getByTestId("query-parallel-client-late-value").textContent();
      },
      { message: "parallel Client Page did not read the current query", timeout: 20_000 },
    )
    .toBe(parallelSecondQuery);

  let forceStaticFirstBody = "";
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${baseURL}/query-force-static/${suffix}?q=first-${suffix}`,
        );
        const status = response.status();
        const cacheStatus = response.headers()[cacheStatusHeader];
        const body = await response.text();
        await response.dispose();
        if (status < 200 || status >= 300) return `HTTP ${status}`;
        if (cacheStatus === "HIT") forceStaticFirstBody = body;
        return cacheStatus;
      },
      { message: `${backend} did not publish the force-static response`, timeout: 30_000 },
    )
    .toBe("HIT");
  const forceStaticSecond = await request.get(
    `${baseURL}/query-force-static/${suffix}?q=second-${suffix}`,
  );
  const forceStaticSecondBody = await forceStaticSecond.text();
  expect(forceStaticSecond.ok()).toBe(true);
  expect(forceStaticSecondBody).toBe(forceStaticFirstBody);
  expect(forceStaticSecondBody).not.toContain(`first-${suffix}`);
  expect(forceStaticSecondBody).not.toContain("searchParamsFromBrowser:true");
  expect(forceStaticSecondBody).toContain(
    'data-testid="query-force-static-client-value">(empty)</output>',
  );
  await page.goto(`${baseURL}/query-force-static/${suffix}?q=second-${suffix}`);
  await expect(page.getByTestId("query-force-static-client-value")).toHaveText("(empty)");
  expect(forceStaticSecond.headers()[cacheStatusHeader]).toBe("HIT");

  // The ordinary static route above has an HTML-only manifest certificate.
  // An explicit force-static route certifies both HTML and RSC on-demand.
  const rscHeaders = { accept: "text/x-component", RSC: "1" };
  const errorClientPath = `/query-error-client/${suffix}`;
  const errorClientFirst = await request.get(
    `${baseURL}${errorClientPath}?q=error-first-${suffix}&_rsc=error-first-${suffix}`,
    { headers: rscHeaders },
  );
  const errorClientFirstBody = await errorClientFirst.text();
  const errorClientRepeat = await request.get(
    `${baseURL}${errorClientPath}?q=error-first-${suffix}&_rsc=error-first-${suffix}`,
    { headers: rscHeaders },
  );
  const errorClientSecond = await request.get(
    `${baseURL}${errorClientPath}?q=error-second-${suffix}&_rsc=error-second-${suffix}`,
    { headers: rscHeaders },
  );
  const errorClientSecondBody = await errorClientSecond.text();
  expect(errorClientFirst.ok()).toBe(true);
  expect(errorClientRepeat.ok()).toBe(true);
  expect(errorClientSecond.ok()).toBe(true);
  expect(errorClientFirstBody).toContain(`error-first-${suffix}`);
  expect(errorClientSecondBody).toContain(`error-second-${suffix}`);
  expect(errorClientSecondBody).not.toContain(`error-first-${suffix}`);
  await errorClientRepeat.dispose();
  let forceStaticRscBody = "";
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${baseURL}/query-force-static/${suffix}?q=first-${suffix}&_rsc=first-${suffix}`,
          { headers: rscHeaders },
        );
        const cacheStatus = response.headers()[cacheStatusHeader];
        if (cacheStatus === "HIT") forceStaticRscBody = await response.text();
        await response.dispose();
        return cacheStatus;
      },
      { message: `${backend} did not publish the force-static RSC response`, timeout: 30_000 },
    )
    .toBe("HIT");
  const forceStaticSecondRsc = await request.get(
    `${baseURL}/query-force-static/${suffix}?q=second-${suffix}&_rsc=second-${suffix}`,
    { headers: rscHeaders },
  );
  expect(forceStaticSecondRsc.ok()).toBe(true);
  expect(forceStaticSecondRsc.headers()["content-type"]).toContain("text/x-component");
  expect(await forceStaticSecondRsc.text()).toBe(forceStaticRscBody);
  expect(forceStaticSecondRsc.headers()[cacheStatusHeader]).toBe("HIT");
  if (backend !== "kv") {
    expect(
      decodeURIComponent(forceStaticSecondRsc.headers()["x-vinext-rendered-path-and-search"] ?? ""),
    ).toBe(`/query-force-static/${suffix}?q=second-${suffix}`);
  }

  const forcedClientPath = `/query-force-static-client/${suffix}`;
  const forcedClientFirst = await request.get(
    `${baseURL}${forcedClientPath}?q=first-${suffix}&_rsc=first-${suffix}`,
    { headers: rscHeaders },
  );
  const forcedClientFirstBody = await forcedClientFirst.text();
  const forcedClientSecond = await request.get(
    `${baseURL}${forcedClientPath}?q=second-${suffix}&_rsc=second-${suffix}`,
    { headers: rscHeaders },
  );
  const forcedClientSecondBody = await forcedClientSecond.text();
  expect(forcedClientFirst.ok()).toBe(true);
  expect(forcedClientSecond.ok()).toBe(true);
  expect(forcedClientSecond.headers()[cacheStatusHeader]).toBe("HIT");
  expect(forcedClientSecondBody).toBe(forcedClientFirstBody);
  expect(forcedClientFirstBody).not.toContain(`first-${suffix}`);
  expect(forcedClientFirstBody).not.toContain(`second-${suffix}`);

  // An on-demand page may prove query independence only after rendering, so
  // Response Store can share its RSC entry while Workers Cache remains conservative.
  // See Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
  const ordinaryPath = `/query-on-demand/${suffix}-rsc`;
  const firstRscUrl = `${baseURL}${ordinaryPath}?q=first-${suffix}&_rsc=first-${suffix}`;
  const secondRscUrl = `${baseURL}${ordinaryPath}?q=second-${suffix}&_rsc=second-${suffix}`;
  const ordinaryRscFirst = await request.get(firstRscUrl, { headers: rscHeaders });
  const ordinaryRscBody = await ordinaryRscFirst.text();
  expect(ordinaryRscFirst.ok(), JSON.stringify(ordinaryRscFirst.headers())).toBe(true);
  expect(ordinaryRscFirst.headers()["content-type"]).toContain("text/x-component");
  expect(ordinaryRscBody).toContain(`${suffix}-rsc`);
  let ordinaryRscSecondHeaders: Record<string, string>;
  let ordinaryRscSecondBody: string;
  if (backend === "response-store") {
    // Separate isolates can briefly miss the same key and publish competing
    // renders. Compare two settled HITs, not either cold render.
    ordinaryRscSecondHeaders = {};
    ordinaryRscSecondBody = "";
    await expect
      .poll(
        async () => {
          const first = await request.get(firstRscUrl, { headers: rscHeaders });
          const second = await request.get(secondRscUrl, { headers: rscHeaders });
          try {
            expect(first.ok(), JSON.stringify(first.headers())).toBe(true);
            expect(second.ok(), JSON.stringify(second.headers())).toBe(true);
            const statuses = `${first.headers()[cacheStatusHeader]}/${second.headers()[cacheStatusHeader]}`;
            if (statuses !== "HIT/HIT") return statuses;
            const firstBody = await first.text();
            const secondBody = await second.text();
            if (firstBody !== secondBody) return "HIT/HIT/different";
            ordinaryRscSecondHeaders = second.headers();
            ordinaryRscSecondBody = secondBody;
            return "HIT/HIT/same";
          } finally {
            await first.dispose();
            await second.dispose();
          }
        },
        { message: "Response Store did not share the on-demand RSC page", timeout: 30_000 },
      )
      .toBe("HIT/HIT/same");
  } else {
    const second = await request.get(secondRscUrl, { headers: rscHeaders });
    expect(second.ok(), JSON.stringify(second.headers())).toBe(true);
    ordinaryRscSecondHeaders = second.headers();
    ordinaryRscSecondBody = await second.text();
    await second.dispose();
  }
  expect(ordinaryRscSecondHeaders["content-type"]).toContain("text/x-component");
  expect(ordinaryRscSecondBody).toContain(`${suffix}-rsc`);
  if (backend === "workers-cache") {
    expect(ordinaryRscSecondHeaders[cacheStatusHeader]).not.toBe("HIT");
  }
  if (backend !== "kv") {
    expect(
      decodeURIComponent(ordinaryRscSecondHeaders["x-vinext-rendered-path-and-search"] ?? ""),
    ).toBe(`${ordinaryPath}?q=second-${suffix}`);
  }

  // A force-static Route Handler strips the query and reuses its pathname artifact.
  // Ported from Next.js: test/e2e/app-dir/app-routes/app-custom-routes.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts
  const handlerFirst = await request.get(`${baseURL}/api/query-handler-static?q=first-${suffix}`);
  expect(handlerFirst.ok(), JSON.stringify(handlerFirst.headers())).toBe(true);
  const firstHandlerBody = (await handlerFirst.json()) as { id: string; search: string };
  await expect
    .poll(
      async () => {
        const repeated = await request.get(`${baseURL}/api/query-handler-static?q=first-${suffix}`);
        const body = (await repeated.json()) as { id: string; search: string };
        await repeated.dispose();
        return body.id;
      },
      { message: `${backend} did not persist the force-static handler`, timeout: 10_000 },
    )
    .toBe(firstHandlerBody.id);
  const handlerSecond = await request.get(`${baseURL}/api/query-handler-static?q=second-${suffix}`);
  expect(handlerSecond.ok(), JSON.stringify(handlerSecond.headers())).toBe(true);
  expect(await handlerSecond.json()).toEqual(firstHandlerBody);
  expect(firstHandlerBody.search).toBe("");
  if (backend !== "kv") expect(handlerSecond.headers()[cacheStatusHeader]).toBe("HIT");

  for (const path of ["query-dependent", "query-client-dependent", "query-prop-to-client"]) {
    // The empty-query response is a particularly dangerous source of false
    // static certification: its thenable carries no enumerable query keys.
    for (const query of ["", `?q=first-${suffix}`, `?q=second-${suffix}`, ""]) {
      const url = `${baseURL}/${path}${query}`;
      const first = await request.get(url);
      const second = await request.get(url);
      expect(first.ok(), `${path}: ${JSON.stringify(first.headers())}`).toBe(true);
      expect(second.ok(), `${path}: ${JSON.stringify(second.headers())}`).toBe(true);
      const expected = new URL(url).searchParams.get("q") || "(empty)";
      for (const response of [first, second]) {
        // Direct KV's fresh empty-query Client Page currently carries no
        // cache policy, but must never produce a cache hit. The two edge
        // adapters explicitly mark it no-store.
        if (backend !== "kv" || path !== "query-client-dependent" || query !== "") {
          expect(response.headers()["cache-control"]).toContain("no-store");
        }
        expect(response.headers()[cacheStatusHeader]).not.toBe("HIT");
        expect(await response.text()).toContain(`data-testid="${path}-value">${expected}</output>`);
      }
    }
  }

  // Metadata reading searchParams makes even the empty-query response dynamic.
  for (const query of ["", `?q=first-${suffix}`, `?q=second-${suffix}`, ""]) {
    const url = `${baseURL}/query-metadata${query}`;
    for (const response of [await request.get(url), await request.get(url)]) {
      expect(response.ok(), JSON.stringify(response.headers())).toBe(true);
      expect(response.headers()[cacheStatusHeader]).not.toBe("HIT");
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(await response.text()).toContain(
        `<title>Query metadata: ${new URL(url).searchParams.get("q") ?? ""}</title>`,
      );
    }
  }

  for (const query of ["", `?q=first-${suffix}`, `?q=second-${suffix}`]) {
    const url = `${baseURL}/query-ssr-client/${suffix}${query}`;
    for (const response of [await request.get(url), await request.get(url)]) {
      const body = await response.text();
      expect(
        response.ok(),
        `${url}: ${JSON.stringify(response.headers())} ${body.slice(0, 400)}`,
      ).toBe(true);
      expect(response.headers()[cacheStatusHeader]).not.toBe("HIT");
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(body).toContain(
        `data-testid="query-ssr-client-value">${new URL(url).searchParams.get("q") || "(empty)"}</output>`,
      );
    }
  }

  const rewriteWithQuery = await request.get(
    `${baseURL}/query-alias-fixed/${suffix}?q=first-${suffix}`,
  );
  expect(rewriteWithQuery.ok()).toBe(true);
  expect(await rewriteWithQuery.text()).not.toContain("searchParamsFromBrowser:true");
  const rewriteWithOtherQuery = await request.get(
    `${baseURL}/query-alias-fixed/${suffix}?q=second-${suffix}`,
  );
  expect(rewriteWithOtherQuery.ok()).toBe(true);
  if (backend !== "kv") {
    expect(rewriteWithOtherQuery.headers()[cacheStatusHeader]).not.toBe("HIT");
  }

  // Explicit public policy may cache a dynamic response, but only under its
  // *full* query. Response Store commits warmup synchronously, but another
  // isolate can retain a short-lived negative lookup after that commit.
  let previousPublicId: string | undefined;
  for (const value of [`first-${suffix}`, `second-${suffix}`]) {
    const url = `${baseURL}/query-public?q=${value}`;
    const first = await request.get(url, {
      headers: { "user-agent": "vinext-cloudflare-cdn-warm" },
    });
    const firstBody = await first.text();
    expect(first.ok(), JSON.stringify(first.headers())).toBe(true);
    expect(firstBody).toContain(`data-testid="query-public-value">${value}</output>`);
    const publicId = /data-testid="query-public-id"[^>]*>([^<]+)/.exec(firstBody)?.[1];
    expect(publicId).toBeTruthy();
    expect(publicId).not.toBe(previousPublicId);
    let cachedPublicId = publicId;
    if (backend !== "kv") {
      let hitBody = "";
      await expect
        .poll(
          async () => {
            const response = await request.get(url);
            const status = response.headers()[cacheStatusHeader];
            const body = await response.text();
            expect(response.ok(), JSON.stringify(response.headers())).toBe(true);
            if (status === "HIT") hitBody = body;
            await response.dispose();
            return status;
          },
          {
            message: `${backend} did not publish the query-specific public response`,
            timeout: 10_000,
          },
        )
        .toBe("HIT");
      // A second edge isolate can miss before the warmup write becomes visible
      // and publish its own render. Only Workers Cache promises the same body
      // for the first fill and the HIT; Response Store must preserve the query.
      if (backend === "workers-cache") expect(hitBody).toBe(firstBody);
      expect(hitBody).toContain(`data-testid="query-public-value">${value}</output>`);
      cachedPublicId = /data-testid="query-public-id"[^>]*>([^<]+)/.exec(hitBody)?.[1];
      expect(cachedPublicId).toBeTruthy();
      expect(cachedPublicId).not.toBe(previousPublicId);
    }
    previousPublicId = cachedPublicId;
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
