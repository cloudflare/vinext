import { describe, expect, it } from "vite-plus/test";
import { createAppPageRenderIdentity } from "../packages/vinext/src/server/app-page-render-identity.js";

describe("createAppPageRenderIdentity", () => {
  it("uses the display pathname as the route identity for direct renders", () => {
    const identity = createAppPageRenderIdentity({ displayPathname: "/photos/42" });

    expect(identity).toEqual({
      displayPathname: "/photos/42",
      interception: null,
      interceptionContext: null,
      matchedRoutePathname: "/photos/42",
      pageId: "page:/photos/42",
      routeId: "route:/photos/42",
      targetMatchedPathname: "/photos/42",
    });
  });

  it("uses the source route as the route identity for intercepted source renders", () => {
    const identity = createAppPageRenderIdentity({
      displayPathname: "/photos/42",
      interceptionContext: "/feed",
      interceptSourceMatchedUrl: "/feed",
      interceptSlotId: "slot:modal:/feed",
    });

    expect(identity.routeId).toBe("route:/feed");
    expect(identity.pageId).toBe("page:/feed");
    expect(identity.matchedRoutePathname).toBe("/feed");
    expect(identity.targetMatchedPathname).toBe("/photos/42");
    expect(identity.interception).toEqual({
      sourceMatchedUrl: "/feed",
      sourceRouteId: "route:/feed",
      slotId: "slot:modal:/feed",
      targetMatchedUrl: "/photos/42",
      targetRouteId: "route:/photos/42",
    });
  });

  it("normalizes encoded source and target pathnames before encoding route IDs", () => {
    const identity = createAppPageRenderIdentity({
      displayPathname: "/photos/caf%C3%A9",
      interceptionContext: "/caf%C3%A9",
      interceptSourceMatchedUrl: "/caf%C3%A9",
      interceptSlotId: "slot:modal:/café",
    });

    expect(identity.routeId).toBe("route:/café");
    expect(identity.pageId).toBe("page:/café");
    expect(identity.matchedRoutePathname).toBe("/café");
    expect(identity.targetMatchedPathname).toBe("/photos/café");
    expect(identity.interception?.sourceMatchedUrl).toBe("/café");
    expect(identity.interception?.targetMatchedUrl).toBe("/photos/café");
  });

  it("ignores invalid source proof and falls back to direct target identity", () => {
    const identity = createAppPageRenderIdentity({
      displayPathname: "/photos/42",
      interceptionContext: "/feed?tab=popular",
      interceptSourceMatchedUrl: "/feed?tab=popular",
      interceptSlotId: "slot:modal:/feed",
    });

    expect(identity.interception).toBeNull();
    expect(identity.routeId).toBe("route:/photos/42");
    expect(identity.pageId).toBe("page:/photos/42");
    expect(identity.matchedRoutePathname).toBe("/photos/42");
    expect(identity.interceptionContext).toBe("/feed?tab=popular");
  });

  it("rejects relative display pathnames", () => {
    expect(() => createAppPageRenderIdentity({ displayPathname: "photos/42" })).toThrow(
      "[vinext] App Router render pathname must be absolute: photos/42",
    );
  });
});
