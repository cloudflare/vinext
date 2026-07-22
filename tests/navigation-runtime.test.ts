import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_RUNTIME_KEY,
  getNavigationRuntime,
  hasAppNavigationRuntime,
  registerNavigationRuntimeBootstrap,
  registerNavigationRuntimeFunctions,
  subscribeNavigationRuntimeRscChunk,
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

  it("creates the RSC bootstrap buffer when subscribing the first chunk", () => {
    Reflect.set(globalThis, "window", {});

    subscribeNavigationRuntimeRscChunk("chunk");

    expect(getNavigationRuntime()?.bootstrap.rsc?.rsc).toEqual(["chunk"]);
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

  it("keeps server-side runtime creation detached from the window contract", () => {
    Reflect.deleteProperty(globalThis, "window");

    const runtime = subscribeNavigationRuntimeRscChunk("server-chunk");

    expect(runtime.bootstrap.rsc?.rsc).toEqual(["server-chunk"]);
    expect(getNavigationRuntime()).toBeNull();
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
