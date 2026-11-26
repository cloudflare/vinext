// Ported from Next.js: test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts
// ("router transition start context"), pinned to getActiveRoutePaths in
// packages/next/src/client/components/router-transition.ts.
// https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts
import path from "node:path";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { appRouteGraph } from "../packages/vinext/src/routing/app-router.js";
import {
  decodeBrowserRouteManifest,
  toBrowserRouteManifestWire,
  type BrowserRouteManifest,
} from "../packages/vinext/src/routing/browser-route-manifest.js";
import { resolveRouterTransitionFromRoutes } from "../packages/vinext/src/server/app-browser-transition-routes.js";
import {
  AppElementsWire,
  type AppElementsInterception,
  type AppElementsSlotBinding,
} from "../packages/vinext/src/server/app-elements.js";

// The transition-events pages, scanned as their own app/ root.
const APP_DIR = path.resolve(
  import.meta.dirname,
  "fixtures/app-basic/app/instrumentation-client/transition-events",
);

let manifest: BrowserRouteManifest;
type ManifestSlotBinding =
  BrowserRouteManifest["segmentGraph"]["slotBindings"] extends ReadonlyMap<string, infer Binding>
    ? Binding
    : never;

beforeAll(async () => {
  const graph = await appRouteGraph(APP_DIR);
  manifest = decodeBrowserRouteManifest(toBrowserRouteManifestWire(graph.routeManifest));
});

type CommittedTree = {
  interception?: AppElementsInterception | null;
  interceptionContext?: string | null;
  routeId?: string;
  slotBindings?: readonly AppElementsSlotBinding[];
  /** The committed source page, as the server renders it; null on a route miss. */
  sourcePage: string | null;
  wholeInterceptionSource?: string | null;
};

// A committed router state, holding the metadata of the payload it rendered.
function committed(tree: CommittedTree) {
  const interception = tree.interception ?? null;
  const slotBindings = tree.slotBindings ?? [];
  return {
    elements: AppElementsWire.createMetadataEntries({
      interception,
      interceptionContext: tree.interceptionContext ?? null,
      layoutIds: [...new Set(slotBindings.flatMap((binding) => binding.ownerLayoutId ?? []))],
      rootLayoutTreePath: "/",
      routeId: tree.routeId ?? "route:/ignored",
      slotBindings,
      sourcePage: tree.sourcePage,
      wholeInterceptionSource: tree.wholeInterceptionSource ?? null,
    }),
    interception,
    slotBindings,
  };
}

function page(sourcePage: string) {
  return committed({ sourcePage });
}

describe("resolveRouterTransitionFromRoutes", () => {
  it("reports route patterns, without route groups", () => {
    expect(resolveRouterTransitionFromRoutes(page("/page"), manifest)).toEqual(["/"]);
    expect(resolveRouterTransitionFromRoutes(page("/blog/[slug]/page"), manifest)).toEqual([
      "/blog/[slug]",
    ]);
    expect(resolveRouterTransitionFromRoutes(page("/(marketing)/about/page"), manifest)).toEqual([
      "/about",
    ]);
    expect(resolveRouterTransitionFromRoutes(page("/docs/[...slug]/page"), manifest)).toEqual([
      "/docs/[...slug]",
    ]);
    expect(resolveRouterTransitionFromRoutes(page("/shop/[[...slug]]/page"), manifest)).toEqual([
      "/shop/[[...slug]]",
    ]);
  });

  it("reports /_not-found for a URL that matched no route", () => {
    expect(resolveRouterTransitionFromRoutes(committed({ sourcePage: null }), manifest)).toEqual([
      "/_not-found",
    ]);
  });

  it("reports a sibling intercept's own page as the primary route", () => {
    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          interceptionContext: "/gallery",
          slotBindings: [
            {
              activeRouteId: "route:/gallery/photos/1",
              ownerLayoutId: "layout:/gallery",
              slotId: "slot:__vinext_sibling_intercept:/gallery",
              state: "active",
            },
          ],
          sourcePage: "/gallery/(.)photos/[id]/page",
        }),
        manifest,
      ),
    ).toEqual(["/gallery/(.)photos/[id]"]);
  });

  it("reports the children default of a synthetic parallel sub-route", () => {
    // /dashboard/settings matched only @analytics/settings, so the children
    // render /dashboard/default, as Next.js's __DEFAULT__ segment reports it.
    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          slotBindings: [
            {
              ownerLayoutId: "layout:/dashboard",
              slotId: "slot:children:/dashboard",
              state: "default",
            },
            {
              activeRouteId: "route:/dashboard/settings",
              ownerLayoutId: "layout:/dashboard",
              slotId: "slot:analytics:/dashboard",
              state: "active",
            },
          ],
          sourcePage: "/dashboard/settings/page",
        }),
        manifest,
      )[0],
    ).toBe("/dashboard/default");
    // Active children render the page itself.
    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          slotBindings: [
            {
              activeRouteId: "route:/dashboard",
              ownerLayoutId: "layout:/dashboard",
              slotId: "slot:children:/dashboard",
              state: "active",
            },
          ],
          sourcePage: "/dashboard/page",
        }),
        manifest,
      ),
    ).toEqual(["/dashboard"]);
  });

  it("reports the children route a slot-only navigation kept", () => {
    // /parallel-layouts/settings -> /parallel-layouts/modal keeps the settings
    // children branch; the merged metadata is the modal payload's.
    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          routeId: "route:/some-page",
          slotBindings: [
            {
              activeRouteId: "route:/blog/:slug",
              ownerLayoutId: "layout:/",
              slotId: "slot:children:/",
              state: "active",
            },
          ],
          sourcePage: "/some-page/page",
        }),
        manifest,
      ),
    ).toEqual(["/blog/[slug]"]);
  });

  it("reports only the slots of a layout composed only of named slots", async () => {
    // parallel-nested/home declares no children: its route renders through
    // @parallelB, so Next.js's tree has no children branch to report.
    const graph = await appRouteGraph(
      path.resolve(import.meta.dirname, "fixtures/app-basic/app/parallel-nested"),
    );
    const namedSlotsManifest = decodeBrowserRouteManifest(
      toBrowserRouteManifestWire(graph.routeManifest),
    );
    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          slotBindings: [
            { ownerLayoutId: "layout:/home", slotId: "slot:children:/home", state: "unmatched" },
            {
              activeRouteId: "route:/home/nested",
              ownerLayoutId: "layout:/home",
              slotId: "slot:parallelB:/home",
              state: "active",
            },
          ],
          sourcePage: "/home/nested/page",
        }),
        namedSlotsManifest,
      ),
    ).toEqual(["/home/@parallelB/nested"]);
  });

  it("reports a whole intercepting route as the owner's default and the intercepted slot", () => {
    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          interceptionContext: "/gallery",
          slotBindings: [
            {
              activeRouteId: "route:/gallery/photos/1",
              ownerLayoutId: "layout:/gallery",
              slotId: "slot:modal:/gallery",
              state: "active",
            },
          ],
          sourcePage: "/gallery/(.)photos/[id]/page",
          wholeInterceptionSource: "/gallery",
        }),
        manifest,
      ),
    ).toEqual(["/gallery/default", "/gallery/@modal/(.)photos/[id]"]);
    // A merge kept an active @aside, which sorts before @modal; the manifest's
    // interceptions still identify @modal as the intercepted slot.
    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          interceptionContext: "/gallery",
          slotBindings: [
            {
              activeRouteId: "route:/gallery",
              ownerLayoutId: "layout:/gallery",
              slotId: "slot:aside:/gallery",
              state: "active",
            },
            {
              activeRouteId: "route:/gallery/photos/1",
              ownerLayoutId: "layout:/gallery",
              slotId: "slot:modal:/gallery",
              state: "active",
            },
          ],
          sourcePage: "/gallery/(.)photos/[id]/page",
          wholeInterceptionSource: "/gallery",
        }),
        manifest,
      ),
    ).toEqual(["/gallery/default", "/gallery/@aside", "/gallery/@modal/(.)photos/[id]"]);
  });

  it("reports every slot of a whole intercepting route nested through slots", async () => {
    // @modal/(.)test-nested renders its page through its own @sidebar slot.
    const graph = await appRouteGraph(
      path.resolve(import.meta.dirname, "fixtures/app-basic/app/interception-dyn-seg"),
    );
    const nestedManifest = decodeBrowserRouteManifest(
      toBrowserRouteManifestWire(graph.routeManifest),
    );
    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          interceptionContext: "/",
          slotBindings: [
            {
              activeRouteId: "route:/test-nested",
              ownerLayoutId: "layout:/",
              slotId: "slot:modal:/",
              state: "active",
            },
          ],
          sourcePage: "/(.)test-nested/page",
          wholeInterceptionSource: "/",
        }),
        nestedManifest,
      ),
    ).toEqual(["/default", "/@modal/(.)test-nested/@sidebar"]);
  });

  it("puts the primary route first, then each slot", () => {
    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          slotBindings: [
            {
              activeRouteId: "route:/dashboard",
              ownerLayoutId: "layout:/dashboard",
              slotId: "slot:analytics:/dashboard",
              state: "active",
            },
          ],
          sourcePage: "/dashboard/page",
        }),
        manifest,
      ),
    ).toEqual(["/dashboard", "/dashboard/@analytics"]);
  });

  it("reports a slot showing its default as @slot/default", () => {
    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          slotBindings: [
            { ownerLayoutId: "layout:/gallery", slotId: "slot:modal:/gallery", state: "default" },
          ],
          sourcePage: "/gallery/page",
        }),
        manifest,
      ),
    ).toEqual(["/gallery", "/gallery/@modal/default"]);
  });

  it("reads an active slot's route by its manifest id, not as a URL", () => {
    // As a URL, the catch-all's id "/shop/:slug*" is one segment, which a
    // sibling /shop/:id would match first and report its default slot.
    const catchAll = manifest.segmentGraph.routes.get("route:/shop/:slug*");
    expect(catchAll).toBeDefined();
    const slotId = "slot:panel:/shop";
    const binding = (routeId: string, state: "active" | "default"): ManifestSlotBinding => ({
      id: `${routeId}::${slotId}`,
      ownerLayoutId: null,
      routeId,
      routeSegments: state === "active" ? ["[[...slug]]"] : null,
      slotId,
      state,
    });
    const withSibling = {
      ...manifest,
      segmentGraph: {
        ...manifest.segmentGraph,
        routes: new Map([
          ...manifest.segmentGraph.routes,
          [
            "route:/shop/:id",
            {
              ...catchAll!,
              id: "route:/shop/:id",
              paramNames: ["id"],
              patternParts: ["shop", ":id"],
            },
          ],
        ]),
        slotBindings: new Map([
          ...manifest.segmentGraph.slotBindings,
          [`route:/shop/:slug*::${slotId}`, binding("route:/shop/:slug*", "active")],
          [`route:/shop/:id::${slotId}`, binding("route:/shop/:id", "default")],
        ]),
      },
    } as BrowserRouteManifest;

    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          slotBindings: [
            { activeRouteId: "route:/shop/:slug*", ownerLayoutId: null, slotId, state: "active" },
          ],
          sourcePage: "/shop/[[...slug]]/page",
        }),
        withSibling,
      ),
    ).toEqual(["/shop/[[...slug]]", "/shop/@panel/[[...slug]]"]);
  });

  it("reports the intercepting page for an intercepted slot", () => {
    const interception = {
      sourceMatchedUrl: "/gallery",
      sourceRouteId: "route:/gallery",
      slotId: "slot:modal:/gallery",
      targetMatchedUrl: "/gallery/photos/1",
      targetRouteId: "route:/gallery/photos/1",
    };
    const binding = {
      activeRouteId: "route:/gallery/photos/1",
      ownerLayoutId: "layout:/gallery",
      slotId: "slot:modal:/gallery",
      state: "active" as const,
    };
    const expected = ["/gallery", "/gallery/@modal/(.)photos/[id]"];

    const interceptionId = "interception:slot:modal:/gallery:/gallery->/gallery/photos/:id";

    expect(
      resolveRouterTransitionFromRoutes(
        committed({
          interception,
          slotBindings: [{ ...binding, interceptionId }],
          sourcePage: "/gallery/page",
        }),
        manifest,
      ),
    ).toEqual(expected);
    // Without the binding's interception id, the target URL selects it.
    expect(
      resolveRouterTransitionFromRoutes(
        committed({ interception, slotBindings: [binding], sourcePage: "/gallery/page" }),
        manifest,
      ),
    ).toEqual(expected);
    // A merge keeps the intercepted slot after an ordinary payload clears the
    // latest interception; its binding still names the interception.
    expect(
      resolveRouterTransitionFromRoutes(
        committed({ slotBindings: [{ ...binding, interceptionId }], sourcePage: "/gallery/page" }),
        manifest,
      ),
    ).toEqual(expected);
  });
});
