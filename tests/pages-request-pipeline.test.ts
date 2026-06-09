import { describe, it, expect, vi } from "vite-plus/test";
import {
  runPagesRequest,
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

// Public-directory static file serving (Node prod only, post-middleware).
describe("serveStaticFile", () => {
  it("returns {type:'handled'} when serveStaticFile serves the request", async () => {
    const renderPage = makeRenderPage(200);
    const serveStaticFile = vi.fn(async () => true);
    const req = makeRequest("/favicon.ico");
    const result = await runPagesRequest(req, baseDeps({ serveStaticFile, renderPage }));
    expect(result.type).toBe("handled");
    // The static file short-circuits — the renderer is never invoked.
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("falls through to render when serveStaticFile returns false", async () => {
    const renderPage = makeRenderPage(200);
    const serveStaticFile = vi.fn(async () => false);
    const req = makeRequest("/page");
    const result = await runPagesRequest(req, baseDeps({ serveStaticFile, renderPage }));
    expect(serveStaticFile).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("response");
    expect(renderPage).toHaveBeenCalled();
  });

  it("passes the original (pre-rewrite) pathname and staged headers", async () => {
    const serveStaticFile = vi.fn(async () => true);
    const middleware = makeMiddleware({ responseHeaders: [["set-cookie", "a=1"]] });
    const req = makeRequest("/robots.txt");
    await runPagesRequest(req, baseDeps({ serveStaticFile, runMiddleware: middleware }));
    expect(serveStaticFile).toHaveBeenCalledWith("/robots.txt", { "set-cookie": ["a=1"] });
  });

  it("runs after middleware — a middleware redirect wins over a public file", async () => {
    const serveStaticFile = vi.fn(async () => true);
    const middleware = makeMiddleware({
      continue: false,
      redirectUrl: "/elsewhere",
      redirectStatus: 307,
    });
    const req = makeRequest("/favicon.ico");
    const result = await runPagesRequest(
      req,
      baseDeps({ serveStaticFile, runMiddleware: middleware }),
    );
    expect(result.type).toBe("response");
    if (result.type !== "response") return;
    expect(result.response.status).toBe(307);
    expect(result.response.headers.get("Location")).toBe("/elsewhere");
    expect(serveStaticFile).not.toHaveBeenCalled();
  });
});

// 13. afterFiles rewrite: dynamic page match is re-queried
describe("afterFiles rewrites", () => {
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
