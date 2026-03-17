/**
 * Next.js Compatibility Tests: dynamic-data
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic-data/dynamic-data.test.ts
 *
 * Covers HTTP-testable dev-mode behavior for dynamic request APIs:
 * - top-level headers()/cookies()/searchParams access
 * - force-dynamic pages using request APIs
 * - force-static pages receiving empty request APIs
 * - client pages receiving searchParams
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchDom } from "../helpers.js";

const REQUEST_INIT = {
  headers: {
    fooheader: "foo header value",
    cookie: "foocookie=foo cookie value",
  },
};

describe("Next.js compat: dynamic-data", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/`);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic-data/dynamic-data.test.ts
  it("should render the dynamic apis dynamically when used in a top-level scope", async () => {
    const { $ } = await fetchDom(
      baseUrl,
      "/nextjs-compat/dynamic-data/top-level?foo=foosearch",
      REQUEST_INIT,
    );

    expect($("#layout").text()).toBe("at runtime");
    expect($("#page").text()).toBe("at runtime");
    expect($("#headers .fooheader").text()).toBe("foo header value");
    expect($("#cookies .foocookie").text()).toBe("foo cookie value");
    expect($("#searchparams .foo").text()).toBe("foosearch");
  });

  it("should render the dynamic apis dynamically when used in a top-level scope with force dynamic", async () => {
    const { $ } = await fetchDom(
      baseUrl,
      "/nextjs-compat/dynamic-data/force-dynamic?foo=foosearch",
      REQUEST_INIT,
    );

    expect($("#layout").text()).toBe("at runtime");
    expect($("#page").text()).toBe("at runtime");
    expect($("#headers .fooheader").text()).toBe("foo header value");
    expect($("#cookies .foocookie").text()).toBe("foo cookie value");
    expect($("#searchparams .foo").text()).toBe("foosearch");
  });

  it("should render empty objects for dynamic APIs when rendering with force-static", async () => {
    const { $ } = await fetchDom(
      baseUrl,
      "/nextjs-compat/dynamic-data/force-static?foo=foosearch",
      REQUEST_INIT,
    );

    expect($("#layout").text()).toBe("at runtime");
    expect($("#page").text()).toBe("at runtime");
    expect($("#headers .fooheader").html()).toBeNull();
    expect($("#cookies .foocookie").html()).toBeNull();
    expect($("#searchparams .foo").html()).toBeNull();
  });

  it("should track searchParams access as dynamic when the Page is a client component", async () => {
    const { $ } = await fetchDom(
      baseUrl,
      "/nextjs-compat/dynamic-data/client-page?foo=foosearch",
      REQUEST_INIT,
    );

    expect($("#layout").text()).toBe("at runtime");
    expect($("#page").text()).toBe("at runtime");
    expect($("#searchparams .foo").text()).toBe("foosearch");
  });
});
