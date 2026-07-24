import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSupplementalRefreshCoordinator,
  mergeRefreshedInterceptedSlot,
  resolveNavigationSourcePageRefresh,
  resolvePersistedSourcePageRefresh,
  resolveSupplementalRefreshes,
  settleSuccessfulServerActionResult,
  shouldScheduleSupplementalRefreshRecovery,
} from "../packages/vinext/src/server/app-browser-supplemental-refresh.js";
import { AppElementsWire, type AppElements } from "../packages/vinext/src/server/app-elements.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("server action supplemental refreshes", () => {
  // Matches Next.js action discarding: test/e2e/app-dir/actions/app-action.test.ts
  // and packages/next/src/client/components/app-router-instance.ts.
  it("retains the exact source query while refreshing an intercepted URL", () => {
    expect(
      resolvePersistedSourcePageRefresh({
        basePath: "",
        refreshUrl: new URL("https://example.com/refreshing/login?modal=new"),
        state: {
          previousNextUrl: "/refreshing?random=old",
          slotBindings: [],
        },
      }),
    ).toBe("/refreshing?random=old");
  });

  it("recovers the active children route when no interception source URL exists", () => {
    expect(
      resolvePersistedSourcePageRefresh({
        basePath: "/docs",
        refreshUrl: new URL("https://example.com/docs/nested-revalidate/modal?view=current"),
        state: {
          previousNextUrl: null,
          slotBindings: [
            {
              activeRouteId: "route:/nested-revalidate/modal",
              ownerLayoutId: "layout:/",
              slotId: "slot:children:/",
              state: "active",
            },
            {
              activeRouteId: "route:/",
              ownerLayoutId: "layout:/",
              slotId: "slot:dialog:/",
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
    ).toBe("/docs/nested-revalidate?view=current");
  });

  it("does not replace a normal traversal target with the intercepted page being left", () => {
    expect(
      resolveNavigationSourcePageRefresh({
        basePath: "",
        navigationKind: "traverse",
        refreshUrl: new URL("https://example.com/profile?target=new"),
        requestPreviousNextUrl: null,
        state: {
          interception: {
            sourceMatchedUrl: "/feed",
            sourceRouteId: "route:/feed",
            slotId: "slot:modal:/",
            targetMatchedUrl: "/feed/photo",
            targetRouteId: "route:/feed/photo",
          },
          previousNextUrl: "/feed?source=old",
          slotBindings: [
            {
              activeRouteId: "route:/feed",
              ownerLayoutId: "layout:/",
              slotId: "slot:children:/",
              state: "active",
            },
            {
              activeRouteId: "route:/feed/photo",
              ownerLayoutId: "layout:/",
              slotId: "slot:modal:/",
              state: "active",
            },
          ],
        },
        targetHistoryBfcacheIds: {
          "layout:/": "_b_4_",
          "page:/profile": "_b_5_",
        },
      }),
    ).toBeNull();
  });

  it("uses the target history source URL for an intercepted traversal", () => {
    expect(
      resolveNavigationSourcePageRefresh({
        basePath: "",
        navigationKind: "traverse",
        refreshUrl: new URL("https://example.com/photo/target?modal=new"),
        requestPreviousNextUrl: "/feed?source=target",
        state: {
          interception: {
            sourceMatchedUrl: "/dashboard",
            sourceRouteId: "route:/dashboard",
            slotId: "slot:modal:/",
            targetMatchedUrl: "/photo/old",
            targetRouteId: "route:/photo/old",
          },
          previousNextUrl: "/dashboard?source=old",
          slotBindings: [],
        },
        targetHistoryBfcacheIds: null,
      }),
    ).toBe("/feed?source=target");
  });

  it("uses target history page identity to recover a normal parallel-route source page", () => {
    expect(
      resolveNavigationSourcePageRefresh({
        basePath: "",
        navigationKind: "traverse",
        refreshUrl: new URL("https://example.com/nested-revalidate/drawer"),
        requestPreviousNextUrl: null,
        state: {
          interception: null,
          previousNextUrl: null,
          slotBindings: [
            {
              activeRouteId: "route:/nested-revalidate/drawer",
              ownerLayoutId: "layout:/",
              slotId: "slot:children:/",
              state: "active",
            },
            {
              activeRouteId: "route:/",
              ownerLayoutId: "layout:/",
              slotId: "slot:dialog:/",
              state: "active",
            },
            {
              activeRouteId: "route:/nested-revalidate",
              ownerLayoutId: "layout:/nested-revalidate",
              slotId: "slot:children:/nested-revalidate",
              state: "active",
            },
            {
              activeRouteId: "route:/nested-revalidate/modal",
              ownerLayoutId: "layout:/nested-revalidate",
              slotId: "slot:modal:/nested-revalidate",
              state: "active",
            },
          ],
        },
        targetHistoryBfcacheIds: {
          "page:/nested-revalidate/drawer": "_b_2_",
        },
      }),
    ).toBe("/nested-revalidate");
  });

  it("rejects a source-page slot whose owner is absent from the primary layout table", () => {
    const currentElements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interception: null,
        interceptionContext: null,
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId: "route:/target",
        slotBindings: [],
      }),
    };
    const supplementalElements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interception: null,
        interceptionContext: null,
        layoutIds: ["layout:/source"],
        rootLayoutTreePath: "/source",
        routeId: "route:/source",
        slotBindings: [
          {
            activeRouteId: "route:/source",
            ownerLayoutId: "layout:/source",
            slotId: "slot:children:/source",
            state: "active",
          },
        ],
      }),
      "slot:children:/source": "fresh source",
    };

    expect(() => mergeRefreshedInterceptedSlot(currentElements, supplementalElements)).toThrow(
      "owner layout id missing from __layoutIds",
    );
  });

  it("merges multiple successful persisted slots", async () => {
    const result = await resolveSupplementalRefreshes({
      merge: (current, supplemental) => [...current, ...supplemental],
      primary: Promise.resolve(["children"]),
      signal: new AbortController().signal,
      supplemental: [async () => ["modal"], async () => ["drawer"]],
    });

    expect(result).toEqual({
      degraded: false,
      value: ["children", "modal", "drawer"],
    });
  });

  it("keeps the primary action payload when a supplemental request fails", async () => {
    let siblingAborted = false;
    const result = await resolveSupplementalRefreshes({
      merge: (current, supplemental) => current + supplemental,
      primary: Promise.resolve("children"),
      signal: new AbortController().signal,
      supplemental: [
        async () => {
          throw new Error("slot failed");
        },
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                siblingAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ],
    });

    expect(result).toEqual({ degraded: true, value: "children" });
    expect(siblingAborted).toBe(true);
  });

  it("times out a hanging supplemental request without blocking the action", async () => {
    vi.useFakeTimers();
    const resultPromise = resolveSupplementalRefreshes({
      merge: (current, supplemental) => current + supplemental,
      primary: Promise.resolve("children"),
      signal: new AbortController().signal,
      supplemental: [
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ],
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(resultPromise).resolves.toEqual({ degraded: true, value: "children" });
  });

  it("settles a successful action value before a hanging supplemental navigation", async () => {
    const navigation = new Promise<never>(() => {});
    const onNavigationFailure = vi.fn();

    await expect(
      settleSuccessfulServerActionResult({
        navigation,
        onNavigationFailure,
        value: "action-value",
      }),
    ).resolves.toBe("action-value");
    expect(onNavigationFailure).not.toHaveBeenCalled();
  });

  it("keeps degraded recovery bounded and atomic when a supplemental fails", async () => {
    const result = await resolveSupplementalRefreshes({
      merge: (current, supplemental) => [...current, ...supplemental],
      primary: Promise.resolve(["children"]),
      signal: new AbortController().signal,
      supplemental: [
        async () => ["modal"],
        async () => {
          throw new Error("drawer failed");
        },
      ],
    });

    expect(result).toEqual({ degraded: true, value: ["children"] });
  });

  it("recovers from detached navigation failure after settling the action", async () => {
    const onNavigationFailure = vi.fn();

    await expect(
      settleSuccessfulServerActionResult({
        navigation: Promise.reject(new Error("supplemental failed")),
        onNavigationFailure,
        value: "action-value",
      }),
    ).resolves.toBe("action-value");
    await vi.waitFor(() => expect(onNavigationFailure).toHaveBeenCalledTimes(1));
  });

  it("stops waiting when a newer navigation supersedes the action", async () => {
    const coordinator = createSupplementalRefreshCoordinator();
    const refresh = coordinator.begin({ activeNavigationId: 4, startedNavigationId: 4 });
    let supplementalAborted = false;
    const resultPromise = resolveSupplementalRefreshes({
      merge: (current, supplemental) => current + supplemental,
      primary: Promise.resolve("children"),
      signal: refresh.signal,
      supplemental: [
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                supplementalAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ],
    });

    coordinator.abortAll();

    await expect(resultPromise).resolves.toEqual({ degraded: true, value: "children" });
    expect(supplementalAborted).toBe(true);
    refresh.finish();
  });

  it("does not start supplemental work for an already-superseded action", async () => {
    const coordinator = createSupplementalRefreshCoordinator();
    const refresh = coordinator.begin({ activeNavigationId: 5, startedNavigationId: 4 });
    const load = vi.fn(async () => "modal");

    await expect(
      resolveSupplementalRefreshes({
        merge: (current, supplemental) => current + supplemental,
        primary: Promise.resolve("children"),
        signal: refresh.signal,
        supplemental: [load],
      }),
    ).resolves.toEqual({ degraded: true, value: "children" });
    expect(load).not.toHaveBeenCalled();
    refresh.finish();
  });

  it("recovers active degraded actions without replacing a superseding navigation", () => {
    expect(
      shouldScheduleSupplementalRefreshRecovery({
        activeNavigationId: 4,
        degraded: true,
        startedNavigationId: 4,
      }),
    ).toBe(true);
    expect(
      shouldScheduleSupplementalRefreshRecovery({
        activeNavigationId: 5,
        degraded: true,
        startedNavigationId: 4,
      }),
    ).toBe(false);
    expect(
      shouldScheduleSupplementalRefreshRecovery({
        activeNavigationId: 4,
        degraded: true,
        recoveryAttempt: true,
        startedNavigationId: 4,
      }),
    ).toBe(false);
  });
});
