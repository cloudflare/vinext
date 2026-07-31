import { describe, expect, it } from "vite-plus/test";
import {
  actionOwnerRouteEntryIds,
  addClientActionReachability,
  buildActionOwnerManifest,
  collectReachableActionReferences,
  collectRscActionReachability,
} from "../packages/vinext/src/build/action-owner-manifest.js";

function route(pattern: string, pagePath: string) {
  return {
    errorPath: null,
    errorPaths: [],
    forbiddenPath: null,
    forbiddenPaths: [],
    layoutErrorPaths: [],
    layouts: [],
    loadingPath: null,
    notFoundPath: null,
    notFoundPaths: [],
    pagePath,
    parallelSlots: [],
    pattern,
    siblingIntercepts: [],
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [],
  };
}

function moduleInfo(graph: Record<string, string[]>) {
  return (id: string) => ({ dynamicallyImportedIds: [], importedIds: graph[id] ?? [] });
}

function referenceMaps(options?: {
  clients?: Record<string, string>;
  servers?: Record<string, { exportNames: string[]; referenceKey: string }>;
}) {
  return {
    clientReferenceMetaMap: Object.fromEntries(
      Object.entries(options?.clients ?? {}).map(([id, importId]) => [
        id,
        { exportNames: [], importId, referenceKey: id, renderedExports: [] },
      ]),
    ),
    serverReferenceMetaMap: new Map(
      Object.entries(options?.servers ?? {}).map(([id, metadata]) => [
        id,
        { ...metadata, importId: id },
      ]),
    ),
  };
}

describe("server action owner manifest", () => {
  it("collects direct and inline server references from the final RSC graph", () => {
    const routeReachability = collectRscActionReachability({
      getModuleInfo: moduleInfo({
        "/app/page.tsx": ["/app/form.tsx"],
      }),
      ...referenceMaps({
        servers: {
          "/app/form.tsx": {
            exportNames: ["submit", "$$hoist_inline"],
            referenceKey: "form",
          },
        },
      }),
      routes: [route("/", "/app/page.tsx")],
    });

    expect(buildActionOwnerManifest(routeReachability)).toEqual({
      "form#$$hoist_inline": ["/"],
      "form#submit": ["/"],
    });
  });

  it("joins RSC Client Component reachability with the final client graph", () => {
    const routeReachability = collectRscActionReachability({
      getModuleInfo: moduleInfo({
        "/app/a/page.tsx": ["/app/a/client.tsx?rsc"],
      }),
      ...referenceMaps({
        clients: {
          "/app/a/client.tsx?rsc": "/app/a/client.tsx",
        },
      }),
      routes: [route("/a", "/app/a/page.tsx")],
    });

    addClientActionReachability({
      getModuleInfo: moduleInfo({
        "/app/a/client.tsx": ["/app/a/commands.ts"],
        "/app/a/commands.ts": ["/app/a/action.ts?server-proxy"],
      }),
      ...referenceMaps({
        servers: {
          "/app/a/action.ts?server-proxy": {
            exportNames: ["objectWrappedAction"],
            referenceKey: "action-a",
          },
        },
      }),
      routeReachability,
    });

    expect(buildActionOwnerManifest(routeReachability)).toEqual({
      "action-a#objectWrappedAction": ["/a"],
    });
  });

  it("conservatively associates every reference exported by a reachable module", () => {
    const result = collectReachableActionReferences({
      getModuleInfo: moduleInfo({
        "/app/page.tsx": ["/app/actions.ts"],
      }),
      ...referenceMaps({
        servers: {
          "/app/actions.ts": {
            exportNames: ["first", "second"],
            referenceKey: "actions",
          },
        },
      }),
      roots: ["/app/page.tsx"],
    });

    expect([...result.serverReferenceIds].sort()).toEqual(["actions#first", "actions#second"]);
  });

  it("follows dynamic imports and canonicalizes graph ids", () => {
    const result = collectReachableActionReferences({
      canonicalizeModuleId: (id) => id.replace("/private/app", "/app"),
      getModuleInfo(id) {
        return id === "/app/page.tsx"
          ? { importedIds: [], dynamicallyImportedIds: ["/private/app/action.ts"] }
          : { importedIds: [], dynamicallyImportedIds: [] };
      },
      ...referenceMaps({
        servers: {
          "/private/app/action.ts": { exportNames: ["submit"], referenceKey: "action" },
        },
      }),
      roots: ["/private/app/page.tsx"],
    });

    expect([...result.serverReferenceIds]).toEqual(["action#submit"]);
  });

  it("includes layouts, boundaries, slots, and intercepts as route roots", () => {
    expect(
      actionOwnerRouteEntryIds({
        ...route("/dashboard", "/app/dashboard/page.tsx"),
        errorPath: "/app/error.tsx",
        errorPaths: ["/app/nested-error.tsx"],
        forbiddenPath: "/app/forbidden.tsx",
        forbiddenPaths: ["/app/nested-forbidden.tsx"],
        layoutErrorPaths: ["/app/layout-error.tsx"],
        layouts: ["/app/layout.tsx"],
        loadingPath: "/app/loading.tsx",
        notFoundPath: "/app/not-found.tsx",
        notFoundPaths: ["/app/nested-not-found.tsx"],
        parallelSlots: [
          {
            configLayoutPaths: ["/app/@slot/config-layout.tsx"],
            defaultPath: "/app/@slot/default.tsx",
            errorPath: "/app/@slot/error.tsx",
            hasPage: true,
            interceptingRoutes: [
              {
                convention: ".",
                layoutPaths: ["/app/@slot/(.)item/layout.tsx"],
                pagePath: "/app/@slot/(.)item/page.tsx",
                params: [],
                sourceMatchPattern: "/dashboard",
                targetPattern: "/item",
              },
            ],
            key: "slot:/app/@slot",
            layoutIndex: 0,
            layoutPath: "/app/@slot/layout.tsx",
            loadingPath: "/app/@slot/loading.tsx",
            name: "slot",
            ownerDir: "/app",
            ownerTreePath: "/app",
            pagePath: "/app/@slot/page.tsx",
            routeSegments: [],
          },
        ],
        siblingIntercepts: [
          {
            convention: ".",
            layoutPaths: ["/app/(.)modal/layout.tsx"],
            pagePath: "/app/(.)modal/page.tsx",
            params: [],
            sourceMatchPattern: "/dashboard",
            targetPattern: "/modal",
          },
        ],
        templates: ["/app/template.tsx"],
        unauthorizedPath: "/app/unauthorized.tsx",
        unauthorizedPaths: ["/app/nested-unauthorized.tsx"],
      }),
    ).toEqual(
      expect.arrayContaining([
        "/app/dashboard/page.tsx",
        "/app/layout.tsx",
        "/app/template.tsx",
        "/app/error.tsx",
        "/app/@slot/page.tsx",
        "/app/@slot/(.)item/page.tsx",
        "/app/(.)modal/page.tsx",
      ]),
    );
  });
});
