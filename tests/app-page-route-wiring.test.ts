import { createElement, isValidElement, type ReactNode } from "react";
import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { useSelectedLayoutSegments } from "../packages/vinext/src/shims/navigation.js";
import {
  buildAppPageRouteElement,
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

function RootLayout(props: Record<string, unknown>) {
  const segments = useSelectedLayoutSegments();
  return createElement(
    "div",
    {
      "data-layout": "root",
      "data-segments": segments.join("|"),
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

function SlotPage(props: Record<string, unknown>) {
  return createElement("p", { "data-slot-page": readNode(props.label) }, readNode(props.label));
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

describe("app page route wiring helpers", () => {
  it("resolves child segments from tree positions and preserves route groups", () => {
    expect(
      resolveAppPageChildSegments(["(marketing)", "blog", "[slug]", "[...parts]"], 1, {
        parts: ["a", "b"],
        slug: "post",
      }),
    ).toEqual(["blog", "post", "a/b"]);
  });

  it("passes route group segments through unchanged", () => {
    expect(resolveAppPageChildSegments(["(auth)", "login"], 0, {})).toEqual(["(auth)", "login"]);
  });

  it("skips optional catch-all when param is undefined", () => {
    expect(resolveAppPageChildSegments(["docs", "[[...slug]]"], 0, {})).toEqual(["docs"]);
  });

  it("skips optional catch-all when param is an empty array", () => {
    expect(resolveAppPageChildSegments(["docs", "[[...slug]]"], 0, { slug: [] })).toEqual(["docs"]);
  });

  it("falls back to raw segment for dynamic param with undefined value", () => {
    expect(resolveAppPageChildSegments(["blog", "[id]"], 0, {})).toEqual(["blog", "[id]"]);
  });

  it("preserves empty-string param instead of falling back to raw segment", () => {
    expect(resolveAppPageChildSegments(["blog", "[...slug]"], 0, { slug: "" })).toEqual([
      "blog",
      "",
    ]);
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

  it("wires templates, slots, and layout segment providers from the route tree", () => {
    const element = buildAppPageRouteElement({
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
            page: { default: SlotPage },
          },
        },
        templates: [null, { default: GroupTemplate }],
      },
      rootNotFoundModule: null,
      slotOverrides: {
        sidebar: {
          pageModule: { default: SlotPage },
          params: { slug: "post" },
          props: { label: "intercepted" },
        },
      },
    });

    const html = ReactDOMServer.renderToStaticMarkup(element);

    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-layout="group"');
    expect(html).toContain('data-template="group"');
    // GroupTemplate must be inside GroupLayout, not RootLayout
    const groupLayoutPos = html.indexOf('data-layout="group"');
    const groupTemplatePos = html.indexOf('data-template="group"');
    expect(groupLayoutPos).toBeLessThan(groupTemplatePos);
    expect(html).toContain('data-slot-layout="sidebar"');
    expect(html).toContain('data-slot-page="intercepted"');
    expect(html).toContain('data-page-segments=""');
    expect(html).toContain('data-segments="(marketing)|blog|post"');
    expect(html).toContain('data-segments="blog|post"');
  });

  it("interleaves templates with their corresponding layouts (Layout[i] > Template[i])", () => {
    // Next.js nesting order per segment: Layout > Template > ErrorBoundary > children
    // With two levels, the correct tree is:
    //   Layout[0] > Template[0] > Layout[1] > Template[1] > Page
    //
    // The bug was: Layout[0] > Layout[1] > Template[0] > Template[1] > Page
    // (all templates grouped as a batch, then all layouts grouped separately)

    const element = buildAppPageRouteElement({
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
        templates: [{ default: RootTemplate }, { default: GroupTemplate }],
      },
      rootNotFoundModule: null,
    });

    const html = ReactDOMServer.renderToStaticMarkup(element);

    // Both layouts and templates must be present
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-layout="group"');
    expect(html).toContain('data-template="root"');
    expect(html).toContain('data-template="group"');

    // Verify interleaving order: Layout[0] > Template[0] > Layout[1] > Template[1] > Page
    const rootLayoutPos = html.indexOf('data-layout="root"');
    const rootTemplatePos = html.indexOf('data-template="root"');
    const groupLayoutPos = html.indexOf('data-layout="group"');
    const groupTemplatePos = html.indexOf('data-template="group"');
    const pagePos = html.indexOf("data-page-segments=");

    // Root layout wraps root template
    expect(rootLayoutPos).toBeLessThan(rootTemplatePos);
    // Root template wraps group layout (NOT: group layout wraps root template)
    expect(rootTemplatePos).toBeLessThan(groupLayoutPos);
    // Group layout wraps group template
    expect(groupLayoutPos).toBeLessThan(groupTemplatePos);
    // Group template wraps page
    expect(groupTemplatePos).toBeLessThan(pagePos);
  });
});
