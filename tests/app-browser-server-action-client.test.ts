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
import { VINEXT_RSC_COMPATIBILITY_ID_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import {
  ACTION_REDIRECT_HEADER,
  ACTION_REDIRECT_STATUS_HEADER,
  ACTION_REVALIDATED_HEADER,
  VINEXT_RENDERED_PATH_AND_SEARCH_HEADER,
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

    await expect(
      invokeClientServerAction("action-id", [], actionInitiation, {
        basePath: "",
        clearClientNavigationCaches: vi.fn(),
        clearDynamicClientNavigationCaches: vi.fn(),
        clientRscCompatibilityId: null,
        commitSameUrlNavigatePayload: vi.fn(),
        navigationPlanner,
        performHardNavigation: vi.fn(),
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      }),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;push;/target;307;" });

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

    await expect(
      invokeClientServerAction("action-id", [], actionInitiation, {
        basePath: "/base",
        clearClientNavigationCaches: vi.fn(),
        clearDynamicClientNavigationCaches: vi.fn(),
        clientRscCompatibilityId: null,
        commitSameUrlNavigatePayload: vi.fn(),
        navigationPlanner,
        performHardNavigation,
        renderRedirectPayload,
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      }),
    ).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;push;/outsideBasePath;307;",
      handled: true,
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
        clearDynamicClientNavigationCaches: vi.fn(),
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

  // Issue #4836. When a response hands the page to a hard navigation, the
  // caller still gets the action's outcome, as in Next.js 16.2.7's
  // server-action-reducer.ts: a build ID mismatch only discards the flight
  // data and resolves with the action result; a redirect rejects with the
  // redirect error, external ones keeping their full URL.
  describe("when the response hard-navigates", () => {
    function invokeWithResponse(
      response: Response,
      options: { basePath?: string; clientRscCompatibilityId?: string | null } = {},
    ) {
      vi.stubGlobal("window", {
        location: { href: "https://example.com/source?tab=1", origin: "https://example.com" },
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const deps = {
        basePath: options.basePath ?? "",
        clearClientNavigationCaches: vi.fn(),
        clearDynamicClientNavigationCaches: vi.fn(),
        clientRscCompatibilityId: options.clientRscCompatibilityId ?? null,
        commitSameUrlNavigatePayload: vi.fn(),
        navigationPlanner,
        performHardNavigation: vi.fn(),
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      };
      const result = invokeClientServerAction(
        "action-id",
        [],
        createServerActionInitiationSnapshot({
          href: "https://example.com/source?tab=1",
          navigationId: 1,
          routerState: createActionTestRouterState(),
        }),
        deps,
      );
      return { deps, result };
    }

    function skewedResponse(headers: Record<string, string> = {}, status = 200) {
      return new Response("flight", {
        status,
        headers: {
          "content-type": "text/x-component",
          [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "newer-build",
          ...headers,
        },
      });
    }

    it("resolves with the action value on a compatibility-id mismatch", async () => {
      vi.mocked(createFromFetch).mockResolvedValueOnce({
        root: AppElementsWire.createMetadataEntries({
          interception: null,
          interceptionContext: null,
          layoutIds: [AppElementsWire.encodeLayoutId("/")],
          rootLayoutTreePath: "/",
          routeId: "route:/source",
          slotBindings: [],
        }),
        returnValue: { ok: true, data: { ok: true } },
      });
      const { deps, result } = invokeWithResponse(
        skewedResponse({ [ACTION_REVALIDATED_HEADER]: "1" }),
        { clientRscCompatibilityId: "older-build" },
      );

      await expect(result).resolves.toEqual({ ok: true });
      expect(deps.performHardNavigation).toHaveBeenCalledWith(
        "https://example.com/source?tab=1",
        undefined,
      );
      // The newer build's tree is discarded, not committed.
      expect(deps.commitSameUrlNavigatePayload).not.toHaveBeenCalled();
    });

    it("rejects with the action's error on a compatibility-id mismatch", async () => {
      const thrown = new Error("save failed");
      const rejection = Promise.reject(thrown);
      rejection.catch(() => {});
      vi.mocked(createFromFetch).mockResolvedValueOnce({
        returnValue: { ok: false, data: rejection },
      });
      const { deps, result } = invokeWithResponse(skewedResponse({}, 500), {
        clientRscCompatibilityId: "older-build",
      });

      await expect(result).rejects.toBe(thrown);
      expect(deps.performHardNavigation).toHaveBeenCalledTimes(1);
    });

    it("rejects with the redirect error on a mismatched action redirect", async () => {
      const { deps, result } = invokeWithResponse(
        skewedResponse({ [ACTION_REDIRECT_HEADER]: "/target" }, 303),
        { clientRscCompatibilityId: "older-build" },
      );

      await expect(result).rejects.toMatchObject({
        digest: "NEXT_REDIRECT;push;/target;307;",
        handled: true,
      });
      expect(deps.performHardNavigation).toHaveBeenCalledWith(
        "https://example.com/target",
        "assign",
      );
      expect(createFromFetch).not.toHaveBeenCalled();
    });

    // Next.js removes basePath from internal action redirect errors.
    it("rejects with a basePath-less redirect error on a mismatched redirect under basePath", async () => {
      const { deps, result } = invokeWithResponse(
        skewedResponse({ [ACTION_REDIRECT_HEADER]: "/base/target?step=2" }, 303),
        { basePath: "/base", clientRscCompatibilityId: "older-build" },
      );

      await expect(result).rejects.toMatchObject({
        digest: "NEXT_REDIRECT;push;/target?step=2;307;",
      });
      // The document still loads the browser URL, with its basePath.
      expect(deps.performHardNavigation).toHaveBeenCalledWith(
        "https://example.com/base/target?step=2",
        "assign",
      );
    });

    // Next.js' createRedirectErrorForAction uses getRedirectError's default
    // 307: only the HTTP response carries permanentRedirect()'s 308.
    it.each([
      ["a mismatched", "text/x-component", "older-build"],
      ["a non-RSC", "text/plain", null],
    ])(
      "rejects with a 307 redirect error for %s permanent redirect",
      async (_label, contentType, clientRscCompatibilityId) => {
        const { deps, result } = invokeWithResponse(
          skewedResponse(
            {
              [ACTION_REDIRECT_HEADER]: "/target",
              [ACTION_REDIRECT_STATUS_HEADER]: "308",
              "content-type": contentType,
            },
            303,
          ),
          { clientRscCompatibilityId },
        );

        await expect(result).rejects.toMatchObject({
          digest: "NEXT_REDIRECT;push;/target;307;",
        });
        expect(deps.performHardNavigation).toHaveBeenCalledTimes(1);
      },
    );

    it("rejects with the full-URL redirect error on a cross-origin action redirect", async () => {
      const { deps, result } = invokeWithResponse(
        new Response(null, {
          status: 303,
          headers: {
            [ACTION_REDIRECT_HEADER]: "https://other.example/landing",
            "content-type": "text/plain",
          },
        }),
      );

      await expect(result).rejects.toMatchObject({
        digest: "NEXT_REDIRECT;push;https://other.example/landing;307;",
        handled: true,
      });
      expect(deps.performHardNavigation).toHaveBeenCalledWith(
        "https://other.example/landing",
        undefined,
      );
    });

    it("rejects with the redirect error on a non-RSC same-origin action redirect", async () => {
      const { deps, result } = invokeWithResponse(
        new Response(null, {
          status: 303,
          headers: { [ACTION_REDIRECT_HEADER]: "/target", "content-type": "text/plain" },
        }),
      );

      await expect(result).rejects.toMatchObject({
        digest: "NEXT_REDIRECT;push;/target;307;",
      });
      expect(deps.performHardNavigation).toHaveBeenCalledWith("https://example.com/target");
    });

    it("rejects with the redirect error on an RSC action redirect without a tree", async () => {
      vi.mocked(createFromFetch).mockResolvedValueOnce({
        returnValue: { ok: true, data: undefined },
      });
      const { deps, result } = invokeWithResponse(
        new Response("flight", {
          status: 303,
          headers: { [ACTION_REDIRECT_HEADER]: "/target", "content-type": "text/x-component" },
        }),
      );

      await expect(result).rejects.toMatchObject({
        digest: "NEXT_REDIRECT;push;/target;307;",
      });
      expect(deps.performHardNavigation).toHaveBeenCalledWith("https://example.com/target");
      expect(deps.renderRedirectPayload).not.toHaveBeenCalled();
    });
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
