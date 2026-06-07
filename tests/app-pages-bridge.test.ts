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
