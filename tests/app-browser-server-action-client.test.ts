import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createFromFetch } from "@vitejs/plugin-rsc/browser";
import { createClientNavigationRenderSnapshot } from "../packages/vinext/src/shims/navigation.js";
import { createServerActionInitiationSnapshot } from "../packages/vinext/src/server/app-browser-action-result.js";
import { invokeClientServerAction } from "../packages/vinext/src/server/app-browser-server-action-client.js";
import type { AppRouterState } from "../packages/vinext/src/server/app-browser-state.js";
import {
  AppElementsWire,
  normalizeAppElements,
} from "../packages/vinext/src/server/app-elements.js";
import {
  ACTION_REDIRECT_HEADER,
  ACTION_REVALIDATED_HEADER,
} from "../packages/vinext/src/server/headers.js";
import { navigationPlanner } from "../packages/vinext/src/server/navigation-planner.js";

vi.mock("@vitejs/plugin-rsc/browser", () => ({
  createFromFetch: vi.fn(),
  createTemporaryReferenceSet: vi.fn(() => new Map()),
  encodeReply: vi.fn(async () => "encoded-action-args"),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("app browser server action client", () => {
  it("commits a raw full-tree Flight payload from an internal action redirect", async () => {
    const wireElements = AppElementsWire.createMetadataEntries({
      interception: null,
      interceptionContext: null,
      layoutIds: [AppElementsWire.encodeLayoutId("/")],
      rootLayoutTreePath: "/",
      routeId: AppElementsWire.encodeRouteId("/target", null),
      slotBindings: [],
    });
    const elements = normalizeAppElements(wireElements);
    const routerState: AppRouterState = {
      activeOperation: null,
      bfcacheIds: {},
      elements,
      interception: null,
      interceptionContext: null,
      layoutFlags: {},
      layoutIds: [AppElementsWire.encodeLayoutId("/")],
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/source", {}),
      previousNextUrl: null,
      renderId: 0,
      rootLayoutTreePath: "/",
      routeId: AppElementsWire.encodeRouteId("/source", null),
      slotBindings: [],
      visibleCommitVersion: 0,
    };
    vi.stubGlobal("window", {
      location: { href: "https://example.com/source", origin: "https://example.com" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("flight", {
          status: 303,
          headers: {
            [ACTION_REDIRECT_HEADER]: "/target",
            "content-type": "text/x-component",
          },
        }),
      ),
    );
    vi.mocked(createFromFetch).mockResolvedValueOnce(wireElements);
    const renderRedirectPayload = vi.fn();
    const performHardNavigation = vi.fn();

    await expect(
      invokeClientServerAction(
        "action-id",
        [],
        createServerActionInitiationSnapshot({
          href: "https://example.com/source",
          navigationId: 1,
          routerState,
        }),
        {
          basePath: "",
          clearClientNavigationCaches: vi.fn(),
          clientRscCompatibilityId: null,
          commitSameUrlNavigatePayload: vi.fn(),
          navigationPlanner,
          performHardNavigation,
          renderRedirectPayload,
          syncCurrentHistoryState: vi.fn(),
          syncServerActionHttpFallbackHead: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ handled: true });

    expect(renderRedirectPayload).toHaveBeenCalledWith(
      normalizeAppElements(wireElements),
      expect.objectContaining({ href: "https://example.com/target" }),
      expect.any(Object),
      "none",
    );
    expect(performHardNavigation).not.toHaveBeenCalled();
  });

  it("uses action state captured before the lazy client loads", async () => {
    const elements = normalizeAppElements(
      AppElementsWire.createMetadataEntries({
        interception: null,
        interceptionContext: null,
        layoutIds: [AppElementsWire.encodeLayoutId("/")],
        rootLayoutTreePath: "/",
        routeId: "route:/original",
        slotBindings: [],
      }),
    );
    const routerState: AppRouterState = {
      activeOperation: null,
      bfcacheIds: {},
      elements,
      interception: null,
      interceptionContext: null,
      layoutFlags: {},
      layoutIds: [AppElementsWire.encodeLayoutId("/")],
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/original", {}),
      previousNextUrl: null,
      renderId: 0,
      rootLayoutTreePath: "/",
      routeId: "route:/original",
      slotBindings: [],
      visibleCommitVersion: 0,
    };
    const actionInitiation = createServerActionInitiationSnapshot({
      href: "https://example.com/original?tab=1",
      navigationId: 42,
      routerState,
    });
    vi.stubGlobal("window", {
      location: {
        href: "https://example.com/newer",
        origin: "https://example.com",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 303,
        headers: {
          [ACTION_REDIRECT_HEADER]: "/target",
          "content-type": "text/plain",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await invokeClientServerAction("action-id", [], actionInitiation, {
      basePath: "",
      clearClientNavigationCaches: vi.fn(),
      clientRscCompatibilityId: null,
      commitSameUrlNavigatePayload: vi.fn(),
      navigationPlanner,
      performHardNavigation: vi.fn(),
      renderRedirectPayload: vi.fn(),
      syncCurrentHistoryState: vi.fn(),
      syncServerActionHttpFallbackHead: vi.fn(),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/original?tab=1",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // Ported from Next.js: test/e2e/app-dir/app-basepath/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-basepath/index.test.ts
  it("hard navigates for same-origin action redirects outside basePath", async () => {
    const elements = normalizeAppElements(
      AppElementsWire.createMetadataEntries({
        interception: null,
        interceptionContext: null,
        layoutIds: [AppElementsWire.encodeLayoutId("/")],
        rootLayoutTreePath: "/",
        routeId: "route:/client",
        slotBindings: [],
      }),
    );
    const routerState: AppRouterState = {
      activeOperation: null,
      bfcacheIds: {},
      elements,
      interception: null,
      interceptionContext: null,
      layoutFlags: {},
      layoutIds: [AppElementsWire.encodeLayoutId("/")],
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/base/client",
        {},
      ),
      previousNextUrl: null,
      renderId: 0,
      rootLayoutTreePath: "/",
      routeId: "route:/client",
      slotBindings: [],
      visibleCommitVersion: 0,
    };
    const actionInitiation = createServerActionInitiationSnapshot({
      href: "https://example.com/base/client",
      navigationId: 1,
      routerState,
    });
    vi.stubGlobal("window", {
      location: {
        href: "https://example.com/base/client",
        origin: "https://example.com",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 303,
          headers: {
            [ACTION_REDIRECT_HEADER]: "https://example.com/outsideBasePath",
            "content-type": "text/plain",
          },
        }),
      ),
    );
    const performHardNavigation = vi.fn();
    const renderRedirectPayload = vi.fn();

    await invokeClientServerAction("action-id", [], actionInitiation, {
      basePath: "/base",
      clearClientNavigationCaches: vi.fn(),
      clientRscCompatibilityId: null,
      commitSameUrlNavigatePayload: vi.fn(),
      navigationPlanner,
      performHardNavigation,
      renderRedirectPayload,
      syncCurrentHistoryState: vi.fn(),
      syncServerActionHttpFallbackHead: vi.fn(),
    });

    expect(performHardNavigation).toHaveBeenCalledWith(
      "https://example.com/outsideBasePath",
      undefined,
    );
    expect(renderRedirectPayload).not.toHaveBeenCalled();
  });

  // Next.js parity contract: a fetch action that neither revalidates nor
  // redirects gets an empty Flight payload — the client resolves the action
  // value without committing a visible router update. The server omits `root`
  // for these responses (packages/vinext/src/server/app-server-action-execution.ts,
  // shouldSkipPageRendering), mirroring Next.js' skip-page-rendering decision:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/action-handler.ts
  // and its client-side bail-out:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/router-reducer/reducers/server-action-reducer.ts
  it("returns the action value without committing when the server omits the tree", async () => {
    const routerState = createActionTestRouterState();
    const actionInitiation = createServerActionInitiationSnapshot({
      href: "https://example.com/source",
      navigationId: 1,
      routerState,
    });
    vi.stubGlobal("window", {
      location: { href: "https://example.com/source", origin: "https://example.com" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("flight", {
          status: 200,
          headers: { "content-type": "text/x-component" },
        }),
      ),
    );
    vi.mocked(createFromFetch).mockResolvedValueOnce({
      returnValue: { ok: true, data: "latest-form-state" },
    });
    const commitSameUrlNavigatePayload = vi.fn();
    const clearClientNavigationCaches = vi.fn();

    await expect(
      invokeClientServerAction("action-id", [], actionInitiation, {
        basePath: "",
        clearClientNavigationCaches,
        clientRscCompatibilityId: null,
        commitSameUrlNavigatePayload,
        navigationPlanner,
        performHardNavigation: vi.fn(),
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      }),
    ).resolves.toBe("latest-form-state");

    expect(commitSameUrlNavigatePayload).not.toHaveBeenCalled();
    expect(clearClientNavigationCaches).not.toHaveBeenCalled();
  });

  it("throws the action error without committing when the action failed", async () => {
    const routerState = createActionTestRouterState();
    const actionInitiation = createServerActionInitiationSnapshot({
      href: "https://example.com/source",
      navigationId: 1,
      routerState,
    });
    vi.stubGlobal("window", {
      location: { href: "https://example.com/source", origin: "https://example.com" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("flight", {
          status: 200,
          headers: { "content-type": "text/x-component" },
        }),
      ),
    );
    vi.mocked(createFromFetch).mockResolvedValueOnce({
      returnValue: { ok: false, data: new Error("action boom") },
    });
    const commitSameUrlNavigatePayload = vi.fn();

    await expect(
      invokeClientServerAction("action-id", [], actionInitiation, {
        basePath: "",
        clearClientNavigationCaches: vi.fn(),
        clientRscCompatibilityId: null,
        commitSameUrlNavigatePayload,
        navigationPlanner,
        performHardNavigation: vi.fn(),
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      }),
    ).rejects.toMatchObject({ message: "action boom" });

    expect(commitSameUrlNavigatePayload).not.toHaveBeenCalled();
  });

  it("commits the RSC tree for revalidated actions and returns the action value", async () => {
    const wireElements = AppElementsWire.createMetadataEntries({
      interception: null,
      interceptionContext: null,
      layoutIds: [AppElementsWire.encodeLayoutId("/")],
      rootLayoutTreePath: "/",
      routeId: AppElementsWire.encodeRouteId("/source", null),
      slotBindings: [],
    });
    const routerState = createActionTestRouterState();
    const actionInitiation = createServerActionInitiationSnapshot({
      href: "https://example.com/source",
      navigationId: 1,
      routerState,
    });
    vi.stubGlobal("window", {
      location: { href: "https://example.com/source", origin: "https://example.com" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("flight", {
          status: 200,
          headers: {
            "content-type": "text/x-component",
            [ACTION_REVALIDATED_HEADER]: "2",
          },
        }),
      ),
    );
    vi.mocked(createFromFetch).mockResolvedValueOnce({
      root: wireElements,
      returnValue: { ok: true, data: "value-after-revalidation" },
    });
    const commitSameUrlNavigatePayload = vi.fn();
    const clearClientNavigationCaches = vi.fn();

    await invokeClientServerAction("action-id", [], actionInitiation, {
      basePath: "",
      clearClientNavigationCaches,
      clientRscCompatibilityId: null,
      commitSameUrlNavigatePayload,
      navigationPlanner,
      performHardNavigation: vi.fn(),
      renderRedirectPayload: vi.fn(),
      syncCurrentHistoryState: vi.fn(),
      syncServerActionHttpFallbackHead: vi.fn(),
    });

    expect(clearClientNavigationCaches).toHaveBeenCalledTimes(1);
    expect(commitSameUrlNavigatePayload).toHaveBeenCalledTimes(1);
    const [elementsArg, , returnValueArg, revalidationArg] =
      commitSameUrlNavigatePayload.mock.calls[0];
    await expect(elementsArg).resolves.toEqual(normalizeAppElements(wireElements));
    expect(returnValueArg).toEqual({ ok: true, data: "value-after-revalidation" });
    expect(revalidationArg).toBe("dynamicOnly");
  });

  it("commits the RSC tree for revalidated void actions with no return value", async () => {
    const wireElements = AppElementsWire.createMetadataEntries({
      interception: null,
      interceptionContext: null,
      layoutIds: [AppElementsWire.encodeLayoutId("/")],
      rootLayoutTreePath: "/",
      routeId: AppElementsWire.encodeRouteId("/source", null),
      slotBindings: [],
    });
    const routerState = createActionTestRouterState();
    const actionInitiation = createServerActionInitiationSnapshot({
      href: "https://example.com/source",
      navigationId: 1,
      routerState,
    });
    vi.stubGlobal("window", {
      location: { href: "https://example.com/source", origin: "https://example.com" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("flight", {
          status: 200,
          headers: {
            "content-type": "text/x-component",
            [ACTION_REVALIDATED_HEADER]: "1",
          },
        }),
      ),
    );
    // The server always pairs a re-rendered root with a returnValue record —
    // void actions come back as `{ ok: true, data: undefined }`, which Flight
    // serializes as `$undefined` and decodes to a truthy object, never an
    // omitted key (app-server-action-execution.ts renderToReadableStream).
    vi.mocked(createFromFetch).mockResolvedValueOnce({
      root: wireElements,
      returnValue: { ok: true, data: undefined },
    });
    const commitSameUrlNavigatePayload = vi.fn();
    const clearClientNavigationCaches = vi.fn();

    await expect(
      invokeClientServerAction("action-id", [], actionInitiation, {
        basePath: "",
        clearClientNavigationCaches,
        clientRscCompatibilityId: null,
        commitSameUrlNavigatePayload,
        navigationPlanner,
        performHardNavigation: vi.fn(),
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      }),
    ).resolves.toBeUndefined();

    expect(clearClientNavigationCaches).toHaveBeenCalledTimes(1);
    expect(commitSameUrlNavigatePayload).toHaveBeenCalledTimes(1);
    const [elementsArg, , returnValueArg, revalidationArg] =
      commitSameUrlNavigatePayload.mock.calls[0];
    await expect(elementsArg).resolves.toEqual(normalizeAppElements(wireElements));
    expect(returnValueArg).toEqual({ ok: true, data: undefined });
    expect(revalidationArg).toBe("staticAndDynamic");
  });

  it("commits a raw full-tree payload from a non-action RSC response", async () => {
    const wireElements = AppElementsWire.createMetadataEntries({
      interception: null,
      interceptionContext: null,
      layoutIds: [AppElementsWire.encodeLayoutId("/")],
      rootLayoutTreePath: "/",
      routeId: AppElementsWire.encodeRouteId("/source", null),
      slotBindings: [],
    });
    const routerState = createActionTestRouterState();
    const actionInitiation = createServerActionInitiationSnapshot({
      href: "https://example.com/source",
      navigationId: 1,
      routerState,
    });
    vi.stubGlobal("window", {
      location: { href: "https://example.com/source", origin: "https://example.com" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("flight", {
          status: 200,
          headers: { "content-type": "text/x-component" },
        }),
      ),
    );
    vi.mocked(createFromFetch).mockResolvedValueOnce(wireElements);
    const commitSameUrlNavigatePayload = vi.fn();
    const clearClientNavigationCaches = vi.fn();

    await invokeClientServerAction("action-id", [], actionInitiation, {
      basePath: "",
      clearClientNavigationCaches,
      clientRscCompatibilityId: null,
      commitSameUrlNavigatePayload,
      navigationPlanner,
      performHardNavigation: vi.fn(),
      renderRedirectPayload: vi.fn(),
      syncCurrentHistoryState: vi.fn(),
      syncServerActionHttpFallbackHead: vi.fn(),
    });

    expect(clearClientNavigationCaches).toHaveBeenCalledTimes(1);
    expect(commitSameUrlNavigatePayload).toHaveBeenCalledTimes(1);
    const [elementsArg, , returnValueArg, revalidationArg] =
      commitSameUrlNavigatePayload.mock.calls[0];
    await expect(elementsArg).resolves.toEqual(normalizeAppElements(wireElements));
    expect(returnValueArg).toBeUndefined();
    expect(revalidationArg).toBe("none");
  });
});

function createActionTestRouterState(): AppRouterState {
  const elements = normalizeAppElements(
    AppElementsWire.createMetadataEntries({
      interception: null,
      interceptionContext: null,
      layoutIds: [AppElementsWire.encodeLayoutId("/")],
      rootLayoutTreePath: "/",
      routeId: "route:/source",
      slotBindings: [],
    }),
  );
  return {
    activeOperation: null,
    bfcacheIds: {},
    elements,
    interception: null,
    interceptionContext: null,
    layoutFlags: {},
    layoutIds: [AppElementsWire.encodeLayoutId("/")],
    navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/source", {}),
    previousNextUrl: null,
    renderId: 0,
    rootLayoutTreePath: "/",
    routeId: "route:/source",
    slotBindings: [],
    visibleCommitVersion: 0,
  };
}
