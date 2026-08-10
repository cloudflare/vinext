import { Fragment, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";
import { useSelectedLayoutSegments } from "../packages/vinext/src/shims/navigation.js";
import {
  APP_BFCACHE_SEGMENT_IDENTITIES_KEY,
  APP_LAYOUT_IDS_KEY,
  APP_PREFETCH_LOADING_SHELL_MARKER_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_SOURCE_PAGE_SEGMENTS_KEY,
  AppElementsWire,
  APP_SLOT_BINDINGS_KEY,
  APP_UNMATCHED_SLOT_WIRE_VALUE,
  buildOutgoingAppPayload,
  isAppElementsRecord,
  type AppElements,
} from "../packages/vinext/src/server/app-elements.js";
import type { AppPageParams } from "../packages/vinext/src/server/app-page-boundary.js";
import {
  type AppPageModule,
  type AppPageSlotOverride,
  buildAppPageElements,
  createAppPageLayoutEntries,
  probeAppPageLayoutWithTracking,
  resolveAppPageChildSegments,
  resolveAppPageLoadingModuleAtOrAbove,
} from "../packages/vinext/src/server/app-page-route-wiring.js";
import { createAppLayoutParamAccessTracker } from "../packages/vinext/src/server/app-layout-param-observation.js";
import {
  APP_RSC_RENDER_MODE_PREFETCH_EMPTY,
  APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
} from "../packages/vinext/src/server/app-rsc-render-mode.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import {
  APP_PAGE_INTERCEPTION_MARKER_TRAVERSALS,
  buildPageElements as buildResolvedPageElements,
} from "../packages/vinext/src/server/app-page-element-builder.js";
import { createNextBfcacheIdMap } from "../packages/vinext/src/server/app-bfcache-identity.js";
import type { AppPageSemanticSegment } from "../packages/vinext/src/server/app-page-segment-state.js";
import { createAppPageRenderDependency } from "../packages/vinext/src/server/app-render-dependency.js";

/**
 * Build the resolved semantic branch the route matcher hands to slot overrides.
 * Production parses filesystem syntax once, in
 * `resolveInterceptedSlotIdentitySegments`; fixtures still spell segments the
 * filesystem way, so this mirrors that resolution for readability.
 */
function toSemanticSegments(segments: readonly string[]): AppPageSemanticSegment[] {
  let beforeMarker = true;
  return segments.map((segment) => {
    const marker =
      APP_PAGE_INTERCEPTION_MARKER_TRAVERSALS.find(({ prefix }) => segment.startsWith(prefix))
        ?.prefix ?? null;
    const paramSource = beforeMarker && marker === null ? "route" : "slot";
    if (marker !== null) beforeMarker = false;
    return {
      marker,
      paramSource,
      segment: marker === null ? segment : segment.slice(marker.length),
    };
  });
}

function readNode(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readChildren(value: unknown): ReactNode {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => readChildren(item));
  }

  if (isValidElement(value)) {
    return value;
  }

  return null;
}

function containsElementType(node: unknown, type: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => containsElementType(child, type));
  }

  if (!isValidElement<{ children?: unknown; fallback?: unknown }>(node)) {
    return false;
  }

  return (
    node.type === type ||
    containsElementType(node.props.children, type) ||
    containsElementType(node.props.fallback, type)
  );
}

function getElementTypeName(type: unknown): string {
  if (typeof type === "string") return type;
  if (typeof type === "function") {
    return (
      (type as { displayName?: string; name?: string }).displayName ??
      (type as { name?: string }).name ??
      ""
    );
  }
  return String(type);
}

type InspectableElementProps = Record<string, unknown> & {
  children?: unknown;
  fallback?: unknown;
  id?: unknown;
};

function findElement(
  node: unknown,
  predicate: (element: ReactElement<InspectableElementProps>) => boolean,
): ReactElement<InspectableElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }

  if (!isValidElement<InspectableElementProps>(node)) {
    return null;
  }

  if (predicate(node)) return node;

  for (const value of Object.values(node.props)) {
    const match = findElement(value, predicate);
    if (match) return match;
  }

  return null;
}

function findElementByTypeName(
  node: unknown,
  typeName: string,
): ReactElement<Record<string, unknown>> | null {
  const match = findElement(node, (element) => getElementTypeName(element.type) === typeName);
  return match as ReactElement<Record<string, unknown>> | null;
}

function findSlotById(node: unknown, id: string): ReactElement<Record<string, unknown>> | null {
  const match = findElement(
    node,
    (element) =>
      getElementTypeName(element.type) === "Slot" &&
      typeof element.props.id === "string" &&
      element.props.id === id,
  );
  return match as ReactElement<Record<string, unknown>> | null;
}

function findSuspenseWithFallback(
  node: unknown,
  fallbackTypeName: string,
): ReactElement<Record<string, unknown>> | null {
  const match = findElement(node, (element) => {
    if (getElementTypeName(element.type) !== "Symbol(react.suspense)") {
      return false;
    }
    const fallback = element.props.fallback;
    return isValidElement(fallback) && getElementTypeName(fallback.type) === fallbackTypeName;
  });
  return match as ReactElement<Record<string, unknown>> | null;
}

function countSuspenseWithFallback(node: unknown, fallbackTypeName: string): number {
  if (Array.isArray(node)) {
    return node.reduce(
      (count, child) => count + countSuspenseWithFallback(child, fallbackTypeName),
      0,
    );
  }

  if (!isValidElement<InspectableElementProps>(node)) {
    return 0;
  }

  const fallback = node.props.fallback;
  const isMatch =
    getElementTypeName(node.type) === "Symbol(react.suspense)" &&
    isValidElement(fallback) &&
    getElementTypeName(fallback.type) === fallbackTypeName;

  return Object.values(node.props).reduce<number>(
    (count, value) => count + countSuspenseWithFallback(value, fallbackTypeName),
    isMatch ? 1 : 0,
  );
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
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

async function renderHtml(node: ReactNode): Promise<string> {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const stream = await renderToReadableStream(node, {
    onError(error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    },
  });

  return readStream(stream);
}

async function renderRouteEntry(elements: AppElements, routeId: string): Promise<string> {
  const { ElementsContext, Slot } = await import("../packages/vinext/src/shims/slot.js");
  return renderHtml(
    createElement(
      ElementsContext.Provider,
      { value: elements },
      createElement(Slot, { id: routeId }),
    ),
  );
}

async function renderRouteDocument(elements: AppElements, routeId: string): Promise<string> {
  const { ElementsContext, Slot } = await import("../packages/vinext/src/shims/slot.js");
  // Match production Flight serialization, which starts the flat page and
  // route entries concurrently before the decoded route tree is rendered.
  const pageEntry = Object.entries(elements).find(([key]) => key.startsWith("page:"))?.[1];
  return renderHtml(
    createElement(
      "html",
      null,
      createElement("head"),
      createElement(
        "body",
        null,
        createElement(
          ElementsContext.Provider,
          { value: elements },
          createElement(
            Fragment,
            null,
            pageEntry as ReactNode,
            createElement(Slot, { id: routeId }),
          ),
        ),
      ),
    ),
  );
}

function readDocumentSection(html: string, tagName: "head" | "body"): string {
  const start = html.indexOf(`<${tagName}>`);
  const end = html.indexOf(`</${tagName}>`);
  if (start === -1 || end === -1) {
    throw new Error(`Rendered document is missing <${tagName}>`);
  }
  return html.slice(start, end + tagName.length + 3);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function RootLayout(props: Record<string, unknown>) {
  const segments = useSelectedLayoutSegments();
  const sidebarSegments = useSelectedLayoutSegments("sidebar");
  return createElement(
    "div",
    {
      "data-layout": "root",
      "data-segments": segments.join("|"),
      "data-sidebar-segments": sidebarSegments.join("|"),
    },
    createElement("aside", { "data-slot": "sidebar" }, readChildren(props.sidebar)),
    readChildren(props.children),
  );
}

function GroupLayout(props: Record<string, unknown>) {
  const segments = useSelectedLayoutSegments();
  return createElement(
    "section",
    {
      "data-layout": "group",
      "data-segments": segments.join("|"),
    },
    readChildren(props.children),
  );
}

function SlotLayout(props: Record<string, unknown>) {
  return createElement("div", { "data-slot-layout": "sidebar" }, readChildren(props.children));
}

function NestedSlotLayout(props: Record<string, unknown>) {
  return createElement("div", { "data-slot-layout": "nested" }, readChildren(props.children));
}

function InterceptOuterLayout(props: Record<string, unknown>) {
  return createElement("div", { "data-intercept-layout": "outer" }, readChildren(props.children));
}

function InterceptInnerLayout(props: Record<string, unknown>) {
  return createElement("div", { "data-intercept-layout": "inner" }, readChildren(props.children));
}

function SlotPage(props: Record<string, unknown>) {
  return createElement("p", { "data-slot-page": readNode(props.label) }, readNode(props.label));
}

function ParentModalLayout(props: Record<string, unknown>) {
  return createElement(
    "div",
    { "data-layout": "parent-modal-layout" },
    createElement("div", { "data-parent-modal": "true" }, readChildren(props.modal)),
    readChildren(props.children),
  );
}

function ChildModalLayout(props: Record<string, unknown>) {
  return createElement(
    "section",
    { "data-layout": "child-modal-layout" },
    createElement("div", { "data-child-modal": "true" }, readChildren(props.modal)),
    readChildren(props.children),
  );
}

function RootTemplate(props: Record<string, unknown>) {
  return createElement("div", { "data-template": "root" }, readChildren(props.children));
}

let lastGroupTemplateProps: Record<string, unknown> | null = null;

function GroupTemplate(props: Record<string, unknown>) {
  lastGroupTemplateProps = props;
  return createElement("div", { "data-template": "group" }, readChildren(props.children));
}

function PageProbe() {
  const segments = useSelectedLayoutSegments();
  return createElement("main", { "data-page-segments": segments.join("|") }, "Page");
}

async function buildGeneratedMetadataRouteHtml(
  userAgent: string,
  htmlLimitedBots?: string,
  serveStreamingMetadata?: boolean,
): Promise<string> {
  const elements = await buildResolvedPageElements({
    route: {
      error: null,
      errors: [null],
      layoutTreePositions: [0],
      layouts: [{ default: RootLayout }],
      loading: null,
      notFound: null,
      notFounds: [null],
      page: {
        default: PageProbe,
        async generateMetadata() {
          return {
            title: "generated page",
            alternates: {
              canonical: "https://example.com/generated",
              languages: { "en-US": "https://example.com/en/generated" },
            },
            robots: { index: false, follow: false },
          };
        },
      },
      params: [],
      pattern: "/generated",
      routeSegments: ["generated"],
      slots: {},
      templateTreePositions: [],
      templates: [],
    },
    params: {},
    routePath: "/generated",
    pageRequest: {
      isRscRequest: false,
      mountedSlotsHeader: null,
      request: new Request("http://localhost/generated", {
        headers: { "user-agent": userAgent },
      }),
      searchParams: null,
      serveStreamingMetadata,
    },
    metadataRoutes: [],
    htmlLimitedBots,
  });

  return renderRouteDocument(elements, "route:/generated");
}

function RouteLoadingProbe() {
  return createElement("p", null, "Route loading");
}

function SlotLoadingProbe() {
  return createElement("p", null, "Slot loading");
}

function LayoutWithoutChildren() {
  return createElement("div", { "data-layout": "without-children" }, "Layout only");
}

describe("app page route wiring helpers", () => {
  it("selects the nearest positioned loading module with a default export", () => {
    const legacyLoading = { default: () => null };
    const rootLoading = { default: () => null };
    const leafWithoutDefault = { generateMetadata: () => null };

    expect(
      resolveAppPageLoadingModuleAtOrAbove(
        {
          loading: legacyLoading,
          loadings: [rootLoading, leafWithoutDefault],
          loadingTreePositions: [0, 2],
        },
        2,
      ),
    ).toBe(rootLoading);
    expect(
      resolveAppPageLoadingModuleAtOrAbove(
        {
          loading: legacyLoading,
          loadings: [rootLoading],
          loadingTreePositions: [],
        },
        2,
      ),
    ).toBe(legacyLoading);
  });

  it("probes returned layout children with param and revalidate tracking", async () => {
    const calls: string[] = [];
    const layoutParamAccess = createAppLayoutParamAccessTracker();

    function Child() {
      calls.push("child");
      return null;
    }

    function Layout() {
      calls.push("layout");
      return createElement("section", null, createElement(Child));
    }

    await probeAppPageLayoutWithTracking({
      layoutIndex: 0,
      layoutParamAccess,
      makeThenableParams,
      matchedParams: {},
      route: {
        layoutTreePositions: [0],
        layouts: [{ default: Layout, revalidate: 60 }],
        routeSegments: ["dashboard"],
      },
    });

    expect(calls).toEqual(["layout", "child"]);
    expect(layoutParamAccess.getLayoutObservation("layout:/")).toMatchObject({
      completeness: "complete",
      finiteRevalidateSeconds: 60,
    });
  });

  it("probes layout branches that render only when children are present", async () => {
    const calls: string[] = [];
    const layoutParamAccess = createAppLayoutParamAccessTracker();

    function ChromeThatUsesTaggedData() {
      calls.push("chrome");
      getRequestContext().currentRequestTags.push("tag:dashboard-chrome");
      return null;
    }

    function Layout(props: { children?: ReactNode }) {
      calls.push("layout");
      if (!props.children) return null;
      return createElement(
        "section",
        null,
        createElement(ChromeThatUsesTaggedData),
        props.children,
      );
    }

    await runWithRequestContext(createRequestContext(), () =>
      probeAppPageLayoutWithTracking({
        layoutIndex: 0,
        layoutParamAccess,
        makeThenableParams,
        matchedParams: {},
        route: {
          layoutTreePositions: [0],
          layouts: [{ default: Layout }],
          routeSegments: ["dashboard"],
        },
      }),
    );

    expect(calls).toEqual(["layout", "chrome"]);
    expect(layoutParamAccess.getLayoutObservation("layout:/")).toMatchObject({
      cacheTags: ["tag:dashboard-chrome"],
      completeness: "complete",
    });
  });

  it("streams generated metadata into the body for streaming-capable requests", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    const html = await buildGeneratedMetadataRouteHtml("HeadlessChrome");
    const head = readDocumentSection(html, "head");
    const body = readDocumentSection(html, "body");

    expect(head).not.toContain("<title>generated page</title>");
    expect(head).not.toContain('rel="canonical"');
    expect(head).not.toContain('hreflang="en-US"');
    expect(head).not.toContain('name="robots"');
    expect(body).toContain("<title>generated page</title>");
    expect(body).toContain('rel="canonical" href="https://example.com/generated"');
    expect(body).toContain('href="https://example.com/en/generated" hreflang="en-US"');
    expect(body).toContain('name="robots" content="noindex, nofollow"');
  });

  it("renders generated metadata in the head for configured html-limited bots", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-streaming/metadata-streaming-customized-rule.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming/metadata-streaming-customized-rule.test.ts
    const html = await buildGeneratedMetadataRouteHtml("Minibot", "Minibot");
    const head = readDocumentSection(html, "head");
    const body = readDocumentSection(html, "body");

    expect(head).toContain("<title>generated page</title>");
    expect(head).toContain('rel="canonical" href="https://example.com/generated"');
    expect(body).not.toContain("<title>generated page</title>");
  });

  it("streams generated metadata for bots outside the configured html-limited rule", async () => {
    // The custom rule replaces the default bot list, so Twitterbot is streaming-capable here.
    const html = await buildGeneratedMetadataRouteHtml("Twitterbot", "Minibot");
    const head = readDocumentSection(html, "head");
    const body = readDocumentSection(html, "body");

    expect(head).not.toContain("<title>generated page</title>");
    expect(body).toContain("<title>generated page</title>");
  });

  it("renders generated metadata in the head for default html-limited bots", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    const html = await buildGeneratedMetadataRouteHtml("Twitterbot");
    const head = readDocumentSection(html, "head");
    const body = readDocumentSection(html, "body");

    expect(head).toContain("<title>generated page</title>");
    expect(head).toContain('rel="canonical" href="https://example.com/generated"');
    expect(body).not.toContain("<title>generated page</title>");
  });

  it("renders generated metadata in the head when streaming is disabled for prerendering", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-streaming-static-generation/metadata-streaming-static-generation.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming-static-generation/metadata-streaming-static-generation.test.ts
    const html = await buildGeneratedMetadataRouteHtml("HeadlessChrome", undefined, false);
    const head = readDocumentSection(html, "head");
    const body = readDocumentSection(html, "body");

    expect(head).toContain("<title>generated page</title>");
    expect(body).not.toContain("<title>generated page</title>");
  });

  it("falls back to the default html-limited bot list for an empty config string", async () => {
    // Next.js normalizes a falsy htmlLimitedBots config to the default bot regex.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/streaming-metadata.ts
    const html = await buildGeneratedMetadataRouteHtml("HeadlessChrome", "");
    const head = readDocumentSection(html, "head");
    const body = readDocumentSection(html, "body");

    expect(head).not.toContain("<title>generated page</title>");
    expect(body).toContain("<title>generated page</title>");
  });

  it("resolves child segments from tree positions and preserves route groups", () => {
    expect(
      resolveAppPageChildSegments(["(marketing)", "blog", "[slug]", "[...parts]"], 1, {
        parts: ["a", "b"],
        slug: "post",
      }),
    ).toEqual(["blog", "post", "a/b", "__PAGE__"]);
  });

  it("builds layout entries from tree paths instead of visible URL segments", () => {
    const entries = createAppPageLayoutEntries({
      layouts: [{ default: RootLayout }, { default: GroupLayout }],
      layoutTreePositions: [0, 1],
      notFounds: [null, null],
      routeSegments: ["(marketing)", "blog", "[slug]"],
    });

    expect(entries.map((entry) => entry.id)).toEqual(["layout:/", "layout:/(marketing)"]);
    expect(entries.map((entry) => entry.treePath)).toEqual(["/", "/(marketing)"]);
  });

  it("passes only segment-applicable params to each layout", () => {
    // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
    const paramCalls: AppPageParams[] = [];

    buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        paramCalls.push({ ...params });
        return Promise.resolve(params);
      },
      matchedParams: { category: "books", id: "hello-world" },
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null, null, null],
        layoutTreePositions: [1, 2, 3],
        layouts: [{ default: RootLayout }, { default: GroupLayout }, { default: GroupLayout }],
        loading: null,
        notFound: null,
        notFounds: [null, null, null],
        routeSegments: ["dynamic", "[category]", "[id]"],
        slots: null,
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dynamic/books/hello-world",
      rootNotFoundModule: null,
    });

    expect(paramCalls).toEqual([
      {},
      { category: "books" },
      { category: "books", id: "hello-world" },
    ]);
  });

  it("encodes the active app source page from route segments", () => {
    // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
    const cases: Array<{
      routePath: string;
      routeSegments: readonly string[];
      sourcePage: string;
    }> = [
      {
        routePath: "/dashboard",
        routeSegments: ["dashboard"],
        sourcePage: "/dashboard/page",
      },
      {
        routePath: "/dynamic/category-1/id-2",
        routeSegments: ["dynamic", "[category]", "[id]"],
        sourcePage: "/dynamic/[category]/[id]/page",
      },
      {
        routePath: "/dashboard/another",
        routeSegments: ["(newroot)", "dashboard", "another"],
        sourcePage: "/(newroot)/dashboard/another/page",
      },
    ];

    for (const { routePath, routeSegments, sourcePage } of cases) {
      const elements = buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(params) {
          return Promise.resolve(params);
        },
        matchedParams: {},
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [],
          layoutTreePositions: [],
          layouts: [],
          loading: null,
          notFound: null,
          notFounds: [],
          routeSegments,
          slots: null,
          templateTreePositions: [],
          templates: [],
        },
        routePath,
        rootNotFoundModule: null,
      });

      expect(elements[APP_SOURCE_PAGE_SEGMENTS_KEY]).toEqual(sourcePage.slice(1).split("/"));
      expect(AppElementsWire.readMetadata(elements).sourcePage).toBe(sourcePage);
    }
  });

  it("builds a flat elements map with route, layout, template, page, and slot entries", async () => {
    lastGroupTemplateProps = null;
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: { slug: "post" },
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null, null],
        layoutTreePositions: [0, 1],
        layouts: [{ default: RootLayout }, { default: GroupLayout }],
        loading: null,
        notFound: null,
        notFounds: [null, null],
        routeSegments: ["(marketing)", "blog", "[slug]"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: { default: SlotLayout },
            layoutIndex: 0,
            loading: null,
            name: "sidebar",
            page: { default: SlotPage },
            routeSegments: ["members"],
          },
        },
        templateTreePositions: [1],
        templates: [{ default: GroupTemplate }],
      },
      routePath: "/blog/post",
      rootNotFoundModule: null,
      slotOverrides: {
        sidebar: {
          pageModule: { default: SlotPage },
          params: { slug: "post" },
          props: { label: "intercepted" },
        },
      },
    });

    expect(elements.__route).toBe("route:/blog/post");
    expect(elements.__srcPage).toEqual(["(marketing)", "blog", "[slug]", "page"]);
    expect(elements.__layoutIds).toEqual(["layout:/", "layout:/(marketing)"]);
    expect(elements.__rootLayout).toBe("/");
    expect(elements["layout:/"]).toBeDefined();
    expect(elements["layout:/(marketing)"]).toBeDefined();
    expect(elements["template:/(marketing)"]).toBeDefined();
    expect(elements["page:/blog/post"]).toBeDefined();
    expect(elements["slot:sidebar:/"]).toBeDefined();
    expect(elements["route:/blog/post"]).toBeDefined();

    const html = await renderRouteEntry(elements, "route:/blog/post");

    expect(lastGroupTemplateProps).not.toHaveProperty("params");
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-layout="group"');
    expect(html).toContain('data-template="group"');
    const groupLayoutPos = html.indexOf('data-layout="group"');
    const groupTemplatePos = html.indexOf('data-template="group"');
    expect(groupLayoutPos).toBeLessThan(groupTemplatePos);
    expect(html).toContain('data-slot-layout="sidebar"');
    expect(html).toContain('data-slot-page="intercepted"');
    expect(html).toContain('data-page-segments=""');
    expect(html).toContain('data-segments="(marketing)|blog|post"');
    expect(html).toContain('data-segments="blog|post"');
  });

  it("keeps default children segments at the parent for synthetic named-slot routes", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        childrenRouteSegments: ["dashboard"],
        error: null,
        errors: [null],
        layoutTreePositions: [1],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard", "members"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "sidebar",
            page: { default: SlotPage },
            routeSegments: ["members"],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard/members",
      rootNotFoundModule: null,
    });

    const html = await renderRouteEntry(elements, "route:/dashboard/members");

    expect(html).toContain('data-segments=""');
    expect(html).toContain('data-sidebar-segments="members"');
  });

  it("omits mounted default-only named-slot state from soft-navigation providers", () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      isRscRequest: true,
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      mountedSlotIds: new Set(["slot:sidebar:/"]),
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard", "settings"],
        slots: {
          sidebar: {
            default: { default: SlotPage },
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "sidebar",
            page: null,
            routeSegments: null,
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard/settings",
      rootNotFoundModule: null,
    });

    const provider = findElementByTypeName(
      elements["route:/dashboard/settings"],
      "LayoutSegmentProvider",
    );

    expect(provider?.props.segmentMap).toEqual({ children: ["dashboard", "settings"] });
    expect(provider?.props.providerId).toBe("layout:/");
  });

  it("omits mounted unmatched named-slot state without default.tsx from providers", () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      isRscRequest: true,
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      mountedSlotIds: new Set(["slot:sidebar:/"]),
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard", "settings"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "sidebar",
            page: null,
            routeSegments: null,
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard/settings",
      rootNotFoundModule: null,
    });

    const provider = findElementByTypeName(
      elements["route:/dashboard/settings"],
      "LayoutSegmentProvider",
    );

    expect(provider?.props.segmentMap).toEqual({ children: ["dashboard", "settings"] });
    expect(provider?.props.providerId).toBe("layout:/");
  });

  it("renders nested active slot layouts inside the slot root layout", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            configLayouts: [{ default: NestedSlotLayout }],
            default: null,
            error: null,
            layout: { default: SlotLayout },
            layoutIndex: 0,
            loading: null,
            name: "sidebar",
            page: { default: SlotPage },
            routeSegments: ["members"],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
    });

    const html = await renderRouteEntry(elements, "route:/dashboard");
    expect(html.indexOf('data-slot-layout="sidebar"')).toBeLessThan(
      html.indexOf('data-slot-layout="nested"'),
    );
    expect(html.indexOf('data-slot-layout="nested"')).toBeLessThan(html.indexOf("data-slot-page"));
  });

  it("keeps route loading boundaries in the rendered tree", () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: { default: RouteLoadingProbe },
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        slots: {},
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
    });

    expect(containsElementType(elements["route:/dashboard"], RouteLoadingProbe)).toBe(true);
  });

  it("keeps slot loading boundaries in the rendered tree", () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [],
        layoutTreePositions: [],
        layouts: [],
        loading: null,
        notFound: null,
        notFounds: [],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: -1,
            loading: { default: SlotLoadingProbe },
            name: "sidebar",
            page: { default: SlotPage },
            routeSegments: ["members"],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
    });

    expect(containsElementType(elements["slot:sidebar:/"], SlotLoadingProbe)).toBe(true);
  });

  it("applies an owning segment loading boundary to named parallel slots", () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [],
        layoutTreePositions: [],
        layouts: [],
        loading: null,
        loadings: [{ default: RouteLoadingProbe }],
        loadingTreePositions: [0],
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: -1,
            loading: null,
            name: "sidebar",
            ownerTreePosition: 0,
            page: { default: SlotPage },
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
    });

    expect(
      containsElementType(
        elements[AppElementsWire.encodeSlotId("sidebar", "/")],
        RouteLoadingProbe,
      ),
    ).toBe(true);
  });

  it("applies the nearest loading boundary above a named-slot owner", () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [],
        layoutTreePositions: [],
        layouts: [],
        loading: null,
        loadings: [{ default: RouteLoadingProbe }],
        loadingTreePositions: [0],
        notFound: null,
        notFounds: [],
        routeSegments: ["dashboard", "members"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: -1,
            loading: null,
            name: "sidebar",
            ownerTreePosition: 1,
            page: { default: SlotPage },
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard/members",
      rootNotFoundModule: null,
    });

    expect(
      containsElementType(
        elements[AppElementsWire.encodeSlotId("sidebar", "/")],
        RouteLoadingProbe,
      ),
    ).toBe(true);
  });

  it("positions nested named-slot loading boundaries inside co-located layouts", () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [],
        layoutTreePositions: [],
        layouts: [],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            configLayouts: [{ default: NestedSlotLayout }],
            configLayoutTreePositions: [1],
            default: null,
            error: null,
            layout: null,
            layoutIndex: -1,
            loading: null,
            loadings: [{ default: SlotLoadingProbe }],
            loadingTreePositions: [1],
            name: "sidebar",
            page: { default: SlotPage },
            routeSegments: ["members"],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
    });

    const slotEntry = elements[AppElementsWire.encodeSlotId("sidebar", "/")];
    const nestedLayout = findElementByTypeName(slotEntry, "NestedSlotLayout");
    expect(nestedLayout).not.toBeNull();
    expect(
      findSuspenseWithFallback(nestedLayout?.props.children, "SlotLoadingProbe"),
    ).not.toBeNull();
    expect(
      containsElementType(
        findSuspenseWithFallback(nestedLayout?.props.children, "SlotLoadingProbe")?.props.children,
        NestedSlotLayout,
      ),
    ).toBe(false);
  });

  it("serializes route loading UI instead of page content for loading-shell prefetches", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: { default: RouteLoadingProbe },
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });

    expect(elements["page:/dashboard"]).toBeNull();
    expect(elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY]).toBe("LoadingBoundary");
    const html = await renderRouteEntry(elements, "route:/dashboard");

    expect(html).toContain("Route loading");
    expect(html).not.toContain("Page");
  });

  it("serializes the nearest ancestor loading UI for loading-shell prefetches", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        loadings: [{ default: RouteLoadingProbe }],
        loadingTreePositions: [0],
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard", "slow"],
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard/slow",
      rootNotFoundModule: null,
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });

    expect(elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY]).toBe("LoadingBoundary");
    const html = await renderRouteEntry(elements, "route:/dashboard/slow");
    expect(html).toContain("Route loading");
    expect(html).not.toContain("Page");
  });

  it("stops loading-shell prefetches at the first ancestor boundary", async () => {
    function ParentLoading(): ReactNode {
      return createElement("p", null, "Parent loading");
    }
    function LeafLoading(): ReactNode {
      return createElement("p", null, "Leaf loading");
    }
    function DescendantLayout(props: Record<string, unknown>): ReactNode {
      return createElement("section", { "data-descendant": "true" }, readChildren(props.children));
    }

    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null, null],
        layoutTreePositions: [0, 2],
        layouts: [{ default: RootLayout }, { default: DescendantLayout }],
        loading: { default: LeafLoading },
        loadings: [{ default: ParentLoading }, { default: LeafLoading }],
        loadingTreePositions: [1, 2],
        notFound: null,
        notFounds: [null, null],
        routeSegments: ["parent", "slow"],
        slots: {},
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/parent/slow",
      rootNotFoundModule: null,
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });

    expect(elements["layout:/parent/slow"]).toBeUndefined();
    const html = await renderRouteEntry(elements, "route:/parent/slow");
    expect(html).toContain("Parent loading");
    expect(html).not.toContain("Leaf loading");
    expect(html).not.toContain('data-descendant="true"');
  });

  it("skips an already-shared root loading boundary for loading-shell prefetches", async () => {
    function RootLoading(): ReactNode {
      return createElement("p", null, "Root loading");
    }
    function NestedLoading(): ReactNode {
      return createElement("p", null, "Nested loading");
    }

    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: { default: NestedLoading },
        loadings: [{ default: RootLoading }, { default: NestedLoading }],
        loadingTreePositions: [0, 2],
        notFound: null,
        notFounds: [null],
        routeSegments: ["prefetch-auto", "slug"],
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/prefetch-auto/slug",
      rootNotFoundModule: null,
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });

    const html = await renderRouteEntry(elements, "route:/prefetch-auto/slug");
    expect(html).toContain("Nested loading");
    expect(html).not.toContain("Root loading");
  });

  it("builds slot-only loading shells and omits unprotected parallel branches", async () => {
    function SlotLoading(): ReactNode {
      return createElement("p", null, "Slot loading shell");
    }
    function UnprotectedPage(): ReactNode {
      return createElement("p", null, "Unprotected slot page");
    }

    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            loadings: [{ default: SlotLoading }],
            loadingTreePositions: [1],
            name: "sidebar",
            ownerTreePosition: 0,
            page: { default: SlotPage },
            routeSegments: ["slow"],
          },
          panel: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "panel",
            ownerTreePosition: 0,
            page: { default: UnprotectedPage },
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });

    expect(elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY]).toBe("LoadingBoundary");
    expect(elements[AppElementsWire.encodeSlotId("panel", "/")]).toBeUndefined();
    const html = await renderRouteEntry(elements, "route:/dashboard");
    expect(html).toContain("Slot loading shell");
    expect(html).not.toContain("Unprotected slot page");
    expect(html).not.toContain("Page");
  });

  it("emits the route loading fallback for slots owned at the shell cutoff", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: { default: RouteLoadingProbe },
        loadings: [{ default: RouteLoadingProbe }],
        loadingTreePositions: [0],
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: { default: SlotLoadingProbe },
            name: "sidebar",
            ownerTreePosition: 0,
            page: { default: SlotPage },
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });

    const html = await renderRouteEntry(elements, "route:/dashboard");
    expect(html.match(/Route loading/g)).toHaveLength(2);
    expect(html).not.toContain("Slot page");
  });

  it("uses the slot owner position when no layout exists at the loading cutoff", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        loadings: [{ default: RouteLoadingProbe }],
        loadingTreePositions: [1],
        notFound: null,
        notFounds: [null],
        routeSegments: ["foo", "photo"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: { default: SlotLoadingProbe },
            name: "sidebar",
            ownerTreePosition: 1,
            page: { default: SlotPage },
            routeSegments: ["photo"],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/foo/photo",
      rootNotFoundModule: null,
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });

    const html = await renderRouteEntry(elements, "route:/foo/photo");
    expect(html.match(/Route loading/g)).toHaveLength(2);
    expect(html).not.toContain("Slot page");
  });

  it("does not render page content for loading-shell prefetches without a route loading boundary", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });

    expect(elements["page:/dashboard"]).toBeNull();
    expect(elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY]).toBeUndefined();
    const html = await renderRouteEntry(elements, "route:/dashboard");

    expect(html).not.toContain("Page");
  });

  it("omits page, layout, and loading content for empty Next prefetch payloads", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: { default: RouteLoadingProbe },
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "sidebar",
            page: { default: SlotPage },
            routeSegments: ["members"],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_EMPTY,
      streamingMetadata: Promise.resolve(null),
      streamingMetadataOutlet: Promise.resolve(null),
    });

    const html = await renderRouteEntry(elements, "route:/dashboard");
    expect(html).not.toContain("Page");
    expect(html).not.toContain("Layout");
    expect(html).not.toContain("Route loading");
    expect(html).not.toContain("slot-page");
    expect(Object.keys(elements).some((key) => key.startsWith("slot:"))).toBe(false);
    expect(Object.keys(elements).some((key) => key.startsWith("__vinext_streaming_metadata"))).toBe(
      false,
    );
    expect(elements[APP_LAYOUT_IDS_KEY]).toEqual([]);
    expect(elements[APP_ROOT_LAYOUT_KEY]).toBeNull();
  });

  it("uses override params for slot segment maps when an override page is active", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "sidebar",
            page: { default: SlotPage },
            routeSegments: ["members", "[id]"],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
      slotOverrides: {
        sidebar: {
          pageModule: { default: SlotPage },
          params: { id: "42" },
          props: { label: "override" },
        },
      },
    });

    const html = await renderRouteEntry(elements, "route:/dashboard");

    expect(html).toContain('data-slot-page="override"');
    expect(html).toContain('data-sidebar-segments="members|42"');
  });

  it("uses override route segments for intercepted named slots", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: [],
        slots: {
          modal: {
            default: { default: SlotPage },
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "modal",
            page: null,
            routeSegments: null,
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/interception-dyn-seg",
      rootNotFoundModule: null,
      slotOverrides: {
        modal: {
          pageModule: { default: SlotPage },
          params: { username: "foo", id: "1" },
          routeSegments: ["[username]", "[id]"],
        },
      },
    });

    const provider = findElementByTypeName(
      elements["route:/interception-dyn-seg"],
      "LayoutSegmentProvider",
    );

    expect(provider?.props.segmentMap).toEqual({ children: [], modal: ["foo", "1"] });
    expect(provider?.props.providerId).toBe("layout:/");
  });

  it("uses intercepted override segments for named slot reset boundaries", async () => {
    function SlotError() {
      return createElement("div", null, "slot error");
    }

    const buildInterceptedElements = (params: { username: string; id: string }) =>
      buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(value) {
          return Promise.resolve(value);
        },
        matchedParams: {},
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null],
          layoutTreePositions: [],
          layouts: [],
          loading: null,
          notFound: null,
          notFounds: [null],
          routeSegments: [],
          slots: {
            modal: {
              default: null,
              error: { default: SlotError },
              layout: null,
              layoutIndex: -1,
              loading: null,
              name: "modal",
              page: null,
              routeSegments: null,
            },
          },
          templateTreePositions: [],
          templates: [],
        },
        routePath: "/interception-dyn-seg",
        rootNotFoundModule: null,
        slotOverrides: {
          modal: {
            pageModule: { default: SlotPage },
            params,
            routeSegments: ["(group)", "[username]", "(nested)", "[id]"],
          },
        },
      });

    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/");
    const fooElements = buildInterceptedElements({ username: "foo", id: "1" });
    const fooOtherIdElements = buildInterceptedElements({ username: "foo", id: "2" });
    const barElements = buildInterceptedElements({ username: "bar", id: "2" });
    const fooBoundary = findElementByTypeName(fooElements[modalSlotId], "ErrorBoundary");
    const barBoundary = findElementByTypeName(barElements[modalSlotId], "ErrorBoundary");

    expect(fooBoundary?.props.resetKey).toBe(JSON.stringify(["username|foo|d", "id|1|d"]));
    expect(barBoundary?.props.resetKey).toBe(JSON.stringify(["username|bar|d", "id|2|d"]));
    expect(barBoundary?.props.resetKey).not.toBe(fooBoundary?.props.resetKey);
    const fooIdentity =
      AppElementsWire.readMetadata(fooElements).bfcacheSegmentIdentities[modalSlotId];
    const barIdentity =
      AppElementsWire.readMetadata(barElements).bfcacheSegmentIdentities[modalSlotId];
    const fooOtherIdIdentity =
      AppElementsWire.readMetadata(fooOtherIdElements).bfcacheSegmentIdentities[modalSlotId];
    const repeatedFooIdentity = AppElementsWire.readMetadata(
      buildInterceptedElements({ username: "foo", id: "1" }),
    ).bfcacheSegmentIdentities[modalSlotId];

    expect(fooIdentity).toBeTypeOf("string");
    expect(barIdentity).toBeTypeOf("string");
    expect(fooIdentity).not.toBe(fooBoundary?.props.resetKey);
    expect(barIdentity).not.toBe(barBoundary?.props.resetKey);
    expect(barIdentity).toBe(fooIdentity);
    expect(fooOtherIdIdentity).toBe(fooIdentity);
    expect(repeatedFooIdentity).toBe(fooIdentity);

    const fooIdentities = AppElementsWire.readMetadata(fooElements).bfcacheSegmentIdentities;
    const fooOtherIdIdentities =
      AppElementsWire.readMetadata(fooOtherIdElements).bfcacheSegmentIdentities;
    const nestedSegmentIds = Object.keys(fooIdentities)
      .filter((id) => id.startsWith("slot:\0vinext_bfcache_segment_"))
      .sort();
    expect(nestedSegmentIds).toHaveLength(4);
    const [outerGroupSegmentId, usernameSegmentId, nestedGroupSegmentId, idSegmentId] =
      nestedSegmentIds;
    expect(fooOtherIdIdentities[outerGroupSegmentId]).toBe(fooIdentities[outerGroupSegmentId]);
    expect(fooOtherIdIdentities[usernameSegmentId]).toBe(fooIdentities[usernameSegmentId]);
    expect(fooOtherIdIdentities[nestedGroupSegmentId]).toBe(fooIdentities[nestedGroupSegmentId]);
    expect(fooOtherIdIdentities[idSegmentId]).not.toBe(fooIdentities[idSegmentId]);

    const fooBfcacheIds = createNextBfcacheIdMap({
      current: {},
      currentElements: fooElements,
      elements: fooElements,
    });
    const fooOtherIdBfcacheIds = createNextBfcacheIdMap({
      current: fooBfcacheIds,
      currentElements: fooElements,
      elements: fooOtherIdElements,
    });
    expect(fooOtherIdBfcacheIds[modalSlotId]).toBe(fooBfcacheIds[modalSlotId]);
    expect(fooOtherIdBfcacheIds[outerGroupSegmentId]).toBe(fooBfcacheIds[outerGroupSegmentId]);
    expect(fooOtherIdBfcacheIds[usernameSegmentId]).toBe(fooBfcacheIds[usernameSegmentId]);
    expect(fooOtherIdBfcacheIds[nestedGroupSegmentId]).toBe(fooBfcacheIds[nestedGroupSegmentId]);
    expect(fooOtherIdBfcacheIds[idSegmentId]).not.toBe(fooBfcacheIds[idSegmentId]);

    const missingProofElements = { ...fooOtherIdElements };
    delete missingProofElements[APP_BFCACHE_SEGMENT_IDENTITIES_KEY];
    const missingProofIds = createNextBfcacheIdMap({
      current: fooBfcacheIds,
      currentElements: fooElements,
      elements: missingProofElements,
    });
    expect(missingProofIds[idSegmentId]).toMatch(/^_b_\d+_$/);
    expect(missingProofIds[idSegmentId]).not.toBe(fooBfcacheIds[idSegmentId]);

    const previousCacheComponents = process.env.__NEXT_CACHE_COMPONENTS;
    process.env.__NEXT_CACHE_COMPONENTS = "true";
    try {
      const cachedElements = buildInterceptedElements({ username: "foo", id: "1" });
      expect(
        findElementByTypeName(cachedElements[modalSlotId], "BfcacheSegmentBoundary")?.props
          .stateKey,
      ).toBe("(group)");
      expect(
        findElementByTypeName(cachedElements[modalSlotId], "BfcacheSegmentBoundary")?.props.id,
      ).toBe(outerGroupSegmentId);
    } finally {
      if (previousCacheComponents === undefined) {
        delete process.env.__NEXT_CACHE_COMPONENTS;
      } else {
        process.env.__NEXT_CACHE_COMPONENTS = previousCacheComponents;
      }
    }
  });

  it("retains matching intercepted layouts with marker-bearing branch segments", () => {
    function PhotosLayout(props: { children?: ReactNode }) {
      return createElement("section", { "data-photos-layout": true }, props.children);
    }

    function AlbumLayout(props: { children?: ReactNode }) {
      return createElement("section", { "data-album-layout": true }, props.children);
    }

    const buildElements = (album: string, id: string) =>
      buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(value) {
          return Promise.resolve(value);
        },
        matchedParams: {},
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null],
          layoutTreePositions: [],
          layouts: [],
          loading: null,
          notFound: null,
          notFounds: [null],
          routeSegments: [],
          slots: {
            modal: {
              default: null,
              error: null,
              layout: null,
              layoutIndex: -1,
              loading: null,
              name: "modal",
              page: null,
              routeSegments: null,
            },
          },
          templateTreePositions: [],
          templates: [],
        },
        routePath: `/photos/${album}/${id}`,
        rootNotFoundModule: null,
        slotOverrides: {
          modal: {
            branchSegments: ["photos", "[album]", "[id]"],
            identitySegments: toSemanticSegments(["(.)photos", "[album]", "[id]"]),
            layoutModules: [
              { default: PhotosLayout } as AppPageModule,
              { default: AlbumLayout } as AppPageModule,
            ],
            layoutSegments: [["(.)photos"], ["(.)photos", "[album]"]],
            pageModule: { default: SlotPage },
            params: { album, id },
            routeSegments: ["photos", "[album]", "[id]"],
          },
        },
      });

    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/");
    const firstElements = buildElements("a", "1");
    const changedLeafElements = buildElements("a", "2");
    const firstIdentities = AppElementsWire.readMetadata(firstElements).bfcacheSegmentIdentities;
    const changedLeafIdentities =
      AppElementsWire.readMetadata(changedLeafElements).bfcacheSegmentIdentities;
    const nestedIds = Object.keys(firstIdentities)
      .filter((id) => id.startsWith("slot:\0vinext_bfcache_segment_"))
      .sort();

    expect(nestedIds).toHaveLength(3);
    const [photosSegmentId, albumSegmentId, idSegmentId] = nestedIds;
    const slotElement = firstElements[modalSlotId];
    expect(isValidElement(slotElement) && getElementTypeName(slotElement.type)).toBe(
      "BfcacheSegmentBoundary",
    );
    expect(isValidElement<Record<string, unknown>>(slotElement) ? slotElement.props.id : null).toBe(
      photosSegmentId,
    );
    expect(findElementByTypeName(slotElement, "PhotosLayout")).not.toBeNull();
    expect(findElementByTypeName(slotElement, "AlbumLayout")).not.toBeNull();
    expect(
      findElement(
        slotElement,
        (element) =>
          getElementTypeName(element.type) === "BfcacheSegmentBoundary" &&
          element.props.id === albumSegmentId,
      )?.props.stateKey,
    ).toBe("album|a|d");
    expect(
      findElement(
        slotElement,
        (element) =>
          getElementTypeName(element.type) === "BfcacheSegmentBoundary" &&
          element.props.id === idSegmentId,
      )?.props.stateKey,
    ).toBe("id|1|d");
    expect(changedLeafIdentities[albumSegmentId]).toBe(firstIdentities[albumSegmentId]);
    expect(changedLeafIdentities[idSegmentId]).not.toBe(firstIdentities[idSegmentId]);

    const firstBfcacheIds = createNextBfcacheIdMap({
      current: {},
      currentElements: firstElements,
      elements: firstElements,
    });
    const changedLeafBfcacheIds = createNextBfcacheIdMap({
      current: firstBfcacheIds,
      currentElements: firstElements,
      elements: changedLeafElements,
    });
    expect(changedLeafBfcacheIds[albumSegmentId]).toBe(firstBfcacheIds[albumSegmentId]);
    expect(changedLeafBfcacheIds[idSegmentId]).not.toBe(firstBfcacheIds[idSegmentId]);
  });

  it("preserves source-only interception ancestors and distinguishes conventions", () => {
    function SourceLayout(props: { children?: ReactNode }) {
      return createElement("section", { "data-source-layout": true }, props.children);
    }

    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/");
    const buildElements = (
      sourceId: string,
      targetId: string,
      marker = "(..)photo",
      targetKind = "photo",
    ) =>
      buildAppPageElements({
        element: createElement(PageProbe),
        interception: {
          sourceMatchedUrl: `/source/${sourceId}`,
          sourceRouteId: `route:/source/${sourceId}`,
          slotId: modalSlotId,
          targetMatchedUrl: `/${targetKind}/${targetId}`,
          targetRouteId: `route:/${targetKind}/${targetId}`,
        },
        makeThenableParams(value) {
          return Promise.resolve(value);
        },
        matchedParams: { id: sourceId },
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null],
          ids: {
            layouts: [],
            page: "graph-page:/source/[id]",
            rootBoundary: "graph-root:/",
            route: "graph-route:/source/[id]",
            routeHandler: null,
            slots: { modal: "graph-slot:modal" },
            templates: [],
          },
          layoutTreePositions: [],
          layouts: [],
          loading: null,
          notFound: null,
          notFounds: [null],
          routeSegments: ["[id]"],
          slots: {
            modal: {
              default: null,
              error: null,
              layout: null,
              layoutIndex: -1,
              loading: null,
              name: "modal",
              page: null,
              routeSegments: null,
            },
          },
          templateTreePositions: [],
          templates: [],
        },
        routePath: `/${targetKind}/${targetId}`,
        rootNotFoundModule: null,
        semanticInterceptionTargetRouteId: `graph-route:/${targetKind}/[id]`,
        slotOverrides: {
          modal: {
            branchSegments: ["[id]", "photo", "[id]"],
            identitySegments: toSemanticSegments(["[id]", marker, "[id]"]),
            layoutModules: [{ default: SourceLayout } as AppPageModule],
            layoutSegments: [["[id]"]],
            pageModule: { default: SlotPage },
            params: { id: targetId },
            routeSegments: ["photo", "[id]"],
          },
        },
      });

    const firstElements = buildElements("source-a", "target-1");
    const changedLeafElements = buildElements("source-a", "target-2");
    const otherSourceElements = buildElements("source-b", "target-1");
    const otherConventionElements = buildElements("source-a", "target-1", "(.)photo");
    const otherTargetElements = buildElements("source-a", "target-1", "(..)video", "video");
    const firstIdentities = AppElementsWire.readMetadata(firstElements).bfcacheSegmentIdentities;
    const changedLeafIdentities =
      AppElementsWire.readMetadata(changedLeafElements).bfcacheSegmentIdentities;
    const otherConventionIdentities =
      AppElementsWire.readMetadata(otherConventionElements).bfcacheSegmentIdentities;
    const otherSourceIdentities =
      AppElementsWire.readMetadata(otherSourceElements).bfcacheSegmentIdentities;
    const otherTargetIdentities =
      AppElementsWire.readMetadata(otherTargetElements).bfcacheSegmentIdentities;
    const nestedIds = Object.keys(firstIdentities)
      .filter((id) => id.startsWith("slot:\0vinext_bfcache_segment_"))
      .sort();

    expect(nestedIds).toHaveLength(3);
    const [sourceSegmentId, targetSegmentId, leafSegmentId] = nestedIds;
    expect(isValidElement(firstElements[modalSlotId])).toBe(true);
    expect(getElementTypeName((firstElements[modalSlotId] as ReactElement).type)).toBe(
      "BfcacheSegmentBoundary",
    );
    expect(findElementByTypeName(firstElements[modalSlotId], "SourceLayout")).not.toBeNull();
    expect(changedLeafIdentities[modalSlotId]).toBe(firstIdentities[modalSlotId]);
    expect(changedLeafIdentities[sourceSegmentId]).toBe(firstIdentities[sourceSegmentId]);
    expect(changedLeafIdentities[targetSegmentId]).toBe(firstIdentities[targetSegmentId]);
    expect(changedLeafIdentities[leafSegmentId]).not.toBe(firstIdentities[leafSegmentId]);
    expect(otherSourceIdentities[modalSlotId]).toBe(firstIdentities[modalSlotId]);
    expect(otherSourceIdentities[sourceSegmentId]).not.toBe(firstIdentities[sourceSegmentId]);
    expect(otherTargetIdentities[sourceSegmentId]).toBe(firstIdentities[sourceSegmentId]);
    expect(otherTargetIdentities[targetSegmentId]).not.toBe(firstIdentities[targetSegmentId]);
    expect(otherConventionIdentities[targetSegmentId]).not.toBe(firstIdentities[targetSegmentId]);
    expect(otherConventionIdentities[leafSegmentId]).not.toBe(firstIdentities[leafSegmentId]);
  });

  it.each([
    ["short", ["(.)photo"]],
    ["long", ["(.)photo", "[id]", "extra"]],
  ])("omits authoritative proof for %s interception identity metadata", (_, identitySegments) => {
    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/");
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(value) {
        return Promise.resolve(value);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [],
        layouts: [],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: [],
        slots: {
          modal: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: -1,
            loading: null,
            name: "modal",
            page: null,
            routeSegments: null,
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/photo/1",
      rootNotFoundModule: null,
      slotOverrides: {
        modal: {
          branchSegments: ["photo", "[id]"],
          identitySegments: toSemanticSegments(identitySegments),
          pageModule: { default: SlotPage },
          params: { id: "1" },
          routeSegments: ["photo", "[id]"],
        },
      },
    });
    const identities = AppElementsWire.readMetadata(elements).bfcacheSegmentIdentities;
    const fallbackBoundary = findElementByTypeName(elements[modalSlotId], "BfcacheSegmentBoundary");

    expect(identities[modalSlotId]).toBeUndefined();
    expect(
      Object.keys(identities).some((id) => id.startsWith("slot:\0vinext_bfcache_segment_")),
    ).toBe(false);
    expect(fallbackBoundary?.props.stateKey).toBe(JSON.stringify(["photo", "id|1|d"]));
  });

  it("emits opaque slot identities from effective route facts", async () => {
    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/");
    const buildSlotElements = (options: {
      defaultModule: AppPageModule | null;
      pageModule: AppPageModule | null;
      targetPath?: string;
    }) =>
      buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(value) {
          return Promise.resolve(value);
        },
        matchedParams: { id: "42" },
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null],
          layoutTreePositions: [],
          layouts: [],
          loading: null,
          notFound: null,
          notFounds: [null],
          routeSegments: ["photos", "[id]"],
          slots: {
            modal: {
              default: options.defaultModule,
              error: null,
              layout: null,
              layoutIndex: -1,
              loading: null,
              name: "modal",
              page: options.pageModule,
              routeSegments: ["photos", "[id]"],
            },
          },
          templateTreePositions: [],
          templates: [],
        },
        ...(options.targetPath
          ? {
              interception: {
                sourceMatchedUrl: "/feed",
                sourceRouteId: "route:/feed",
                slotId: modalSlotId,
                targetMatchedUrl: options.targetPath,
                targetRouteId: `route:${options.targetPath}`,
              },
              interceptionContext: "/feed",
            }
          : {}),
        routePath: "/photos/42",
        rootNotFoundModule: null,
      });

    const activeIdentities = AppElementsWire.readMetadata(
      buildSlotElements({
        defaultModule: null,
        pageModule: { default: SlotPage },
        targetPath: "/photos/42",
      }),
    ).bfcacheSegmentIdentities;
    const changedTargetIdentities = AppElementsWire.readMetadata(
      buildSlotElements({
        defaultModule: null,
        pageModule: { default: SlotPage },
        targetPath: "/photos/43",
      }),
    ).bfcacheSegmentIdentities;
    const defaultIdentities = AppElementsWire.readMetadata(
      buildSlotElements({ defaultModule: { default: SlotPage }, pageModule: null }),
    ).bfcacheSegmentIdentities;
    const unmatchedIdentities = AppElementsWire.readMetadata(
      buildSlotElements({ defaultModule: null, pageModule: null }),
    ).bfcacheSegmentIdentities;
    const firstSegmentId = Object.keys(activeIdentities).find((id) =>
      id.startsWith("slot:\0vinext_bfcache_segment_"),
    );

    expect(firstSegmentId).toBeTypeOf("string");
    if (firstSegmentId === undefined) return;
    expect(activeIdentities[modalSlotId]).toBe(changedTargetIdentities[modalSlotId]);
    expect(activeIdentities[modalSlotId]).toBe(defaultIdentities[modalSlotId]);
    expect(defaultIdentities[modalSlotId]).toBe(unmatchedIdentities[modalSlotId]);
    expect(changedTargetIdentities[firstSegmentId]).toBe(activeIdentities[firstSegmentId]);
    expect(defaultIdentities[firstSegmentId]).not.toBe(activeIdentities[firstSegmentId]);
    expect(unmatchedIdentities[firstSegmentId]).not.toBe(defaultIdentities[firstSegmentId]);
  });

  it("derives BFCache identities from graph semantic ids when available", () => {
    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/");
    const buildElements = (graph: {
      pageId: string | null;
      rootBoundaryId: string;
      routeId: string;
    }) =>
      buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(value) {
          return Promise.resolve(value);
        },
        matchedParams: { id: "42" },
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null],
          ids: {
            layouts: ["layout:/"],
            page: graph.pageId,
            rootBoundary: graph.rootBoundaryId,
            route: graph.routeId,
            routeHandler: null,
            slots: { modal: "graph-slot:modal" },
            templates: [],
          },
          layoutTreePositions: [0],
          layouts: [{ default: RootLayout }],
          loading: null,
          notFound: null,
          notFounds: [null],
          routeSegments: ["photos", "[id]"],
          slots: {
            modal: {
              default: null,
              error: null,
              id: modalSlotId,
              layout: null,
              layoutIndex: 0,
              loading: null,
              name: "modal",
              page: { default: SlotPage },
              routeSegments: ["photos", "[id]"],
            },
          },
          templateTreePositions: [],
          templates: [],
        },
        routePath: "/photos/42",
        rootNotFoundModule: null,
      });

    const baseline = AppElementsWire.readMetadata(
      buildElements({
        pageId: "page:/photos/[id]",
        rootBoundaryId: "root-boundary:/",
        routeId: "route:/photos/[id]",
      }),
    ).bfcacheSegmentIdentities;
    const changedGraphIds = AppElementsWire.readMetadata(
      buildElements({
        pageId: "page:/albums/[id]",
        rootBoundaryId: "root-boundary:/",
        routeId: "route:/albums/[id]",
      }),
    ).bfcacheSegmentIdentities;
    const changedRootBoundary = AppElementsWire.readMetadata(
      buildElements({
        pageId: "page:/photos/[id]",
        rootBoundaryId: "root-boundary:/(shell)",
        routeId: "route:/photos/[id]",
      }),
    ).bfcacheSegmentIdentities;
    const layoutOnly = AppElementsWire.readMetadata(
      buildElements({
        pageId: null,
        rootBoundaryId: "root-boundary:/",
        routeId: "route:/photos/[id]",
      }),
    ).bfcacheSegmentIdentities;

    expect(changedGraphIds["page:/photos/42"]).not.toBe(baseline["page:/photos/42"]);
    // An unchanged active parallel slot is independent of an unrelated change
    // to the aggregate children route.
    expect(changedGraphIds[modalSlotId]).toBe(baseline[modalSlotId]);
    expect(changedRootBoundary["page:/photos/42"]).not.toBe(baseline["page:/photos/42"]);
    expect(layoutOnly["page:/photos/42"]).toBeDefined();
    expect(JSON.parse(baseline[modalSlotId])[1]).toBe("graph-slot:modal");
  });

  it.each([false, true])(
    "binds nested slot identities to their dynamic owner with cacheComponents=%s",
    (cacheComponents) => {
      const previousCacheComponents = process.env.__NEXT_CACHE_COMPONENTS;
      if (cacheComponents) {
        process.env.__NEXT_CACHE_COMPONENTS = "true";
      } else {
        delete process.env.__NEXT_CACHE_COMPONENTS;
      }

      try {
        const modalSlotId = AppElementsWire.encodeSlotId("modal", "/");
        const buildElements = (teamID: string, catchAll: string) =>
          buildAppPageElements({
            element: createElement(PageProbe),
            makeThenableParams(value) {
              return Promise.resolve(value);
            },
            matchedParams: { catchAll: [catchAll], teamID },
            resolvedMetadata: null,
            resolvedViewport: {},
            route: {
              error: null,
              errors: [null],
              ids: {
                layouts: ["graph-layout:/"],
                page: "graph-page:/[teamID]/dashboard",
                rootBoundary: "graph-root:/",
                route: "graph-route:/[teamID]/dashboard",
                routeHandler: null,
                slots: { modal: "graph-slot:modal" },
                templates: [],
              },
              layoutTreePositions: [0],
              layouts: [{ default: RootLayout }],
              loading: null,
              notFound: null,
              notFounds: [null],
              routeSegments: ["[teamID]", "dashboard"],
              slots: {
                modal: {
                  default: null,
                  error: null,
                  id: modalSlotId,
                  layout: null,
                  layoutIndex: 0,
                  loading: null,
                  name: "modal",
                  ownerTreePosition: 1,
                  page: { default: SlotPage },
                  routeSegments: ["projects", "[...catchAll]"],
                },
              },
              templateTreePositions: [],
              templates: [],
            },
            routePath: `/${teamID}/dashboard`,
            rootNotFoundModule: null,
          });

        const alphaElements = buildElements("alpha", "same");
        const betaElements = buildElements("beta", "same");
        const alphaOtherLeafElements = buildElements("alpha", "other");
        const alphaIdentities =
          AppElementsWire.readMetadata(alphaElements).bfcacheSegmentIdentities;
        const betaIdentities = AppElementsWire.readMetadata(betaElements).bfcacheSegmentIdentities;
        const alphaOtherLeafIdentities =
          AppElementsWire.readMetadata(alphaOtherLeafElements).bfcacheSegmentIdentities;
        const nestedSegmentId = Object.keys(alphaIdentities)
          .filter((id) => id.startsWith("slot:\0vinext_bfcache_segment_"))
          .sort()
          .at(-1);

        expect(nestedSegmentId).toBeTypeOf("string");
        if (nestedSegmentId === undefined) return;
        expect(betaIdentities[modalSlotId]).not.toBe(alphaIdentities[modalSlotId]);
        expect(betaIdentities[nestedSegmentId]).not.toBe(alphaIdentities[nestedSegmentId]);
        expect(alphaOtherLeafIdentities[modalSlotId]).toBe(alphaIdentities[modalSlotId]);
        expect(alphaOtherLeafIdentities[nestedSegmentId]).not.toBe(
          alphaIdentities[nestedSegmentId],
        );

        const alphaBfcacheIds = createNextBfcacheIdMap({
          current: {},
          currentElements: alphaElements,
          elements: alphaElements,
        });
        const betaBfcacheIds = createNextBfcacheIdMap({
          current: alphaBfcacheIds,
          currentElements: alphaElements,
          elements: betaElements,
        });
        expect(betaBfcacheIds[modalSlotId]).not.toBe(alphaBfcacheIds[modalSlotId]);
        expect(betaBfcacheIds[nestedSegmentId]).not.toBe(alphaBfcacheIds[nestedSegmentId]);
      } finally {
        if (previousCacheComponents === undefined) {
          delete process.env.__NEXT_CACHE_COMPONENTS;
        } else {
          process.env.__NEXT_CACHE_COMPONENTS = previousCacheComponents;
        }
      }
    },
  );

  it.each([false, true])(
    "retains named-slot route-group ownership with cacheComponents=%s",
    (cacheComponents) => {
      const previousCacheComponents = process.env.__NEXT_CACHE_COMPONENTS;
      if (cacheComponents) {
        process.env.__NEXT_CACHE_COMPONENTS = "true";
      } else {
        delete process.env.__NEXT_CACHE_COMPONENTS;
      }

      try {
        const panelSlotId = AppElementsWire.encodeSlotId("panel", "/");
        const buildElements = (id: string) =>
          buildAppPageElements({
            element: createElement(PageProbe),
            makeThenableParams(value) {
              return Promise.resolve(value);
            },
            matchedParams: { id },
            resolvedMetadata: null,
            resolvedViewport: {},
            route: {
              error: null,
              errors: [null],
              ids: {
                layouts: [],
                page: "graph-page:/dashboard",
                rootBoundary: "graph-root:/",
                route: "graph-route:/dashboard",
                routeHandler: null,
                slots: { panel: "graph-slot:panel" },
                templates: [],
              },
              layoutTreePositions: [],
              layouts: [],
              loading: null,
              notFound: null,
              notFounds: [null],
              routeSegments: ["dashboard"],
              slots: {
                panel: {
                  configLayouts: [{ default: GroupLayout }],
                  configLayoutTreePositions: [1],
                  default: null,
                  error: null,
                  id: panelSlotId,
                  layout: { default: SlotLayout },
                  layoutIndex: -1,
                  loading: null,
                  name: "panel",
                  page: { default: SlotPage },
                  routeSegments: ["(shared)", "[id]"],
                },
              },
              templateTreePositions: [],
              templates: [],
            },
            routePath: `/dashboard/${id}`,
            rootNotFoundModule: null,
          });

        const firstElements = buildElements("a");
        const secondElements = buildElements("b");
        const firstIdentities =
          AppElementsWire.readMetadata(firstElements).bfcacheSegmentIdentities;
        const secondIdentities =
          AppElementsWire.readMetadata(secondElements).bfcacheSegmentIdentities;
        const nestedSegmentIds = Object.keys(firstIdentities)
          .filter((candidate) => candidate.startsWith("slot:\0vinext_bfcache_segment_"))
          .sort();
        const groupSegmentId = nestedSegmentIds[0];
        const nestedSegmentId = nestedSegmentIds.at(-1);

        expect(nestedSegmentIds).toHaveLength(2);
        expect(nestedSegmentId).toBeTypeOf("string");
        if (nestedSegmentId === undefined) return;
        expect(firstIdentities[panelSlotId]).toBe(secondIdentities[panelSlotId]);
        expect(firstIdentities[nestedSegmentId]).not.toBe(secondIdentities[nestedSegmentId]);
        expect(
          isValidElement(firstElements[panelSlotId]) &&
            getElementTypeName(firstElements[panelSlotId].type),
        ).toBe("SlotLayout");
        expect(findElementByTypeName(firstElements[panelSlotId], "GroupLayout")).not.toBeNull();

        const firstSegmentBoundary = findElement(
          firstElements[panelSlotId],
          (element) =>
            getElementTypeName(element.type) === "BfcacheSegmentBoundary" &&
            element.props.id === groupSegmentId,
        );
        expect(firstSegmentBoundary?.props.stateKey).toBe("(shared)");
      } finally {
        if (previousCacheComponents === undefined) {
          delete process.env.__NEXT_CACHE_COMPONENTS;
        } else {
          process.env.__NEXT_CACHE_COMPONENTS = previousCacheComponents;
        }
      }
    },
  );

  it("keys a named slot's first dynamic segment without cache components", () => {
    const previousCacheComponents = process.env.__NEXT_CACHE_COMPONENTS;
    delete process.env.__NEXT_CACHE_COMPONENTS;
    try {
      const panelSlotId = AppElementsWire.encodeSlotId("panel", "/");
      const buildElements = (id: string) =>
        buildAppPageElements({
          element: createElement(PageProbe),
          makeThenableParams(value) {
            return Promise.resolve(value);
          },
          matchedParams: { id },
          resolvedMetadata: null,
          resolvedViewport: {},
          route: {
            error: null,
            errors: [null],
            layoutTreePositions: [],
            layouts: [],
            loading: null,
            notFound: null,
            notFounds: [null],
            routeSegments: [],
            slots: {
              panel: {
                default: null,
                error: null,
                layout: null,
                layoutIndex: -1,
                loading: null,
                name: "panel",
                page: { default: SlotPage },
                routeSegments: ["[id]"],
              },
            },
            templateTreePositions: [],
            templates: [],
          },
          routePath: `/panel/${id}`,
          rootNotFoundModule: null,
        });

      const firstElements = buildElements("a");
      const secondElements = buildElements("b");
      const firstIdentities = AppElementsWire.readMetadata(firstElements).bfcacheSegmentIdentities;
      const secondIdentities =
        AppElementsWire.readMetadata(secondElements).bfcacheSegmentIdentities;
      const firstSegmentId = Object.keys(firstIdentities).find((id) =>
        id.startsWith("slot:\0vinext_bfcache_segment_"),
      );
      expect(firstSegmentId).toBeTypeOf("string");
      if (firstSegmentId === undefined) return;
      const firstSegmentBoundary = findElement(
        firstElements[panelSlotId],
        (element) =>
          getElementTypeName(element.type) === "BfcacheSegmentBoundary" &&
          element.props.id === firstSegmentId,
      );

      expect(secondIdentities[panelSlotId]).toBe(firstIdentities[panelSlotId]);
      expect(secondIdentities[firstSegmentId]).not.toBe(firstIdentities[firstSegmentId]);
      expect(firstSegmentBoundary?.props.stateKey).toBe("id|a|d");
    } finally {
      if (previousCacheComponents === undefined) {
        delete process.env.__NEXT_CACHE_COMPONENTS;
      } else {
        process.env.__NEXT_CACHE_COMPONENTS = previousCacheComponents;
      }
    }
  });

  it("keys an empty named-slot branch by its dynamic owner without cache components", () => {
    const previousCacheComponents = process.env.__NEXT_CACHE_COMPONENTS;
    delete process.env.__NEXT_CACHE_COMPONENTS;
    try {
      const panelSlotId = AppElementsWire.encodeSlotId("panel", "/");
      const buildElements = (team: string) =>
        buildAppPageElements({
          element: createElement(PageProbe),
          makeThenableParams(value) {
            return Promise.resolve(value);
          },
          matchedParams: { team },
          resolvedMetadata: null,
          resolvedViewport: {},
          route: {
            error: null,
            errors: [null],
            ids: {
              layouts: [],
              page: "graph-page:/[team]",
              rootBoundary: "graph-root:/",
              route: "graph-route:/[team]",
              routeHandler: null,
              slots: { panel: "graph-slot:panel" },
              templates: [],
            },
            layoutTreePositions: [],
            layouts: [],
            loading: null,
            notFound: null,
            notFounds: [null],
            routeSegments: ["[team]"],
            slots: {
              panel: {
                default: null,
                error: null,
                id: panelSlotId,
                layout: null,
                layoutIndex: -1,
                loading: null,
                name: "panel",
                ownerTreePosition: 1,
                page: { default: SlotPage },
                routeSegments: [],
              },
            },
            templateTreePositions: [],
            templates: [],
          },
          routePath: `/${team}`,
          rootNotFoundModule: null,
        });

      const firstElements = buildElements("a");
      const secondElements = buildElements("b");
      const firstIdentities = AppElementsWire.readMetadata(firstElements).bfcacheSegmentIdentities;
      const secondIdentities =
        AppElementsWire.readMetadata(secondElements).bfcacheSegmentIdentities;
      const branchSegmentId = Object.keys(firstIdentities).find((id) =>
        id.startsWith("slot:\0vinext_bfcache_segment_"),
      );
      expect(branchSegmentId).toBeTypeOf("string");
      if (branchSegmentId === undefined) return;
      const ownerBoundary = findElement(
        firstElements[panelSlotId],
        (element) =>
          getElementTypeName(element.type) === "BfcacheSegmentBoundary" &&
          element.props.id === branchSegmentId,
      );

      expect(secondIdentities[panelSlotId]).not.toBe(firstIdentities[panelSlotId]);
      expect(secondIdentities[branchSegmentId]).not.toBe(firstIdentities[branchSegmentId]);
      expect(ownerBoundary?.props.stateKey).toBe("active");
    } finally {
      if (previousCacheComponents === undefined) {
        delete process.env.__NEXT_CACHE_COMPONENTS;
      } else {
        process.env.__NEXT_CACHE_COMPONENTS = previousCacheComponents;
      }
    }
  });

  it("separates empty active and default slot branches without cache components", () => {
    const previousCacheComponents = process.env.__NEXT_CACHE_COMPONENTS;
    delete process.env.__NEXT_CACHE_COMPONENTS;
    try {
      const panelSlotId = AppElementsWire.encodeSlotId("panel", "/");
      const buildElements = (active: boolean) =>
        buildAppPageElements({
          element: createElement(PageProbe),
          makeThenableParams(value) {
            return Promise.resolve(value);
          },
          matchedParams: {},
          resolvedMetadata: null,
          resolvedViewport: {},
          route: {
            error: null,
            errors: [null],
            layoutTreePositions: [],
            layouts: [],
            loading: null,
            notFound: null,
            notFounds: [null],
            routeSegments: [],
            slots: {
              panel: {
                default: active ? null : { default: SlotPage },
                error: null,
                layout: null,
                layoutIndex: -1,
                loading: null,
                name: "panel",
                page: active ? { default: SlotPage } : null,
                routeSegments: [],
              },
            },
            templateTreePositions: [],
            templates: [],
          },
          routePath: "/",
          rootNotFoundModule: null,
        });

      const activeElements = buildElements(true);
      const defaultElements = buildElements(false);
      const activeIdentities =
        AppElementsWire.readMetadata(activeElements).bfcacheSegmentIdentities;
      const defaultIdentities =
        AppElementsWire.readMetadata(defaultElements).bfcacheSegmentIdentities;
      const branchSegmentId = Object.keys(activeIdentities).find((id) =>
        id.startsWith("slot:\0vinext_bfcache_segment_"),
      );

      expect(branchSegmentId).toBeTypeOf("string");
      if (branchSegmentId === undefined) return;
      expect(defaultIdentities[panelSlotId]).toBe(activeIdentities[panelSlotId]);
      expect(defaultIdentities[branchSegmentId]).not.toBe(activeIdentities[branchSegmentId]);
      expect(
        findElementByTypeName(activeElements[panelSlotId], "BfcacheSegmentBoundary")?.props
          .stateKey,
      ).toBe("active");
      expect(
        findElementByTypeName(defaultElements[panelSlotId], "BfcacheSegmentBoundary")?.props
          .stateKey,
      ).toBe("default");
    } finally {
      if (previousCacheComponents === undefined) {
        delete process.env.__NEXT_CACHE_COMPONENTS;
      } else {
        process.env.__NEXT_CACHE_COMPONENTS = previousCacheComponents;
      }
    }
  });

  it("does not over-key intercepted segments by leaf route ids", () => {
    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/");
    const buildIdentity = (
      wireTargetRouteId: string,
      semanticTargetRouteId: string | null,
      sourceId = "a",
    ): string | undefined => {
      const elements = buildAppPageElements({
        element: createElement(PageProbe),
        interception: {
          sourceMatchedUrl: "/feed",
          sourceRouteId: "route:/feed",
          slotId: modalSlotId,
          targetMatchedUrl: "/photos/42",
          targetRouteId: wireTargetRouteId,
        },
        makeThenableParams(value) {
          return Promise.resolve(value);
        },
        matchedParams: { id: "42", sourceId },
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null],
          ids: {
            layouts: ["graph-layout:root"],
            page: "graph-page:/feed",
            rootBoundary: "graph-root:/",
            route: "graph-route:/feed/[sourceId]",
            routeHandler: null,
            slots: { modal: "graph-slot:modal" },
            templates: [],
          },
          layoutTreePositions: [0],
          layouts: [{ default: RootLayout }],
          loading: null,
          notFound: null,
          notFounds: [null],
          routeSegments: ["feed", "[sourceId]"],
          slots: {
            modal: {
              default: null,
              error: null,
              id: "transport-independent-slot-id",
              layout: null,
              layoutIndex: 0,
              loading: null,
              name: "modal",
              page: { default: SlotPage },
              routeSegments: ["photos", "[id]"],
            },
          },
          templateTreePositions: [],
          templates: [],
        },
        routePath: "/photos/42",
        rootNotFoundModule: null,
        semanticInterceptionTargetRouteId: semanticTargetRouteId,
      });
      const identities = elements[AppElementsWire.keys.bfcacheSegmentIdentities];
      if (typeof identities !== "object" || identities === null || Array.isArray(identities)) {
        throw new Error("Expected BFCache identity metadata");
      }
      const identityId = Object.keys(identities).find((id) =>
        id.startsWith("slot:\0vinext_bfcache_segment_"),
      );
      const identity = identityId
        ? (identities as Readonly<Record<string, unknown>>)[identityId]
        : undefined;
      if (identity !== undefined && typeof identity !== "string") {
        throw new Error("Expected modal BFCache identity");
      }
      return identity;
    };

    const baseline = buildIdentity("route:/photos/42", "graph-route:/photos/[id]");
    const changedWireId = buildIdentity(
      "route:/transport-format-changed/photos/42",
      "graph-route:/photos/[id]",
    );
    const changedGraphId = buildIdentity("route:/photos/42", "graph-route:/albums/[id]");
    const changedSourceParams = buildIdentity("route:/photos/42", "graph-route:/photos/[id]", "b");
    const missingGraphId = buildIdentity("route:/photos/42", null);

    expect(changedWireId).toBe(baseline);
    expect(changedGraphId).toBe(baseline);
    // Next.js keys named-slot Activity from the slot's active segment. Opening
    // the same interception target from another source instance must retain
    // the slot identity; the parent route owns source-state separation.
    expect(changedSourceParams).toBe(baseline);
    expect(missingGraphId).toBeDefined();
    expect(baseline).toBeDefined();
    if (baseline === undefined) return;
    expect(JSON.parse(baseline)).toMatchObject({
      1: "graph-slot:modal",
      2: "graph-layout:root",
      4: null,
      5: null,
    });
  });

  it("retains an intercepted target's shared physical segment identities", () => {
    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/");
    const buildIdentities = (
      identitySegments: string[],
      targetRouteId: string,
    ): Readonly<Record<string, string>> => {
      const elements = buildAppPageElements({
        element: createElement(PageProbe),
        interception: {
          sourceMatchedUrl: "/feed",
          sourceRouteId: "route:/feed",
          slotId: modalSlotId,
          targetMatchedUrl: "/photo/42",
          targetRouteId: "route:/photo/42",
        },
        makeThenableParams(value) {
          return Promise.resolve(value);
        },
        matchedParams: {},
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null],
          ids: {
            layouts: ["graph-layout:root"],
            page: "graph-page:/feed",
            rootBoundary: "graph-root:/",
            route: "graph-route:/feed",
            routeHandler: null,
            slots: { modal: "graph-slot:modal" },
            templates: [],
          },
          layoutTreePositions: [0],
          layouts: [{ default: RootLayout }],
          loading: null,
          notFound: null,
          notFounds: [null],
          routeSegments: ["feed"],
          slots: {
            modal: {
              default: null,
              error: null,
              id: modalSlotId,
              layout: null,
              layoutIndex: 0,
              loading: null,
              name: "modal",
              page: null,
              routeSegments: null,
            },
          },
          templateTreePositions: [],
          templates: [],
        },
        routePath: "/photo/42",
        rootNotFoundModule: null,
        semanticInterceptionTargetRouteId: targetRouteId,
        slotOverrides: {
          modal: {
            branchSegments: identitySegments.map((segment) => segment.replace("(.)", "")),
            identitySegments: toSemanticSegments(identitySegments),
            pageModule: { default: SlotPage },
            params: { id: "42" },
            routeSegments: identitySegments.map((segment) => segment.replace("(.)", "")),
          },
        },
      });
      const identities = elements[AppElementsWire.keys.bfcacheSegmentIdentities];
      if (typeof identities !== "object" || identities === null || Array.isArray(identities)) {
        throw new Error("Expected BFCache identity metadata");
      }
      return identities as Readonly<Record<string, string>>;
    };

    const base = buildIdentities(["(.)photo", "[id]"], "graph-route:/photo/[id]");
    const extended = buildIdentities(
      ["(.)photo", "[id]", "details"],
      "graph-route:/photo/[id]/details",
    );
    const baseSegmentIds = Object.keys(base)
      .filter((id) => id.startsWith("slot:\0vinext_bfcache_segment_"))
      .sort();
    const extendedSegmentIds = Object.keys(extended)
      .filter((id) => id.startsWith("slot:\0vinext_bfcache_segment_"))
      .sort();

    expect(baseSegmentIds).toHaveLength(2);
    expect(extendedSegmentIds).toHaveLength(3);
    expect(extended[extendedSegmentIds[0]!]).toBe(base[baseSegmentIds[0]!]);
    expect(extended[extendedSegmentIds[1]!]).toBe(base[baseSegmentIds[1]!]);
    expect(base[extendedSegmentIds[2]!]).toBeUndefined();
    expect(extended[extendedSegmentIds[2]!]).toBeTypeOf("string");
  });

  it("keys synthetic children-slot page elements with their emitted identity", () => {
    const childrenSlotId = AppElementsWire.encodeSlotId("children", "/");
    const buildElements = (id: string) =>
      buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(value) {
          return Promise.resolve(value);
        },
        matchedParams: { id },
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          childrenSlot: {
            id: "graph-slot:children",
            ownerTreePath: "/",
            state: "active",
          },
          error: null,
          errors: [null],
          layoutTreePositions: [0],
          layouts: [{ default: RootLayout }],
          loading: null,
          notFound: null,
          notFounds: [null],
          routeSegments: ["photos", "[id]"],
          templateTreePositions: [],
          templates: [],
        },
        routePath: `/photos/${id}`,
        rootNotFoundModule: null,
      });

    const firstIdentity = AppElementsWire.readMetadata(buildElements("42"))
      .bfcacheSegmentIdentities[childrenSlotId];
    const repeatedIdentity = AppElementsWire.readMetadata(buildElements("42"))
      .bfcacheSegmentIdentities[childrenSlotId];
    const changedIdentity = AppElementsWire.readMetadata(buildElements("43"))
      .bfcacheSegmentIdentities[childrenSlotId];

    expect(firstIdentity).toBeTypeOf("string");
    expect(JSON.parse(firstIdentity)[1]).toBe("graph-slot:children");
    expect(repeatedIdentity).toBe(firstIdentity);
    expect(changedIdentity).not.toBe(firstIdentity);
  });

  it("wraps intercepted slot overrides with intercept layout modules inside the slot layout", async () => {
    function SlotRootLoading() {
      return createElement("p", null, "Slot root loading");
    }

    const sidebarOverride: AppPageSlotOverride<AppPageModule> = {
      layoutModules: [{ default: InterceptOuterLayout }, { default: InterceptInnerLayout }],
      loadingModules: [{ default: SlotLoadingProbe }],
      loadingTreePositions: [1],
      pageModule: { default: SlotPage },
      props: { label: "intercepted" },
    };

    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: { default: SlotLayout },
            layoutIndex: 0,
            loading: { default: SlotRootLoading },
            name: "sidebar",
            page: { default: SlotPage },
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
      slotOverrides: {
        sidebar: sidebarOverride,
      },
    });

    const html = await renderRouteEntry(elements, "route:/dashboard");

    expect(html).toContain('data-slot-layout="sidebar"');
    expect(html).toContain('data-intercept-layout="outer"');
    expect(html).toContain('data-intercept-layout="inner"');
    expect(html).toContain('data-slot-page="intercepted"');
    const slotLayoutPos = html.indexOf('data-slot-layout="sidebar"');
    const outerLayoutPos = html.indexOf('data-intercept-layout="outer"');
    const innerLayoutPos = html.indexOf('data-intercept-layout="inner"');
    const pagePos = html.indexOf('data-slot-page="intercepted"');

    expect(slotLayoutPos).toBeLessThan(outerLayoutPos);
    expect(outerLayoutPos).toBeLessThan(innerLayoutPos);
    expect(innerLayoutPos).toBeLessThan(pagePos);
  });

  it("retains slot-root loading outside intercepted branch loading", () => {
    function SlotRootLoading() {
      return createElement("p", null, "Slot root loading");
    }
    function NormalBranchLoading() {
      return createElement("p", null, "Normal branch loading");
    }

    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [],
        layoutTreePositions: [],
        layouts: [],
        loading: null,
        notFound: null,
        notFounds: [],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: -1,
            loading: { default: SlotRootLoading },
            loadings: [{ default: SlotRootLoading }, { default: NormalBranchLoading }],
            loadingTreePositions: [0, 1],
            name: "sidebar",
            page: { default: SlotPage },
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
      slotOverrides: {
        sidebar: {
          loadingModules: [{ default: SlotLoadingProbe }],
          loadingTreePositions: [1],
          pageModule: { default: SlotPage },
          routeSegments: ["photo"],
        },
      },
    });

    const slotEntry = elements[AppElementsWire.encodeSlotId("sidebar", "/")];
    const rootBoundary = findSuspenseWithFallback(slotEntry, "SlotRootLoading");
    const interceptBoundary = findSuspenseWithFallback(slotEntry, "SlotLoadingProbe");
    expect(rootBoundary).not.toBeNull();
    expect(interceptBoundary).not.toBeNull();
    expect(findSuspenseWithFallback(slotEntry, "NormalBranchLoading")).toBeNull();
    expect(
      findSuspenseWithFallback(rootBoundary?.props.children, "SlotLoadingProbe"),
    ).not.toBeNull();
  });

  it("renders same-named slot props independently at different layout levels", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null, null],
        layoutTreePositions: [0, 1],
        layouts: [{ default: ParentModalLayout }, { default: ChildModalLayout }],
        loading: null,
        notFound: null,
        notFounds: [null, null],
        routeSegments: ["parent", "child"],
        slots: {
          "modal@parent/@modal": {
            default: {
              default: () => createElement("p", { "data-parent-slot": "true" }, "parent-slot"),
            },
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "modal",
            page: null,
            routeSegments: null,
          },
          "modal@parent/child/@modal": {
            default: {
              default: () => createElement("p", { "data-child-slot": "true" }, "child-slot"),
            },
            error: null,
            layout: null,
            layoutIndex: 1,
            loading: null,
            name: "modal",
            page: null,
            routeSegments: null,
          },
        },
        templateTreePositions: [0, 1],
        templates: [null, null],
      },
      routePath: "/parent/child",
      rootNotFoundModule: null,
    });

    const html = await renderRouteEntry(elements, "route:/parent/child");

    expect(html).toContain('data-layout="parent-modal-layout"');
    expect(html).toContain('data-layout="child-modal-layout"');
    expect(html).toContain('data-parent-slot="true"');
    expect(html).toContain("parent-slot");
    expect(html).toContain('data-child-slot="true"');
    expect(html).toContain("child-slot");
  });

  it("does not apply ambiguous name-only slot overrides when same-named slots exist", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null, null],
        layoutTreePositions: [0, 1],
        layouts: [{ default: ParentModalLayout }, { default: ChildModalLayout }],
        loading: null,
        notFound: null,
        notFounds: [null, null],
        routeSegments: ["parent", "child"],
        slots: {
          "modal@parent/@modal": {
            default: {
              default: () => createElement("p", { "data-parent-slot": "true" }, "parent-slot"),
            },
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "modal",
            page: null,
            routeSegments: null,
          },
          "modal@parent/child/@modal": {
            default: {
              default: () => createElement("p", { "data-child-slot": "true" }, "child-slot"),
            },
            error: null,
            layout: null,
            layoutIndex: 1,
            loading: null,
            name: "modal",
            page: null,
            routeSegments: null,
          },
        },
        templateTreePositions: [0, 1],
        templates: [null, null],
      },
      routePath: "/parent/child",
      rootNotFoundModule: null,
      slotOverrides: {
        modal: {
          pageModule: { default: SlotPage },
          props: { label: "ambiguous-override" },
        },
      },
    });

    const html = await renderRouteEntry(elements, "route:/parent/child");

    expect(html).toContain('data-parent-slot="true"');
    expect(html).toContain("parent-slot");
    expect(html).toContain('data-child-slot="true"');
    expect(html).toContain("child-slot");
    expect(html).not.toContain('data-slot-page="ambiguous-override"');
  });

  it("omits slot key on RSC request when slot has only default.tsx (no page) and slot is already mounted", () => {
    const DefaultPage = () => createElement("p", null, "default-slot");
    const elements = buildAppPageElements({
      isRscRequest: true,
      mountedSlotIds: new Set(["slot:team:/"]),
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: [],
        slots: {
          team: {
            default: { default: DefaultPage },
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "team",
            page: null,
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/",
      rootNotFoundModule: null,
    });

    // On RSC soft nav, a slot with only default.tsx (no page) should have its
    // key absent so the browser retains prior content — but only when the slot
    // is already mounted (browser told us via X-Vinext-Mounted-Slots header).
    expect(elements["slot:team:/"]).toBeUndefined();
  });

  it("renders slot default.tsx on RSC request when slot is not in mountedSlotIds (first entry)", () => {
    const DefaultPage = () => createElement("p", null, "default-slot");
    const elements = buildAppPageElements({
      isRscRequest: true,
      mountedSlotIds: new Set([]),
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: [],
        slots: {
          team: {
            default: { default: DefaultPage },
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "team",
            page: null,
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/",
      rootNotFoundModule: null,
    });

    // Even on an RSC request, when the slot has not been mounted on the client
    // yet (first navigation into this layout), default.tsx must render so the
    // initial slot content is populated.
    expect(elements["slot:team:/"]).toBeDefined();
  });

  it("renders slot default.tsx without its slot layout on hard navigation", async () => {
    const DefaultPage = () => createElement("p", null, "default-slot");
    const elements = buildAppPageElements({
      isRscRequest: false,
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: [],
        slots: {
          sidebar: {
            default: { default: DefaultPage },
            error: null,
            layout: { default: SlotLayout },
            layoutIndex: 0,
            loading: null,
            name: "sidebar",
            page: null,
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/",
      rootNotFoundModule: null,
    });

    // On hard navigation the default.tsx must render so the initial HTML is
    // fully populated, but Next.js does not wrap the fallback in the slot's
    // own layout because default.tsx sits beside that layout in the loader tree.
    expect(elements["slot:sidebar:/"]).toBeDefined();
    const html = await renderRouteEntry(elements, "route:/");
    expect(html).toContain("default-slot");
    expect(html).not.toContain('data-slot-layout="sidebar"');
  });

  it.each([
    {
      label: "page module without default export",
      slotModule: { default: null, page: {} },
    },
    {
      label: "default module without default export",
      slotModule: { default: {}, page: null },
    },
  ])("marks slots unmatched when the effective $label is not renderable", ({ slotModule }) => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: [],
        slots: {
          team: {
            default: slotModule.default,
            error: null,
            layout: null,
            layoutIndex: 0,
            loading: null,
            name: "team",
            page: slotModule.page,
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/",
      rootNotFoundModule: null,
    });

    expect(elements[APP_SLOT_BINDINGS_KEY]).toEqual([
      {
        ownerLayoutId: "layout:/",
        slotId: "slot:team:/",
        state: "unmatched",
      },
    ]);
    expect(elements["slot:team:/"]).toBe(APP_UNMATCHED_SLOT_WIRE_VALUE);
  });

  it("does not deadlock when a layout renders without children", async () => {
    const elements = buildAppPageElements({
      element: createElement("main", null, "Page content"),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: LayoutWithoutChildren }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: [],
        slots: null,
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/layout-only",
      rootNotFoundModule: null,
    });

    const body = await withTimeout(renderRouteEntry(elements, "route:/layout-only"), 1_000);

    expect(body).toContain("Layout only");
    expect(body).not.toContain("Page content");
  });

  it("preserves route subtree when a layout entry has no default export", async () => {
    const elements = buildAppPageElements({
      element: createElement("main", null, "Page content"),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null, null],
        layoutTreePositions: [0, 1],
        layouts: [{ default: RootLayout }, null],
        loading: null,
        notFound: null,
        notFounds: [null, null],
        routeSegments: ["dashboard"],
        slots: null,
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
    });

    const body = await renderRouteEntry(elements, "route:/dashboard");

    expect(body).toContain('data-layout="root"');
    expect(body).toContain("Page content");
  });

  it("waits for template-only segments before serializing the page entry", async () => {
    let activeLocale = "en";

    async function AsyncTemplate(props: Record<string, unknown>) {
      await Promise.resolve();
      activeLocale = "de";
      return createElement("div", { "data-template": "async" }, readChildren(props.children));
    }

    function LocalePage() {
      return createElement("main", null, `page:${activeLocale}`);
    }

    const elements = buildAppPageElements({
      element: createElement(LocalePage),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [],
        layoutTreePositions: [],
        layouts: [],
        loading: null,
        notFound: null,
        notFounds: [],
        routeSegments: ["blog"],
        slots: null,
        templateTreePositions: [1],
        templates: [{ default: AsyncTemplate }],
      },
      routePath: "/blog",
      rootNotFoundModule: null,
    });

    const body = await renderHtml(
      createElement(
        Fragment,
        null,
        readChildren(elements["template:/blog"]),
        readChildren(elements["page:/blog"]),
      ),
    );

    expect(body).toContain("page:de");
    expect(body).not.toContain("page:en");
  });

  it("waits for page initialization before serializing parallel slot entries", async () => {
    let activeLocale = "en";
    const pageRenderDependency = createAppPageRenderDependency();

    function LocaleSlot() {
      return createElement("aside", null, `slot:${activeLocale}`);
    }

    const elements = buildAppPageElements({
      element: createElement("main", null, "Page content"),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      pageRenderDependency,
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [],
        layoutTreePositions: [],
        layouts: [],
        loading: null,
        notFound: null,
        notFounds: [],
        routeSegments: ["dashboard"],
        slots: {
          sidebar: {
            default: null,
            error: null,
            layout: null,
            layoutIndex: -1,
            loading: null,
            name: "sidebar",
            page: { default: LocaleSlot },
            routeSegments: [],
          },
        },
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard",
      rootNotFoundModule: null,
    });

    const slotId = AppElementsWire.encodeSlotId("sidebar", "/");
    let slotRenderSettled = false;
    const slotHtmlPromise = renderHtml(readChildren(elements[slotId])).then((html) => {
      slotRenderSettled = true;
      return html;
    });

    await Promise.resolve();
    expect(slotRenderSettled).toBe(false);

    activeLocale = "de";
    pageRenderDependency.release();
    const html = await withTimeout(slotHtmlPromise, 1_000);

    expect(html).toContain("slot:de");
    expect(html).not.toContain("slot:en");
  });

  it("preserves parent-before-child execution under an ancestor loading boundary", async () => {
    let activeLocale = "en";

    async function AsyncTemplate(props: Record<string, unknown>) {
      await Promise.resolve();
      activeLocale = "de";
      return createElement("div", null, readChildren(props.children));
    }
    function LocalePage() {
      return createElement("main", null, `page:${activeLocale}`);
    }

    const elements = buildAppPageElements({
      element: createElement(LocalePage),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [],
        layoutTreePositions: [],
        layouts: [],
        loading: null,
        loadings: [{ default: RouteLoadingProbe }],
        loadingTreePositions: [0],
        notFound: null,
        notFounds: [],
        routeSegments: ["blog"],
        slots: null,
        templateTreePositions: [1],
        templates: [{ default: AsyncTemplate }],
      },
      routePath: "/blog",
      rootNotFoundModule: null,
    });

    const body = await renderHtml(
      createElement(
        Fragment,
        null,
        readChildren(elements["template:/blog"]),
        readChildren(elements["page:/blog"]),
      ),
    );

    expect(body).toContain("page:de");
    expect(body).not.toContain("page:en");
  });

  it("releases skipped layout dependencies before serializing retained child entries", async () => {
    let activeLocale = "en";

    async function StaticLayout(props: Record<string, unknown>) {
      await Promise.resolve();
      activeLocale = "de";
      return createElement("div", { "data-layout": "static" }, readChildren(props.children));
    }

    function LocalePage() {
      return createElement("main", null, `page:${activeLocale}`);
    }

    const elements = buildAppPageElements({
      element: createElement(LocalePage),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: StaticLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["skip-layout"],
        slots: null,
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/skip-layout",
      rootNotFoundModule: null,
    });

    const payload = buildOutgoingAppPayload({
      element: elements,
      layoutFlags: { "layout:/": "s" },
      skipDisposition: {
        code: "SKIP_STATIC_LAYOUT_VERIFIED",
        enabled: true,
        mode: "skipStaticLayout",
        skippedEntryIds: ["layout:/"],
      },
    });

    expect(isAppElementsRecord(payload)).toBe(true);
    if (!isAppElementsRecord(payload)) return;
    expect(Object.hasOwn(payload, "layout:/")).toBe(false);

    const body = await withTimeout(renderHtml(readChildren(payload["page:/skip-layout"])), 1_000);

    expect(body).toContain("page:en");
  });

  it("renders template-only segments in the route entry even without a matching layout", async () => {
    function BlogTemplate(props: Record<string, unknown>) {
      return createElement("div", { "data-template": "blog" }, readChildren(props.children));
    }

    function BlogPage() {
      return createElement("main", null, "Blog page");
    }

    const elements = buildAppPageElements({
      element: createElement(BlogPage),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["blog"],
        slots: null,
        templateTreePositions: [1],
        templates: [{ default: BlogTemplate }],
      },
      routePath: "/blog",
      rootNotFoundModule: null,
    });

    const body = await renderRouteEntry(elements, "route:/blog");

    expect(body).toContain('data-layout="root"');
    expect(body).toContain('data-template="blog"');
    expect(body).toContain("Blog page");
  });

  // Ported from Next.js: test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
  it("wraps the streaming metadata outlet in the built-in not-found boundary", () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      streamingMetadataOutlet: Promise.resolve(null),
      streamingMetadataOutletSuspended: true,
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["metadata-not-found"],
        slots: {},
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/metadata-not-found",
      rootNotFoundModule: null,
    });

    const notFoundBoundary = findElementByTypeName(
      elements["route:/metadata-not-found"],
      "NotFoundBoundary",
    );

    expect(notFoundBoundary).not.toBeNull();
    if (!notFoundBoundary) throw new Error("Expected the built-in not-found boundary");
    expect(getElementTypeName((notFoundBoundary.props.fallback as ReactElement).type)).toBe(
      "DefaultNotFound",
    );
    expect(
      findSlotById(
        notFoundBoundary.props.children,
        "__vinext_streaming_metadata_outlet:route:/metadata-not-found",
      ),
    ).not.toBeNull();
  });

  it("owns the built-in not-found boundary at the root layout", () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null, null],
        layoutTreePositions: [0, 1],
        layouts: [{ default: RootLayout }, { default: GroupLayout }],
        loading: null,
        notFound: null,
        notFounds: [null, null],
        routeSegments: ["dashboard", "reports"],
        slots: {},
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/dashboard/reports",
      rootNotFoundModule: null,
    });

    const routeEntry = elements["route:/dashboard/reports"];
    const rootLayoutSlot = findSlotById(routeEntry, "layout:/");
    const nestedLayoutSlot = findSlotById(routeEntry, "layout:/dashboard");
    expect(rootLayoutSlot).not.toBeNull();
    expect(nestedLayoutSlot).not.toBeNull();
    if (!rootLayoutSlot || !nestedLayoutSlot) {
      throw new Error("Expected both root and nested layout slots");
    }

    const rootNotFoundBoundary = findElementByTypeName(
      rootLayoutSlot.props.children,
      "NotFoundBoundary",
    );
    expect(rootNotFoundBoundary).not.toBeNull();
    if (!rootNotFoundBoundary) throw new Error("Expected the built-in not-found boundary");
    expect(getElementTypeName((rootNotFoundBoundary.props.fallback as ReactElement).type)).toBe(
      "DefaultNotFound",
    );
    expect(findSlotById(rootNotFoundBoundary.props.children, "layout:/dashboard")).not.toBeNull();
    expect(findElementByTypeName(nestedLayoutSlot.props.children, "NotFoundBoundary")).toBeNull();
  });

  it("nests per-segment NotFoundBoundary inside the template wrapper", () => {
    function RootNotFound() {
      return createElement("div", { "data-not-found": "root" }, "Not Found");
    }

    function LeafPage() {
      return createElement("main", null, "Page");
    }

    const elements = buildAppPageElements({
      element: createElement(LeafPage),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [{ default: RootNotFound }],
        routeSegments: ["blog"],
        slots: {},
        templateTreePositions: [0],
        templates: [{ default: RootTemplate }],
      },
      routePath: "/blog",
      rootNotFoundModule: null,
    });

    function walkDepth(node: unknown, depth: number, found: Map<string, number>): void {
      if (!isValidElement(node)) return;
      const element = node as { type: unknown; props: Record<string, unknown> };

      if (typeof element.props.id === "string" && element.props.id.startsWith("template:")) {
        found.set(`template:${element.props.id}`, depth);
      }

      const typeName =
        typeof element.type === "function"
          ? ((element.type as { displayName?: string; name?: string }).displayName ??
            (element.type as { name?: string }).name ??
            "")
          : typeof element.type === "string"
            ? element.type
            : "";

      if (!found.has(typeName)) {
        found.set(typeName, depth);
      }

      const { children, ...rest } = element.props;
      for (const value of Object.values(rest)) {
        walkDepth(value, depth + 1, found);
      }
      if (Array.isArray(children)) {
        for (const child of children) {
          walkDepth(child, depth + 1, found);
        }
      } else {
        walkDepth(children, depth + 1, found);
      }
    }

    const depthMap = new Map<string, number>();
    walkDepth(elements["route:/blog"], 0, depthMap);

    const templateDepth = depthMap.get("template:template:/");
    const notFoundDepth = depthMap.get("NotFoundBoundaryInner") ?? depthMap.get("NotFoundBoundary");

    expect(templateDepth).toBeDefined();
    expect(notFoundDepth).toBeDefined();
    expect(templateDepth).toBeLessThan(notFoundDepth!);
  });

  it("keys template slots with the semantic segment state key", () => {
    function LeafTemplate(props: { children?: ReactNode }) {
      return createElement("section", { "data-template": "leaf" }, readChildren(props.children));
    }

    const buildElements = (slug: string) =>
      buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(params) {
          return Promise.resolve(params);
        },
        matchedParams: { slug },
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null, null],
          ids: {
            layouts: ["graph-layout:/", "graph-layout:/docs"],
            page: "graph-page:/docs/[slug]",
            rootBoundary: "graph-root:/",
            route: "graph-route:/docs/[slug]",
            routeHandler: null,
            slots: {},
            templates: ["graph-template:/docs"],
          },
          layoutTreePositions: [0, 1],
          layouts: [{ default: RootLayout }, { default: GroupLayout }],
          loading: null,
          notFound: null,
          notFounds: [null, null],
          routeSegments: ["docs", "[slug]"],
          slots: {},
          templateTreePositions: [1],
          templates: [{ default: LeafTemplate }],
        },
        routePath: `/docs/${slug}`,
        rootNotFoundModule: null,
      });
    const elements = buildElements("launch");

    const templateSlot = findSlotById(elements["route:/docs/launch"], "template:/docs");

    expect(templateSlot).not.toBeNull();
    expect(templateSlot?.key).toBe(JSON.stringify(["docs", "slug|launch|d"]));
    expect(
      AppElementsWire.readMetadata(buildElements("release")).bfcacheSegmentIdentities[
        "template:/docs"
      ],
    ).not.toBe(AppElementsWire.readMetadata(elements).bfcacheSegmentIdentities["template:/docs"]);

    const buildTenantElements = (tenant: string) =>
      buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(params) {
          return Promise.resolve(params);
        },
        matchedParams: { tenant },
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null, null],
          ids: {
            layouts: ["graph-layout:/", "graph-layout:/[tenant]"],
            page: "graph-page:/[tenant]/settings",
            rootBoundary: "graph-root:/",
            route: "graph-route:/[tenant]/settings",
            routeHandler: null,
            slots: {},
            templates: ["graph-template:/[tenant]"],
          },
          layoutTreePositions: [0, 1],
          layouts: [{ default: RootLayout }, { default: GroupLayout }],
          loading: null,
          notFound: null,
          notFounds: [null, null],
          routeSegments: ["[tenant]", "settings"],
          slots: {},
          templateTreePositions: [1],
          templates: [{ default: LeafTemplate }],
        },
        routePath: `/${tenant}/settings`,
        rootNotFoundModule: null,
      });
    const tenantAIdentity = AppElementsWire.readMetadata(buildTenantElements("a"))
      .bfcacheSegmentIdentities["template:/[tenant]"];
    const tenantBIdentity = AppElementsWire.readMetadata(buildTenantElements("b"))
      .bfcacheSegmentIdentities["template:/[tenant]"];
    expect(tenantAIdentity).toBeTypeOf("string");
    expect(tenantBIdentity).not.toBe(tenantAIdentity);

    const buildGroupedElements = (group: string, id: string) =>
      buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(params) {
          return Promise.resolve(params);
        },
        matchedParams: { id },
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null],
          ids: {
            layouts: ["graph-layout:/"],
            page: `graph-page:/${group}/[id]`,
            rootBoundary: "graph-root:/",
            route: `graph-route:/${group}/[id]`,
            routeHandler: null,
            slots: {},
            templates: ["graph-template:/"],
          },
          layoutTreePositions: [0],
          layouts: [{ default: RootLayout }],
          loading: null,
          notFound: null,
          notFounds: [null],
          routeSegments: [group, "[id]"],
          slots: {},
          templateTreePositions: [0],
          templates: [{ default: LeafTemplate }],
        },
        routePath: `/${id}`,
        rootNotFoundModule: null,
      });
    const groupedAIdentity = AppElementsWire.readMetadata(buildGroupedElements("(stable)", "a"))
      .bfcacheSegmentIdentities["template:/"];
    const groupedBIdentity = AppElementsWire.readMetadata(buildGroupedElements("(stable)", "b"))
      .bfcacheSegmentIdentities["template:/"];
    const otherGroupIdentity = AppElementsWire.readMetadata(buildGroupedElements("(other)", "a"))
      .bfcacheSegmentIdentities["template:/"];
    expect(groupedBIdentity).toBe(groupedAIdentity);
    expect(otherGroupIdentity).not.toBe(groupedAIdentity);

    const previousCacheComponents = process.env.__NEXT_CACHE_COMPONENTS;
    process.env.__NEXT_CACHE_COMPONENTS = "true";
    try {
      const cachedElements = buildElements("launch");
      expect(findSlotById(cachedElements["route:/docs/launch"], "template:/docs")?.key).toBeNull();
    } finally {
      if (previousCacheComponents === undefined) {
        delete process.env.__NEXT_CACHE_COMPONENTS;
      } else {
        process.env.__NEXT_CACHE_COMPONENTS = previousCacheComponents;
      }
    }
  });

  it("nests per-segment loading boundaries around slow child layouts without duplicating the leaf", () => {
    function ParentLoading() {
      return createElement("p", null, "Loading layout");
    }

    function LeafLoading() {
      return createElement("p", null, "Loading page");
    }

    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null, null],
        layoutTreePositions: [0, 2],
        layouts: [{ default: RootLayout }, { default: GroupLayout }],
        loading: { default: LeafLoading },
        loadings: [{ default: ParentLoading }, { default: LeafLoading }],
        loadingTreePositions: [1, 2],
        notFound: null,
        notFounds: [null, null],
        routeSegments: ["parent", "slow"],
        slots: {},
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/parent/slow",
      rootNotFoundModule: null,
    });

    const routeEntry = elements["route:/parent/slow"];
    const parentBoundary = findSuspenseWithFallback(routeEntry, "ParentLoading");
    const leafBoundary = findSuspenseWithFallback(routeEntry, "LeafLoading");

    expect(parentBoundary?.key).toBe("slow");
    expect(leafBoundary?.key).toBe(JSON.stringify(["parent", "slow"]));
    expect(findSuspenseWithFallback(parentBoundary?.props.children, "LeafLoading")).not.toBeNull();
    expect(findSlotById(parentBoundary?.props.children, "layout:/parent/slow")).not.toBeNull();
    expect(countSuspenseWithFallback(routeEntry, "LeafLoading")).toBe(1);
  });

  it("threads route state reset keys into loading, error, and not-found boundaries", () => {
    function RouteLoading() {
      return createElement("p", null, "Loading");
    }

    function RouteError() {
      return createElement("p", null, "Error");
    }

    function RouteNotFound() {
      return createElement("p", null, "Not Found");
    }

    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: { id: "alpha" },
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: { default: RouteError },
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: { default: RouteLoading },
        notFound: { default: RouteNotFound },
        notFounds: [null],
        routeSegments: ["products", "[id]"],
        slots: {},
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/products/alpha",
      rootNotFoundModule: null,
    });

    const routeEntry = elements["route:/products/alpha"];
    const loadingBoundary = findSuspenseWithFallback(routeEntry, "RouteLoading");
    const errorBoundary = findElementByTypeName(routeEntry, "ErrorBoundary");
    const notFoundBoundary = findElementByTypeName(routeEntry, "NotFoundBoundary");

    expect(loadingBoundary?.key).toBe(JSON.stringify(["products", "id|alpha|d"]));
    expect(errorBoundary?.props.resetKey).toBe(JSON.stringify(["products", "id|alpha|d"]));
    expect(notFoundBoundary?.props.resetKey).toBe(JSON.stringify(["products", "id|alpha|d"]));
  });

  it("does not collide route reset keys across branches with the same dynamic leaf value", () => {
    function RouteLoading() {
      return createElement("p", null, "Loading");
    }

    function RouteError() {
      return createElement("p", null, "Error");
    }

    function RouteNotFound() {
      return createElement("p", null, "Not Found");
    }

    function buildBranchElements(branch: "posts" | "photos") {
      return buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(params) {
          return Promise.resolve(params);
        },
        matchedParams: { id: "123" },
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: { default: RouteError },
          errors: [null],
          layoutTreePositions: [0],
          layouts: [{ default: RootLayout }],
          loading: { default: RouteLoading },
          notFound: { default: RouteNotFound },
          notFounds: [null],
          routeSegments: ["reset-collision", branch, "[id]"],
          slots: {},
          templateTreePositions: [],
          templates: [],
        },
        routePath: `/reset-collision/${branch}/123`,
        rootNotFoundModule: null,
      })[`route:/reset-collision/${branch}/123`];
    }

    const postsRoute = buildBranchElements("posts");
    const photosRoute = buildBranchElements("photos");
    const postsLoadingBoundary = findSuspenseWithFallback(postsRoute, "RouteLoading");
    const photosLoadingBoundary = findSuspenseWithFallback(photosRoute, "RouteLoading");
    const postsErrorBoundary = findElementByTypeName(postsRoute, "ErrorBoundary");
    const photosErrorBoundary = findElementByTypeName(photosRoute, "ErrorBoundary");
    const postsNotFoundBoundary = findElementByTypeName(postsRoute, "NotFoundBoundary");
    const photosNotFoundBoundary = findElementByTypeName(photosRoute, "NotFoundBoundary");

    expect(postsLoadingBoundary?.key).toBe(
      JSON.stringify(["reset-collision", "posts", "id|123|d"]),
    );
    expect(photosLoadingBoundary?.key).toBe(
      JSON.stringify(["reset-collision", "photos", "id|123|d"]),
    );
    expect(postsLoadingBoundary?.key).not.toBe(photosLoadingBoundary?.key);
    expect(postsErrorBoundary?.props.resetKey).not.toBe(photosErrorBoundary?.props.resetKey);
    expect(postsNotFoundBoundary?.props.resetKey).not.toBe(photosNotFoundBoundary?.props.resetKey);
  });

  it("does not collide route reset keys across static branches with the same leaf segment", () => {
    function RouteLoading() {
      return createElement("p", null, "Loading");
    }

    function RouteError() {
      return createElement("p", null, "Error");
    }

    function buildStaticBranchElements(branch: "account" | "admin") {
      return buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(params) {
          return Promise.resolve(params);
        },
        matchedParams: {},
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: { default: RouteError },
          errors: [null],
          layoutTreePositions: [0],
          layouts: [{ default: RootLayout }],
          loading: { default: RouteLoading },
          notFound: null,
          notFounds: [null],
          routeSegments: ["reset-collision", branch, "settings"],
          slots: {},
          templateTreePositions: [],
          templates: [],
        },
        routePath: `/reset-collision/${branch}/settings`,
        rootNotFoundModule: null,
      })[`route:/reset-collision/${branch}/settings`];
    }

    const accountRoute = buildStaticBranchElements("account");
    const adminRoute = buildStaticBranchElements("admin");
    const accountLoadingBoundary = findSuspenseWithFallback(accountRoute, "RouteLoading");
    const adminLoadingBoundary = findSuspenseWithFallback(adminRoute, "RouteLoading");
    const accountErrorBoundary = findElementByTypeName(accountRoute, "ErrorBoundary");
    const adminErrorBoundary = findElementByTypeName(adminRoute, "ErrorBoundary");

    expect(accountLoadingBoundary?.key).toBe(
      JSON.stringify(["reset-collision", "account", "settings"]),
    );
    expect(adminLoadingBoundary?.key).toBe(
      JSON.stringify(["reset-collision", "admin", "settings"]),
    );
    expect(accountLoadingBoundary?.key).not.toBe(adminLoadingBoundary?.key);
    expect(accountErrorBoundary?.props.resetKey).not.toBe(adminErrorBoundary?.props.resetKey);
  });

  it("threads segment reset keys into boundaries even without template.tsx", () => {
    function SegmentError() {
      return createElement("p", null, "Segment Error");
    }

    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: { slug: "intro" },
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errorPaths: [{ default: SegmentError }],
        errors: [null],
        errorTreePositions: [1],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: ["docs", "[slug]"],
        slots: {},
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/docs/intro",
      rootNotFoundModule: null,
    });

    const errorBoundary = findElementByTypeName(elements["route:/docs/intro"], "ErrorBoundary");

    expect(errorBoundary?.props.resetKey).toBe("slug|intro|d");
  });

  it("nests user global errors inside the default global error fallback", () => {
    function UserGlobalError() {
      return createElement("p", null, "User global error");
    }

    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      globalErrorModule: { default: UserGlobalError },
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: [],
        slots: {},
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/",
      rootNotFoundModule: null,
    });

    const routeEntry = elements["route:/"];
    const outerBoundary = findElementByTypeName(routeEntry, "GlobalErrorBoundary");
    const userBoundary = findElementByTypeName(outerBoundary?.props.children, "ErrorBoundary");

    expect(getElementTypeName(outerBoundary?.props.fallback)).toBe("DefaultGlobalError");
    expect(userBoundary?.props.fallback).toBe(UserGlobalError);
  });

  it("installs the default global error boundary without a user global error", () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams: (params) => Promise.resolve(params),
      matchedParams: {},
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null],
        layoutTreePositions: [0],
        layouts: [{ default: RootLayout }],
        loading: null,
        notFound: null,
        notFounds: [null],
        routeSegments: [],
        slots: {},
        templateTreePositions: [],
        templates: [],
      },
      routePath: "/",
      rootNotFoundModule: null,
    });

    const outerBoundary = findElementByTypeName(elements["route:/"], "GlobalErrorBoundary");
    expect(getElementTypeName(outerBoundary?.props.fallback)).toBe("DefaultGlobalError");
  });

  it("interleaves templates with their corresponding layouts", async () => {
    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: { slug: "post" },
      resolvedMetadata: null,
      resolvedViewport: {},
      route: {
        error: null,
        errors: [null, null],
        layoutTreePositions: [0, 1],
        layouts: [{ default: RootLayout }, { default: GroupLayout }],
        loading: null,
        notFound: null,
        notFounds: [null, null],
        routeSegments: ["(marketing)", "blog", "[slug]"],
        slots: {},
        templateTreePositions: [0, 1],
        templates: [{ default: RootTemplate }, { default: GroupTemplate }],
      },
      routePath: "/blog/post",
      rootNotFoundModule: null,
    });

    const html = await renderRouteEntry(elements, "route:/blog/post");

    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-layout="group"');
    expect(html).toContain('data-template="root"');
    expect(html).toContain('data-template="group"');

    const rootLayoutPos = html.indexOf('data-layout="root"');
    const rootTemplatePos = html.indexOf('data-template="root"');
    const groupLayoutPos = html.indexOf('data-layout="group"');
    const groupTemplatePos = html.indexOf('data-template="group"');
    const pagePos = html.indexOf("data-page-segments=");

    expect(rootLayoutPos).toBeLessThan(rootTemplatePos);
    expect(rootTemplatePos).toBeLessThan(groupLayoutPos);
    expect(groupLayoutPos).toBeLessThan(groupTemplatePos);
    expect(groupTemplatePos).toBeLessThan(pagePos);
  });
});
