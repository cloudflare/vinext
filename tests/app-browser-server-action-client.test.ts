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
import { startAppPrefetchRevalidationCooldown } from "../packages/vinext/src/shims/internal/app-prefetch-fetch-queue.js";

vi.mock(
  "../packages/vinext/src/shims/internal/app-prefetch-fetch-queue.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../packages/vinext/src/shims/internal/app-prefetch-fetch-queue.js")
    >()),
    startAppPrefetchRevalidationCooldown: vi.fn(),
  }),
);

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
      // Client pages in the target read the query it rendered with.
      expect.objectContaining({
        href: "https://example.com/target",
        renderedPathAndSearch: "/page?q=rewritten",
      }),
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

  // Next.js: server-action-reducer.ts calls startRevalidationCooldown() for
  // every revalidation kind, and never for an action that didn't revalidate.
  it.each([
    ["1", true],
    ["2", true],
    [null, false],
  ] as const)(
    "holds prefetches for the revalidation cooldown (x-action-revalidated: %s)",
    async (revalidatedHeader, startsCooldown) => {
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
            status: 200,
            headers: {
              "content-type": "text/x-component",
              ...(revalidatedHeader === null
                ? {}
                : { [ACTION_REVALIDATED_HEADER]: revalidatedHeader }),
            },
          }),
        ),
      );
      let decode!: () => void;
      vi.mocked(createFromFetch).mockReturnValueOnce(
        new Promise((resolve) => {
          decode = () => resolve({ returnValue: { ok: true, data: "value" } });
        }) as ReturnType<typeof createFromFetch>,
      );
      const clearClientNavigationCaches = vi.fn();

      const invoked = invokeClientServerAction("action-id", [], actionInitiation, {
        basePath: "",
        clearClientNavigationCaches,
        clientRscCompatibilityId: null,
        commitSameUrlNavigatePayload: vi.fn(),
        navigationPlanner,
        performHardNavigation: vi.fn(),
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      });
      const cooldownStarts = vi.mocked(startAppPrefetchRevalidationCooldown).mock;

      // The caches are cleared while the response is still decoding, so a
      // navigation meanwhile can't reuse data from before the revalidation.
      await vi.waitFor(() => expect(createFromFetch).toHaveBeenCalledOnce());
      expect(cooldownStarts.calls.length).toBe(startsCooldown ? 1 : 0);
      expect(clearClientNavigationCaches).toHaveBeenCalledTimes(startsCooldown ? 1 : 0);
      if (startsCooldown) {
        // Started before the cache clear, so its re-prefetches are held.
        expect(cooldownStarts.invocationCallOrder[0]).toBeLessThan(
          clearClientNavigationCaches.mock.invocationCallOrder[0]!,
        );
      }

      // Decoding restarts the cooldown, so the window ends 300ms after the
      // action completes, as in Next.js.
      decode();
      await invoked;
      expect(cooldownStarts.calls.length).toBe(startsCooldown ? 2 : 0);
      expect(clearClientNavigationCaches).toHaveBeenCalledTimes(startsCooldown ? 1 : 0);
    },
  );

  it.each([
    ["an invalid response", "text/plain", null],
    ["a response that fails to decode", "text/x-component", new Error("decode failed")],
  ] as const)(
    "clears the client caches when a revalidating action returns %s",
    async (_name, contentType, decodeError) => {
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
          new Response("action failed", {
            status: 500,
            headers: { "content-type": contentType, [ACTION_REVALIDATED_HEADER]: "1" },
          }),
        ),
      );
      if (decodeError !== null) vi.mocked(createFromFetch).mockRejectedValueOnce(decodeError);
      const clearClientNavigationCaches = vi.fn();

      await expect(
        invokeClientServerAction("action-id", [], actionInitiation, {
          basePath: "",
          clearClientNavigationCaches,
          clientRscCompatibilityId: null,
          commitSameUrlNavigatePayload: vi.fn(),
          navigationPlanner,
          performHardNavigation: vi.fn(),
          renderRedirectPayload: vi.fn(),
          syncCurrentHistoryState: vi.fn(),
          syncServerActionHttpFallbackHead: vi.fn(),
        }),
      ).rejects.toThrow(decodeError?.message ?? "action failed");

      // The server revalidated, so the caches can't keep data from before it.
      expect(startAppPrefetchRevalidationCooldown).toHaveBeenCalledOnce();
      expect(clearClientNavigationCaches).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: "a header-only redirect",
      redirect: "/source",
      basePath: "",
      navigatesTo: "https://example.com/source",
    },
    {
      name: "a redirect outside basePath",
      redirect: "/outside",
      basePath: "/base",
      navigatesTo: "/outside",
    },
    {
      name: "an external redirect",
      redirect: "https://other.example/landing",
      basePath: "",
      navigatesTo: "https://other.example/landing",
    },
  ])(
    "clears the client caches before hard navigating to $name that revalidated",
    async ({ redirect, basePath, navigatesTo }) => {
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
          new Response(null, {
            status: 303,
            headers: {
              [ACTION_REDIRECT_HEADER]: redirect,
              [ACTION_REVALIDATED_HEADER]: "1",
              "content-type": "text/plain",
            },
          }),
        ),
      );
      const clearClientNavigationCaches = vi.fn();
      // The loop guard refused the navigation, so this document stays.
      const performHardNavigation = vi.fn();

      await invokeClientServerAction("action-id", [], actionInitiation, {
        basePath,
        clearClientNavigationCaches,
        clientRscCompatibilityId: null,
        commitSameUrlNavigatePayload: vi.fn(),
        navigationPlanner,
        performHardNavigation,
        renderRedirectPayload: vi.fn(),
        syncCurrentHistoryState: vi.fn(),
        syncServerActionHttpFallbackHead: vi.fn(),
      });

      expect(performHardNavigation).toHaveBeenCalledOnce();
      expect(performHardNavigation.mock.calls[0]?.[0]).toBe(navigatesTo);
      expect(startAppPrefetchRevalidationCooldown).toHaveBeenCalledOnce();
      expect(clearClientNavigationCaches).toHaveBeenCalledOnce();
      expect(clearClientNavigationCaches.mock.invocationCallOrder[0]).toBeLessThan(
        performHardNavigation.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("starts the cooldown before a revalidating action's compatibility hard navigation", async () => {
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
          status: 200,
          headers: {
            "content-type": "text/x-component",
            [ACTION_REVALIDATED_HEADER]: "1",
            [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "new-build",
          },
        }),
      ),
    );
    const clearClientNavigationCaches = vi.fn();
    // The loop guard refused the navigation, so this document stays.
    const performHardNavigation = vi.fn();

    await invokeClientServerAction("action-id", [], actionInitiation, {
      basePath: "",
      clearClientNavigationCaches,
      clientRscCompatibilityId: "old-build",
      commitSameUrlNavigatePayload: vi.fn(),
      navigationPlanner,
      performHardNavigation,
      renderRedirectPayload: vi.fn(),
      syncCurrentHistoryState: vi.fn(),
      syncServerActionHttpFallbackHead: vi.fn(),
    });

    expect(performHardNavigation).toHaveBeenCalledOnce();
    expect(createFromFetch).not.toHaveBeenCalled();
    const cooldownStarts = vi.mocked(startAppPrefetchRevalidationCooldown).mock;
    expect(cooldownStarts.calls.length).toBe(1);
    expect(clearClientNavigationCaches).toHaveBeenCalledOnce();
    expect(cooldownStarts.invocationCallOrder[0]).toBeLessThan(
      clearClientNavigationCaches.mock.invocationCallOrder[0]!,
    );
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
