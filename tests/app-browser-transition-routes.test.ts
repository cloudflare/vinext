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

// The transition-events pages, scanned as their own app/ root.
const APP_DIR = path.resolve(
  import.meta.dirname,
  "fixtures/app-basic/app/instrumentation-client/transition-events",
);

let manifest: BrowserRouteManifest;

beforeAll(async () => {
  const graph = await appRouteGraph(APP_DIR);
  manifest = decodeBrowserRouteManifest(toBrowserRouteManifestWire(graph.routeManifest));
});

function page(routePath: string) {
  return { interception: null, routeId: `route:${routePath}`, slotBindings: [] };
}

describe("resolveRouterTransitionFromRoutes", () => {
  it("reports route patterns, without route groups", () => {
    expect(resolveRouterTransitionFromRoutes(page("/"), manifest)).toEqual(["/"]);
    expect(resolveRouterTransitionFromRoutes(page("/blog/hello"), manifest)).toEqual([
      "/blog/[slug]",
    ]);
    expect(resolveRouterTransitionFromRoutes(page("/about"), manifest)).toEqual(["/about"]);
    expect(resolveRouterTransitionFromRoutes(page("/docs/a/b"), manifest)).toEqual([
      "/docs/[...slug]",
    ]);
    expect(resolveRouterTransitionFromRoutes(page("/shop"), manifest)).toEqual([
      "/shop/[[...slug]]",
    ]);
  });

  it("puts the primary route first, then each slot", () => {
    expect(
      resolveRouterTransitionFromRoutes(
        {
          interception: null,
          routeId: "route:/dashboard",
          slotBindings: [
            {
              activeRouteId: "route:/dashboard",
              ownerLayoutId: "layout:/dashboard",
              slotId: "slot:analytics:/dashboard",
              state: "active",
            },
          ],
        },
        manifest,
      ),
    ).toEqual(["/dashboard", "/dashboard/@analytics"]);
  });

  it("reports a slot showing its default as @slot/default", () => {
    expect(
      resolveRouterTransitionFromRoutes(
        {
          interception: null,
          routeId: "route:/gallery",
          slotBindings: [
            { ownerLayoutId: "layout:/gallery", slotId: "slot:modal:/gallery", state: "default" },
          ],
        },
        manifest,
      ),
    ).toEqual(["/gallery", "/gallery/@modal/default"]);
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

    expect(
      resolveRouterTransitionFromRoutes(
        {
          interception,
          routeId: "route:/gallery",
          slotBindings: [
            {
              ...binding,
              interceptionId: "interception:slot:modal:/gallery:/gallery->/gallery/photos/:id",
            },
          ],
        },
        manifest,
      ),
    ).toEqual(expected);
    // Without the binding's interception id, the target URL selects it.
    expect(
      resolveRouterTransitionFromRoutes(
        { interception, routeId: "route:/gallery", slotBindings: [binding] },
        manifest,
      ),
    ).toEqual(expected);
  });
});
