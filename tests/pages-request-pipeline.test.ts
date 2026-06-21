import { describe, it, expect, vi } from "vite-plus/test";
import {
  runPagesRequest,
  wrapMiddlewareWithBasePath,
  type PagesPipelineDeps,
  type MiddlewareResult,
  type PagesRenderOptions,
} from "../packages/vinext/src/server/pages-request-pipeline.js";

// Helpers

function makeRequest(pathname: string, headers?: Record<string, string>): Request {
  return new Request(`http://localhost${pathname}`, { headers });
}

function baseDeps(overrides?: Partial<PagesPipelineDeps>): PagesPipelineDeps {
  return {
    basePath: "",
    trailingSlash: false,
    i18nConfig: null,
    configRedirects: [],
    configRewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
    configHeaders: [],
    hadBasePath: true,
    isDataReq: false,
    isDataRequest: false,
    hasMiddleware: false,
    ...overrides,
  };
}

function makeMiddleware(result: Partial<MiddlewareResult>) {
  return vi.fn(async (_req: Request, _ctx: unknown, _opts: { isDataRequest: boolean }) => ({
    continue: true,
    ...result,
  }));
}

function makeRenderPage(status = 200, body = "ok") {
  return vi.fn(
    async (_req: Request, _url: string, _opts?: PagesRenderOptions) =>
      new Response(body, { status }),
  );
}

// 1. Trailing-slash: /foo/ with trailingSlash: false → {type:"response"} with status 308
describe("trailing slash normalization", () => {
  it("redirects /foo/ to /foo when trailingSlash is false", async () => {
    const req = makeRequest("/foo/");
    const result = await runPagesRequest(req, baseDeps({ trailingSlash: false }));
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(308);
    expect(result.response.headers.get("Location")).toBe("/foo");
  });

  it("does not redirect /foo when trailingSlash is false", async () => {
    const req = makeRequest("/foo");
    const result = await runPagesRequest(req, baseDeps({ renderPage: makeRenderPage() }));
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
  });
});

// 2. Config redirect: permanent redirect → status 308 with Location
describe("config redirects", () => {
  it("permanent redirect returns 308", async () => {
    const req = makeRequest("/old");
    const result = await runPagesRequest(
      req,
      baseDeps({
        configRedirects: [{ source: "/old", destination: "/new", permanent: true }],
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(308);
    expect(result.response.headers.get("Location")).toBe("/new");
  });

  // 3. Config redirect: non-permanent → status 307
  it("non-permanent redirect returns 307", async () => {
    const req = makeRequest("/old");
    const result = await runPagesRequest(
      req,
      baseDeps({
        configRedirects: [{ source: "/old", destination: "/new", permanent: false }],
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(307);
    expect(result.response.headers.get("Location")).toBe("/new");
  });

  it("keeps the real redirect status for trusted data requests", async () => {
    // Ported from Next.js: test/e2e/middleware-general/test/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/middleware-general/test/index.test.ts
    const result = await runPagesRequest(
      makeRequest("/old"),
      baseDeps({
        configRedirects: [{ source: "/old", destination: "/new", permanent: true }],
        isDataReq: true,
        isDataRequest: true,
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(308);
    expect(result.response.headers.get("Location")).toBe("/new");
    expect(result.response.headers.get("x-nextjs-redirect")).toBeNull();
  });

  it("does not use the soft redirect protocol for forged data headers", async () => {
    const result = await runPagesRequest(
      makeRequest("/old", { "x-nextjs-data": "1" }),
      baseDeps({
        configRedirects: [{ source: "/old", destination: "/new", permanent: true }],
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(308);
    expect(result.response.headers.get("Location")).toBe("/new");
    expect(result.response.headers.get("x-nextjs-redirect")).toBeNull();
  });

  it("does not match when source does not match", async () => {
    const req = makeRequest("/other");
    const result = await runPagesRequest(
      req,
      baseDeps({
        configRedirects: [{ source: "/old", destination: "/new", permanent: false }],
        renderPage: makeRenderPage(),
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
  });
});

// 4. Middleware redirect short-circuit → {type:"response"} status 307
describe("middleware", () => {
  it("adds the final matched path to rewritten data responses", async () => {
    const result = await runPagesRequest(
      makeRequest("/ssr-page"),
      baseDeps({
        isDataReq: true,
        isDataRequest: true,
        runMiddleware: makeMiddleware({ rewriteUrl: "/ssr-page-2" }),
        matchPageRoute: vi
          .fn()
          .mockReturnValue({ route: { isDynamic: false, pattern: "/ssr-page-2" } }),
        renderPage: makeRenderPage(),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.headers.get("x-nextjs-rewrite")).toBe("/ssr-page-2");
    expect(result.response.headers.get("x-nextjs-matched-path")).toBe("/ssr-page-2");
  });

  it("locale-prefixes the final matched path on i18n data responses", async () => {
    const result = await runPagesRequest(
      makeRequest("/ssr-page"),
      baseDeps({
        i18nConfig: { locales: ["en", "fr"], defaultLocale: "en" },
        isDataReq: true,
        isDataRequest: true,
        runMiddleware: makeMiddleware({ rewriteUrl: "/ssr-page-2" }),
        matchPageRoute: vi
          .fn()
          .mockReturnValue({ route: { isDynamic: false, pattern: "/ssr-page-2" } }),
        renderPage: makeRenderPage(),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.headers.get("x-nextjs-matched-path")).toBe("/en/ssr-page-2");
  });

  it("preserves an explicit locale on dynamic data responses", async () => {
    const result = await runPagesRequest(
      makeRequest("/fr/source"),
      baseDeps({
        i18nConfig: { locales: ["en", "fr"], defaultLocale: "en" },
        isDataReq: true,
        isDataRequest: true,
        runMiddleware: makeMiddleware({ rewriteUrl: "/fr/blog/example" }),
        matchPageRoute: vi
          .fn()
          .mockReturnValue({ route: { isDynamic: true, pattern: "/blog/:slug" } }),
        renderPage: makeRenderPage(),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.headers.get("x-nextjs-matched-path")).toBe("/fr/blog/[slug]");
  });

  it("does not add matched-path routing metadata to HTML responses", async () => {
    const result = await runPagesRequest(
      makeRequest("/ssr-page"),
      baseDeps({
        runMiddleware: makeMiddleware({ rewriteUrl: "/ssr-page-2" }),
        matchPageRoute: vi.fn().mockReturnValue({ route: { isDynamic: false } }),
        renderPage: makeRenderPage(),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.headers.get("x-nextjs-matched-path")).toBeNull();
  });

  it("returns middleware data misses as JSON with the requested matched path", async () => {
    const result = await runPagesRequest(
      makeRequest("/unknown"),
      baseDeps({
        isDataReq: true,
        isDataRequest: true,
        hasMiddleware: true,
        runMiddleware: makeMiddleware({ continue: true }),
        matchPageRoute: vi.fn().mockReturnValue(null),
        renderPage: makeRenderPage(404, "not found"),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(result.response.headers.get("x-nextjs-matched-path")).toBe("/unknown");
    expect(await result.response.text()).toBe("{}");
  });

  it("keeps data misses as JSON 404 when generated wiring provides a no-op middleware", async () => {
    const result = await runPagesRequest(
      makeRequest("/unknown"),
      baseDeps({
        isDataReq: true,
        isDataRequest: true,
        hasMiddleware: false,
        runMiddleware: makeMiddleware({ continue: true }),
        matchPageRoute: vi.fn().mockReturnValue(null),
        renderPage: makeRenderPage(404, "{}"),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(404);
    expect(result.response.headers.get("x-nextjs-matched-path")).toBeNull();
  });

  it("uses the matched route pattern for dynamic data responses", async () => {
    const result = await runPagesRequest(
      makeRequest("/source"),
      baseDeps({
        isDataReq: true,
        isDataRequest: true,
        runMiddleware: makeMiddleware({ rewriteUrl: "/blog/example" }),
        matchPageRoute: vi
          .fn()
          .mockReturnValue({ route: { isDynamic: true, pattern: "/blog/:slug" } }),
        renderPage: makeRenderPage(),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.headers.get("x-nextjs-matched-path")).toBe("/blog/[slug]");
  });

  it("does not add matched-path routing metadata to failed data responses", async () => {
    const result = await runPagesRequest(
      makeRequest("/ssr-page"),
      baseDeps({
        isDataReq: true,
        isDataRequest: true,
        runMiddleware: makeMiddleware({ rewriteUrl: "/ssr-page-2" }),
        matchPageRoute: vi
          .fn()
          .mockReturnValue({ route: { isDynamic: false, pattern: "/ssr-page-2" } }),
        renderPage: makeRenderPage(500, "failed"),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("x-nextjs-matched-path")).toBeNull();
  });

  it("does not add matched-path metadata when middleware overrides the response status", async () => {
    const result = await runPagesRequest(
      makeRequest("/ssr-page"),
      baseDeps({
        isDataReq: true,
        isDataRequest: true,
        runMiddleware: makeMiddleware({
          rewriteUrl: "/ssr-page-2",
          status: 418,
        }),
        matchPageRoute: vi
          .fn()
          .mockReturnValue({ route: { isDynamic: false, pattern: "/ssr-page-2" } }),
        renderPage: makeRenderPage(),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(418);
    expect(result.response.headers.get("x-nextjs-matched-path")).toBeNull();
  });

  it("middleware redirect short-circuits with 307", async () => {
    const req = makeRequest("/foo");
    const result = await runPagesRequest(
      req,
      baseDeps({
        runMiddleware: makeMiddleware({
          continue: false,
          redirectUrl: "http://localhost/bar",
          redirectStatus: 307,
        }),
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(307);
    expect(result.response.headers.get("Location")).toBe("http://localhost/bar");
  });

  it("middleware redirect uses default 307 when no redirectStatus given", async () => {
    const req = makeRequest("/foo");
    const result = await runPagesRequest(
      req,
      baseDeps({
        runMiddleware: makeMiddleware({ continue: false, redirectUrl: "http://localhost/bar" }),
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(307);
  });

  // Ported from Next.js: test/e2e/middleware-general/test/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-general/test/index.test.ts
  it("does not classify a normal request as data from x-nextjs-data alone", async () => {
    const runMiddleware = vi.fn(async () => ({
      continue: false,
      redirectUrl: "http://localhost/somewhere",
      redirectStatus: 307,
    }));

    const result = await runPagesRequest(
      makeRequest("/redirect-to-somewhere", { "x-nextjs-data": "1" }),
      baseDeps({ runMiddleware }),
    );

    expect(runMiddleware).toHaveBeenCalledWith(expect.any(Request), null, {
      isDataRequest: false,
    });
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(307);
    expect(result.response.headers.get("Location")).toBe("http://localhost/somewhere");
    expect(result.response.headers.get("x-nextjs-redirect")).toBeNull();
  });

  // 5. Middleware rewrite: resolvedUrl changes, pipeline continues
  it("middleware rewrite changes resolved URL, pipeline continues to render", async () => {
    const renderPage = makeRenderPage(200, "rewrite target");
    const req = makeRequest("/foo");
    const result = await runPagesRequest(
      req,
      baseDeps({
        runMiddleware: makeMiddleware({ continue: true, rewriteUrl: "/bar" }),
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
    // renderPage should have been called with the rewritten URL
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/bar",
      undefined,
      expect.any(Headers),
    );
  });

  it.each([
    { i18nConfig: null, requestPath: "/ssr-page", rewritePath: "/ssr-page-2" },
    {
      i18nConfig: { locales: ["en", "fr"], defaultLocale: "en" },
      requestPath: "/en/ssr-page",
      rewritePath: "/en/ssr-page-2",
    },
  ])(
    "exposes the middleware rewrite target on real Pages data responses ($requestPath)",
    async ({ i18nConfig, requestPath, rewritePath }) => {
      const result = await runPagesRequest(
        makeRequest(requestPath),
        baseDeps({
          isDataReq: true,
          isDataRequest: true,
          i18nConfig,
          runMiddleware: makeMiddleware({
            continue: true,
            rewriteUrl: rewritePath,
          }),
          renderPage: makeRenderPage(200, '{"pageProps":{"message":"Bye Cruel World"}}'),
        }),
      );

      expect(result.type).toBe("response");
      if (result.type !== "response") return;
      expect(result.response.headers.get("x-nextjs-rewrite")).toBe(rewritePath);
      expect(result.response.headers.get("x-middleware-rewrite")).toBeNull();
    },
  );

  it("does not expose the middleware rewrite target on HTML responses", async () => {
    const result = await runPagesRequest(
      makeRequest("/to-blog/post"),
      baseDeps({
        runMiddleware: makeMiddleware({
          continue: true,
          rewriteUrl: "/fallback-true-blog/post",
        }),
        renderPage: makeRenderPage(200),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.headers.get("x-nextjs-rewrite")).toBeNull();
  });

  it("exposes the final config rewrite URL with appended source params", async () => {
    const result = await runPagesRequest(
      makeRequest("/config-rewrite-to-dynamic-static/post-2"),
      baseDeps({
        isDataRequest: true,
        configRewrites: {
          beforeFiles: [
            {
              source: "/config-rewrite-to-dynamic-static/:rewriteSlug",
              destination: "/ssg",
            },
          ],
          afterFiles: [],
          fallback: [],
        },
        renderPage: makeRenderPage(200),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.headers.get("x-nextjs-rewrite")).toBe("/ssg?rewriteSlug=post-2");
  });

  // 6. Middleware response short-circuit → {type:"response"} with middleware response
  it("middleware response short-circuit returns the middleware response", async () => {
    const middlewareResponse = new Response("blocked", { status: 403 });
    const req = makeRequest("/foo");
    const result = await runPagesRequest(
      req,
      baseDeps({
        runMiddleware: makeMiddleware({ continue: false, response: middlewareResponse }),
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response).toBe(middlewareResponse);
    expect(result.response.status).toBe(403);
    // Passthrough response: no content-type default → Node sends it verbatim.
    expect(result.defaultContentType).toBeUndefined();
  });

  // 18. middlewareStatus reconciliation: result.status takes priority over result.rewriteStatus
  it("middlewareStatus: result.status takes priority over result.rewriteStatus", async () => {
    const renderPage = makeRenderPage(200);
    const req = makeRequest("/foo");
    const result = await runPagesRequest(
      req,
      baseDeps({
        runMiddleware: makeMiddleware({ continue: true, status: 404, rewriteStatus: 403 }),
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    // middlewareStatus=404 from result.status should override rewriteStatus=403
    expect(result.response.status).toBe(404);
  });

  // 20. Multi-value Set-Cookie accumulation from middleware response headers
  it("accumulates multiple Set-Cookie headers from middleware", async () => {
    const renderPage = makeRenderPage(200);
    const req = makeRequest("/foo");
    const responseHeaders = new Headers();
    responseHeaders.append("set-cookie", "a=1");
    responseHeaders.append("set-cookie", "b=2");

    const result = await runPagesRequest(
      req,
      baseDeps({
        runMiddleware: vi.fn(async () => ({
          continue: true,
          responseHeaders: [...responseHeaders.entries()],
        })),
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    const cookies = result.response.headers.getSetCookie?.() ?? [];
    expect(cookies).toContain("a=1");
    expect(cookies).toContain("b=2");
  });
});

// 7. Config headers staged
describe("config headers", () => {
  it("stages config headers into middleware headers", async () => {
    const renderPage = makeRenderPage(200);
    const req = makeRequest("/foo");
    const result = await runPagesRequest(
      req,
      baseDeps({
        configHeaders: [{ source: "/foo", headers: [{ key: "X-Custom", value: "test" }] }],
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.headers.get("X-Custom")).toBe("test");
  });
});

// 8. External proxy after middleware rewrite
describe("external proxy", () => {
  it("proxies to external URL when middleware rewrites to external", async () => {
    const req = makeRequest("/proxy-me");
    // Use fetchMock or just observe isExternalUrl → proxyExternalRequest
    // Since proxyExternalRequest will actually fetch, we mock globalThis.fetch
    const mockFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("external response", { status: 200 }));

    const result = await runPagesRequest(
      req,
      baseDeps({
        runMiddleware: makeMiddleware({
          continue: true,
          rewriteUrl: "https://example.com/proxied",
        }),
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
    mockFetch.mockRestore();
  });
});

// 9. beforeFiles rewrite with external URL → {type:"response"} from proxy
describe("beforeFiles rewrites", () => {
  it("beforeFiles external rewrite proxies the request", async () => {
    const req = makeRequest("/proxy-me");
    const mockFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("from proxy", { status: 200 }));

    const result = await runPagesRequest(
      req,
      baseDeps({
        configRewrites: {
          beforeFiles: [{ source: "/proxy-me", destination: "https://example.com/proxied" }],
          afterFiles: [],
          fallback: [],
        },
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
    mockFetch.mockRestore();
  });

  it("beforeFiles rewrite changes resolved URL", async () => {
    const renderPage = makeRenderPage(200);
    const req = makeRequest("/from");

    const result = await runPagesRequest(
      req,
      baseDeps({
        configRewrites: {
          beforeFiles: [{ source: "/from", destination: "/to" }],
          afterFiles: [],
          fallback: [],
        },
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/to",
      undefined,
      expect.any(Headers),
    );
  });

  it("applies chained beforeFiles rewrites with accumulated query conditions", async () => {
    const renderPage = makeRenderPage(200);
    const result = await runPagesRequest(
      makeRequest("/from?keep=1"),
      baseDeps({
        configRewrites: {
          beforeFiles: [
            { source: "/from", destination: "/middle?stage=1" },
            {
              source: "/middle",
              destination: "/to",
              has: [{ type: "query", key: "stage", value: "1" }],
            },
          ],
          afterFiles: [],
          fallback: [],
        },
        renderPage,
      }),
    );

    expect(result.type).toBe("response");
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/to?keep=1&stage=1",
      undefined,
      expect.any(Headers),
    );
  });

  it("applies every matching beforeFiles rewrite in sequence", async () => {
    const renderPage = makeRenderPage(200);
    const result = await runPagesRequest(
      makeRequest("/start"),
      baseDeps({
        isDataRequest: true,
        configRewrites: {
          beforeFiles: [
            { source: "/start", destination: "/middle?first=1" },
            { source: "/middle", destination: "/destination?second=2" },
          ],
          afterFiles: [],
          fallback: [],
        },
        renderPage,
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/destination?first=1&second=2",
      undefined,
      expect.any(Headers),
    );
    expect(result.response.headers.get("x-nextjs-rewrite")).toBe("/destination?first=1&second=2");
  });

  it("excludes beforeFiles fragments from Pages route matching", async () => {
    const matchPageRoute = vi.fn((pathname: string) =>
      pathname === "/to" ? { route: { isDynamic: false } } : null,
    );
    await runPagesRequest(
      makeRequest("/from"),
      baseDeps({
        configRewrites: {
          beforeFiles: [{ source: "/from", destination: "/to#section" }],
          afterFiles: [],
          fallback: [],
        },
        matchPageRoute,
        renderPage: makeRenderPage(200),
      }),
    );

    expect(matchPageRoute).toHaveBeenCalledWith("/to", expect.any(Request));
    expect(matchPageRoute).not.toHaveBeenCalledWith("/to#section", expect.any(Request));
  });
});

// 10. Out-of-basePath reject when basePath: "/base" and hadBasePath: false and no configRewrite fired
describe("out-of-basePath rejection", () => {
  it("rejects requests outside basePath with 404 when no rewrite fires", async () => {
    const req = makeRequest("/outside/page");
    const result = await runPagesRequest(
      req,
      baseDeps({
        basePath: "/base",
        hadBasePath: false,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(404);
  });

  it("allows requests outside basePath when beforeFiles rewrite fires", async () => {
    const renderPage = makeRenderPage(200);
    const req = makeRequest("/outside");
    const result = await runPagesRequest(
      req,
      baseDeps({
        basePath: "/base",
        hadBasePath: false,
        configRewrites: {
          beforeFiles: [{ source: "/outside", destination: "/inside", basePath: false }],
          afterFiles: [],
          fallback: [],
        },
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
  });
});

// 11. API route with renderPage absent → {type:"api"} intent
describe("API routes", () => {
  it("emits api intent when handleApi absent", async () => {
    const req = makeRequest("/api/users");
    const result = await runPagesRequest(req, baseDeps());
    expect(result.type).toBe("api");
    if (result.type !== "api") return;
    expect(result.apiUrl).toBe("/api/users");
  });

  // 12. API route with handleApi present → {type:"response"}
  it("returns response when handleApi present", async () => {
    const req = makeRequest("/api/users");
    const handleApi = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const result = await runPagesRequest(req, baseDeps({ handleApi }));
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
    expect(handleApi).toHaveBeenCalledWith(expect.any(Request), "/api/users", null);
    // API responses default a missing content-type to octet-stream, not text/html.
    expect(result.defaultContentType).toBe("application/octet-stream");
  });

  it("tags page renders with a text/html content-type default", async () => {
    const req = makeRequest("/page");
    const result = await runPagesRequest(req, baseDeps({ renderPage: makeRenderPage(200) }));
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.defaultContentType).toBe("text/html");
  });

  it("matches /api exactly", async () => {
    const req = makeRequest("/api");
    const result = await runPagesRequest(req, baseDeps());
    expect(result.type).toBe("api");
  });
});

// Filesystem/static route serving supplied by each runtime adapter.
describe("serveFilesystemRoute", () => {
  it("returns {type:'handled'} when serveFilesystemRoute serves the request", async () => {
    const renderPage = makeRenderPage(200);
    const serveFilesystemRoute = vi.fn(async () => true);
    const req = makeRequest("/favicon.ico");
    const result = await runPagesRequest(req, baseDeps({ serveFilesystemRoute, renderPage }));
    expect(result.type).toBe("handled");
    // The static file short-circuits — the renderer is never invoked.
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("falls through to render when serveFilesystemRoute returns false", async () => {
    const renderPage = makeRenderPage(200);
    const serveFilesystemRoute = vi.fn(async () => false);
    const req = makeRequest("/page");
    const result = await runPagesRequest(req, baseDeps({ serveFilesystemRoute, renderPage }));
    expect(serveFilesystemRoute).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("response");
    expect(renderPage).toHaveBeenCalled();
  });

  it("passes the original (pre-rewrite) pathname and staged headers", async () => {
    const serveFilesystemRoute = vi.fn(async () => true);
    const middleware = makeMiddleware({ responseHeaders: [["set-cookie", "a=1"]] });
    const req = makeRequest("/robots.txt");
    await runPagesRequest(req, baseDeps({ serveFilesystemRoute, runMiddleware: middleware }));
    expect(serveFilesystemRoute).toHaveBeenCalledWith(
      "/robots.txt",
      { "set-cookie": ["a=1"] },
      "direct",
    );
  });

  it("runs after middleware — a middleware redirect wins over a public file", async () => {
    const serveFilesystemRoute = vi.fn(async () => true);
    const middleware = makeMiddleware({
      continue: false,
      redirectUrl: "/elsewhere",
      redirectStatus: 307,
    });
    const req = makeRequest("/favicon.ico");
    const result = await runPagesRequest(
      req,
      baseDeps({ serveFilesystemRoute, runMiddleware: middleware }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(307);
    expect(result.response.headers.get("Location")).toBe("/elsewhere");
    expect(serveFilesystemRoute).not.toHaveBeenCalled();
  });

  // Ported from Next.js: test/e2e/i18n-ignore-rewrite-source-locale/rewrites.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/i18n-ignore-rewrite-source-locale/rewrites.test.ts
  it("re-enters filesystem matching after a locale:false beforeFiles rewrite", async () => {
    const serveFilesystemRoute = vi.fn(async (pathname: string) => pathname === "/file.txt");
    const result = await runPagesRequest(
      makeRequest("/sv/rewrite-files/file.txt"),
      baseDeps({
        i18nConfig: { locales: ["en", "sv", "nl"], defaultLocale: "en" },
        configRewrites: {
          beforeFiles: [
            {
              source: "/:locale/rewrite-files/:path*",
              destination: "/:path*",
              locale: false,
            },
          ],
          afterFiles: [],
          fallback: [],
        },
        serveFilesystemRoute,
      }),
    );

    expect(result.type).toBe("handled");
    expect(serveFilesystemRoute).toHaveBeenNthCalledWith(
      1,
      "/sv/rewrite-files/file.txt",
      {},
      "direct",
    );
    expect(serveFilesystemRoute).toHaveBeenNthCalledWith(2, "/file.txt", {}, "beforeFiles");
  });

  it("returns a Worker-style asset response after a beforeFiles rewrite", async () => {
    const serveFilesystemRoute = vi.fn(async (pathname: string) =>
      pathname === "/file.txt"
        ? new Response("worker asset", { headers: { "content-type": "text/plain" } })
        : false,
    );
    const result = await runPagesRequest(
      makeRequest("/en/rewrite-files/file.txt"),
      baseDeps({
        i18nConfig: { locales: ["en", "sv", "nl"], defaultLocale: "en" },
        configRewrites: {
          beforeFiles: [
            {
              source: "/:locale/rewrite-files/:path*",
              destination: "/:path*",
              locale: false,
            },
          ],
          afterFiles: [],
          fallback: [],
        },
        serveFilesystemRoute,
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
    await expect(result.response.text()).resolves.toBe("worker asset");
  });

  it("continues rewritten API and page routing when no filesystem target exists", async () => {
    const serveFilesystemRoute = vi.fn(async () => false);
    const handleApi = vi.fn(async () => new Response("api"));
    const renderPage = makeRenderPage(200, "page");
    const rewrites = {
      beforeFiles: [
        { source: "/rewrite-api/:path*", destination: "/api/:path*" },
        { source: "/rewrite-page", destination: "/about" },
      ],
      afterFiles: [],
      fallback: [],
    };

    const apiResult = await runPagesRequest(
      makeRequest("/rewrite-api/hello"),
      baseDeps({ configRewrites: rewrites, serveFilesystemRoute, handleApi, renderPage }),
    );
    const pageResult = await runPagesRequest(
      makeRequest("/rewrite-page"),
      baseDeps({ configRewrites: rewrites, serveFilesystemRoute, handleApi, renderPage }),
    );

    expect(apiResult.type).toBe("response");
    expect(handleApi).toHaveBeenCalledWith(expect.any(Request), "/api/hello", null);
    expect(pageResult.type).toBe("response");
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/about",
      undefined,
      expect.any(Headers),
    );
  });
});

// 13. afterFiles rewrite: dynamic page match is re-queried
describe("afterFiles rewrites", () => {
  it("re-enters Worker assets after afterFiles rewrites", async () => {
    const serveFilesystemRoute = vi.fn(async (pathname: string, _headers, phase) =>
      pathname === "/file.txt" && phase === "afterFiles"
        ? new Response("worker afterFiles asset")
        : false,
    );
    const result = await runPagesRequest(
      makeRequest("/sv/after-files/file.txt"),
      baseDeps({
        i18nConfig: { locales: ["en", "sv", "nl"], defaultLocale: "en" },
        matchPageRoute: vi.fn().mockReturnValue(null),
        configRewrites: {
          beforeFiles: [],
          afterFiles: [
            {
              source: "/:locale/after-files/:path*",
              destination: "/:path*",
              locale: false,
            },
          ],
          fallback: [],
        },
        serveFilesystemRoute,
        renderPage: makeRenderPage(404),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    await expect(result.response.text()).resolves.toBe("worker afterFiles asset");
    expect(serveFilesystemRoute).toHaveBeenLastCalledWith("/file.txt", {}, "afterFiles");
  });

  it("does not run afterFiles filesystem re-entry when a static page matches", async () => {
    const serveFilesystemRoute = vi.fn(async () => false);
    const renderPage = makeRenderPage(200, "page wins");
    const result = await runPagesRequest(
      makeRequest("/after-control"),
      baseDeps({
        matchPageRoute: vi.fn().mockReturnValue({ route: { isDynamic: false } }),
        configRewrites: {
          beforeFiles: [],
          afterFiles: [{ source: "/after-control", destination: "/file.txt" }],
          fallback: [],
        },
        serveFilesystemRoute,
        renderPage,
      }),
    );

    expect(result.type).toBe("response");
    expect(serveFilesystemRoute).toHaveBeenCalledOnce();
    expect(serveFilesystemRoute).toHaveBeenCalledWith("/after-control", {}, "direct");
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/after-control",
      undefined,
      expect.any(Headers),
    );
  });

  it("dispatches rewritten API routes after afterFiles filesystem misses", async () => {
    const serveFilesystemRoute = vi.fn(async () => false);
    const handleApi = vi.fn(async () => new Response("worker afterFiles api"));
    const result = await runPagesRequest(
      makeRequest("/sv/after-files/api/hello"),
      baseDeps({
        i18nConfig: { locales: ["en", "sv", "nl"], defaultLocale: "en" },
        matchPageRoute: vi.fn().mockReturnValue(null),
        configRewrites: {
          beforeFiles: [],
          afterFiles: [
            {
              source: "/:locale/after-files/:path*",
              destination: "/:path*",
              locale: false,
            },
          ],
          fallback: [],
        },
        serveFilesystemRoute,
        handleApi,
      }),
    );

    expect(result.type).toBe("response");
    expect(handleApi).toHaveBeenCalledWith(expect.any(Request), "/api/hello", null);
  });

  it("applies afterFiles rewrite when page match is dynamic", async () => {
    const renderPage = makeRenderPage(200);
    const req = makeRequest("/dynamic-route");
    const result = await runPagesRequest(
      req,
      baseDeps({
        matchPageRoute: vi.fn().mockReturnValue({ route: { isDynamic: true } }),
        configRewrites: {
          beforeFiles: [],
          afterFiles: [{ source: "/dynamic-route", destination: "/rewritten" }],
          fallback: [],
        },
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/rewritten",
      undefined,
      expect.any(Headers),
    );
  });

  it("skips afterFiles rewrite when static page match exists", async () => {
    const renderPage = makeRenderPage(200);
    const req = makeRequest("/static-page");
    const result = await runPagesRequest(
      req,
      baseDeps({
        matchPageRoute: vi.fn().mockReturnValue({ route: { isDynamic: false } }),
        configRewrites: {
          beforeFiles: [],
          afterFiles: [{ source: "/static-page", destination: "/rewritten" }],
          fallback: [],
        },
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    // Should be called with original URL, not rewritten
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/static-page",
      undefined,
      expect.any(Headers),
    );
  });

  it("continues afterFiles rewrites until a Pages destination resolves", async () => {
    const renderPage = makeRenderPage(200);
    const matchPageRoute = vi.fn((pathname: string) =>
      pathname === "/resolved" ? { route: { isDynamic: false } } : null,
    );
    await runPagesRequest(
      makeRequest("/from"),
      baseDeps({
        configRewrites: {
          beforeFiles: [],
          afterFiles: [
            { source: "/from", destination: "/missing" },
            { source: "/missing", destination: "/resolved#section" },
          ],
          fallback: [],
        },
        matchPageRoute,
        renderPage,
      }),
    );

    expect(matchPageRoute).toHaveBeenCalledWith("/resolved", expect.any(Request));
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/resolved#section",
      undefined,
      expect.any(Headers),
    );
  });
});

// 14. Render intent when renderPage absent → {type:"render"}
describe("render intent", () => {
  it("emits render intent when renderPage absent", async () => {
    const req = makeRequest("/page");
    const result = await runPagesRequest(req, baseDeps());
    expect(result.type).toBe("render");
    if (result.type !== "render") return;
    expect(result.resolvedUrl).toBe("/page");
    expect(result.isDataReq).toBe(false);
  });

  it("emits render intent with isDataReq when isDataReq is true", async () => {
    const req = makeRequest("/page");
    const result = await runPagesRequest(req, baseDeps({ isDataReq: true }));
    expect(result.type).toBe("render");
    if (result.type !== "render") return;
    expect(result.isDataReq).toBe(true);
    expect(result.renderOptions).toEqual({ isDataReq: true });
  });

  it("stages the final dev fallback rewrite target for data navigation", async () => {
    const result = await runPagesRequest(
      makeRequest("/to-blog/post"),
      baseDeps({
        isDataReq: true,
        matchPageRoute: () => null,
        configRewrites: {
          beforeFiles: [],
          afterFiles: [],
          fallback: [
            {
              source: "/to-blog/:slug",
              destination: "/fallback-true-blog/:slug",
            },
          ],
        },
      }),
    );

    expect(result.type).toBe("render");
    if (result.type !== "render") return;
    expect(result.resolvedUrl).toBe("/fallback-true-blog/post");
    expect(result.stagedHeaders["x-nextjs-rewrite"]).toBe("/fallback-true-blog/post");
  });
});

// 15. {type:"response"} from renderPage (happy path)
describe("render via renderPage callback", () => {
  it("returns response from renderPage", async () => {
    const renderPage = makeRenderPage(200, "Hello World");
    const req = makeRequest("/about");
    const result = await runPagesRequest(req, baseDeps({ renderPage }));
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
  });
});

// 16. shouldDeferErrorPageOnMiss: 404 → fallback rewrite → re-render
describe("fallback rewrites on 404", () => {
  it("re-enters Worker assets after fallback rewrites", async () => {
    const serveFilesystemRoute = vi.fn(async (pathname: string, _headers, phase) =>
      pathname === "/file.txt" && phase === "fallback"
        ? new Response("worker fallback asset")
        : false,
    );
    const result = await runPagesRequest(
      makeRequest("/sv/fallback-files/file.txt"),
      baseDeps({
        i18nConfig: { locales: ["en", "sv", "nl"], defaultLocale: "en" },
        matchPageRoute: vi.fn().mockReturnValue(null),
        configRewrites: {
          beforeFiles: [],
          afterFiles: [],
          fallback: [
            {
              source: "/:locale/fallback-files/:path*",
              destination: "/:path*",
              locale: false,
            },
          ],
        },
        serveFilesystemRoute,
        renderPage: makeRenderPage(404),
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    await expect(result.response.text()).resolves.toBe("worker fallback asset");
    expect(serveFilesystemRoute).toHaveBeenLastCalledWith("/file.txt", {}, "fallback");
  });

  it("dispatches rewritten API routes after fallback filesystem misses", async () => {
    const serveFilesystemRoute = vi.fn(async () => false);
    const handleApi = vi.fn(async () => new Response("worker fallback api"));
    const result = await runPagesRequest(
      makeRequest("/sv/fallback-files/api/hello"),
      baseDeps({
        i18nConfig: { locales: ["en", "sv", "nl"], defaultLocale: "en" },
        matchPageRoute: vi.fn().mockReturnValue(null),
        configRewrites: {
          beforeFiles: [],
          afterFiles: [],
          fallback: [
            {
              source: "/:locale/fallback-files/:path*",
              destination: "/:path*",
              locale: false,
            },
          ],
        },
        serveFilesystemRoute,
        handleApi,
        renderPage: makeRenderPage(404),
      }),
    );

    expect(result.type).toBe("response");
    expect(handleApi).toHaveBeenCalledWith(expect.any(Request), "/api/hello", null);
  });

  it("uses fallback rewrite when page misses and renders 404", async () => {
    let callCount = 0;
    const renderPage = vi.fn(async (_req: Request, url: string) => {
      callCount++;
      if (callCount === 1) {
        // First call: return 404
        return new Response("not found", { status: 404 });
      }
      // After fallback rewrite: return 200
      return new Response(`ok ${url}`, { status: 200 });
    });

    const req = makeRequest("/missing-page");
    const result = await runPagesRequest(
      req,
      baseDeps({
        matchPageRoute: vi.fn().mockReturnValue(null), // no page match
        configRewrites: {
          beforeFiles: [],
          afterFiles: [],
          fallback: [{ source: "/missing-page", destination: "/fallback" }],
        },
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it("continues fallback rewrites after an unresolved destination", async () => {
    const renderPage = vi.fn(
      async (_req: Request, resolvedUrl: string) =>
        new Response(resolvedUrl, { status: resolvedUrl.startsWith("/resolved") ? 200 : 404 }),
    );
    const result = await runPagesRequest(
      makeRequest("/from"),
      baseDeps({
        matchPageRoute: vi.fn().mockReturnValue(null),
        configRewrites: {
          beforeFiles: [],
          afterFiles: [],
          fallback: [
            { source: "/from", destination: "/missing" },
            { source: "/missing", destination: "/resolved#section" },
          ],
        },
        renderPage,
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(200);
    expect(renderPage).toHaveBeenLastCalledWith(
      expect.any(Request),
      "/resolved#section",
      undefined,
      expect.any(Headers),
    );
  });
});

// 17. shouldDeferErrorPageOnMiss: 404 → no fallback → deferred error page re-render
describe("deferred error page re-render on 404", () => {
  it("re-renders without renderErrorPageOnMiss when no fallback matches", async () => {
    let callCount = 0;
    const renderPage = vi.fn(async (_req: Request, _url: string, opts?: PagesRenderOptions) => {
      callCount++;
      if (opts?.renderErrorPageOnMiss === false) {
        // Initial deferred call: return 404
        return new Response("not found", { status: 404 });
      }
      // Second call: render actual error page
      return new Response("error page", { status: 404 });
    });

    const req = makeRequest("/missing-page");
    const result = await runPagesRequest(
      req,
      baseDeps({
        matchPageRoute: vi.fn().mockReturnValue(null), // no page match
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(404);
    expect(callCount).toBe(2);
    // Second call should NOT have renderErrorPageOnMiss: false
    expect(renderPage.mock.calls[1][2]).toBeUndefined();
  });

  it("does not defer or run fallback rewrites for a data request (x-nextjs-data, worker path)", async () => {
    // Worker scenario: it never normalizes /_next/data paths (isDataReq stays
    // false) but flags the request via the x-nextjs-data header (isDataRequest).
    // A data-request miss must render once directly, not defer + run fallback.
    const renderPage = makeRenderPage(404, "not found");
    const fallback = [{ source: "/missing-page", destination: "/fallback" }];
    const req = makeRequest("/missing-page");
    const result = await runPagesRequest(
      req,
      baseDeps({
        isDataReq: false,
        isDataRequest: true,
        matchPageRoute: vi.fn().mockReturnValue(null), // no page match
        configRewrites: { beforeFiles: [], afterFiles: [], fallback },
        renderPage,
      }),
    );
    expect(result.type).toBe("response");
    // Rendered exactly once with no defer option, and the fallback never fired.
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(renderPage.mock.calls[0][2]).toBeUndefined();
  });

  it("resolves fallback rewrites before rendering a production data request", async () => {
    const renderPage = vi.fn(
      async (_request: Request, url: string) => new Response(`data ${url}`, { status: 200 }),
    );
    const matchPageRoute = vi.fn((pathname: string) =>
      pathname === "/fallback-target" ? ({ route: { isDynamic: false } } as any) : null,
    );

    const result = await runPagesRequest(
      makeRequest("/missing-page"),
      baseDeps({
        isDataRequest: true,
        matchPageRoute,
        configRewrites: {
          beforeFiles: [],
          afterFiles: [],
          fallback: [{ source: "/missing-page", destination: "/fallback-target?from=fallback" }],
        },
        renderPage,
      }),
    );

    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(renderPage).toHaveBeenCalledOnce();
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/fallback-target?from=fallback",
      undefined,
      expect.any(Headers),
    );
    expect(result.response.headers.get("x-nextjs-rewrite")).toBe("/fallback-target?from=fallback");
  });
});

// 19. preserveCredentialHeaders: isExternalUrl(resolvedUrl) → passed to applyMiddlewareRequestHeaders
describe("preserveCredentialHeaders", () => {
  it("preserves credential headers when resolvedUrl is external", async () => {
    // When middleware rewrites to an external URL, the Authorization header
    // should be forwarded. We verify by ensuring the pipeline reaches external proxy.
    const mockFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("proxied", { status: 200 }));

    const req = makeRequest("/internal", { Authorization: "Bearer token" });
    const result = await runPagesRequest(
      req,
      baseDeps({
        runMiddleware: makeMiddleware({
          continue: true,
          rewriteUrl: "https://external.com/api",
          responseHeaders: [["x-middleware-request-authorization", "Bearer token"]],
        }),
      }),
    );
    expect(result.type).toBe("response");
    // Verify fetch was called (external proxy triggered)
    expect(mockFetch).toHaveBeenCalled();
    mockFetch.mockRestore();
  });
});

// 20. wrapMiddlewareWithBasePath: shared adapter helper that re-adds the basePath
// to the middleware request URL. Used by prod-server.ts and the generated worker
// entry (deploy.ts) so middleware sees the original (pre-stripping) URL.
describe("wrapMiddlewareWithBasePath", () => {
  it("passes through unchanged when hadBasePath is false (out-of-basePath request)", async () => {
    const runMiddleware = makeMiddleware({ continue: true });
    const wrapped = wrapMiddlewareWithBasePath(runMiddleware, "/root", false);
    // Out-of-basePath requests stay bare so middleware sees nextUrl.basePath === "" (#1830).
    expect(wrapped).toBe(runMiddleware);
    await wrapped(makeRequest("/dashboard"), null, { isDataRequest: false });
    expect(runMiddleware.mock.calls[0][0].url).toBe("http://localhost/dashboard");
  });

  it("passes through unchanged when basePath is empty", () => {
    const runMiddleware = makeMiddleware({ continue: true });
    expect(wrapMiddlewareWithBasePath(runMiddleware, "", true)).toBe(runMiddleware);
  });

  it("re-adds the basePath to the request URL when hadBasePath is true", async () => {
    const runMiddleware = makeMiddleware({ continue: true });
    const wrapped = wrapMiddlewareWithBasePath(runMiddleware, "/root", true);
    expect(wrapped).not.toBe(runMiddleware);
    const result = await wrapped(makeRequest("/dashboard?q=1", { "x-test": "kept" }), "ctx", {
      isDataRequest: true,
    });
    expect(result.continue).toBe(true);
    const [mwReq, ctx, opts] = runMiddleware.mock.calls[0];
    expect(mwReq.url).toBe("http://localhost/root/dashboard?q=1");
    // Headers, ctx, and opts are forwarded untouched.
    expect(mwReq.headers.get("x-test")).toBe("kept");
    expect(ctx).toBe("ctx");
    expect(opts).toEqual({ isDataRequest: true });
  });

  it("does not double-add an already-present basePath (addBasePathToPathname is idempotent)", async () => {
    const runMiddleware = makeMiddleware({ continue: true });
    const wrapped = wrapMiddlewareWithBasePath(runMiddleware, "/root", true);
    await wrapped(makeRequest("/root/dashboard"), null, { isDataRequest: false });
    expect(runMiddleware.mock.calls[0][0].url).toBe("http://localhost/root/dashboard");
  });
});
