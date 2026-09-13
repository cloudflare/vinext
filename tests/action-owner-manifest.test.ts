import { describe, expect, it } from "vite-plus/test";
import {
  actionOwnerRouteEntryIds,
  addClientActionReachability,
  buildActionOwnerManifest,
  collectReachableActionReferences,
  collectRscActionReachability,
  resolveClientReferenceImportIds,
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

  it("associates shared render roots with every route", () => {
    const routeReachability = collectRscActionReachability({
      getModuleInfo: moduleInfo({}),
      ...referenceMaps({
        servers: {
          "/app/global-error.tsx": {
            exportNames: ["globalErrorAction"],
            referenceKey: "global-error",
          },
        },
      }),
      routes: [route("/a", "/app/a/page.tsx"), route("/b", "/app/b/page.tsx")],
      sharedRoots: ["/app/global-error.tsx"],
    });

    expect(buildActionOwnerManifest(routeReachability)).toEqual({
      "global-error#globalErrorAction": ["*"],
    });
  });

  it("resolves RSC Client Component import ids before joining the final client graph", async () => {
    const routeReachability = collectRscActionReachability({
      getModuleInfo: moduleInfo({
        "/app/a/page.tsx": ["/app/a/client.tsx?rsc"],
      }),
      ...referenceMaps({
        clients: {
          "/app/a/client.tsx?rsc": "action-client-package",
        },
      }),
      routes: [route("/a", "/app/a/page.tsx")],
    });

    await resolveClientReferenceImportIds({
      resolveId: async (id) =>
        id === "action-client-package" ? "/node_modules/action-client-package/client.tsx" : null,
      routeReachability,
    });
    addClientActionReachability({
      getModuleInfo: moduleInfo({
        "/node_modules/action-client-package/client.tsx": ["/app/a/commands.ts"],
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
        loadingPaths: ["/app/nested-loading.tsx"],
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
                loadingPaths: ["/app/@slot/(.)item/loading.tsx"],
                notFoundPath: "/app/@slot/(.)item/not-found.tsx",
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
            loadingPaths: ["/app/@slot/nested-loading.tsx"],
            name: "slot",
            notFoundPath: "/app/@slot/not-found.tsx",
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
            loadingPaths: ["/app/(.)modal/loading.tsx"],
            notFoundPath: "/app/(.)modal/not-found.tsx",
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
    ).toEqual([
      "/app/dashboard/page.tsx",
      "/app/layout.tsx",
      "/app/template.tsx",
      "/app/loading.tsx",
      "/app/nested-loading.tsx",
      "/app/error.tsx",
      "/app/layout-error.tsx",
      "/app/nested-error.tsx",
      "/app/not-found.tsx",
      "/app/nested-not-found.tsx",
      "/app/forbidden.tsx",
      "/app/nested-forbidden.tsx",
      "/app/unauthorized.tsx",
      "/app/nested-unauthorized.tsx",
      "/app/@slot/page.tsx",
      "/app/@slot/default.tsx",
      "/app/@slot/layout.tsx",
      "/app/@slot/config-layout.tsx",
      "/app/@slot/loading.tsx",
      "/app/@slot/nested-loading.tsx",
      "/app/@slot/error.tsx",
      "/app/@slot/not-found.tsx",
      "/app/@slot/(.)item/page.tsx",
      "/app/@slot/(.)item/layout.tsx",
      "/app/@slot/(.)item/loading.tsx",
      "/app/@slot/(.)item/not-found.tsx",
      "/app/(.)modal/page.tsx",
      "/app/(.)modal/layout.tsx",
      "/app/(.)modal/loading.tsx",
      "/app/(.)modal/not-found.tsx",
    ]);
  });
});
