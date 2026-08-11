import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSupplementalRefreshCoordinator,
  mergeRefreshedParallelSlot,
  resolvePersistedSourcePageRefreshes,
  resolveSupplementalRefreshes,
} from "../packages/vinext/src/server/app-browser-supplemental-refresh.js";
import { AppElementsWire, type AppElements } from "../packages/vinext/src/server/app-elements.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("parallel route supplemental refreshes", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
  it("retains the source query while refreshing an intercepted URL", () => {
    expect(
      resolvePersistedSourcePageRefreshes({
        basePath: "",
        refreshUrl: new URL("https://example.com/refreshing/login?modal=new"),
        state: {
          previousNextUrl: "/refreshing?random=old",
          slotBindings: [],
        },
      }),
    ).toEqual(["/refreshing?random=old"]);
  });

  it("recovers the active children route when multiple parallel slots are active", () => {
    expect(
      resolvePersistedSourcePageRefreshes({
        basePath: "/docs",
        refreshUrl: new URL("https://example.com/docs/nested-revalidate/modal?view=current"),
        state: {
          previousNextUrl: "/docs/nested-revalidate/drawer",
          slotBindings: [
            {
              activeRouteId: "route:/nested-revalidate/modal",
              ownerLayoutId: "layout:/",
              slotId: "slot:children:/",
              state: "active",
            },
            {
              activeRouteId: "route:/nested-revalidate",
              ownerLayoutId: "layout:/nested-revalidate",
              slotId: "slot:children:/nested-revalidate",
              state: "active",
            },
            {
              activeRouteId: "route:/nested-revalidate/drawer",
              ownerLayoutId: "layout:/nested-revalidate",
              slotId: "slot:drawer:/nested-revalidate",
              state: "active",
            },
          ],
        },
      }),
    ).toEqual(["/docs/nested-revalidate/drawer", "/docs/nested-revalidate?view=current"]);
  });

  it("merges every active slot from a supplemental route response", () => {
    const current: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/nested"],
        rootLayoutTreePath: "/",
        routeId: "route:/nested/modal",
        slotBindings: [
          {
            activeRouteId: "route:/nested/modal",
            ownerLayoutId: "layout:/nested",
            slotId: "slot:modal:/nested",
            state: "active",
          },
        ],
      }),
      "slot:children:/nested": "stale page",
      "slot:drawer:/nested": "stale drawer",
      "slot:modal:/nested": "fresh modal",
      "route:/nested": "stale page route",
      "route:/nested/drawer": "stale drawer route",
    };
    const refreshed: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/nested"],
        rootLayoutTreePath: "/",
        routeId: "route:/nested/drawer",
        slotBindings: [
          {
            activeRouteId: "route:/nested",
            ownerLayoutId: "layout:/nested",
            slotId: "slot:children:/nested",
            state: "active",
          },
          {
            activeRouteId: "route:/nested/drawer",
            ownerLayoutId: "layout:/nested",
            slotId: "slot:drawer:/nested",
            state: "active",
          },
        ],
      }),
      "slot:children:/nested": "fresh page",
      "slot:drawer:/nested": "fresh drawer",
      "route:/nested": "fresh page route",
      "route:/nested/drawer": "fresh drawer route",
    };

    const result = mergeRefreshedParallelSlot(current, refreshed);
    expect(result["slot:children:/nested"]).toBe("fresh page");
    expect(result["slot:drawer:/nested"]).toBe("fresh drawer");
    expect(result["slot:modal:/nested"]).toBe("fresh modal");
    expect(result["route:/nested"]).toBe("fresh page route");
    expect(result["route:/nested/drawer"]).toBe("fresh drawer route");
    expect(AppElementsWire.readMetadata(result).routeId).toBe("route:/nested/drawer");
    expect(AppElementsWire.readMetadata(result).slotBindings).toEqual([
      expect.objectContaining({ slotId: "slot:children:/nested", state: "active" }),
      expect.objectContaining({ slotId: "slot:drawer:/nested", state: "active" }),
      expect.objectContaining({ slotId: "slot:modal:/nested", state: "active" }),
    ]);
  });

  it("replaces only the refreshed slot and its binding", () => {
    const current: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interception: null,
        interceptionContext: null,
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId: "route:/other",
        slotBindings: [],
      }),
      "slot:children:/": "fresh other",
    };
    const refreshed: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interception: {
          sourceMatchedUrl: "/",
          sourceRouteId: "route:/",
          slotId: "slot:modal:/",
          targetMatchedUrl: "/login",
          targetRouteId: "route:/login",
        },
        interceptionContext: "/",
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId: "route:/",
        slotBindings: [
          {
            activeRouteId: "route:/login",
            interceptionId: "interception:modal",
            interceptionSourceMatchedUrl: "/",
            ownerLayoutId: "layout:/",
            slotId: "slot:modal:/",
            state: "active",
          },
        ],
      }),
      "slot:modal:/": "fresh modal",
    };

    const result = mergeRefreshedParallelSlot(current, refreshed);
    expect(result["slot:children:/"]).toBe("fresh other");
    expect(result["slot:modal:/"]).toBe("fresh modal");
    expect(AppElementsWire.readMetadata(result).slotBindings).toEqual([
      expect.objectContaining({ slotId: "slot:modal:/", state: "active" }),
    ]);
  });

  it("merges all successful active branches", async () => {
    await expect(
      resolveSupplementalRefreshes({
        merge: (current, supplemental) => [...current, ...supplemental],
        primary: Promise.resolve(["children"]),
        signal: new AbortController().signal,
        supplemental: [async () => ["modal"], async () => ["drawer"]],
      }),
    ).resolves.toEqual({
      degraded: false,
      value: ["children", "modal", "drawer"],
    });
  });

  it("keeps the primary payload atomically when one branch fails", async () => {
    await expect(
      resolveSupplementalRefreshes({
        merge: (current, supplemental) => [...current, ...supplemental],
        primary: Promise.resolve(["children"]),
        signal: new AbortController().signal,
        supplemental: [
          async () => ["modal"],
          async () => {
            throw new Error("drawer failed");
          },
        ],
      }),
    ).resolves.toEqual({ degraded: true, value: ["children"] });
  });

  it("aborts supplemental work when a newer navigation wins", async () => {
    const coordinator = createSupplementalRefreshCoordinator();
    const refresh = coordinator.begin({ activeNavigationId: 4, startedNavigationId: 4 });
    const result = resolveSupplementalRefreshes({
      merge: (current, supplemental) => current + supplemental,
      primary: Promise.resolve("children"),
      signal: refresh.signal,
      supplemental: [
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ],
    });

    coordinator.abortAll();
    await expect(result).resolves.toEqual({ degraded: true, value: "children" });
    refresh.finish();
  });
});
