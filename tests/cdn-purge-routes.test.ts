import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  isPathKnownNotEdgeCached,
  registerCdnPurgeRoutes,
} from "../packages/vinext/src/shims/cdn-purge-routes.js";
import { routePatternParts } from "../packages/vinext/src/routing/route-pattern.js";

const PURGE_ROUTES_KEY = Symbol.for("vinext.cdnPurgeRoutes");

function route(segments: string, forceDynamic: boolean) {
  const routeSegments = segments.split("/").filter(Boolean);
  const urlSegments = routeSegments.filter((segment) => !segment.startsWith("("));
  return {
    forceDynamic,
    patternParts: routePatternParts(urlSegments.join("/")),
    routeSegments,
  };
}

function register(
  routes: ReturnType<typeof route>[],
  options: {
    configHeaders?: Parameters<typeof registerCdnPurgeRoutes>[0]["configHeaders"];
    metadataRoutes?: Parameters<typeof registerCdnPurgeRoutes>[0]["metadataRoutes"];
  } = {},
) {
  registerCdnPurgeRoutes({
    configHeaders: options.configHeaders ?? [],
    metadataRoutes: options.metadataRoutes ?? [],
    routes,
  });
}

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[PURGE_ROUTES_KEY];
});

describe("isPathKnownNotEdgeCached", () => {
  it("purges when no routes are registered", () => {
    expect(isPathKnownNotEdgeCached("/dashboard")).toBe(false);
  });

  it("skips a path served only by force-dynamic routes", () => {
    register([
      route("/(app)/dashboard", true),
      route("/(app)/dashboard/[id]", true),
      route("/blog", false),
    ]);
    expect(isPathKnownNotEdgeCached("/dashboard")).toBe(true);
    expect(isPathKnownNotEdgeCached("/dashboard/123")).toBe(true);
    expect(isPathKnownNotEdgeCached("/(app)/dashboard/[id]")).toBe(true);
  });

  it("purges when any route under the path can be cached", () => {
    register([route("/dashboard", true), route("/dashboard/reports", false)]);
    expect(isPathKnownNotEdgeCached("/dashboard")).toBe(false);
    expect(isPathKnownNotEdgeCached("/")).toBe(false);
  });

  it("purges when a cacheable dynamic or catch-all route can serve the path", () => {
    register([route("/dashboard", true), route("/[slug]", false), route("/docs/[...path]", false)]);
    expect(isPathKnownNotEdgeCached("/dashboard")).toBe(false);
    expect(isPathKnownNotEdgeCached("/docs/a/b")).toBe(false);
  });

  it("purges when no App route serves the path", () => {
    register([route("/dashboard", true)]);
    expect(isPathKnownNotEdgeCached("/blog")).toBe(false);
  });

  it("purges when a metadata route can serve the path", () => {
    register([route("/dashboard", true)], {
      metadataRoutes: [
        {
          patternParts: null,
          routeSegments: ["dashboard", "opengraph-image"],
          servedUrl: "/dashboard/opengraph-image",
        },
      ],
    });
    expect(isPathKnownNotEdgeCached("/dashboard")).toBe(false);
  });

  it("purges when next.config headers set a cacheable policy", () => {
    register([route("/dashboard", true)], {
      configHeaders: [
        { source: "/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=60" }] },
      ],
    });
    expect(isPathKnownNotEdgeCached("/dashboard")).toBe(false);
  });

  it("keeps skipping when next.config headers only disable storage", () => {
    register([route("/dashboard", true)], {
      configHeaders: [
        { source: "/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
        { source: "/:path*", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
      ],
    });
    expect(isPathKnownNotEdgeCached("/dashboard")).toBe(true);
  });

  it("purges encoded paths and the /index alias", () => {
    register([route("/", true), route("/café", true), route("/index", true)]);
    expect(isPathKnownNotEdgeCached("/café")).toBe(false);
    expect(isPathKnownNotEdgeCached("/caf%C3%A9")).toBe(false);
    expect(isPathKnownNotEdgeCached("/index")).toBe(false);
  });
});
