import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NAVIGATION_RUNTIME_KEY,
  createNavigationRuntimeRouteManifestLoader,
  getNavigationRuntime,
  hasAppNavigationRuntime,
  loadNavigationRuntimeRouteManifest,
  registerNavigationRuntimeBootstrap,
  registerNavigationRuntimeFunctions,
  type NavigationRuntime,
  type NavigationRuntimeBootstrap,
  type NavigationRuntimeFunctions,
  type NavigationRuntimeRscBootstrap,
  type NavigationRuntimeRscChunk,
} from "../packages/vinext/src/client/navigation-runtime.js";
import type { BrowserRouteManifestWire } from "../packages/vinext/src/routing/browser-route-manifest.js";

const originalWindow = Reflect.get(globalThis, "window");
const hadWindow = Reflect.has(globalThis, "window");

afterEach(() => {
  vi.restoreAllMocks();
  if (hadWindow) {
    Reflect.set(globalThis, "window", originalWindow);
    return;
  }
  Reflect.deleteProperty(globalThis, "window");
});

describe("navigation runtime contract", () => {
  it("merges bootstrap data without clobbering independently registered RSC payloads", () => {
    Reflect.set(globalThis, "window", {});

    const chunk: NavigationRuntimeRscChunk = "flight";
    const rscBootstrap: NavigationRuntimeRscBootstrap = {
      params: { id: "123" },
      rsc: [chunk],
    };
    const bootstrap: Partial<NavigationRuntimeBootstrap> = { rsc: rscBootstrap };

    registerNavigationRuntimeBootstrap(bootstrap);
    registerNavigationRuntimeBootstrap({ routeManifest: null });

    expect(getNavigationRuntime()?.bootstrap.rsc?.params?.id).toBe("123");
    expect(getNavigationRuntime()?.bootstrap.routeManifest).toBeNull();
  });

  it("reports app navigation availability from the registered navigate slot", () => {
    Reflect.set(globalThis, "window", {});

    expect(hasAppNavigationRuntime()).toBe(false);

    registerNavigationRuntimeFunctions({
      navigate: () => Promise.resolve(),
    });

    expect(hasAppNavigationRuntime()).toBe(true);
  });

  it("merges registered function slots without clobbering existing capabilities", () => {
    Reflect.set(globalThis, "window", {});
    const navigate = () => Promise.resolve();
    const pingVisibleLinks = () => {};

    registerNavigationRuntimeFunctions({ navigate });
    registerNavigationRuntimeFunctions({ pingVisibleLinks });

    expect(getNavigationRuntime()?.functions.navigate).toBe(navigate);
    expect(getNavigationRuntime()?.functions.pingVisibleLinks).toBe(pingVisibleLinks);
  });

  it("rejects runtime objects with non-function capability slots", () => {
    const runtimeWindow = {};
    const functions: NavigationRuntimeFunctions = {};
    const runtime: NavigationRuntime = {
      bootstrap: {
        routeManifest: null,
        rsc: undefined,
      },
      functions,
    };
    Reflect.set(globalThis, "window", runtimeWindow);
    Reflect.set(runtimeWindow, NAVIGATION_RUNTIME_KEY, runtime);
    Reflect.set(runtimeWindow, NAVIGATION_RUNTIME_KEY, {
      bootstrap: {
        routeManifest: null,
        rsc: undefined,
      },
      functions: {
        navigate: "not callable",
      },
    });

    expect(getNavigationRuntime()).toBeNull();
  });

  it("rejects route manifests without the map-backed segment graph contract", () => {
    const runtimeWindow = {};
    Reflect.set(globalThis, "window", runtimeWindow);
    Reflect.set(runtimeWindow, NAVIGATION_RUNTIME_KEY, {
      bootstrap: {
        routeManifest: {
          graphVersion: "test",
          segmentGraph: {
            interceptions: {
              values: () => [],
            },
          },
        },
        rsc: undefined,
      },
      functions: {},
    });

    expect(getNavigationRuntime()).toBeNull();
  });

  it("rejects route manifests with malformed interception entries", () => {
    const runtimeWindow = {};
    const segmentGraphMaps = {
      interceptions: new Map([["bad", {}]]),
      interceptionsBySlotId: new Map(),
      layouts: new Map(),
      rootBoundaries: new Map(),
      routes: new Map(),
      slotBindings: new Map(),
    };
    Reflect.set(globalThis, "window", runtimeWindow);
    Reflect.set(runtimeWindow, NAVIGATION_RUNTIME_KEY, {
      bootstrap: {
        routeManifest: {
          graphVersion: "test",
          segmentGraph: segmentGraphMaps,
        },
        rsc: undefined,
      },
      functions: {},
    });

    expect(getNavigationRuntime()).toBeNull();
  });

  it("loads the route manifest once and registers it", async () => {
    Reflect.set(globalThis, "window", {});
    const importManifest = vi.fn(() => Promise.resolve({ default: routeManifestWire }));
    registerNavigationRuntimeFunctions({
      loadRouteManifest: createNavigationRuntimeRouteManifestLoader(importManifest),
    });

    const load = loadNavigationRuntimeRouteManifest();
    expect(load).not.toBeNull();
    expect(loadNavigationRuntimeRouteManifest()).toBe(load);
    expect(getNavigationRuntime()?.bootstrap.routeManifest).toBeNull();

    await expect(load).resolves.toBe(true);

    const routeManifest = getNavigationRuntime()?.bootstrap.routeManifest;
    expect(routeManifest?.graphVersion).toBe("graph:test");
    expect(routeManifest?.segmentGraph.routes.get("route:/blog/:slug")?.paramNames).toEqual([
      "slug",
    ]);
    expect(loadNavigationRuntimeRouteManifest()).toBeNull();
    expect(importManifest).toHaveBeenCalledTimes(1);
  });

  it("reports a failed route manifest load to callers, retries it and logs once", async () => {
    Reflect.set(globalThis, "window", {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const importManifest = vi
      .fn<() => Promise<{ default: BrowserRouteManifestWire | null }>>()
      .mockRejectedValueOnce(new Error("chunk load failed"))
      .mockRejectedValueOnce(new Error("chunk load failed again"))
      .mockResolvedValueOnce({ default: routeManifestWire });
    registerNavigationRuntimeFunctions({
      loadRouteManifest: createNavigationRuntimeRouteManifestLoader(importManifest),
    });

    await expect(loadNavigationRuntimeRouteManifest()).resolves.toBe(false);
    expect(getNavigationRuntime()?.bootstrap.routeManifest).toBeNull();
    expect(consoleError).toHaveBeenCalledTimes(1);

    await expect(loadNavigationRuntimeRouteManifest()).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);

    await expect(loadNavigationRuntimeRouteManifest()).resolves.toBe(true);
    expect(getNavigationRuntime()?.bootstrap.routeManifest?.graphVersion).toBe("graph:test");
    expect(importManifest).toHaveBeenCalledTimes(3);
  });

  it("has no route manifest load to wait for without a registered loader", () => {
    Reflect.set(globalThis, "window", {});

    expect(loadNavigationRuntimeRouteManifest()).toBeNull();
  });
});

const routeManifestWire: BrowserRouteManifestWire = {
  graphVersion: "graph:test",
  routes: [
    {
      patternParts: ["blog", ":slug"],
      isDynamic: true,
      paramNames: ["slug"],
      rootBoundaryId: "root-boundary:/",
      pageId: "page:/blog/:slug",
      layoutIds: ["layout:/"],
      slotIds: [],
    },
  ],
  layouts: [{ id: "layout:/", patternParts: [], rootBoundaryId: "root-boundary:/" }],
  slotBindings: [],
  interceptions: [],
  interceptionsBySlotId: [],
  rootBoundaries: [{ id: "root-boundary:/", treePath: "/" }],
};
