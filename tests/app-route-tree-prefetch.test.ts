import { describe, expect, it } from "vite-plus/test";
import { renderToReadableStream } from "react-dom/server.edge";
import { createElement, Suspense } from "react";
import {
  createRouteTreePrefetchResponse,
  isRouteTreePrefetchRequest,
  type AppRouteTreePrefetchRoute,
  type RouteTreePrefetchRenderer,
  type TreePrefetch,
} from "../packages/vinext/src/server/app-route-tree-prefetch.js";

const ParentInlinedIntoSelf = 0b100000;
const InlinedIntoChild = 0b1000000;
const HeadInlinedIntoSelf = 0b10000000;

type RootTreePrefetch = {
  buildId?: string;
  staleTime: number;
  tree: TreePrefetch;
};

const smallModule = { default() {} };
const largeModule = {
  prefetchSize: "large",
};
const renderedLargeModule = {
  default() {
    return "x".repeat(3000);
  },
};
const renderedVeryCompressibleModule = {
  default() {
    return "x".repeat(20_000);
  },
};
const sourceTrapModule = {
  default() {
    return "NoInline";
  },
};
const syncPropsModule = {
  default({
    params,
    searchParams,
  }: {
    params: Promise<Record<string, string | string[]>> & Record<string, string | string[]>;
    searchParams: Promise<Record<string, string | string[]>> & Record<string, string | string[]>;
  }) {
    if (params.slug !== "hello" || searchParams.q !== "world") {
      throw new Error("route-tree prefetch sizing props did not match App Router props");
    }
    return "sync props are readable";
  },
};
const scopedLayoutParamsModule = {
  default({
    params,
  }: {
    params: Promise<Record<string, string | string[]>> & Record<string, string | string[]>;
  }) {
    if (params.slug !== undefined) {
      throw new Error("parent layout received leaf params");
    }
    return "parent layout without leaf params";
  },
};

let asyncSegmentResolved = false;
const asyncSegmentModule = {
  default() {
    function AsyncContent() {
      if (!asyncSegmentResolved) {
        throw new Promise<void>((resolve) => {
          setTimeout(() => {
            asyncSegmentResolved = true;
            resolve();
          }, 10);
        });
      }

      return "small async content";
    }

    return createElement(
      Suspense,
      { fallback: createElement("div", null, "x".repeat(20_000)) },
      createElement(AsyncContent),
    );
  },
};

async function readTree(response: Response): Promise<RootTreePrefetch> {
  const text = await response.text();
  return JSON.parse(text.slice(text.indexOf(":") + 1));
}

function routeTreeResponse(
  route: AppRouteTreePrefetchRoute,
  params: Record<string, string | string[]> = {},
  options: Parameters<typeof createRouteTreePrefetchResponse>[3] = {},
): Promise<Response> {
  return createRouteTreePrefetchResponse(
    route,
    renderToReadableStream as unknown as RouteTreePrefetchRenderer,
    params,
    options,
  );
}

function renderInliningTree(tree: TreePrefetch): string {
  const lines: string[] = [];
  collectNodes(tree, "", true, false, lines);
  return lines.join("\n");
}

function collectNodes(
  node: TreePrefetch,
  prefix: string,
  isLast: boolean,
  hasParent: boolean,
  lines: string[],
  slotKey?: string,
): void {
  const inlinedIntoChild = (node.prefetchHints & InlinedIntoChild) !== 0;
  const headInlined = (node.prefetchHints & HeadInlinedIntoSelf) !== 0;
  const slotPrefix = slotKey !== undefined && slotKey !== "children" ? `@${slotKey}/` : "";
  const name = hasParent
    ? `${slotPrefix}"${node.name}"${headInlined ? " (+metadata)" : ""}`
    : "root";
  const tag = inlinedIntoChild ? "inlined" : "outlined";
  const connector = hasParent ? (isLast ? "`-- " : "|-- ") : "";
  lines.push(`${tag} ${prefix}${connector}${name}`);

  if (node.slots) {
    const childPrefix = prefix + (hasParent ? (isLast ? "    " : "|   ") : "");
    const keys = Object.keys(node.slots);
    for (let i = 0; i < keys.length; i++) {
      collectNodes(
        node.slots[keys[i]],
        childPrefix,
        i === keys.length - 1,
        true,
        lines,
        keys.length > 1 ? keys[i] : undefined,
      );
    }
  }
}

describe("App Router route tree prefetch", () => {
  it("detects segment-cache route tree prefetch requests", () => {
    expect(
      isRouteTreePrefetchRequest(
        new Request("https://example.test/dashboard", {
          headers: {
            RSC: "1",
            "Next-Router-Prefetch": "1",
            "Next-Router-Segment-Prefetch": "/_tree",
          },
        }),
      ),
    ).toBe(true);
    expect(isRouteTreePrefetchRequest(new Request("https://example.test/dashboard"))).toBe(false);
  });

  // Mirrors the route-tree hint assertions in Next.js:
  // test/e2e/app-dir/segment-cache/prefetch-inlining/prefetch-inlining.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/prefetch-inlining/prefetch-inlining.test.ts
  it("emits deterministic inlining hints for static route trees", async () => {
    const data = await readTree(
      await routeTreeResponse({
        layoutTreePositions: [0, 1],
        layouts: [smallModule, smallModule],
        page: smallModule,
        routeSegments: ["test-small-chain"],
      }),
    );

    expect(renderInliningTree(data.tree)).toBe(
      [
        "inlined root",
        'inlined `-- "test-small-chain"',
        'outlined     `-- "__PAGE__" (+metadata)',
      ].join("\n"),
    );
  });

  it("breaks the inlining chain around large segments", async () => {
    const data = await readTree(
      await routeTreeResponse({
        layoutTreePositions: [0, 1, 2, 3],
        layouts: [smallModule, smallModule, largeModule, smallModule],
        page: smallModule,
        routeSegments: ["test-restart", "large-middle", "after"],
      }),
    );

    expect(renderInliningTree(data.tree)).toBe(
      [
        "inlined root",
        'inlined `-- "test-restart"',
        'outlined     `-- "large-middle"',
        'inlined         `-- "after"',
        'outlined             `-- "__PAGE__" (+metadata)',
      ].join("\n"),
    );
  });

  it("uses rendered segment size rather than source-string names for inlining hints", async () => {
    const renderedLarge = await readTree(
      await routeTreeResponse({
        layoutTreePositions: [0, 1],
        layouts: [smallModule, renderedLargeModule],
        page: smallModule,
        routeSegments: ["test-rendered-large"],
      }),
    );
    expect(renderInliningTree(renderedLarge.tree)).toBe(
      [
        "inlined root",
        'inlined `-- "test-rendered-large"',
        'outlined     `-- "__PAGE__" (+metadata)',
      ].join("\n"),
    );

    const sourceTrap = await readTree(
      await routeTreeResponse({
        layoutTreePositions: [0, 1],
        layouts: [smallModule, sourceTrapModule],
        page: smallModule,
        routeSegments: ["test-source-trap"],
      }),
    );
    expect(renderInliningTree(sourceTrap.tree)).toBe(
      [
        "inlined root",
        'inlined `-- "test-source-trap"',
        'outlined     `-- "__PAGE__" (+metadata)',
      ].join("\n"),
    );
  });

  it("uses completed React output when measuring async segment size", async () => {
    asyncSegmentResolved = false;
    const data = await readTree(
      await routeTreeResponse({
        layoutTreePositions: [0, 1],
        layouts: [smallModule, asyncSegmentModule],
        page: smallModule,
        routeSegments: ["test-async-size"],
      }),
    );

    expect(renderInliningTree(data.tree)).toBe(
      [
        "inlined root",
        'inlined `-- "test-async-size"',
        'outlined     `-- "__PAGE__" (+metadata)',
      ].join("\n"),
    );
  });

  it("uses compressed size for highly compressible rendered segments", async () => {
    const data = await readTree(
      await routeTreeResponse({
        layoutTreePositions: [0, 1],
        layouts: [smallModule, renderedVeryCompressibleModule],
        page: smallModule,
        routeSegments: ["test-compressible-size"],
      }),
    );

    expect(renderInliningTree(data.tree)).toBe(
      [
        "inlined root",
        'inlined `-- "test-compressible-size"',
        'outlined     `-- "__PAGE__" (+metadata)',
      ].join("\n"),
    );
  });

  it("uses App Router thenable params and searchParams when measuring segment size", async () => {
    const data = await readTree(
      await routeTreeResponse(
        {
          layoutTreePositions: [0, 2],
          layouts: [smallModule, syncPropsModule],
          page: smallModule,
          routeSegments: ["test-dynamic", "[slug]"],
        },
        { slug: "hello" },
        { searchParams: new URLSearchParams("q=world") },
      ),
    );

    expect(renderInliningTree(data.tree)).toBe(
      [
        "inlined root",
        'inlined `-- "test-dynamic"',
        'inlined     `-- "slug"',
        'outlined         `-- "__PAGE__" (+metadata)',
      ].join("\n"),
    );
  });

  it("scopes layout params to the measured layout tree position", async () => {
    let measuredWithScopedParams = false;
    const scopedModule = {
      default(props: Parameters<typeof scopedLayoutParamsModule.default>[0]) {
        scopedLayoutParamsModule.default(props);
        measuredWithScopedParams = true;
        return "scoped";
      },
    };

    await routeTreeResponse(
      {
        layoutTreePositions: [0, 1],
        layouts: [smallModule, scopedModule],
        page: smallModule,
        routeSegments: ["blog", "[slug]"],
      },
      { slug: "hello" },
    );

    expect(measuredWithScopedParams).toBe(true);
  });

  it("orders the page segment before parallel slots", async () => {
    const data = await readTree(
      await routeTreeResponse({
        layoutTreePositions: [0, 1],
        layouts: [smallModule, smallModule],
        page: smallModule,
        routeSegments: ["test-parallel"],
        slots: {
          sidebar: {
            name: "sidebar",
            page: smallModule,
            routeSegments: [],
          },
        },
      }),
    );

    expect(renderInliningTree(data.tree)).toBe(
      [
        "inlined root",
        'inlined `-- "test-parallel"',
        'outlined     |-- "__PAGE__" (+metadata)',
        'inlined     `-- @sidebar/"(__SLOT__)"',
        'outlined         `-- "__PAGE__"',
      ].join("\n"),
    );
  });

  it("measures active parallel slot defaults as slot page leaves", async () => {
    let measuredDefault = false;
    const defaultModule = {
      default() {
        measuredDefault = true;
        return "slot default";
      },
    };

    const data = await readTree(
      await routeTreeResponse({
        layoutTreePositions: [0, 1],
        layouts: [smallModule, smallModule],
        page: smallModule,
        routeSegments: ["test-parallel-default"],
        slots: {
          sidebar: {
            name: "sidebar",
            default: defaultModule,
            page: null,
            routeSegments: null,
          },
        },
      }),
    );

    expect(measuredDefault).toBe(true);
    expect(data.tree.slots?.children?.slots?.sidebar?.slots?.children?.name).toBe("__PAGE__");
  });

  it("measures nested parallel slot config layouts", async () => {
    let measuredNestedLayout = false;
    const nestedSlotLayout = {
      default() {
        measuredNestedLayout = true;
        return "nested slot layout";
      },
    };

    await routeTreeResponse({
      layoutTreePositions: [0, 1],
      layouts: [smallModule, smallModule],
      page: smallModule,
      routeSegments: ["dashboard"],
      slots: {
        sidebar: {
          name: "sidebar",
          configLayouts: [nestedSlotLayout],
          configLayoutTreePositions: [1],
          page: smallModule,
          routeSegments: ["settings"],
        },
      },
    });

    expect(measuredNestedLayout).toBe(true);
  });

  it("serializes dynamic segment params for client-side segment cache keys", async () => {
    const response = await routeTreeResponse(
      {
        layoutTreePositions: [0, 1],
        layouts: [smallModule, largeModule],
        page: smallModule,
        routeSegments: ["test-dynamic", "[slug]"],
        staticSiblings: ["sale"],
      },
      { slug: "hello" },
    );
    const data = await readTree(response);

    const dynamicSegment = data.tree.slots?.children?.slots?.children;
    expect(dynamicSegment?.name).toBe("slug");
    expect(dynamicSegment?.param).toEqual({ key: null, siblings: ["sale"], type: "d" });
    expect((dynamicSegment?.prefetchHints ?? 0) & ParentInlinedIntoSelf).toBe(0);
    expect(response.headers.get("x-nextjs-postponed")).toBe("2");
  });

  it("includes route-tree identity accepted by the segment-cache client", async () => {
    const response = await routeTreeResponse(
      {
        layoutTreePositions: [0],
        layouts: [smallModule],
        page: smallModule,
        routeSegments: [],
      },
      {},
      { buildId: "build-route-tree", deploymentId: "deployment-route-tree" },
    );
    const data = await readTree(response);

    expect(data.buildId).toBe("build-route-tree");
    expect(data.staleTime).toBe(-1);
    expect(response.headers.get("x-nextjs-deployment-id")).toBe("deployment-route-tree");
    expect(response.headers.get("x-nextjs-deployment-id") ?? data.buildId).toBe(
      "deployment-route-tree",
    );
  });
});
