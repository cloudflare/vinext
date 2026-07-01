import { describe, expect, it } from "vite-plus/test";
import {
  createRouteTreePrefetchResponse,
  isRouteTreePrefetchRequest,
  type AppRouteTreePrefetchRoute,
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
const userComponentTrapModule = {
  default({ children: _children }: { children?: unknown }) {
    throw new Error("route-tree prefetch must not execute user components");
  },
};

async function readTree(response: Response): Promise<RootTreePrefetch> {
  const text = await response.text();
  return JSON.parse(text.slice(text.indexOf(":") + 1));
}

function routeTreeResponse(
  route: AppRouteTreePrefetchRoute,
  options: Parameters<typeof createRouteTreePrefetchResponse>[1] = {},
): Promise<Response> {
  return createRouteTreePrefetchResponse(route, options);
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

  it("uses configured prefetchInlining thresholds for route-tree hints", async () => {
    const data = await readTree(
      await routeTreeResponse(
        {
          layoutTreePositions: [0, 1],
          layouts: [smallModule, largeModule],
          page: smallModule,
          routeSegments: ["test-max-threshold"],
        },
        {
          prefetchInlining: {
            maxBundleSize: Number.MAX_SAFE_INTEGER,
            maxSize: Number.MAX_SAFE_INTEGER,
          },
        },
      ),
    );

    expect(renderInliningTree(data.tree)).toBe(
      [
        "inlined root",
        'inlined `-- "test-max-threshold"',
        'outlined     `-- "__PAGE__" (+metadata)',
      ].join("\n"),
    );
  });

  it("does not execute user components while building route-tree hints", async () => {
    const data = await readTree(
      await routeTreeResponse({
        layoutTreePositions: [0, 1],
        layouts: [smallModule, userComponentTrapModule],
        page: userComponentTrapModule,
        routeSegments: ["test-no-runtime-render"],
      }),
    );

    expect(renderInliningTree(data.tree)).toBe(
      [
        "inlined root",
        'inlined `-- "test-no-runtime-render"',
        'outlined     `-- "__PAGE__" (+metadata)',
      ].join("\n"),
    );
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

  it("treats active parallel slot defaults as slot page leaves", async () => {
    const data = await readTree(
      await routeTreeResponse({
        layoutTreePositions: [0, 1],
        layouts: [smallModule, smallModule],
        page: smallModule,
        routeSegments: ["test-parallel-default"],
        slots: {
          sidebar: {
            name: "sidebar",
            default: userComponentTrapModule,
            page: null,
            routeSegments: null,
          },
        },
      }),
    );

    expect(data.tree.slots?.children?.slots?.sidebar?.slots?.children?.name).toBe("__PAGE__");
  });

  it("leaves dynamic segment siblings unknown until segment-local metadata exists", async () => {
    const response = await routeTreeResponse({
      layoutTreePositions: [0, 1],
      layouts: [smallModule, largeModule],
      page: smallModule,
      routeSegments: ["test-dynamic", "[slug]"],
    });
    const data = await readTree(response);

    const dynamicSegment = data.tree.slots?.children?.slots?.children;
    expect(dynamicSegment?.name).toBe("slug");
    expect(dynamicSegment?.param).toEqual({ key: null, siblings: null, type: "d" });
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
