import { Fragment, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";
import { useSelectedLayoutSegments } from "../packages/vinext/src/shims/navigation.js";
import {
  APP_PREFETCH_LOADING_SHELL_MARKER_KEY,
  APP_SOURCE_PAGE_KEY,
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
} from "../packages/vinext/src/server/app-page-route-wiring.js";
import { createAppLayoutParamAccessTracker } from "../packages/vinext/src/server/app-layout-param-observation.js";
import { APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL } from "../packages/vinext/src/server/app-rsc-render-mode.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import { buildPageElements as buildResolvedPageElements } from "../packages/vinext/src/server/app-page-element-builder.js";

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
          createElement(Slot, { id: routeId }),
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

      expect(elements[APP_SOURCE_PAGE_KEY]).toBe(sourcePage);
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
    expect(elements.__sourcePage).toBe("/(marketing)/blog/[slug]/page");
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
    const fooBoundary = findElementByTypeName(
      buildInterceptedElements({ username: "foo", id: "1" })[modalSlotId],
      "ErrorBoundary",
    );
    const barBoundary = findElementByTypeName(
      buildInterceptedElements({ username: "bar", id: "2" })[modalSlotId],
      "ErrorBoundary",
    );

    expect(fooBoundary?.props.resetKey).toBe(JSON.stringify(["username|foo|d", "id|1|d"]));
    expect(barBoundary?.props.resetKey).toBe(JSON.stringify(["username|bar|d", "id|2|d"]));
    expect(barBoundary?.props.resetKey).not.toBe(fooBoundary?.props.resetKey);
  });

  it("wraps intercepted slot overrides with intercept layout modules inside the slot layout", async () => {
    const sidebarOverride: AppPageSlotOverride<AppPageModule> = {
      layoutModules: [{ default: InterceptOuterLayout }, { default: InterceptInnerLayout }],
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
            loading: null,
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

    const elements = buildAppPageElements({
      element: createElement(PageProbe),
      makeThenableParams(params) {
        return Promise.resolve(params);
      },
      matchedParams: { slug: "launch" },
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
        routeSegments: ["docs", "[slug]"],
        slots: {},
        templateTreePositions: [1],
        templates: [{ default: LeafTemplate }],
      },
      routePath: "/docs/launch",
      rootNotFoundModule: null,
    });

    const templateSlot = findSlotById(elements["route:/docs/launch"], "template:/docs");

    expect(templateSlot).not.toBeNull();
    expect(templateSlot?.key).toBe("slug|launch|d");
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
