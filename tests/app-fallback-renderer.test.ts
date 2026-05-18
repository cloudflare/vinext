import { describe, expect, it, vi } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { createAppFallbackRenderer } from "../packages/vinext/src/server/app-fallback-renderer.js";
import type { AppElements } from "../packages/vinext/src/server/app-elements.js";

function createStreamFromMarkup(markup: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(markup));
      controller.close();
    },
  });
}

function renderElementToStream(element: React.ReactNode | AppElements): ReadableStream<Uint8Array> {
  if (element !== null && typeof element === "object" && !React.isValidElement(element)) {
    const record = element as Record<string, unknown>;
    const routeId = record.__route;
    if (typeof routeId === "string" && React.isValidElement(record[routeId])) {
      return createStreamFromMarkup(
        ReactDOMServer.renderToStaticMarkup(record[routeId] as React.ReactNode),
      );
    }
    return createStreamFromMarkup(JSON.stringify(element));
  }
  return createStreamFromMarkup(ReactDOMServer.renderToStaticMarkup(element));
}

function createRenderer(overrides?: {
  createRscOnErrorHandler?: (
    request: Request,
    pathname: string,
    routePath: string,
  ) => (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown;
  sanitizeErrorForClient?: (error: Error) => Error;
  globalNotFoundModule?: { default: React.ComponentType<any> } | null;
  rootLayoutModules?: readonly ({ default: React.ComponentType<any> } | null | undefined)[];
  rootNotFoundModule?: { default: React.ComponentType<any> } | null;
}) {
  const clearRequestContext = vi.fn();
  const ssrLoader = vi.fn(async () => ({
    async handleSsr(rscStream: ReadableStream<Uint8Array>) {
      return rscStream;
    },
  }));

  return {
    clearRequestContext,
    renderer: createAppFallbackRenderer({
      clearRequestContext,
      createRscOnErrorHandler: overrides?.createRscOnErrorHandler ?? (() => () => null),
      fontProviders: {
        buildFontLinkHeader(
          preloads: readonly { href: string; type: string }[] | null | undefined,
        ) {
          if (!preloads || preloads.length === 0) return "";
          return preloads.map((p) => `<${p.href}>; rel=preload`).join(", ");
        },
        getFontLinks() {
          return ["/styles.css"];
        },
        getFontPreloads() {
          return [{ href: "/font.woff2", type: "font/woff2" }];
        },
        getFontStyles() {
          return [".font { font-family: Test; }"];
        },
      },
      getNavigationContext() {
        return { pathname: "/posts/missing" };
      },
      globalErrorModule: null,
      globalNotFoundModule: overrides?.globalNotFoundModule ?? null,
      makeThenableParams<T>(params: T) {
        return params;
      },
      metadataRoutes: [],
      resolveChildSegments() {
        return [];
      },
      rootBoundaries: {
        rootForbiddenModule: null,
        rootLayouts: overrides?.rootLayoutModules ?? [],
        rootNotFoundModule: overrides?.rootNotFoundModule ?? null,
        rootUnauthorizedModule: null,
      },
      rscRenderer: renderElementToStream,
      sanitizer: overrides?.sanitizeErrorForClient ?? ((error: Error) => error),
      ssrLoader,
    }),
    ssrLoader,
  };
}

function NotFoundBoundary() {
  return React.createElement("p", { "data-boundary": "not-found" }, "Missing page");
}

function RouteErrorBoundary({ error }: { error: Error }) {
  return React.createElement("p", { "data-boundary": "route-error" }, `route:${error.message}`);
}

function ParamsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { slug?: string };
}) {
  return React.createElement("div", { "data-params-slug": params.slug ?? "none" }, children);
}

function OverrideLayout({ children }: { children: React.ReactNode }) {
  return React.createElement("div", { "data-layout": "override" }, children);
}

type TestModule = {
  default: React.ComponentType<any>;
};

const notFoundModule = { default: NotFoundBoundary } satisfies TestModule;
const routeErrorModule = { default: RouteErrorBoundary } satisfies TestModule;
const paramsLayoutModule = { default: ParamsLayout } satisfies TestModule;
const overrideLayoutModule = { default: OverrideLayout } satisfies TestModule;

describe("app fallback renderer factory", () => {
  it("constructs once and passes request at call site", async () => {
    const { renderer } = createRenderer();
    const requestA = new Request("https://example.com/a");
    const requestB = new Request("https://example.com/b");

    // Both calls succeed with different requests — proves request is not
    // captured in the factory closure but passed per-call.
    const responseA = await renderer.renderNotFound(
      {
        notFound: notFoundModule,
        params: {},
        pattern: "/a",
      },
      false,
      requestA,
      undefined,
      undefined,
      { headers: null, status: null },
    );
    const responseB = await renderer.renderNotFound(
      {
        notFound: notFoundModule,
        params: {},
        pattern: "/b",
      },
      false,
      requestB,
      undefined,
      undefined,
      { headers: null, status: null },
    );

    expect(responseA?.status).toBe(404);
    expect(responseB?.status).toBe(404);
  });

  it("delegates renderNotFound to renderHttpAccessFallback with status 404", async () => {
    const { renderer, ssrLoader } = createRenderer();
    const request = new Request("https://example.com/posts/missing");

    const response = await renderer.renderNotFound(
      {
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
      },
      false,
      request,
      { slug: "missing" },
      undefined,
      { headers: null, status: null },
    );

    expect(response?.status).toBe(404);
    expect(ssrLoader).toHaveBeenCalledTimes(1);

    const html = await response?.text();
    expect(html).toContain('data-boundary="not-found"');
  });

  it("renders error boundaries with sanitized errors", async () => {
    const sanitizer = vi.fn((error: Error) => new Error(`safe:${error.message}`));
    const { renderer, ssrLoader, clearRequestContext } = createRenderer({
      sanitizeErrorForClient: sanitizer,
    });
    const request = new Request("https://example.com/posts/boom");

    const response = await renderer.renderErrorBoundary(
      {
        error: routeErrorModule,
        layouts: [],
        params: { slug: "boom" },
        pattern: "/posts/[slug]",
      },
      new Error("secret"),
      false,
      request,
      { slug: "boom" },
      undefined,
      { headers: null, status: null },
    );

    expect(response?.status).toBe(200);
    expect(sanitizer).toHaveBeenCalledTimes(1);
    expect(ssrLoader).toHaveBeenCalledTimes(1);

    const html = await response?.text();
    // clearRequestContext is deferred until the stream is consumed.
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-boundary="route-error"');
    expect(html).toContain("route:safe:secret");
  });

  it("passes request to createRscOnErrorHandler at call time", async () => {
    const createRscOnErrorHandler = vi.fn(
      (_request: Request, _pathname: string, _routePath: string) => () => null,
    );
    const { renderer } = createRenderer({ createRscOnErrorHandler });
    const request = new Request("https://example.com/posts/boom");

    await renderer.renderErrorBoundary(
      {
        error: routeErrorModule,
        layouts: [],
        params: { slug: "boom" },
        pattern: "/posts/[slug]",
      },
      new Error("boom"),
      false,
      request,
      { slug: "boom" },
      undefined,
      { headers: null, status: null },
    );

    expect(createRscOnErrorHandler).toHaveBeenCalledTimes(1);
    expect(createRscOnErrorHandler).toHaveBeenCalledWith(request, "/posts/boom", "/posts/[slug]");
  });

  it("uses empty middleware context when none is provided", async () => {
    const { renderer } = createRenderer();
    const request = new Request("https://example.com/posts/missing");

    // Pass undefined middlewareContext — factory should fall back to empty.
    const response = await renderer.renderNotFound(
      {
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
      },
      false,
      request,
      { slug: "missing" },
      undefined,
      undefined as unknown as { headers: null; status: null },
    );

    expect(response?.status).toBe(404);
  });

  it("falls back matchedParams to route.params when not provided", async () => {
    const { renderer } = createRenderer();
    const request = new Request("https://example.com/posts/missing");

    // Call without matchedParams in opts — factory should fall back to route.params.
    // Provide routeSegments + layoutTreePositions so the layout receives the slug param.
    const response = await renderer.renderHttpAccessFallback(
      {
        layouts: [paramsLayoutModule],
        layoutTreePositions: [1],
        notFound: notFoundModule,
        params: { slug: "from-route" },
        pattern: "/[slug]",
        routeSegments: ["[slug]"],
      },
      404,
      false,
      request,
      {}, // no matchedParams, no boundaryComponent override
      undefined,
      { headers: null, status: null },
    );

    const html = await response?.text();
    expect(html).toContain('data-params-slug="from-route"');
    expect(html).toContain('data-boundary="not-found"');
  });

  it("uses opts.layouts override instead of route.layouts", async () => {
    const { renderer } = createRenderer();
    const request = new Request("https://example.com/posts/missing");

    const response = await renderer.renderHttpAccessFallback(
      {
        layouts: [paramsLayoutModule], // route layout — should NOT appear
        layoutTreePositions: [1],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/[slug]",
        routeSegments: ["[slug]"],
      },
      404,
      false,
      request,
      {
        layouts: [overrideLayoutModule], // override — SHOULD appear
        matchedParams: { slug: "missing" },
      },
      undefined,
      { headers: null, status: null },
    );

    const html = await response?.text();
    expect(html).toContain('data-layout="override"');
    expect(html).not.toContain("data-params-slug");
    expect(html).toContain('data-boundary="not-found"');
  });
});

// Mirrors Next.js 16 experimental.globalNotFound behavior.
// Ported from Next.js: test/e2e/app-dir/global-not-found/{basic,both-present,not-present}.
// Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found
// In Next.js, `app/global-not-found.tsx` replaces the root layout for
// route-miss 404s — see createNotFoundLoaderTree in
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx#L495-L520
describe("app fallback renderer with globalNotFoundModule", () => {
  function RootLayout({ children }: { children: React.ReactNode }) {
    return React.createElement("html", { lang: "en" }, React.createElement("body", null, children));
  }
  const rootLayoutModule = { default: RootLayout } satisfies TestModule;

  function GlobalNotFound() {
    return React.createElement(
      "html",
      { "data-global-not-found": "true" },
      React.createElement(
        "body",
        null,
        React.createElement("h1", { id: "global-error-title" }, "global-not-found"),
      ),
    );
  }
  const globalNotFoundModule = { default: GlobalNotFound } satisfies TestModule;

  it("renders global-not-found for route-miss 404 without root layout wrapping", async () => {
    // Mirrors test/e2e/app-dir/global-not-found/basic:
    //   visiting /does-not-exist should produce global-not-found's own
    //   <html data-global-not-found="true"> document, not the root layout's.
    const { renderer } = createRenderer({
      globalNotFoundModule,
      rootLayoutModules: [rootLayoutModule],
    });
    const request = new Request("https://example.com/does-not-exist");

    // route = null mirrors the route-miss path in app-rsc-handler.ts:504.
    const response = await renderer.renderNotFound(null, false, request, undefined, undefined, {
      headers: null,
      status: null,
    });

    expect(response?.status).toBe(404);
    const html = await response?.text();
    expect(html).toContain('data-global-not-found="true"');
    expect(html).toContain('id="global-error-title"');
    expect(html).toContain("global-not-found");
    // Root layout was NOT applied — it would have rendered <html lang="en">.
    expect(html).not.toContain('lang="en"');
  });

  it("uses the route's not-found.tsx boundary when notFound() is called from a page", async () => {
    // Mirrors test/e2e/app-dir/global-not-found/basic, /call-not-found case:
    //   when notFound() is called inside a matched page, the regular
    //   not-found.tsx boundary should render inside the root layout, NOT the
    //   global-not-found.tsx document.
    const { renderer } = createRenderer({
      globalNotFoundModule,
      rootLayoutModules: [rootLayoutModule],
      rootNotFoundModule: notFoundModule,
    });
    const request = new Request("https://example.com/call-not-found");

    // route is non-null: simulates a matched page that called notFound().
    const response = await renderer.renderNotFound(
      {
        layouts: [rootLayoutModule],
        notFound: notFoundModule,
        params: {},
        pattern: "/call-not-found",
      },
      false,
      request,
      undefined,
      undefined,
      { headers: null, status: null },
    );

    expect(response?.status).toBe(404);
    const html = await response?.text();
    // Should render the regular not-found boundary inside the root layout.
    expect(html).toContain('data-boundary="not-found"');
    expect(html).toContain('lang="en"');
    // Should NOT render the global-not-found document.
    expect(html).not.toContain('data-global-not-found="true"');
  });

  it("falls back to default not-found when global-not-found is absent and route is null", async () => {
    // Mirrors test/e2e/app-dir/global-not-found/not-present: when the user
    // opted into experimental.globalNotFound but never created the file,
    // route-miss 404s should still serve the default 404 response. With no
    // root notFoundModule either, the renderer returns null and the caller
    // falls back to the framework's 404 Response.
    const { renderer } = createRenderer({
      globalNotFoundModule: null,
      rootLayoutModules: [rootLayoutModule],
    });
    const request = new Request("https://example.com/does-not-exist");

    const response = await renderer.renderNotFound(null, false, request, undefined, undefined, {
      headers: null,
      status: null,
    });

    // No boundary component to render -> renderer returns null.
    expect(response).toBeNull();
  });

  it("does not use global-not-found for non-404 access fallbacks (403, 401)", async () => {
    // global-not-found only applies to 404. Other HTTP access fallbacks
    // (forbidden / unauthorized) keep their normal behavior.
    function ForbiddenBoundary() {
      return React.createElement("p", { "data-boundary": "forbidden" }, "Forbidden");
    }
    const forbiddenModule = { default: ForbiddenBoundary } satisfies TestModule;

    const { renderer } = createRenderer({
      globalNotFoundModule,
      rootLayoutModules: [rootLayoutModule],
    });
    const request = new Request("https://example.com/admin");

    // statusCode 403 with route = null. Should NOT trigger global-not-found.
    // With no boundary configured, the renderer returns null.
    const response = await renderer.renderHttpAccessFallback(
      null,
      403,
      false,
      request,
      { boundaryComponent: forbiddenModule.default },
      undefined,
      { headers: null, status: null },
    );

    expect(response?.status).toBe(403);
    const html = await response?.text();
    expect(html).toContain('data-boundary="forbidden"');
    // 403 wraps in the root layout (not global-not-found).
    expect(html).toContain('lang="en"');
    expect(html).not.toContain('data-global-not-found="true"');
  });
});
