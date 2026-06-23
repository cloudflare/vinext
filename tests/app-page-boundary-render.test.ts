import { describe, expect, it, vi } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import {
  renderAppPageErrorBoundary,
  renderAppPageHttpAccessFallback,
} from "../packages/vinext/src/server/app-page-boundary-render.js";
import type { AppElements } from "../packages/vinext/src/server/app-elements.js";
import type { MetadataFileRoute } from "../packages/vinext/src/server/metadata-routes.js";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { applyFileBasedMetadata } from "../packages/vinext/src/server/file-based-metadata.js";

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
    // Flat map payload — extract the route element and render it to HTML
    // (mirrors what the real SSR entry does after deserializing the Flight stream)
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

function renderWirePayloadToStream(payload: unknown): ReadableStream<Uint8Array> {
  return createStreamFromMarkup(JSON.stringify(payload));
}

function createCommonOptions() {
  const clearRequestContext = vi.fn();
  const loadSsrHandler = vi.fn(async () => ({
    async handleSsr(rscStream: ReadableStream<Uint8Array>) {
      return rscStream;
    },
  }));

  return {
    applyFileBasedMetadata,
    buildFontLinkHeader(preloads: readonly { href: string; type: string }[] | null | undefined) {
      if (!preloads || preloads.length === 0) {
        return "";
      }
      return preloads.map((preload) => `<${preload.href}>; rel=preload`).join(", ");
    },
    clearRequestContext,
    createRscOnErrorHandler() {
      return () => null;
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
    getNavigationContext() {
      return { pathname: "/posts/missing", searchParams: new URLSearchParams(), params: {} };
    },
    isRscRequest: false,
    loadSsrHandler,
    makeThenableParams<T>(params: T) {
      return params;
    },
    middlewareContext: {
      headers: null,
      status: null,
    },
    metadataRoutes: [],
    renderToReadableStream: renderElementToStream,
    requestUrl: "https://example.com/posts/missing",
    resolveChildSegments() {
      return [];
    },
    rootLayouts: EMPTY_ROOT_LAYOUTS,
  };
}

function createMiddlewareContext() {
  const headers = new Headers();
  headers.set("x-middleware-security", "present");
  headers.append("set-cookie", "session=rotated; Path=/; HttpOnly");
  headers.set("vary", "x-auth-state");

  return {
    headers,
    status: 299,
  };
}

function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { slug?: string };
}) {
  return React.createElement("div", { "data-layout": "root", "data-slug": params.slug }, children);
}

function LeafLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { slug?: string };
}) {
  return React.createElement(
    "section",
    { "data-layout": "leaf", "data-slug": params.slug },
    children,
  );
}

function NotFoundBoundary() {
  return React.createElement("p", { "data-boundary": "not-found" }, "Missing page");
}

function RouteErrorBoundary({ error }: { error: Error }) {
  return React.createElement("p", { "data-boundary": "route-error" }, `route:${error.message}`);
}

function GlobalErrorBoundary({ error }: { error: Error }) {
  return React.createElement("p", { "data-boundary": "global-error" }, `global:${error.message}`);
}

function GlobalErrorBoundaryWithStack({ error }: { error: Error }) {
  return React.createElement("p", { "data-boundary": "global-error" }, error.stack);
}

type TestModule = {
  default: React.ComponentType<any>;
  metadata?: { description?: string; title?: string };
  viewport?: { themeColor: string };
};

const rootLayoutModule = {
  default: RootLayout,
  metadata: { description: "Root layout description" },
  viewport: { themeColor: "#111111" },
} satisfies TestModule;

const leafLayoutModule = {
  default: LeafLayout,
} satisfies TestModule;

const notFoundModule = {
  default: NotFoundBoundary,
} satisfies TestModule;

const notFoundModuleWithMetadata = {
  default: NotFoundBoundary,
  metadata: { title: "notfound title" },
} satisfies TestModule;

const routeErrorModule = {
  default: RouteErrorBoundary,
} satisfies TestModule;

const globalErrorModule = {
  default: GlobalErrorBoundary,
} satisfies TestModule;

const globalErrorModuleWithStack = {
  default: GlobalErrorBoundaryWithStack,
} satisfies TestModule;

function ThrowingGlobalErrorBoundary(): React.ReactNode {
  throw new Error("global-error boom");
}

const throwingGlobalErrorModule = {
  default: ThrowingGlobalErrorBoundary,
} satisfies TestModule;

function SignalThrowingGlobalErrorBoundary(): React.ReactNode {
  // Mimics notFound() called from inside global-error: a navigation signal that
  // must propagate rather than being degraded to a built-in 200.
  const signal = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  throw signal;
}

const signalThrowingGlobalErrorModule = {
  default: SignalThrowingGlobalErrorBoundary,
} satisfies TestModule;

const EMPTY_ROOT_LAYOUTS: readonly TestModule[] = [];

describe("app page boundary render helpers", () => {
  it("returns null when no HTTP access fallback boundary exists", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      route: {
        pattern: "/posts/[slug]",
        params: { slug: "missing" },
      },
      statusCode: 404,
    });

    expect(response).toBeNull();
    expect(common.loadSsrHandler).not.toHaveBeenCalled();
    expect(common.clearRequestContext).not.toHaveBeenCalled();
  });

  it("renders HTTP access fallbacks with layout metadata and wrapped HTML", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      rootLayouts: [rootLayoutModule],
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(common.loadSsrHandler).toHaveBeenCalledTimes(1);
    expect(response?.status).toBe(404);
    expect(response?.headers.get("link")).toContain("/font.woff2");

    const html = await response?.text();
    expect(common.clearRequestContext).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-layout="leaf"');
    expect(html).toContain('data-boundary="not-found"');
    expect(html).toContain('content="Root layout description"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="theme-color" content="#111111"');
    expect(html).toContain('name="robots"');
    expect(html).toContain('content="noindex"');
  });

  it("renders not-found boundary metadata exactly once for HTTP access fallbacks", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    //   "should not duplicate metadata with navigation API"
    //
    // The upstream fixture calls notFound() from generateMetadata() and expects
    // the rendered not-found boundary's metadata (`not-found.tsx` static
    // metadata) to produce a single title in the document.
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      rootLayouts: [rootLayoutModule],
      route: {
        layoutTreePositions: [0],
        layouts: [rootLayoutModule],
        notFound: notFoundModuleWithMetadata,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);

    const html = await response?.text();
    expect(html?.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>notfound title</title>");
  });

  it("does not inject child route file metadata into layout-level HTTP access fallbacks", async () => {
    const common = createCommonOptions();
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: false,
        filePath: "/tmp/app/posts/[slug]/opengraph-image.png",
        routePrefix: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
        servedUrl: "/posts/-/opengraph-image.png",
        contentType: "image/png",
        headData: {
          kind: "openGraph",
          href: "/posts/-/opengraph-image.png?hash",
          type: "image/png",
          width: 1200,
          height: 630,
        },
      },
    ];

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      layoutModules: [rootLayoutModule],
      matchedParams: { slug: "missing" },
      metadataRoutes,
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);

    const html = await response?.text();
    expect(html).toContain('content="Root layout description"');
    expect(html).not.toContain("opengraph-image");
  });

  it("preserves middleware headers on HTTP access fallback HTML responses", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      middlewareContext: createMiddlewareContext(),
      route: {
        layouts: [rootLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-middleware-security")).toBe("present");
    expect(response?.headers.get("vary")).toBe(`${VINEXT_RSC_VARY_HEADER}, x-auth-state`);
    expect(response?.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
  });

  it("renders HTTP access fallback RSC responses as flat payloads", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      rootLayouts: [rootLayoutModule],
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    expect(response?.headers.get("Content-Type")).toBe("text/x-component");

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__route).toBe("route:/posts/missing");
    expect(payload.__layoutIds).toEqual(["layout:/", "layout:/posts"]);
    expect(payload.__rootLayout).toBe("/");
    expect(payload.__sourcePage).toBe("/posts/[slug]/page");
    expect(payload["route:/posts/missing"]).toBeTruthy();
  });

  it("derives HTTP access fallback layout metadata from the rendered layout subset", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      layoutModules: [rootLayoutModule],
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__layoutIds).toEqual(["layout:/"]);
    expect(payload.__rootLayout).toBe("/");
    expect(payload["route:/posts/missing"]).toBeTruthy();
  });

  it("uses unknown root metadata when no route layout is rendered for an HTTP access fallback", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      layoutModules: [],
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__layoutIds).toEqual([]);
    expect(payload.__rootLayout).toBeNull();
    expect(payload["route:/posts/missing"]).toBeTruthy();
  });

  it("preserves middleware headers on HTTP access fallback RSC responses", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      matchedParams: { slug: "missing" },
      middlewareContext: createMiddlewareContext(),
      renderToReadableStream: renderWirePayloadToStream,
      route: {
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-middleware-security")).toBe("present");
    expect(response?.headers.get("vary")).toBe(`${VINEXT_RSC_VARY_HEADER}, x-auth-state`);
    expect(response?.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
  });

  it("uses null root layout metadata when a boundary payload has no route context", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      boundaryComponent: NotFoundBoundary,
      isRscRequest: true,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      rootLayouts: [rootLayoutModule],
      route: null,
      statusCode: 404,
    });

    expect(response?.status).toBe(404);

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__route).toBe("route:/posts/missing");
    expect(payload.__layoutIds).toEqual([]);
    expect(payload.__rootLayout).toBeNull();
    expect(payload.__sourcePage).toBeUndefined();
    expect(payload["route:/posts/missing"]).toBeTruthy();
  });

  it("omits source-page metadata when route segments are unavailable", async () => {
    const common = createCommonOptions();
    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      matchedParams: {},
      renderToReadableStream: renderWirePayloadToStream,
      route: {
        notFound: notFoundModule,
        pattern: "/posts/missing",
      },
      statusCode: 404,
    });

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__sourcePage).toBeUndefined();
  });

  it("renders route error boundaries with sanitized errors inside layouts", async () => {
    const common = createCommonOptions();
    const sanitizeErrorForClient = vi.fn((error: Error) => new Error(`safe:${error.message}`));

    const response = await renderAppPageErrorBoundary<TestModule>({
      ...common,
      error: new Error("secret"),
      matchedParams: { slug: "post" },
      route: {
        error: routeErrorModule,
        layouts: [rootLayoutModule],
        params: { slug: "post" },
        pattern: "/posts/[slug]",
      },
      sanitizeErrorForClient,
    });

    expect(response?.status).toBe(200);
    expect(sanitizeErrorForClient).toHaveBeenCalledTimes(1);

    const html = await response?.text();
    expect(common.clearRequestContext).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-boundary="route-error"');
    expect(html).toContain("route:safe:secret");
  });

  it("does not serialize production SSR stacks into the global error payload", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const common = createCommonOptions();
    const error = new Error("client page error");
    error.stack = "/private/deployment/server.js:42";

    try {
      const response = await renderAppPageErrorBoundary<TestModule>({
        ...common,
        error,
        errorOrigin: "ssr",
        globalErrorModule,
        sanitizeErrorForClient(value: Error) {
          return value;
        },
      });

      const html = await response?.text();
      expect(html).toContain("client page error");
      expect(html).not.toContain("/private/deployment/server.js:42");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves development RSC stacks in the global error payload", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const common = createCommonOptions();
    const error = Object.assign(new Error("server page error"), {
      digest: "12345",
      stack: "/app/rsc/page.tsx:2",
    });

    try {
      const response = await renderAppPageErrorBoundary<TestModule>({
        ...common,
        error,
        errorOrigin: "rsc",
        globalErrorModule: globalErrorModuleWithStack,
        sanitizeErrorForClient(value: Error) {
          return value;
        },
      });

      const html = await response?.text();
      expect(html).toContain("/app/rsc/page.tsx:2");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves middleware headers on error boundary responses", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageErrorBoundary<TestModule>({
      ...common,
      error: new Error("secret"),
      matchedParams: { slug: "post" },
      middlewareContext: createMiddlewareContext(),
      route: {
        error: routeErrorModule,
        params: { slug: "post" },
        pattern: "/posts/[slug]",
      },
      sanitizeErrorForClient(error: Error) {
        return error;
      },
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-middleware-security")).toBe("present");
    expect(response?.headers.get("vary")).toBe(`${VINEXT_RSC_VARY_HEADER}, x-auth-state`);
    expect(response?.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
  });

  it("renders error boundaries when dynamic file metadata resolution fails", async () => {
    const error = new Error("metadata boom");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const common = createCommonOptions();
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: true,
        filePath: "/tmp/app/posts/[slug]/opengraph-image.tsx",
        routePrefix: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
        servedUrl: "/posts/[slug]/opengraph-image",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          generateImageMetadata() {
            throw error;
          },
        },
      },
    ];

    try {
      const response = await renderAppPageErrorBoundary<TestModule>({
        ...common,
        error: new Error("secret"),
        matchedParams: { slug: "post" },
        metadataRoutes,
        route: {
          error: routeErrorModule,
          layoutTreePositions: [0],
          layouts: [rootLayoutModule],
          params: { slug: "post" },
          pattern: "/posts/[slug]",
          routeSegments: ["posts", "[slug]"],
        },
        sanitizeErrorForClient(error: Error) {
          return error;
        },
      });

      expect(response?.status).toBe(200);
      expect(consoleError).toHaveBeenCalledWith(
        "[vinext] File-based metadata resolution failed while rendering error boundary for /posts/[slug]:",
        error,
      );

      const html = await response?.text();
      expect(html).toContain('data-boundary="route-error"');
      expect(html).toContain("route:secret");
      expect(html).toContain('content="Root layout description"');
      expect(html).not.toContain("opengraph-image");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("renders error boundary RSC responses as flat payloads", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageErrorBoundary<TestModule>({
      ...common,
      error: new Error("secret"),
      isRscRequest: true,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      route: {
        error: routeErrorModule,
        layoutTreePositions: [0],
        layouts: [rootLayoutModule],
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      sanitizeErrorForClient(error: Error) {
        return new Error(`safe:${error.message}`);
      },
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("text/x-component");

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__route).toBe("route:/posts/missing");
    expect(payload.__layoutIds).toEqual(["layout:/"]);
    expect(payload.__rootLayout).toBe("/");
    expect(payload.__sourcePage).toBe("/posts/[slug]/page");
    expect(payload["route:/posts/missing"]).toBeTruthy();
  });

  it("renders global-error boundaries without layout wrapping", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageErrorBoundary<TestModule>({
      ...common,
      error: new Error("boom"),
      globalErrorModule,
      matchedParams: { slug: "post" },
      route: {
        layouts: [rootLayoutModule],
        params: { slug: "post" },
        pattern: "/posts/[slug]",
      },
      sanitizeErrorForClient(error: Error) {
        return error;
      },
    });

    expect(response?.status).toBe(500);
    expect(response?.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );

    const html = await response?.text();
    expect(html).toContain('data-boundary="global-error"');
    expect(html).toContain("global:boom");
    expect(html).not.toContain('data-layout="root"');
    expect(html).not.toContain("Root layout description");
    expect(html).not.toContain('name="viewport"');
  });

  it("falls back to the built-in default global-error when the user's global-error throws", async () => {
    // When the resolved global-error boundary itself throws while rendering, the
    // SSR render rejects; renderAppPageErrorBoundary catches it and re-renders
    // with the built-in default global-error so the request still produces a
    // usable error document with the original HTTP 500 semantics. Locks in the server-side
    // retry directly (the integration test in tests/nextjs-compat/global-error
    // exercises the same path through the dev/preview server). Fixes #1548.
    const common = createCommonOptions();

    const response = await renderAppPageErrorBoundary<TestModule>({
      ...common,
      error: new Error("boom"),
      globalErrorModule: throwingGlobalErrorModule,
      matchedParams: { slug: "post" },
      route: {
        layouts: [rootLayoutModule],
        params: { slug: "post" },
        pattern: "/posts/[slug]",
      },
      sanitizeErrorForClient(error: Error) {
        return error;
      },
    });

    expect(response?.status).toBe(500);
    expect(response?.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );

    const html = await response?.text();
    // The built-in default global-error UI from
    // packages/vinext/src/shims/default-global-error.tsx.
    expect(html).toContain("This page couldn");
    // The user's throwing boundary contributed no markup.
    expect(html).not.toContain("global-error boom");
  });

  it("re-throws navigation signals from a throwing global-error instead of degrading to the built-in fallback", async () => {
    // A redirect()/notFound() thrown from inside global-error must propagate,
    // not be swallowed into a built-in default 200.
    const common = createCommonOptions();

    await expect(
      renderAppPageErrorBoundary<TestModule>({
        ...common,
        error: new Error("boom"),
        globalErrorModule: signalThrowingGlobalErrorModule,
        matchedParams: { slug: "post" },
        route: {
          layouts: [rootLayoutModule],
          params: { slug: "post" },
          pattern: "/posts/[slug]",
        },
        sanitizeErrorForClient(error: Error) {
          return error;
        },
      }),
    ).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
  });
});
