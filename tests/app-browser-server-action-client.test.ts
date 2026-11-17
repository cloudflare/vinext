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
  VINEXT_RENDERED_PATH_AND_SEARCH_HEADER,
} from "../packages/vinext/src/server/headers.js";
import { navigationPlanner } from "../packages/vinext/src/server/navigation-planner.js";
import { VINEXT_RSC_COMPATIBILITY_ID_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";

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
  // A "/.//" target names a "//" pathname on the app origin, so the thrown
  // redirect digest keeps its "/." prefix rather than a protocol-relative URL.
  it.each([
    ["/target", "https://example.com/target", "/target"],
    [
      "/.//other.invalid/landing",
      "https://example.com//other.invalid/landing",
      "/.//other.invalid/landing",
    ],
  ])(
    "commits a raw full-tree Flight payload from an internal action redirect to %s",
    async (target, href, digestUrl) => {
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
              [ACTION_REDIRECT_HEADER]: target,
              // The target's render, rewritten from /target to /page?q=rewritten.
              [VINEXT_RENDERED_PATH_AND_SEARCH_HEADER]: encodeURIComponent("/page?q=rewritten"),
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
            clearDynamicClientNavigationCaches: vi.fn(),
            clientRscCompatibilityId: null,
            commitSameUrlNavigatePayload: vi.fn(),
            navigationPlanner,
            notifyDiscardedServerActionRevalidation: vi.fn(),
            ownsRouterForServerAction: () => true,
            performHardNavigation,
            renderRedirectPayload,
            syncCurrentHistoryState: vi.fn(),
            syncServerActionHttpFallbackHead: vi.fn(),
          },
        ),
      ).rejects.toMatchObject({ digest: `NEXT_REDIRECT;push;${digestUrl};307;`, handled: true });

      expect(renderRedirectPayload).toHaveBeenCalledWith(
        normalizeAppElements(wireElements),
        // Client pages in the target read the query it rendered with.
        expect.objectContaining({
          href,
          renderedPathAndSearch: "/page?q=rewritten",
        }),
        expect.any(Object),
        "none",
      );
      expect(performHardNavigation).not.toHaveBeenCalled();
    },
  );

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
      clearDynamicClientNavigationCaches: vi.fn(),
      clientRscCompatibilityId: null,
      commitSameUrlNavigatePayload: vi.fn(),
      navigationPlanner,
      notifyDiscardedServerActionRevalidation: vi.fn(),
      ownsRouterForServerAction: () => true,
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
      clearDynamicClientNavigationCaches: vi.fn(),
      clientRscCompatibilityId: null,
      commitSameUrlNavigatePayload: vi.fn(),
      navigationPlanner,
      notifyDiscardedServerActionRevalidation: vi.fn(),
      ownsRouterForServerAction: () => true,
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
        clearDynamicClientNavigationCaches: vi.fn(),
        clientRscCompatibilityId: null,
        commitSameUrlNavigatePayload,
        navigationPlanner,
        notifyDiscardedServerActionRevalidation: vi.fn(),
        ownsRouterForServerAction: () => true,
        performHardNavigation: vi.fn(),
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      }),
    ).resolves.toBe("latest-form-state");

    expect(commitSameUrlNavigatePayload).not.toHaveBeenCalled();
    expect(clearClientNavigationCaches).not.toHaveBeenCalled();
  });

  describe("compatible revalidating action responses without a tree", () => {
    function setUpForwardedResponse(ownsRouter: boolean) {
      vi.stubGlobal("window", {
        location: { href: "https://example.com/source?tab=billing", origin: "https://example.com" },
      });
      // A forwarded action revalidates but skips page rendering: the response
      // carries only its value, with the client's own compatibility id.
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("flight", {
              status: 200,
              headers: {
                "content-type": "text/x-component",
                [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "current-deployment",
                [ACTION_REVALIDATED_HEADER]: "2",
              },
            }),
        ),
      );
      vi.mocked(createFromFetch).mockResolvedValueOnce({
        returnValue: { ok: true, data: "saved" },
      });
      const actionInitiation = createServerActionInitiationSnapshot({
        href: "https://example.com/source?tab=profile",
        navigationId: 1,
        routerState: createActionTestRouterState(),
      });
      const deps = {
        basePath: "",
        clearClientNavigationCaches: vi.fn(),
        clearDynamicClientNavigationCaches: vi.fn(),
        clientRscCompatibilityId: "current-deployment",
        commitSameUrlNavigatePayload: vi.fn(),
        navigationPlanner,
        notifyDiscardedServerActionRevalidation: vi.fn(),
        ownsRouterForServerAction: vi.fn(() => ownsRouter),
        performHardNavigation: vi.fn(),
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      };
      return { actionInitiation, deps };
    }

    it("refreshes what the action revalidated when a navigation superseded it", async () => {
      const { actionInitiation, deps } = setUpForwardedResponse(false);

      await expect(invokeClientServerAction("action-id", [], actionInitiation, deps)).resolves.toBe(
        "saved",
      );
      expect(deps.performHardNavigation).not.toHaveBeenCalled();
      expect(deps.commitSameUrlNavigatePayload).not.toHaveBeenCalled();
      expect(deps.clearDynamicClientNavigationCaches).toHaveBeenCalledTimes(1);
      expect(deps.notifyDiscardedServerActionRevalidation).toHaveBeenCalledWith("dynamicOnly");
    });

    it("refreshes what the action revalidated while the action owns the router", async () => {
      // Next.js navigates to the current URL for a revalidating response that
      // carries no Flight data.
      const { actionInitiation, deps } = setUpForwardedResponse(true);

      await expect(invokeClientServerAction("action-id", [], actionInitiation, deps)).resolves.toBe(
        "saved",
      );
      expect(deps.performHardNavigation).not.toHaveBeenCalled();
      expect(deps.commitSameUrlNavigatePayload).not.toHaveBeenCalled();
      expect(deps.notifyDiscardedServerActionRevalidation).toHaveBeenCalledWith("dynamicOnly");
    });
  });

  describe("incompatible action responses", () => {
    const sourceHref = "https://example.com/source?tab=profile";

    function setUpIncompatibleResponse(headers: Record<string, string> = {}) {
      vi.stubGlobal("window", {
        location: { href: "https://example.com/source?tab=billing", origin: "https://example.com" },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("flight", {
              status: 200,
              headers: {
                "content-type": "text/x-component",
                [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "next-deployment",
                ...headers,
              },
            }),
        ),
      );
      const actionInitiation = createServerActionInitiationSnapshot({
        href: sourceHref,
        navigationId: 1,
        routerState: createActionTestRouterState(),
      });
      const deps = {
        basePath: "",
        clearClientNavigationCaches: vi.fn(),
        clearDynamicClientNavigationCaches: vi.fn(),
        clientRscCompatibilityId: "current-deployment",
        commitSameUrlNavigatePayload: vi.fn(),
        navigationPlanner,
        notifyDiscardedServerActionRevalidation: vi.fn(),
        // A navigation superseded the action: it owns what loads next, so the
        // action must not reload the page it came from.
        ownsRouterForServerAction: vi.fn(() => false),
        performHardNavigation: vi.fn(),
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      };
      return { actionInitiation, deps };
    }

    it("resolves a discarded action's value and hands its tree to the commit's ownership check", async () => {
      const { actionInitiation, deps } = setUpIncompatibleResponse({
        [ACTION_REVALIDATED_HEADER]: "1",
      });
      const wireElements = AppElementsWire.createMetadataEntries({
        interception: null,
        interceptionContext: null,
        layoutIds: [AppElementsWire.encodeLayoutId("/")],
        rootLayoutTreePath: "/",
        routeId: AppElementsWire.encodeRouteId("/source", null),
        slotBindings: [],
      });
      vi.mocked(createFromFetch).mockResolvedValueOnce({
        root: wireElements,
        returnValue: { ok: true, data: "saved" },
      });
      // The commit discards a tree the action does not own and resolves its value.
      deps.commitSameUrlNavigatePayload.mockImplementation(
        async (_elements: unknown, _initiation: unknown, returnValue?: { data: unknown }) =>
          returnValue?.data,
      );

      await expect(invokeClientServerAction("action-id", [], actionInitiation, deps)).resolves.toBe(
        "saved",
      );
      expect(deps.ownsRouterForServerAction).toHaveBeenCalledWith(actionInitiation);
      expect(deps.performHardNavigation).not.toHaveBeenCalled();
      expect(deps.clearClientNavigationCaches).toHaveBeenCalledTimes(1);
      expect(deps.commitSameUrlNavigatePayload).toHaveBeenCalledTimes(1);
      const [elementsArg, initiationArg, returnValueArg, revalidationArg] =
        deps.commitSameUrlNavigatePayload.mock.calls[0];
      await expect(elementsArg).resolves.toEqual(normalizeAppElements(wireElements));
      expect(initiationArg).toBe(actionInitiation);
      expect(returnValueArg).toEqual({ ok: true, data: "saved" });
      expect(revalidationArg).toBe("staticAndDynamic");
    });

    it("rejects with a discarded action's error", async () => {
      const { actionInitiation, deps } = setUpIncompatibleResponse({
        [ACTION_REVALIDATED_HEADER]: "2",
      });
      const thrown = new Error("action failed");
      vi.mocked(createFromFetch).mockResolvedValueOnce({
        returnValue: { ok: false, data: thrown },
      });

      await expect(invokeClientServerAction("action-id", [], actionInitiation, deps)).rejects.toBe(
        thrown,
      );
      expect(deps.performHardNavigation).not.toHaveBeenCalled();
      expect(deps.commitSameUrlNavigatePayload).not.toHaveBeenCalled();
      expect(deps.notifyDiscardedServerActionRevalidation).toHaveBeenCalledWith("dynamicOnly");
    });

    it("refreshes what a discarded forwarded action revalidated without a tree", async () => {
      // A forwarded action revalidates but skips page rendering: the response
      // carries only its value.
      const { actionInitiation, deps } = setUpIncompatibleResponse({
        [ACTION_REVALIDATED_HEADER]: "1",
      });
      vi.mocked(createFromFetch).mockResolvedValueOnce({
        returnValue: { ok: true, data: "saved" },
      });

      await expect(invokeClientServerAction("action-id", [], actionInitiation, deps)).resolves.toBe(
        "saved",
      );
      expect(deps.performHardNavigation).not.toHaveBeenCalled();
      expect(deps.commitSameUrlNavigatePayload).not.toHaveBeenCalled();
      expect(deps.clearClientNavigationCaches).toHaveBeenCalledTimes(1);
      expect(deps.notifyDiscardedServerActionRevalidation).toHaveBeenCalledWith("staticAndDynamic");
    });

    it("discards an incompatible redirect and refreshes what the action revalidated", async () => {
      const { actionInitiation, deps } = setUpIncompatibleResponse({
        [ACTION_REDIRECT_HEADER]: "/target",
        [ACTION_REVALIDATED_HEADER]: "1",
      });

      await expect(
        invokeClientServerAction("action-id", [], actionInitiation, deps),
      ).resolves.toBeUndefined();
      expect(deps.performHardNavigation).not.toHaveBeenCalled();
      expect(deps.commitSameUrlNavigatePayload).not.toHaveBeenCalled();
      expect(createFromFetch).not.toHaveBeenCalled();
      expect(deps.clearClientNavigationCaches).toHaveBeenCalledTimes(1);
      expect(deps.notifyDiscardedServerActionRevalidation).toHaveBeenCalledWith("staticAndDynamic");
    });

    it("reloads the page the action was posted from while the action owns the router", async () => {
      const { actionInitiation, deps } = setUpIncompatibleResponse({
        [ACTION_REVALIDATED_HEADER]: "1",
      });
      deps.ownsRouterForServerAction.mockReturnValue(true);

      await expect(
        invokeClientServerAction("action-id", [], actionInitiation, deps),
      ).resolves.toBeUndefined();
      expect(deps.performHardNavigation).toHaveBeenCalledWith(sourceHref, undefined);
      expect(createFromFetch).not.toHaveBeenCalled();
      expect(deps.commitSameUrlNavigatePayload).not.toHaveBeenCalled();
      expect(deps.notifyDiscardedServerActionRevalidation).not.toHaveBeenCalled();
    });
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
        clearDynamicClientNavigationCaches: vi.fn(),
        clientRscCompatibilityId: null,
        commitSameUrlNavigatePayload,
        navigationPlanner,
        notifyDiscardedServerActionRevalidation: vi.fn(),
        ownsRouterForServerAction: () => true,
        performHardNavigation: vi.fn(),
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      }),
    ).rejects.toMatchObject({ message: "action boom" });

    expect(commitSameUrlNavigatePayload).not.toHaveBeenCalled();
  });

  it("commits the RSC tree of a failed action without waiting for its rejection", async () => {
    const wireElements = AppElementsWire.createMetadataEntries({
      interception: null,
      interceptionContext: null,
      layoutIds: [AppElementsWire.encodeLayoutId("/")],
      rootLayoutTreePath: "/",
      routeId: AppElementsWire.encodeRouteId("/source", null),
      slotBindings: [],
    });
    const actionInitiation = createServerActionInitiationSnapshot({
      href: "https://example.com/source",
      navigationId: 1,
      routerState: createActionTestRouterState(),
    });
    vi.stubGlobal("window", {
      location: { href: "https://example.com/source", origin: "https://example.com" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("flight", {
          status: 500,
          headers: { "content-type": "text/x-component", [ACTION_REVALIDATED_HEADER]: "2" },
        }),
      ),
    );
    // The action's rejection arrives in a later Flight chunk than the tree.
    const thrown = new Error("action failed after revalidating");
    let rejectActionResult: (error: unknown) => void = () => {};
    const actionResult = new Promise<never>((_resolve, reject) => {
      rejectActionResult = reject;
    });
    vi.mocked(createFromFetch).mockResolvedValueOnce({
      root: wireElements,
      returnValue: { ok: false, data: actionResult },
    });
    const commitSameUrlNavigatePayload = vi.fn(
      async (_elements: unknown, _initiation: unknown, returnValue?: { data: unknown }) => {
        throw await returnValue?.data;
      },
    );

    const result = invokeClientServerAction("action-id", [], actionInitiation, {
      basePath: "",
      clearClientNavigationCaches: vi.fn(),
      clearDynamicClientNavigationCaches: vi.fn(),
      clientRscCompatibilityId: null,
      commitSameUrlNavigatePayload,
      navigationPlanner,
      notifyDiscardedServerActionRevalidation: vi.fn(),
      ownsRouterForServerAction: () => true,
      performHardNavigation: vi.fn(),
      renderRedirectPayload: vi.fn(),
      syncCurrentHistoryState: vi.fn(),
      syncServerActionHttpFallbackHead: vi.fn(),
    });
    const rejection = expect(result).rejects.toBe(thrown);

    await vi.waitFor(() => {
      expect(commitSameUrlNavigatePayload).toHaveBeenCalledOnce();
    });
    rejectActionResult(thrown);
    await rejection;
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
            // A rewrite on the POST re-rendered the page with another query.
            [VINEXT_RENDERED_PATH_AND_SEARCH_HEADER]: encodeURIComponent("/source?q=rewritten"),
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
    const clearDynamicClientNavigationCaches = vi.fn();

    await invokeClientServerAction("action-id", [], actionInitiation, {
      basePath: "",
      clearClientNavigationCaches,
      clearDynamicClientNavigationCaches,
      clientRscCompatibilityId: null,
      commitSameUrlNavigatePayload,
      navigationPlanner,
      notifyDiscardedServerActionRevalidation: vi.fn(),
      ownsRouterForServerAction: () => true,
      performHardNavigation: vi.fn(),
      renderRedirectPayload: vi.fn(),
      syncCurrentHistoryState: vi.fn(),
      syncServerActionHttpFallbackHead: vi.fn(),
    });

    // Like Next.js, `refresh()` alone keeps the static prefetches.
    expect(clearClientNavigationCaches).not.toHaveBeenCalled();
    expect(clearDynamicClientNavigationCaches).toHaveBeenCalledTimes(1);
    expect(commitSameUrlNavigatePayload).toHaveBeenCalledTimes(1);
    const [elementsArg, , returnValueArg, revalidationArg, renderedPathAndSearchArg] =
      commitSameUrlNavigatePayload.mock.calls[0];
    await expect(elementsArg).resolves.toEqual(normalizeAppElements(wireElements));
    expect(returnValueArg).toEqual({ ok: true, data: "value-after-revalidation" });
    expect(revalidationArg).toBe("dynamicOnly");
    expect(renderedPathAndSearchArg).toBe("/source?q=rewritten");
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
        clearDynamicClientNavigationCaches: vi.fn(),
        clientRscCompatibilityId: null,
        commitSameUrlNavigatePayload,
        navigationPlanner,
        notifyDiscardedServerActionRevalidation: vi.fn(),
        ownsRouterForServerAction: () => true,
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
      clearDynamicClientNavigationCaches: vi.fn(),
      clientRscCompatibilityId: null,
      commitSameUrlNavigatePayload,
      navigationPlanner,
      notifyDiscardedServerActionRevalidation: vi.fn(),
      ownsRouterForServerAction: () => true,
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
