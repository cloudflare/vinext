import { describe, expect, it, vi } from "vite-plus/test";
import {
  renderPagesFallback,
  type PagesEntry,
} from "../packages/vinext/src/server/app-pages-bridge.js";
import type { AppMiddlewareContext } from "../packages/vinext/src/server/app-middleware.js";

describe("renderPagesFallback", () => {
  const defaultDeps = {
    loadPagesEntry: () => ({}) as PagesEntry,
    buildRequestHeaders: (reqHeaders: Headers, mwHeaders: Headers) => {
      const merged = new Headers(reqHeaders);
      for (const [k, v] of mwHeaders) {
        merged.set(k, v);
      }
      return merged;
    },
    decodePathParams: (pathname: string) => decodeURIComponent(pathname),
    applyRouteHandlerMiddlewareContext: (res: Response, mwCtx: AppMiddlewareContext) => {
      const mergedHeaders = new Headers(res.headers);
      if (mwCtx.headers) {
        for (const [k, v] of mwCtx.headers) {
          mergedHeaders.set(k, v);
        }
      }
      return new Response(res.body, {
        status: mwCtx.status ?? res.status,
        headers: mergedHeaders,
      });
    },
    getDraftModeCookieHeader: (): string | null | undefined => null,
  };

  it("returns null for RSC requests and does not call the Pages loader", async () => {
    const loadPagesEntry = vi.fn(() => ({}) as PagesEntry);
    const res = await renderPagesFallback(
      {
        isRscRequest: true,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        request: new Request("http://localhost/about"),
        url: new URL("http://localhost/about"),
      },
      {
        ...defaultDeps,
        loadPagesEntry,
      },
    );
    expect(res).toBeNull();
    expect(loadPagesEntry).not.toHaveBeenCalled();
  });

  it("allows middleware-rewritten RSC requests to return a Pages document", async () => {
    const renderPage = vi.fn(
      () => new Response("pages", { headers: { "content-type": "text/html" } }),
    );
    const response = await renderPagesFallback(
      {
        allowRscDocumentFallback: true,
        isRscRequest: true,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        pathname: "/pages",
        request: new Request("http://localhost/source"),
        url: new URL("http://localhost/source"),
      },
      { ...defaultDeps, loadPagesEntry: () => ({ renderPage }) },
    );

    expect(await response!.text()).toBe("pages");
  });

  it("matches hybrid Pages data requests against their normalized page pathname", async () => {
    const matchPageRoute = vi.fn(() => ({
      route: { isDynamic: false, pattern: "/pages-dir/search" },
    }));
    let renderedRequestUrl: string | null = null;
    const renderPage = vi.fn((renderedRequest: Request) => {
      renderedRequestUrl = renderedRequest.url;
      return new Response('{"pageProps":{"query":"search"}}', {
        headers: { "content-type": "application/json" },
      });
    });
    const pagesDataRequest = new Request(
      "http://localhost/_next/data/build-id/pages-dir/search.json?query=search",
    );
    const request = new Request("http://localhost/pages-dir/search?query=search");

    const response = await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        pagesDataRequest,
        request,
        url: new URL(request.url),
      },
      {
        ...defaultDeps,
        loadPagesEntry: () => ({ matchPageRoute, renderPage }),
      },
    );

    expect(matchPageRoute).toHaveBeenCalledWith("/pages-dir/search?query=search", request);
    expect(renderedRequestUrl).toBe(pagesDataRequest.url);
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/pages-dir/search?query=search",
      {},
      undefined,
      null,
    );
    expect(response?.headers.get("content-type")).toContain("application/json");
  });

  it("preserves header-recognized Pages data intent after URL normalization", async () => {
    const renderPage = vi.fn(
      () =>
        new Response('{"pageProps":{"query":"search"}}', {
          headers: { "content-type": "application/json" },
        }),
    );
    const request = new Request("http://localhost/pages-dir/search?query=search", {
      headers: { "x-nextjs-data": "1" },
    });

    await renderPagesFallback(
      {
        isDataRequest: true,
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        request,
        url: new URL(request.url),
      },
      { ...defaultDeps, loadPagesEntry: () => ({ renderPage }) },
    );

    expect(renderPage).toHaveBeenCalledWith(
      request,
      "/pages-dir/search?query=search",
      {},
      undefined,
      null,
      { isDataReq: true },
    );
  });

  it("forwards the basePath-stripped Pages data request after App pipeline normalization", async () => {
    const matchPageRoute = vi.fn(() => ({
      route: { isDynamic: false, pattern: "/pages-dir/search" },
    }));
    let renderedRequestUrl: string | null = null;
    const renderPage = vi.fn((renderedRequest: Request) => {
      renderedRequestUrl = renderedRequest.url;
      return new Response("data");
    });
    const pagesDataRequest = new Request(
      "http://localhost/_next/data/build-id/pages-dir/search.json?query=search",
    );
    const request = new Request("http://localhost/pages-dir/search?query=search");

    await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        pagesDataRequest,
        request,
        url: new URL(request.url),
      },
      {
        ...defaultDeps,
        loadPagesEntry: () => ({ matchPageRoute, renderPage }),
      },
    );

    expect(matchPageRoute).toHaveBeenCalledWith("/pages-dir/search?query=search", request);
    expect(renderedRequestUrl).toBe(
      "http://localhost/_next/data/build-id/pages-dir/search.json?query=search",
    );
    expect(renderPage).toHaveBeenCalledWith(
      expect.any(Request),
      "/pages-dir/search?query=search",
      {},
      undefined,
      null,
    );
  });

  it("applies middleware request headers to Pages data renders", async () => {
    let renderedHeader: string | null = null;
    let renderedCf: unknown;
    const renderPage = vi.fn((renderedRequest: Request) => {
      renderedHeader = renderedRequest.headers.get("x-middleware");
      renderedCf = (renderedRequest as Request & { cf?: unknown }).cf;
      return new Response("data");
    });
    const pagesDataRequest = new Request(
      "http://localhost/_next/data/build-id/pages-dir/search.json?query=search",
    );
    const request = new Request("http://localhost/pages-dir/search?query=search");
    const cf = { colo: "LHR" };
    Object.defineProperty(request, "cf", { value: cf, enumerable: true });

    await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: {
          headers: null,
          requestHeaders: new Headers({ "x-middleware": "injected" }),
          status: null,
        },
        pagesDataRequest,
        request,
        url: new URL(request.url),
      },
      {
        ...defaultDeps,
        loadPagesEntry: () => ({ renderPage }),
      },
    );

    expect(renderedHeader).toBe("injected");
    expect(renderedCf).toBe(cf);
  });

  it("matches rewritten Pages data requests against the rewritten destination", async () => {
    const matchPageRoute = vi.fn(() => ({
      route: { isDynamic: false, pattern: "/rewritten-search" },
    }));
    const renderPage = vi.fn(() => new Response("rewritten"));
    const request = new Request(
      "http://localhost/_next/data/build-id/pages-dir/search.json?query=search",
    );

    const response = await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        pathname: "/rewritten-search?query=search",
        request,
        url: new URL(request.url),
      },
      {
        ...defaultDeps,
        loadPagesEntry: () => ({ matchPageRoute, renderPage }),
      },
    );

    expect(matchPageRoute).toHaveBeenCalledWith("/rewritten-search?query=search", request);
    expect(renderPage).toHaveBeenCalledWith(
      request,
      "/rewritten-search?query=search",
      {},
      undefined,
      null,
    );
    expect(await response?.text()).toBe("rewritten");
  });

  it("rebuilds request when middleware request headers are present", async () => {
    const handleApiRoute = vi.fn((_req: Request, _url: string) => new Response("api"));
    const deps = {
      ...defaultDeps,
      loadPagesEntry: () => ({ handleApiRoute }) as PagesEntry,
    };

    const request = new Request("http://localhost/api/test", {
      headers: { "x-original": "value" },
    });
    const url = new URL("http://localhost/api/test");

    const mwRequestHeaders = new Headers({ "x-middleware": "injected" });

    await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: mwRequestHeaders, status: null },
        request,
        url,
      },
      deps,
    );

    expect(handleApiRoute).toHaveBeenCalledTimes(1);
    const forwardedReq = handleApiRoute.mock.calls[0][0];
    expect(forwardedReq.headers.get("x-original")).toBe("value");
    expect(forwardedReq.headers.get("x-middleware")).toBe("injected");
  });

  it("forwards the original request unchanged when buildRequestHeaders returns null", async () => {
    const handleApiRoute = vi.fn((_req: Request, _url: string) => new Response("api"));
    const buildRequestHeaders = vi.fn((_req: Headers, _mw: Headers): Headers | null => null);
    const deps = {
      ...defaultDeps,
      buildRequestHeaders,
      loadPagesEntry: () => ({ handleApiRoute }) as PagesEntry,
    };

    const request = new Request("http://localhost/api/test", {
      headers: { "x-original": "value" },
    });
    const url = new URL("http://localhost/api/test");
    const mwRequestHeaders = new Headers({ "x-middleware": "injected" });

    await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: mwRequestHeaders, status: null },
        request,
        url,
      },
      deps,
    );

    expect(buildRequestHeaders).toHaveBeenCalledTimes(1);
    expect(handleApiRoute).toHaveBeenCalledTimes(1);
    // The original request object is forwarded as-is (not rebuilt).
    expect(handleApiRoute.mock.calls[0][0]).toBe(request);
    const forwardedReq = handleApiRoute.mock.calls[0][0];
    expect(forwardedReq.headers.get("x-original")).toBe("value");
    expect(forwardedReq.headers.get("x-middleware")).toBeNull();
  });

  it("preserves method, body, and duplex for non-GET/HEAD requests", async () => {
    const handleApiRoute = vi.fn((_req: Request, _url: string) => new Response("api"));
    const deps = {
      ...defaultDeps,
      loadPagesEntry: () => ({ handleApiRoute }) as PagesEntry,
    };

    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "x-original": "value" },
      body: "test-body",
    });
    const url = new URL("http://localhost/api/test");
    const mwRequestHeaders = new Headers({ "x-middleware": "injected" });

    await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: mwRequestHeaders, status: null },
        request,
        url,
      },
      deps,
    );

    expect(handleApiRoute).toHaveBeenCalledTimes(1);
    const forwardedReq = handleApiRoute.mock.calls[0][0];
    expect(forwardedReq.method).toBe("POST");
    expect(await forwardedReq.text()).toBe("test-body");
  });

  it("routes /api and /api/* through handleApiRoute and applies middleware context", async () => {
    const handleApiRoute = vi.fn((_req: Request, _url: string) => new Response("api-response"));
    const mwHeaders = new Headers({ "x-res-mw": "value" });
    const deps = {
      ...defaultDeps,
      loadPagesEntry: () => ({ handleApiRoute }) as PagesEntry,
    };

    const request = new Request("http://localhost/api/foo/bar");
    const url = new URL("http://localhost/api/foo/bar");

    const res = await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: mwHeaders, requestHeaders: null, status: 201 },
        request,
        url,
      },
      deps,
    );

    expect(handleApiRoute).toHaveBeenCalledTimes(1);
    expect(handleApiRoute.mock.calls[0][1]).toBe("/api/foo/bar");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    expect(res!.headers.get("x-res-mw")).toBe("value");
    expect(await res!.text()).toBe("api-response");
  });

  it("routes normal paths through renderPage and passes decoded pathname + search", async () => {
    const renderPage = vi.fn((_req: Request, _url: string) => new Response("page-response"));
    const deps = {
      ...defaultDeps,
      loadPagesEntry: () => ({ renderPage }) as PagesEntry,
    };

    const request = new Request("http://localhost/about%20us?foo=bar");
    const url = new URL("http://localhost/about%20us?foo=bar");

    const res = await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        request,
        url,
      },
      deps,
    );

    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(renderPage.mock.calls[0][1]).toBe("/about us?foo=bar");
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("page-response");
  });

  it("filters static and dynamic Pages matches by ownership phase", async () => {
    const renderPage = vi.fn(() => new Response("page"));
    const request = new Request("http://localhost/blog/hello");
    const url = new URL(request.url);
    const deps = {
      ...defaultDeps,
      loadPagesEntry: () => ({
        matchPageRoute: () => ({ route: { isDynamic: true, pattern: "/blog/:slug" } }),
        renderPage,
      }),
    };

    expect(
      await renderPagesFallback(
        {
          isRscRequest: false,
          matchKind: "static",
          middlewareContext: { headers: null, requestHeaders: null, status: null },
          request,
          url,
        },
        deps,
      ),
    ).toBeNull();
    expect(
      await renderPagesFallback(
        {
          isRscRequest: false,
          matchKind: "dynamic",
          middlewareContext: { headers: null, requestHeaders: null, status: null },
          request,
          url,
        },
        deps,
      ),
    ).not.toBeNull();
  });

  it("filters static and dynamic Pages API matches by ownership phase", async () => {
    const handleApiRoute = vi.fn(() => new Response("api"));
    const request = new Request("http://localhost/api/posts/hello");
    const url = new URL(request.url);
    const deps = {
      ...defaultDeps,
      loadPagesEntry: () => ({
        handleApiRoute,
        matchApiRoute: () => ({ route: { isDynamic: true, pattern: "/api/posts/:slug" } }),
      }),
    };

    expect(
      await renderPagesFallback(
        {
          isRscRequest: false,
          matchKind: "static",
          middlewareContext: { headers: null, requestHeaders: null, status: null },
          request,
          url,
        },
        deps,
      ),
    ).toBeNull();
    expect(handleApiRoute).not.toHaveBeenCalled();

    expect(
      await renderPagesFallback(
        {
          isRscRequest: false,
          matchKind: "dynamic",
          middlewareContext: { headers: null, requestHeaders: null, status: null },
          request,
          url,
        },
        deps,
      ),
    ).not.toBeNull();
    expect(handleApiRoute).toHaveBeenCalledTimes(1);
  });

  it("decodes rewritten page paths without decoding their query", async () => {
    const matchPageRoute = vi.fn(() => ({
      route: { isDynamic: false, pattern: "/café" },
    }));
    const renderPage = vi.fn(() => new Response("page"));
    const request = new Request("http://localhost/legacy?original=1");
    const url = new URL(request.url);

    await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        pathname: "/caf%C3%A9?value=hello%20world",
        request,
        url,
      },
      {
        ...defaultDeps,
        loadPagesEntry: () => ({ matchPageRoute, renderPage }),
      },
    );

    expect(matchPageRoute).toHaveBeenCalledWith("/café?value=hello%20world", request);
    expect(renderPage).toHaveBeenCalledWith(
      request,
      "/café?value=hello%20world",
      {},
      undefined,
      null,
    );
  });

  it("decodes rewritten API paths without decoding their query", async () => {
    const matchApiRoute = vi.fn(() => ({
      route: { isDynamic: false, pattern: "/api/café" },
    }));
    const handleApiRoute = vi.fn(() => new Response("api"));
    const request = new Request("http://localhost/api/legacy?original=1");
    const url = new URL(request.url);

    await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        pathname: "/api/caf%C3%A9?value=hello%20world",
        request,
        url,
      },
      {
        ...defaultDeps,
        loadPagesEntry: () => ({ handleApiRoute, matchApiRoute }),
      },
    );

    expect(matchApiRoute).toHaveBeenCalledWith("/api/café?value=hello%20world", request);
    expect(handleApiRoute).toHaveBeenCalledWith(
      request,
      "/api/café?value=hello%20world",
      undefined,
      "http://localhost",
    );
  });

  it("appends the middleware draft cookie to an API fallback response (#1520)", async () => {
    const handleApiRoute = vi.fn((_req: Request, _url: string) => new Response("api-response"));
    const deps = {
      ...defaultDeps,
      loadPagesEntry: () => ({ handleApiRoute }) as PagesEntry,
      getDraftModeCookieHeader: () => "__prerender_bypass=secret; Path=/; HttpOnly",
    };

    const request = new Request("http://localhost/api/draft");
    const url = new URL("http://localhost/api/draft");

    const res = await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        request,
        url,
      },
      deps,
    );

    expect(res).not.toBeNull();
    const setCookies = res!.headers.getSetCookie();
    expect(setCookies.some((c) => c.includes("__prerender_bypass"))).toBe(true);
  });

  it("does not append a draft cookie when middleware did not enable draft mode", async () => {
    const handleApiRoute = vi.fn((_req: Request, _url: string) => new Response("api-response"));
    const deps = {
      ...defaultDeps,
      loadPagesEntry: () => ({ handleApiRoute }) as PagesEntry,
      getDraftModeCookieHeader: () => null,
    };

    const res = await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        request: new Request("http://localhost/api/draft"),
        url: new URL("http://localhost/api/draft"),
      },
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.headers.has("set-cookie")).toBe(false);
  });

  it("appends the middleware draft cookie to a renderPage fallback response (#1520)", async () => {
    const renderPage = vi.fn((_req: Request, _url: string) => new Response("page-response"));
    const deps = {
      ...defaultDeps,
      loadPagesEntry: () => ({ renderPage }) as PagesEntry,
      getDraftModeCookieHeader: () => "__prerender_bypass=secret; Path=/; HttpOnly",
    };

    const res = await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        request: new Request("http://localhost/page"),
        url: new URL("http://localhost/page"),
      },
      deps,
    );

    expect(res).not.toBeNull();
    expect(res!.headers.getSetCookie().some((c) => c.includes("__prerender_bypass"))).toBe(true);
  });

  it("returns null when Pages renderPage returns 404 status", async () => {
    const renderPage = vi.fn(
      (_req: Request, _url: string) => new Response("not found", { status: 404 }),
    );
    const deps = {
      ...defaultDeps,
      loadPagesEntry: () => ({ renderPage }) as PagesEntry,
    };

    const request = new Request("http://localhost/nonexistent");
    const url = new URL("http://localhost/nonexistent");

    const res = await renderPagesFallback(
      {
        isRscRequest: false,
        middlewareContext: { headers: null, requestHeaders: null, status: null },
        request,
        url,
      },
      deps,
    );

    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(res).toBeNull();
  });
});
