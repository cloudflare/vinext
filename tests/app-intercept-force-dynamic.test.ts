import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { generateAppRequestRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import { appRouter, invalidateAppRouteCache } from "../packages/vinext/src/routing/app-router.js";
import { createAppRscRouteMatcher } from "../packages/vinext/src/server/app-rsc-route-matching.js";

const appDir = path.resolve(import.meta.dirname, "fixtures/app-intercept-force-dynamic-owner/app");

type RequestStageIntercept = { forceDynamic: boolean; targetPattern: string };
type RequestStageRoute = {
  forceDynamic: boolean;
  pattern: string;
  slots: Record<string, { name: string; intercepts: RequestStageIntercept[] }>;
};

// Next.js rewrites an intercepted request to the intercepting route's own app
// path (generateInterceptionRoutesRewrites), and each app path collects segment
// config from its own tree. `next build` of this fixture prerenders `/feed` and
// keeps only `/feed/(.)photo/[id]` dynamic.
describe("intercepting route force-dynamic", () => {
  it("applies an interceptor's force-dynamic to the intercepted render only", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(appDir);
    const feed = routes.find((route) => route.pattern === "/feed");
    expect(feed).toBeDefined();
    expect(feed!.parallelSlots.some((slot) => slot.interceptingRoutes.length > 0)).toBe(true);

    const code = generateAppRequestRscEntry(appDir, routes);
    const serializedRoutes = code.match(/^const __routes = (.+);$/m)?.[1];
    expect(serializedRoutes).toBeDefined();
    const requestRoutes = JSON.parse(serializedRoutes!) as RequestStageRoute[];
    const byPattern = Object.fromEntries(requestRoutes.map((route) => [route.pattern, route]));

    expect(byPattern["/photo/:id"]?.forceDynamic).toBe(false);
    // A direct load of /feed never renders the intercept.
    expect(byPattern["/feed"]?.forceDynamic).toBe(false);
    // The render that shows the intercept stays force-dynamic.
    const modal = Object.values(byPattern["/feed"]!.slots).find((slot) => slot.name === "modal");
    expect(modal?.intercepts).toEqual([
      expect.objectContaining({ forceDynamic: true, targetPattern: "/feed/photo/:id" }),
    ]);
    // The inverse: a force-dynamic source page is not part of the intercept's tree.
    expect(byPattern["/board"]?.forceDynamic).toBe(true);
    const boardModal = Object.values(byPattern["/board"]!.slots).find(
      (slot) => slot.name === "modal",
    );
    expect(boardModal?.intercepts).toEqual([
      expect.objectContaining({ forceDynamic: false, targetPattern: "/board/card/:id" }),
    ]);
    // The owner's force-dynamic layout is part of the intercept's tree.
    const deckModal = Object.values(byPattern["/deck"]!.slots).find(
      (slot) => slot.name === "modal",
    );
    expect(deckModal?.intercepts).toEqual([
      expect.objectContaining({ forceDynamic: true, targetPattern: "/deck/slide/:id" }),
    ]);
    // The request stage's intercept match carries the intercept's own flag.
    expect(code).toContain("interceptionForceDynamic: intercept.forceDynamic === true");
  });

  it("takes the flag from the copy of an inherited intercept the source renders", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(appDir);
    const code = generateAppRequestRscEntry(appDir, routes);
    const requestRoutes = JSON.parse(code.match(/^const __routes = (.+);$/m)![1]!);
    const matcher = createAppRscRouteMatcher(requestRoutes);

    // /shelf/sub shows its own force-dynamic `@aside` page beside the intercept,
    // which /shelf, the owner, does not.
    expect(matcher.findIntercept("/shelf/book/1", "/shelf")?.forceDynamic).toBe(false);
    expect(matcher.findIntercept("/shelf/book/1", "/shelf/sub")?.forceDynamic).toBe(true);
  });

  it("takes a stand-in owner's sibling intercept flag from the source that renders it", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(appDir);
    const code = generateAppRequestRscEntry(appDir, routes);
    const requestRoutes = JSON.parse(code.match(/^const __routes = (.+);$/m)![1]!);
    const matcher = createAppRscRouteMatcher(requestRoutes);

    // /gallery has no page, so the static /gallery/list stands in as the owner.
    const owner = (
      requestRoutes as Array<{ pattern: string; siblingIntercepts?: RequestStageIntercept[] }>
    ).find((route) =>
      route.siblingIntercepts?.some(
        (intercept) => intercept.targetPattern === "/gallery/photo/:id",
      ),
    );
    expect(owner?.pattern).toBe("/gallery/list");
    expect(matcher.findIntercept("/gallery/photo/2", "/gallery/list")?.forceDynamic).toBe(false);
    // From /gallery/photo/1 the intercept renders in that route, beside its
    // force-dynamic `@aside` page.
    const fromPhoto = matcher.findIntercept("/gallery/photo/2", "/gallery/photo/1");
    expect(requestRoutes[fromPhoto!.sourceRouteIndex]?.pattern).toBe("/gallery/photo/:id");
    expect(fromPhoto?.forceDynamic).toBe(true);

    // The source renders all of its layouts around the intercept, including
    // the force-dynamic album/pic/layout.tsx below the owner folder.
    expect(matcher.findIntercept("/album/pic/2", "/album/list")?.forceDynamic).toBe(false);
    const fromPic = matcher.findIntercept("/album/pic/2", "/album/pic/1");
    expect(requestRoutes[fromPic!.sourceRouteIndex]?.pattern).toBe("/album/pic/:id");
    expect(fromPic?.forceDynamic).toBe(true);
  });
});
