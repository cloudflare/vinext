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
  ACTION_REVALIDATED_HEADER,
  NEXTJS_ACTION_NOT_FOUND_HEADER,
  VINEXT_RENDERED_PATH_AND_SEARCH_HEADER,
} from "../packages/vinext/src/server/headers.js";
import { navigationPlanner } from "../packages/vinext/src/server/navigation-planner.js";
import { UnrecognizedActionError } from "../packages/vinext/src/shims/unrecognized-action-error.js";

vi.mock("@vitejs/plugin-rsc/browser", () => ({
  createFromFetch: vi.fn(),
  createTemporaryReferenceSet: vi.fn(() => new Map()),
  encodeReply: vi.fn(async () => "encoded-action-args"),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.mocked(createFromFetch).mockReset();
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

  it("uses the action state captured when the action started", async () => {
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
          [ACTION_REDIRECT_HEADER]: "target",
          "content-type": "text/plain",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const performHardNavigation = vi.fn();
    await invokeClientServerAction("action-id", [], actionInitiation, {
      basePath: "",
      clearClientNavigationCaches: vi.fn(),
      clientRscCompatibilityId: null,
      commitSameUrlNavigatePayload: vi.fn(),
      navigationPlanner,
      performHardNavigation,
      renderRedirectPayload: vi.fn(),
      syncCurrentHistoryState: vi.fn(),
      syncServerActionHttpFallbackHead: vi.fn(),
    });

    expect(performHardNavigation).toHaveBeenCalledWith(
      "https://example.com/original/target",
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/original?tab=1",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // Ported from Next.js: test/e2e/app-dir/app-basepath/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-basepath/index.test.ts
  it.each(["https://example.com/outsideBasePath", "../../outsideBasePath"])(
    "hard navigates to the resolved action redirect outside basePath: %s",
    async (redirectTarget) => {
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
          href: "https://example.com/base/deep/current/page",
          origin: "https://example.com",
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(null, {
            status: 303,
            headers: {
              [ACTION_REDIRECT_HEADER]: redirectTarget,
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
    },
  );

  // Next discards every navigation effect from a superseded action, retaining
  // revalidation until the queue drains, including MPA and rootless results.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router-instance.ts
  for (const revalidated of [false, true]) {
    it.each([
      "external",
      "outside basePath",
      "malformed",
      "blocked",
      "compatibility",
      "non-RSC",
      "rootless",
    ])(`discards a stale %s redirect and preserves revalidation=${revalidated}`, async (kind) => {
      vi.stubGlobal("window", {
        location: { href: "https://example.com/newer", origin: "https://example.com" },
      });
      const headers = new Headers({
        "content-type": kind === "non-RSC" ? "text/plain" : "text/x-component",
        [ACTION_REDIRECT_HEADER]:
          kind === "external"
            ? "https://other.example/target"
            : kind === "malformed"
              ? "http://["
              : kind === "blocked"
                ? "javascript:alert(1)"
                : "/target",
      });
      if (revalidated) headers.set(ACTION_REVALIDATED_HEADER, "1");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("flight", { headers })));
      // The rootless case loses ownership during decoding, after headers arrive.
      let current = kind === "rootless";
      vi.mocked(createFromFetch).mockImplementationOnce(async () => {
        current = false;
        return { returnValue: { ok: true, data: null } };
      });
      const performHardNavigation = vi.fn();
      const clearClientNavigationCaches = vi.fn();
      const onRevalidationWithoutRender = vi.fn();
      await invokeClientServerAction(
        "action-id",
        [],
        createServerActionInitiationSnapshot({
          href: "https://example.com/base/source",
          navigationId: 1,
          routerState: createActionTestRouterState(),
        }),
        {
          basePath: kind === "outside basePath" ? "/base" : "",
          clearClientNavigationCaches,
          clientRscCompatibilityId: kind === "compatibility" ? "client-build" : null,
          commitSameUrlNavigatePayload: vi.fn(),
          navigationPlanner,
          isCurrentAction: () => current,
          onRevalidationWithoutRender,
          performHardNavigation,
          renderRedirectPayload: vi.fn(),
          syncCurrentHistoryState: vi.fn(),
          syncServerActionHttpFallbackHead: vi.fn(),
        },
      );
      expect(performHardNavigation).not.toHaveBeenCalled();
      if (revalidated) expect(clearClientNavigationCaches).toHaveBeenCalled();
      expect(onRevalidationWithoutRender).toHaveBeenCalledTimes(revalidated ? 1 : 0);
    });
  }

  for (const target of ["/pages", "https://other.example/pages"]) {
    it.each([false, true])(
      `retains current ${target} redirect revalidation when location throws=%s`,
      async (throws) => {
        vi.stubGlobal("window", {
          location: { href: "https://example.com/source", origin: "https://example.com" },
        });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(
            new Response("document", {
              headers: {
                "content-type": "text/plain",
                [ACTION_REDIRECT_HEADER]: target,
                [ACTION_REVALIDATED_HEADER]: "1",
              },
            }),
          ),
        );
        const failure = new Error("Location failed");
        const performHardNavigation = vi.fn(() => {
          if (throws) throw failure;
        });
        const onRevalidationWithoutRender = vi.fn();
        const result = invokeClientServerAction(
          "action-id",
          [],
          createServerActionInitiationSnapshot({
            href: "https://example.com/source",
            navigationId: 1,
            routerState: createActionTestRouterState(),
          }),
          {
            basePath: "",
            clearClientNavigationCaches: vi.fn(),
            clientRscCompatibilityId: null,
            commitSameUrlNavigatePayload: vi.fn(),
            navigationPlanner,
            isCurrentAction: () => true,
            onRevalidationWithoutRender,
            performHardNavigation,
            renderRedirectPayload: vi.fn(),
            syncCurrentHistoryState: vi.fn(),
            syncServerActionHttpFallbackHead: vi.fn(),
          },
        );
        if (throws) await expect(result).rejects.toBe(failure);
        else await result;
        expect(performHardNavigation).toHaveBeenCalledOnce();
        expect(onRevalidationWithoutRender).toHaveBeenCalledExactlyOnceWith("document-navigation");
      },
    );
  }

  for (const current of [false, true]) {
    it.each([true, false])(
      `refreshes a revalidated rootless action with current=${current}, ok=%s`,
      async (ok) => {
        vi.stubGlobal("window", {
          location: { href: "https://example.com/source", origin: "https://example.com" },
        });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(
            new Response("flight", {
              headers: { "content-type": "text/x-component", [ACTION_REVALIDATED_HEADER]: "1" },
            }),
          ),
        );
        vi.mocked(createFromFetch).mockResolvedValueOnce({
          returnValue: { ok, data: "action-result" },
        });
        const onRevalidationWithoutRender = vi.fn();
        const commitSameUrlNavigatePayload = vi.fn();
        const result = invokeClientServerAction(
          "action-id",
          [],
          createServerActionInitiationSnapshot({
            href: "https://example.com/source",
            navigationId: 1,
            routerState: createActionTestRouterState(),
          }),
          {
            basePath: "",
            clearClientNavigationCaches: vi.fn(),
            clientRscCompatibilityId: null,
            commitSameUrlNavigatePayload,
            navigationPlanner,
            isCurrentAction: () => current,
            onRevalidationWithoutRender,
            performHardNavigation: vi.fn(),
            renderRedirectPayload: vi.fn(),
            syncCurrentHistoryState: vi.fn(),
            syncServerActionHttpFallbackHead: vi.fn(),
          },
        );
        if (ok) await expect(result).resolves.toBe("action-result");
        else await expect(result).rejects.toBe("action-result");
        expect(onRevalidationWithoutRender).toHaveBeenCalledTimes(1);
        expect(commitSameUrlNavigatePayload).not.toHaveBeenCalled();
      },
    );
  }

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

  describe("HTTP fallback head with overlapping actions", () => {
    // Navigation discards slow action A, so queued action B owns the page.
    // Only B may set or clear the action 404 noindex marker; A still settles
    // its own caller.
    async function startOverlappingActions() {
      vi.stubGlobal("window", {
        location: { href: "https://example.com/source", origin: "https://example.com" },
      });
      const fetchResolvers: Array<(response: Response) => void> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              fetchResolvers.push(resolve);
            }),
        ),
      );
      const head = { noindex: false };
      let currentAction: "A" | "B" = "A";
      const start = (name: "A" | "B") =>
        invokeClientServerAction(
          "action-id",
          [],
          createServerActionInitiationSnapshot({
            href: "https://example.com/source",
            navigationId: 1,
            routerState: createActionTestRouterState(),
          }),
          {
            basePath: "",
            clearClientNavigationCaches: vi.fn(),
            clientRscCompatibilityId: null,
            commitSameUrlNavigatePayload: vi.fn(),
            isCurrentAction: () => currentAction === name,
            navigationPlanner,
            performHardNavigation: vi.fn(),
            renderRedirectPayload: vi.fn(),
            syncCurrentHistoryState: vi.fn(),
            syncServerActionHttpFallbackHead: (status) => {
              head.noindex = status === 404;
            },
          },
        );
      const actionA = start("A");
      currentAction = "B";
      const actionB = start("B");
      // The request goes out after the arguments are encoded.
      await vi.waitFor(() => expect(fetchResolvers).toHaveLength(2));
      const respond = (index: 0 | 1, status: number) => {
        vi.mocked(createFromFetch).mockResolvedValueOnce({
          returnValue: { ok: true, data: index === 0 ? "a-value" : "b-value" },
        });
        fetchResolvers[index](
          new Response("flight", { headers: { "content-type": "text/x-component" }, status }),
        );
      };
      return { actionA, actionB, head, respond };
    }

    it("keeps the marker B installed when stale A finishes with a non-404 payload", async () => {
      const { actionA, actionB, head, respond } = await startOverlappingActions();

      respond(1, 404);
      await expect(actionB).resolves.toBe("b-value");
      expect(head.noindex).toBe(true);

      respond(0, 200);
      await expect(actionA).resolves.toBe("a-value");
      expect(head.noindex).toBe(true);
    });

    it("does not install a marker from stale A when it finishes with a 404 first", async () => {
      const { actionA, actionB, head, respond } = await startOverlappingActions();

      respond(0, 404);
      await expect(actionA).resolves.toBe("a-value");
      expect(head.noindex).toBe(false);

      respond(1, 200);
      await expect(actionB).resolves.toBe("b-value");
      expect(head.noindex).toBe(false);
    });

    it("does not install a marker from stale A when it finishes with a 404 after B", async () => {
      const { actionA, actionB, head, respond } = await startOverlappingActions();

      respond(1, 200);
      await expect(actionB).resolves.toBe("b-value");
      expect(head.noindex).toBe(false);

      respond(0, 404);
      await expect(actionA).resolves.toBe("a-value");
      expect(head.noindex).toBe(false);
    });
  });

  describe("action ids the server does not recognize", () => {
    function invokeUnknownAction(options: {
      clientRscCompatibilityId: string | null;
      serverCompatibilityId: string | null;
    }) {
      const headers = new Headers({
        [NEXTJS_ACTION_NOT_FOUND_HEADER]: "1",
        "content-type": "text/plain",
      });
      if (options.serverCompatibilityId !== null) {
        headers.set(VINEXT_RSC_COMPATIBILITY_ID_HEADER, options.serverCompatibilityId);
      }
      vi.stubGlobal("window", {
        location: { href: "https://example.com/source", origin: "https://example.com" },
      });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response("Server action not found.", { headers, status: 404 })),
      );
      const performHardNavigation = vi.fn();
      const result = invokeClientServerAction(
        "stale-action-id",
        [],
        createServerActionInitiationSnapshot({
          href: "https://example.com/source",
          navigationId: 1,
          routerState: createActionTestRouterState(),
        }),
        {
          basePath: "",
          clearClientNavigationCaches: vi.fn(),
          clientRscCompatibilityId: options.clientRscCompatibilityId,
          commitSameUrlNavigatePayload: vi.fn(),
          navigationPlanner,
          performHardNavigation,
          renderRedirectPayload: vi.fn(),
          syncCurrentHistoryState: vi.fn(),
          syncServerActionHttpFallbackHead: vi.fn(),
        },
      );
      return { performHardNavigation, result };
    }

    it("reloads the document instead of throwing when the server build differs", async () => {
      const { performHardNavigation, result } = invokeUnknownAction({
        clientRscCompatibilityId: "client-build",
        serverCompatibilityId: "server-build",
      });

      await expect(result).resolves.toBeUndefined();
      expect(performHardNavigation).toHaveBeenCalledTimes(1);
      expect(performHardNavigation).toHaveBeenCalledWith("https://example.com/source", undefined);
    });

    it("reloads the document when the not-found response names no build", async () => {
      const { performHardNavigation, result } = invokeUnknownAction({
        clientRscCompatibilityId: "client-build",
        serverCompatibilityId: null,
      });

      await expect(result).resolves.toBeUndefined();
      expect(performHardNavigation).toHaveBeenCalledTimes(1);
    });

    it("throws UnrecognizedActionError when the server build matches", async () => {
      const { performHardNavigation, result } = invokeUnknownAction({
        clientRscCompatibilityId: "client-build",
        serverCompatibilityId: "client-build",
      });

      await expect(result).rejects.toBeInstanceOf(UnrecognizedActionError);
      await expect(result).rejects.toMatchObject({
        message: expect.stringContaining('Server Action "stale-action-id" was not found'),
      });
      expect(performHardNavigation).not.toHaveBeenCalled();
    });

    it("throws UnrecognizedActionError when the client has no compatibility id", async () => {
      const { performHardNavigation, result } = invokeUnknownAction({
        clientRscCompatibilityId: null,
        serverCompatibilityId: "server-build",
      });

      await expect(result).rejects.toBeInstanceOf(UnrecognizedActionError);
      expect(performHardNavigation).not.toHaveBeenCalled();
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
