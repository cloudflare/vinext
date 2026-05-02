import { describe, expect, it, vi } from "vite-plus/test";
import {
  renderAppPageBoundaryResponse,
  resolveAppPageErrorBoundary,
  resolveAppPageHttpAccessBoundaryComponent,
  resolveAppPageParentHttpAccessBoundaryModule,
  wrapAppPageBoundaryElement,
} from "../packages/vinext/src/server/app-page-boundary.js";

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

describe("app page boundary helpers", () => {
  it("prefers route-specific HTTP access boundaries over root fallbacks", () => {
    const component = resolveAppPageHttpAccessBoundaryComponent({
      getDefaultExport(boundaryModule) {
        return boundaryModule?.default ?? null;
      },
      rootForbiddenModule: { default: "RootForbidden" },
      rootNotFoundModule: { default: "RootNotFound" },
      rootUnauthorizedModule: { default: "RootUnauthorized" },
      routeForbiddenModule: { default: "RouteForbidden" },
      routeNotFoundModule: { default: "RouteNotFound" },
      routeUnauthorizedModule: { default: "RouteUnauthorized" },
      statusCode: 403,
    });

    expect(component).toBe("RouteForbidden");
  });

  it("falls back to the root not-found boundary when the route has none", () => {
    const component = resolveAppPageHttpAccessBoundaryComponent({
      getDefaultExport(boundaryModule) {
        return boundaryModule?.default ?? null;
      },
      rootNotFoundModule: { default: "RootNotFound" },
      statusCode: 404,
    });

    expect(component).toBe("RootNotFound");
  });

  it("selects the matching parent HTTP access boundary for layout throws", () => {
    expect(
      resolveAppPageParentHttpAccessBoundaryModule({
        layoutIndex: 2,
        rootForbiddenModule: "RootForbidden",
        routeForbiddenModules: [null, "ParentForbidden", "ThrowingLayoutForbidden"],
        routeNotFoundModules: [null, "ParentNotFound"],
        statusCode: 403,
      }),
    ).toBe("ParentForbidden");

    expect(
      resolveAppPageParentHttpAccessBoundaryModule({
        layoutIndex: 2,
        rootUnauthorizedModule: "RootUnauthorized",
        routeNotFoundModules: [null, "ParentNotFound"],
        routeUnauthorizedModules: [null, undefined, "ThrowingLayoutUnauthorized"],
        statusCode: 401,
      }),
    ).toBe("RootUnauthorized");
  });

  it("resolves page, layout, and global error boundaries in order", () => {
    expect(
      resolveAppPageErrorBoundary({
        getDefaultExport(errorModule) {
          return errorModule?.default ?? null;
        },
        layoutErrorModules: [{ default: "RootLayoutError" }, { default: "LeafLayoutError" }],
        pageErrorModule: { default: "PageError" },
      }),
    ).toEqual({
      component: "PageError",
      isGlobalError: false,
    });

    expect(
      resolveAppPageErrorBoundary({
        getDefaultExport(errorModule) {
          return errorModule?.default ?? null;
        },
        globalErrorModule: { default: "GlobalError" },
        layoutErrorModules: [{ default: "RootLayoutError" }, { default: "LeafLayoutError" }],
        pageErrorModule: null,
      }),
    ).toEqual({
      component: "LeafLayoutError",
      isGlobalError: false,
    });

    expect(
      resolveAppPageErrorBoundary({
        getDefaultExport(errorModule) {
          return errorModule?.default ?? null;
        },
        globalErrorModule: { default: "GlobalError" },
        layoutErrorModules: [null, undefined],
        pageErrorModule: null,
      }),
    ).toEqual({
      component: "GlobalError",
      isGlobalError: true,
    });
  });

  it("wraps boundary elements with layouts, segment providers, and the global boundary for RSC", () => {
    const wrapped = wrapAppPageBoundaryElement({
      element: "Boundary",
      getDefaultExport(layoutModule) {
        return layoutModule?.default ?? null;
      },
      globalErrorComponent: "GlobalError",
      includeGlobalErrorBoundary: true,
      isRscRequest: true,
      layoutModules: [{ default: "RootLayout" }, { default: "LeafLayout" }],
      layoutTreePositions: [0, 1],
      makeThenableParams(params) {
        return { ...params, thenable: true };
      },
      matchedParams: { slug: "post" },
      renderErrorBoundary(component, children) {
        return `ErrorBoundary(${component})[${children}]`;
      },
      renderLayout(component, children, params) {
        return `Layout(${component})[${children}|${JSON.stringify(params)}]`;
      },
      renderLayoutSegmentProvider(segmentMap, children) {
        return `Segment(${String(segmentMap.children)})[${children}]`;
      },
      resolveChildSegments(routeSegments, treePosition, params) {
        const slug = Array.isArray(params.slug) ? params.slug.join("/") : params.slug;
        return `${routeSegments[treePosition] ?? "root"}:${slug}`;
      },
      routeSegments: ["[slug]"],
    });

    expect(wrapped).toBe(
      'ErrorBoundary(GlobalError)[Segment([slug]:post)[Layout(RootLayout)[Segment(root:post)[Layout(LeafLayout)[Boundary|{"slug":"post","thenable":true}]]|{"thenable":true}]]]',
    );
  });

  it("skips layout wrapping for global-error renders", () => {
    const wrapped = wrapAppPageBoundaryElement({
      element: "Boundary",
      getDefaultExport(layoutModule) {
        return layoutModule?.default ?? null;
      },
      globalErrorComponent: "GlobalError",
      includeGlobalErrorBoundary: false,
      isRscRequest: false,
      layoutModules: [{ default: "RootLayout" }],
      makeThenableParams(params) {
        return params;
      },
      matchedParams: {},
      renderErrorBoundary(component, children) {
        return `ErrorBoundary(${component})[${children}]`;
      },
      renderLayout(component, children) {
        return `Layout(${component})[${children}]`;
      },
      skipLayoutWrapping: true,
    });

    expect(wrapped).toBe("Boundary");
  });

  it("returns direct RSC responses without invoking the HTML callback", async () => {
    const createHtmlResponse = vi.fn(async () => new Response("html"));

    const response = await renderAppPageBoundaryResponse({
      createHtmlResponse,
      createRscOnErrorHandler() {
        return () => null;
      },
      element: "RSC boundary",
      isRscRequest: true,
      renderToReadableStream(element) {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(String(element)));
            controller.close();
          },
        });
      },
      status: 404,
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/x-component; charset=utf-8");
    expect(createHtmlResponse).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("RSC boundary");
  });

  it("routes HTML boundary renders through the provided SSR callback", async () => {
    const createHtmlResponse = vi.fn(
      async (rscStream: ReadableStream<Uint8Array>, status: number) =>
        new Response(`${status}:${await readText(rscStream)}`),
    );

    const response = await renderAppPageBoundaryResponse({
      createHtmlResponse,
      createRscOnErrorHandler() {
        return () => null;
      },
      element: "HTML boundary",
      isRscRequest: false,
      renderToReadableStream(element) {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(String(element)));
            controller.close();
          },
        });
      },
      status: 200,
    });

    expect(createHtmlResponse).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe("200:HTML boundary");
  });
});
