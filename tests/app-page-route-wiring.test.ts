import { Fragment, createElement, isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";
import { useSelectedLayoutSegments } from "../packages/vinext/src/shims/navigation.js";
import type { AppElements } from "../packages/vinext/src/server/app-elements.js";
import {
  type AppPageModule,
  type AppPageSlotOverride,
  buildAppPageElements,
  createAppPageLayoutEntries,
  resolveAppPageChildSegments,
} from "../packages/vinext/src/server/app-page-route-wiring.js";

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

function GroupTemplate(props: Record<string, unknown>) {
  return createElement("div", { "data-template": "group" }, readChildren(props.children));
}

function PageProbe() {
  const segments = useSelectedLayoutSegments();
  return createElement("main", { "data-page-segments": segments.join("|") }, "Page");
}

function LayoutWithoutChildren() {
  return createElement("div", { "data-layout": "without-children" }, "Layout only");
}

describe("app page route wiring helpers", () => {
  it("resolves child segments from tree positions and preserves route groups", () => {
    expect(
      resolveAppPageChildSegments(["(marketing)", "blog", "[slug]", "[...parts]"], 1, {
        parts: ["a", "b"],
        slug: "post",
      }),
    ).toEqual(["blog", "post", "a/b"]);
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

  it("builds a flat elements map with route, layout, template, page, and slot entries", async () => {
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
    expect(elements.__rootLayout).toBe("/");
    expect(elements["layout:/"]).toBeDefined();
    expect(elements["layout:/(marketing)"]).toBeDefined();
    expect(elements["template:/(marketing)"]).toBeDefined();
    expect(elements["page:/blog/post"]).toBeDefined();
    expect(elements["slot:sidebar:/"]).toBeDefined();
    expect(elements["route:/blog/post"]).toBeDefined();

    const html = await renderRouteEntry(elements, "route:/blog/post");

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

  it("renders slot default.tsx on hard navigation when slot has no page", () => {
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

    // On hard navigation the default.tsx must render so the initial HTML is
    // fully populated.
    expect(elements["slot:team:/"]).toBeDefined();
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
