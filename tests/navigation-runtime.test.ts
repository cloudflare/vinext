import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NAVIGATION_RUNTIME_KEY,
  getNavigationRuntime,
  hasAppNavigationRuntime,
  navigateDocument,
  registerNavigationRuntimeBootstrap,
  registerNavigationRuntimeFunctions,
  type NavigationRuntime,
  type NavigationRuntimeBootstrap,
  type NavigationRuntimeFunctions,
  type NavigationRuntimeRscBootstrap,
  type NavigationRuntimeRscChunk,
} from "../packages/vinext/src/client/navigation-runtime.js";

const originalWindow = Reflect.get(globalThis, "window");
const hadWindow = Reflect.has(globalThis, "window");

afterEach(() => {
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

  it("accepts a runtime whose optional refresh slots are absent", () => {
    Reflect.set(globalThis, "window", {});

    registerNavigationRuntimeFunctions({});

    expect(getNavigationRuntime()?.functions.refresh).toBeUndefined();
  });

  it("rejects a non-function refresh slot", () => {
    const runtimeWindow = {};
    Reflect.set(globalThis, "window", runtimeWindow);
    Reflect.set(runtimeWindow, NAVIGATION_RUNTIME_KEY, {
      bootstrap: {
        routeManifest: null,
        rsc: undefined,
      },
      functions: { refresh: "not callable" },
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
      boundaries: new Map(),
      defaults: new Map(),
      interceptions: new Map([["bad", {}]]),
      interceptionsBySlotId: new Map(),
      layouts: new Map(),
      pages: new Map(),
      rootBoundaries: new Map(),
      routeHandlers: new Map(),
      routes: new Map(),
      slotBindings: new Map(),
      slots: new Map(),
      templates: new Map(),
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
});

describe("navigateDocument", () => {
  function installWindow() {
    const assign = vi.fn();
    const replace = vi.fn();
    Reflect.set(globalThis, "window", { location: { assign, replace } });
    return { assign, replace };
  }

  it.each([
    { location: "assign" as const, mode: "push" as const },
    { location: "replace" as const, mode: "replace" as const },
  ])("loads the document with location.$location for $mode when no runtime is installed", (c) => {
    const locations = installWindow();

    navigateDocument("/target", c.mode);

    expect(locations[c.location]).toHaveBeenCalledExactlyOnceWith("/target");
    expect(locations[c.location === "assign" ? "replace" : "assign"]).not.toHaveBeenCalled();
  });

  it("loads the document with location when the runtime has no external navigation slot", () => {
    const locations = installWindow();
    registerNavigationRuntimeFunctions({ navigate: () => Promise.resolve() });

    navigateDocument("/target", "push");

    expect(locations.assign).toHaveBeenCalledExactlyOnceWith("/target");
  });

  it.each(["push", "replace"] as const)(
    "hands a %s document load to the runtime's external navigation",
    (mode) => {
      const locations = installWindow();
      const navigateExternal = vi.fn(() => new Promise<void>(() => {}));
      registerNavigationRuntimeFunctions({ navigateExternal });

      navigateDocument("/target", mode);

      expect(navigateExternal).toHaveBeenCalledExactlyOnceWith("/target", mode);
      expect(locations.assign).not.toHaveBeenCalled();
      expect(locations.replace).not.toHaveBeenCalled();
    },
  );
});
