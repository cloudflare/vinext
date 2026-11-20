import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createAppRscRouteMatcher,
  SIBLING_PAGE_INTERCEPT_SLOT_KEY,
} from "../packages/vinext/src/server/app-rsc-route-matching.js";
import {
  addPregeneratedConcretePath,
  clearPregeneratedConcretePaths,
} from "../packages/vinext/src/server/pregenerated-concrete-paths.js";

describe("App RSC route matching", () => {
  afterEach(() => {
    clearPregeneratedConcretePaths();
  });

  it("matches app routes through the shared route trie", () => {
    const matcher = createAppRscRouteMatcher([
      route("/", []),
      route("/blog/:slug", ["blog", ":slug"]),
      route("/docs/:path+", ["docs", ":path+"]),
      route("/shop/:path*", ["shop", ":path*"]),
    ]);

    expect(matcher.matchRoute("/blog/hello-world/")).toMatchObject({
      route: { pattern: "/blog/:slug" },
      params: { slug: "hello-world" },
    });
    expect(matcher.matchRoute("/docs")).toBeNull();
    expect(matcher.matchRoute("/docs/guides/rsc")).toMatchObject({
      route: { pattern: "/docs/:path+" },
      params: { path: ["guides", "rsc"] },
    });
    const result = matcher.matchRoute("/shop");
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/shop/:path*");
    expect(result!.params).toEqual({});
  });

  it("omits optional catch-all params when zero segments are matched", () => {
    // Next.js represents a missing optional catch-all param as absent at the
    // route-match boundary; app rendering later treats that as the `null`
    // tree segment for optional catch-all.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/route-matcher.ts
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/get-dynamic-param.test.ts
    const matcher = createAppRscRouteMatcher([route("/shop/:path*", ["shop", ":path*"])]);

    const result = matcher.matchRoute("/shop");
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/shop/:path*");
    expect(result!.params).toEqual({});
  });

  // Ported from Next.js: route-matcher.ts decodeURIComponent behaviour.
  // Route Handlers expose decoded params, unlike App Pages, whose params use
  // the canonical encoded representation.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/route-matcher.ts#L25-L27
  it("decodes rewritten Route Handler params via decodeURIComponent", () => {
    const matcher = createAppRscRouteMatcher([
      { ...route("/files/:name", ["files", ":name"]), routeHandler: {} },
    ]);

    expect(matcher.matchRoute("/files/a%2Fb")).toMatchObject({
      params: { name: "a/b" },
    });
  });

  it("matches rewritten static segments on their raw spelling", () => {
    // Next.js 16.2.7 routes a rewrite destination like a direct request to it,
    // so an encoded static segment does not name the literal one. Dynamic
    // params keep the canonical encoded representation.
    const matcher = createAppRscRouteMatcher([
      route("/_sites/:subdomain", ["_sites", ":subdomain"]),
      route("/files/:name", ["files", ":name"]),
      route("/:locale/dashboard", [":locale", "dashboard"]),
    ]);

    expect(matcher.matchRoute("/%5Fsites/demo")).toBeNull();
    expect(matcher.matchRoute("/_sites/demo")).toMatchObject({
      route: { pattern: "/_sites/:subdomain" },
      params: { subdomain: "demo" },
    });
    expect(matcher.matchRoute("/en/%64ashboard")).toBeNull();
    expect(matcher.matchRoute("/en/dashboard")).toMatchObject({
      route: { pattern: "/:locale/dashboard" },
      params: { locale: "en" },
    });
    expect(matcher.matchRoute("/files/a%252Fb")).toMatchObject({
      params: { name: "a%252Fb" },
    });
  });

  it("classifies lazy Route Handlers consistently before and after their first load", () => {
    const lazyRoute: TestRoute = {
      ...route("/api/:path*", ["api", ":path*"]),
      __loadRouteHandler: async () => ({}),
      routeHandler: null,
    };
    const matcher = createAppRscRouteMatcher([lazyRoute]);

    expect(matcher.matchRequestRoute("/api/a%2561/b%2Fc")).toMatchObject({
      params: { path: ["a%61", "b/c"] },
    });
    lazyRoute.routeHandler = {};
    expect(matcher.matchRequestRoute("/api/a%2561/b%2Fc")).toMatchObject({
      params: { path: ["a%61", "b/c"] },
    });
    expect(matcher.matchRequestRoute("/api")).toMatchObject({ params: {} });
  });

  it("keeps rewritten App Page params canonical while Route Handlers decode once", () => {
    const matcher = createAppRscRouteMatcher([
      route("/page/:path+", ["page", ":path+"]),
      {
        ...route("/api/:path+", ["api", ":path+"]),
        __loadRouteHandler: async () => ({}),
      },
    ]);

    expect(matcher.matchRoute("/page/a%2561/b%2Fc")).toMatchObject({
      params: { path: ["a%2561", "b%2Fc"] },
    });
    expect(matcher.matchRoute("/api/a%2561/b%2Fc")).toMatchObject({
      params: { path: ["a%61", "b/c"] },
    });
  });

  it("matches encoded request pathnames with Next.js App Router semantics", () => {
    const matcher = createAppRscRouteMatcher([
      route("/admin", ["admin"]),
      route("/files/:name", ["files", ":name"]),
      { ...route("/api/:name", ["api", ":name"]), routeHandler: {} },
    ]);

    expect(matcher.matchRoute("/%61dmin")).toBeNull();
    expect(matcher.matchRequestRoute("/%61dmin")).toBeNull();
    expect(matcher.matchRequestRoute("/%2561dmin")).toBeNull();
    expect(matcher.matchRequestRoute("/files/%61")).toMatchObject({
      params: { name: "a" },
    });
    expect(matcher.matchRequestRoute("/files/a%2561")).toMatchObject({
      params: { name: "a%2561" },
    });
    expect(matcher.matchRequestRoute("/files/a%2Fb")).toMatchObject({
      params: { name: "a%2Fb" },
    });
    expect(matcher.matchRequestRoute("/api/a%2561")).toMatchObject({
      params: { name: "a%61" },
    });
    expect(matcher.matchRequestRoute("/api/a%2Fb")).toMatchObject({
      params: { name: "a/b" },
    });
  });

  it("answers an encoded static page pathname beside a dynamic sibling with the static page", () => {
    // Next.js 16.2.7 production: `/%61` and `/caf%C3%A9` beside `/[slug]`
    // render the prerendered `/a` and `/café`; a force-dynamic page has no
    // prerender, so `/[slug]` renders; without a dynamic sibling the raw path
    // stays a 404; a Route Handler sibling keeps the request.
    const matcher = createAppRscRouteMatcher(
      [
        route("/a", ["a"]),
        route("/café", ["café"]),
        route("/live", ["live"]),
        route("/:slug", [":slug"]),
        route("/blog/new", ["blog", "new"]),
        route("/blog/:slug", ["blog", ":slug"]),
        route("/members/:user/settings", ["members", ":user", "settings"]),
        route("/members/:user/:tab", ["members", ":user", ":tab"]),
        route("/solo/only", ["solo", "only"]),
        route("/files/new", ["files", "new"]),
        { ...route("/files/:name", ["files", ":name"]), routeHandler: {} },
      ],
      ["/a", "/café", "/blog/new", "/solo/only", "/files/new"],
    );
    for (const pathname of ["/a", "/café", "/blog/new", "/solo/only", "/files/new"]) {
      addPregeneratedConcretePath(pathname, pathname);
    }
    const pattern = (pathname: string) => matcher.matchRequestRoute(pathname)?.route.pattern;
    // Next.js answers a rewrite destination like a direct request to it.
    expect(matcher.matchRoute("/%61")?.route.pattern).toBe("/a");
    expect(matcher.matchRoute("/members/bob/%73ettings")?.route.pattern).toBe(
      "/members/:user/:tab",
    );

    expect(matcher.matchRequestRoute("/%61")).toEqual({
      route: expect.objectContaining({ pattern: "/a" }),
      params: {},
    });
    expect(pattern("/caf%C3%A9")).toBe("/café");
    expect(pattern("/caf%c3%a9")).toBe("/café");
    expect(pattern("/%63af%C3%A9/")).toBe("/café");
    expect(pattern("/blog/%6Eew")).toBe("/blog/new");
    // An exact static raw match keeps its route.
    expect(
      createAppRscRouteMatcher(
        [route("/%61", ["%61"]), route("/a", ["a"])],
        ["/a"],
      ).matchRequestRoute("/%61")?.route.pattern,
    ).toBe("/%61");
    // Draft mode and server actions render the raw match instead.
    expect(matcher.matchRawRequestRoute("/%61")).toMatchObject({
      route: { pattern: "/:slug" },
      params: { slug: "a" },
    });

    expect(matcher.matchRequestRoute("/%6Cive")).toMatchObject({
      route: { pattern: "/:slug" },
      params: { slug: "live" },
    });
    expect(matcher.matchRequestRoute("/%2561")).toMatchObject({
      route: { pattern: "/:slug" },
      params: { slug: "%2561" },
    });
    expect(matcher.matchRequestRoute("/blog%2Fnew")).toMatchObject({
      route: { pattern: "/:slug" },
      params: { slug: "blog%2Fnew" },
    });
    // Static segments below a dynamic parent compare against the raw path.
    expect(matcher.matchRequestRoute("/members/bob/%73ettings")).toMatchObject({
      route: { pattern: "/members/:user/:tab" },
      params: { user: "bob", tab: "settings" },
    });
    expect(matcher.matchRequestRoute("/solo/%6Fnly")).toBeNull();
    expect(matcher.matchRequestRoute("/files/%6Eew")).toMatchObject({
      route: { pattern: "/files/:name" },
      params: { name: "new" },
    });
  });

  it("renders the dynamic sibling for another spelling of a page without a recorded prerender", () => {
    // Next.js 16.2.7: a page that reads cookies() or searchParams has no
    // prerender, so `/%61dmin` beside `/[slug]` renders `/[slug]`, and
    // middleware that compared the pathname with `/admin` never saw `/admin`.
    // A rewrite destination is routed the same way.
    const matcher = createAppRscRouteMatcher(
      [
        route("/admin", ["admin"]),
        route("/café", ["café"]),
        route("/:slug", [":slug"]),
        route("/blog/new", ["blog", "new"]),
        route("/blog/:slug", ["blog", ":slug"]),
        route("/docs/admin/billing", ["docs", "admin", "billing"]),
        route("/docs/:path+", ["docs", ":path+"]),
        route("/q&a", ["q&a"]),
        route("/a b", ["a b"]),
      ],
      ["/admin", "/café", "/blog/new", "/docs/admin/billing", "/q&a", "/a b"],
    );

    for (const pathname of ["/%61dmin", "/admi%6E", "/%61%64%6d%69%6e", "/%61dmin?page=2"]) {
      for (const match of [matcher.matchRequestRoute(pathname), matcher.matchRoute(pathname)]) {
        expect(match).toMatchObject({
          route: { pattern: "/:slug" },
          params: { slug: "admin" },
        });
      }
    }
    expect(matcher.matchRequestRoute("/blog/%6Eew")).toMatchObject({
      route: { pattern: "/blog/:slug" },
      params: { slug: "new" },
    });
    for (const pathname of ["/docs/%61dmin/billing", "/docs/admin/%62illing"]) {
      expect(matcher.matchRequestRoute(pathname)).toMatchObject({
        route: { pattern: "/docs/:path+" },
        params: { path: ["admin", "billing"] },
      });
    }

    // The exact spelling a browser sends for `/café` is the page's own
    // pathname, not another spelling of it, so it needs no prerender.
    expect(matcher.matchRequestRoute("/caf%C3%A9")?.route.pattern).toBe("/café");
    expect(matcher.matchRoute("/caf%C3%A9")?.route.pattern).toBe("/café");
    expect(matcher.matchRequestRoute("/a%20b")?.route.pattern).toBe("/a b");
    expect(matcher.matchRequestRoute("/q&a")?.route.pattern).toBe("/q&a");
    for (const pathname of ["/caf%c3%a9", "/%63af%C3%A9", "/caf%C3%a9", "/q%26a", "/a%20%62"]) {
      expect(matcher.matchRequestRoute(pathname)?.route.pattern).toBe("/:slug");
      expect(matcher.matchRoute(pathname)?.route.pattern).toBe("/:slug");
    }

    // A recorded prerender is the response Next.js answers from.
    addPregeneratedConcretePath("/admin", "/admin");
    addPregeneratedConcretePath("/café", "/café");
    expect(matcher.matchRequestRoute("/%61dmin")?.route.pattern).toBe("/admin");
    expect(matcher.matchRoute("/%61dmin")?.route.pattern).toBe("/admin");
    expect(matcher.matchRequestRoute("/caf%c3%a9")?.route.pattern).toBe("/café");
    expect(matcher.matchRequestRoute("/blog/%6Eew")?.route.pattern).toBe("/blog/:slug");
  });

  it("keeps a static interception source gate raw when a direct request decodes", () => {
    const matcher = createAppRscRouteMatcher(
      [
        route("/admin", ["admin"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/admin",
                targetPattern: "/photos/:id",
                interceptLayouts: ["modal-layout"],
                page: "photo-page",
                params: ["id"],
              },
            ],
          },
        }),
        route("/:slug", [":slug"]),
      ],
      ["/admin"],
    );
    addPregeneratedConcretePath("/admin", "/admin");

    expect(matcher.matchRequestRoute("/%61dmin")?.route.pattern).toBe("/admin");
    expect(matcher.findIntercept("/photos/1", "/admin")).not.toBeNull();
    expect(matcher.findIntercept("/photos/1", "/%61dmin")).toBeNull();
  });

  it("keeps a dynamic interception source owner for an encoded static alias", () => {
    // Next.js tests the raw Next-Url against the owner's pattern, so
    // `/%61dmin` is a `/:slug` source even though a direct request to it
    // renders the static `/admin`, which doesn't own the intercept.
    const matcher = createAppRscRouteMatcher(
      [
        route("/admin", ["admin"]),
        route("/:slug", [":slug"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/:slug",
                targetPattern: "/photos/:id",
                interceptLayouts: ["modal-layout"],
                page: "photo-page",
                params: ["id"],
              },
            ],
          },
        }),
      ],
      ["/admin"],
    );
    addPregeneratedConcretePath("/admin", "/admin");

    expect(matcher.matchRequestRoute("/%61dmin")?.route.pattern).toBe("/admin");
    expect(matcher.findIntercept("/photos/1", "/%61dmin")).toMatchObject({ sourceRouteIndex: 1 });
  });

  it("preserves encoded interception target identity and canonicalizes target params", () => {
    const matcher = createAppRscRouteMatcher([
      route("/feed/:slug", ["feed", ":slug"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: ["modal-layout"],
              page: "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/a%2562", "/feed/a%2561")).toMatchObject({
      matchedParams: { slug: "a%2561", id: "a%2562" },
    });
    expect(matcher.findIntercept("/photos/a%2Fb", "/feed/a%2561")).toMatchObject({
      matchedParams: { slug: "a%2561", id: "a%2Fb" },
    });
    expect(matcher.findIntercept("/ph%6Ftos/a", "/feed/a%2561")).toBeNull();
    expect(matcher.findIntercept("/photos/%e2%9c%93", "/feed/a%2561")).toMatchObject({
      matchedParams: { slug: "a%2561", id: "%E2%9C%93" },
    });
  });

  it("finds intercepting routes and merges source and target params", () => {
    const matcher = createAppRscRouteMatcher([
      route("/feed/:id", ["feed", ":id"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: ["modal-layout"],
              page: "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/target-id", "/feed/source-id")).toMatchObject({
      sourceRouteIndex: 0,
      slotKey: "modal",
      targetPattern: "/photos/:id",
      page: "photo-page",
      matchedParams: { id: "target-id" },
    });
  });

  it("accepts only the graph-owned interception id for an exact source and target", () => {
    const interceptionId = "interception:slot:modal:/feed:/feed->/photos/:id";
    const matcher = createAppRscRouteMatcher([
      route("/feed", ["feed"], {
        modal: {
          id: "slot:modal:/feed",
          intercepts: [
            {
              sourceMatchPattern: "/feed",
              targetPattern: "/photos/:id",
              interceptLayouts: ["modal-layout"],
              page: "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/42", "/feed", interceptionId)).toMatchObject({
      interceptionId,
      slotId: "slot:modal:/feed",
    });
    expect(matcher.hasInterceptionId(interceptionId)).toBe(true);
    expect(matcher.hasInterceptionId("interception:attacker-selected")).toBe(false);
    expect(
      matcher.findIntercept("/photos/42", "/feed", "interception:attacker-selected"),
    ).toBeNull();
    expect(matcher.findIntercept("/other/42", "/feed", interceptionId)).toBeNull();
    expect(matcher.findIntercept("/photos/42", "/other", interceptionId)).toBeNull();
  });

  it("prefers static interception targets over dynamic targets", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/interception-dynamic-segment/interception-dynamic-segment.test.ts
    // https://github.com/vercel/next.js/blob/ee6e79b1792a4d401ddf2480f40a83549fe8e722/test/e2e/app-dir/interception-dynamic-segment/interception-dynamic-segment.test.ts
    const matcher = createAppRscRouteMatcher([
      route("/", [], {
        modal: {
          intercepts: [
            {
              sourceMatchPattern: "/",
              targetPattern: "/:username/:id",
              interceptLayouts: [],
              page: "dynamic-page",
              params: ["username", "id"],
            },
            {
              sourceMatchPattern: "/",
              targetPattern: "/explicit-layout/deeper",
              interceptLayouts: ["explicit-layout"],
              page: "static-page",
              params: [],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/explicit-layout/deeper", "/")).toMatchObject({
      targetPattern: "/explicit-layout/deeper",
      interceptLayouts: ["explicit-layout"],
      page: "static-page",
      matchedParams: {},
    });
  });

  it("orders overlapping interception targets segment by segment", () => {
    const matcher = createAppRscRouteMatcher([
      route("/", [], {
        modal: {
          intercepts: [
            {
              targetPattern: "/:name/static",
              interceptLayouts: [],
              page: "dynamic-prefix",
              params: ["name"],
            },
            {
              targetPattern: "/foo/:id",
              interceptLayouts: [],
              page: "static-prefix",
              params: ["id"],
            },
            {
              targetPattern: "/files/:slug*",
              interceptLayouts: [],
              page: "optional-catch-all",
              params: ["slug"],
            },
            {
              targetPattern: "/files/:slug+",
              interceptLayouts: [],
              page: "catch-all",
              params: ["slug"],
            },
            {
              targetPattern: "/files/:id",
              interceptLayouts: [],
              page: "dynamic",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/foo/static", "/")).toMatchObject({
      targetPattern: "/foo/:id",
      page: "static-prefix",
      matchedParams: { id: "static" },
    });
    expect(matcher.findIntercept("/files/one", "/")).toMatchObject({
      targetPattern: "/files/:id",
      page: "dynamic",
      matchedParams: { id: "one" },
    });
    expect(matcher.findIntercept("/files/one/two", "/")).toMatchObject({
      targetPattern: "/files/:slug+",
      page: "catch-all",
      matchedParams: { slug: ["one", "two"] },
    });
    expect(matcher.findIntercept("/files", "/")).toMatchObject({
      targetPattern: "/files/:slug*",
      page: "optional-catch-all",
      matchedParams: {},
    });
  });

  it("orders equally specific dynamic interception segments lexicographically", () => {
    // Mirrors Next.js compareRouteSegments, including dynamic parameter names:
    // packages/next/src/shared/lib/router/utils/sortable-routes.ts
    const matcher = createAppRscRouteMatcher([
      route("/", [], {
        modal: {
          intercepts: [
            {
              targetPattern: "/:name/foo",
              interceptLayouts: [],
              page: "name-page",
              params: ["name"],
            },
            {
              targetPattern: "/:id/foo",
              interceptLayouts: [],
              page: "id-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/value/foo", "/")).toMatchObject({
      targetPattern: "/:id/foo",
      page: "id-page",
      matchedParams: { id: "value" },
    });
  });

  it("preserves declaration order for identical interception targets", () => {
    const matcher = createAppRscRouteMatcher([
      route("/", [], {
        first: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: [],
              page: "first-page",
              params: ["id"],
            },
          ],
        },
        second: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: [],
              page: "second-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/42", "/")).toMatchObject({
      slotKey: "first",
      page: "first-page",
      matchedParams: { id: "42" },
    });
  });

  it("shares lazy intercept load state across fresh match objects", () => {
    const matcher = createAppRscRouteMatcher([
      route("/feed", ["feed"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: [null],
              __loadInterceptLayouts: [async () => "modal-layout"],
              page: null,
              __pageLoader: async () => "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    const first = matcher.findIntercept("/photos/42", "/feed");
    const second = matcher.findIntercept("/photos/42", "/feed");

    expect(first).not.toBe(second);
    expect(first?.__loadState).toBe(second?.__loadState);
  });

  it("does not treat a target match as an intercept without a matching source route", () => {
    const matcher = createAppRscRouteMatcher([
      route("/feed", ["feed"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: ["modal-layout"],
              page: "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/42", null)).toBeNull();
    expect(matcher.findIntercept("/photos/42", "/gallery")).toBeNull();
  });

  it("does not use an unrelated concrete route for legacy interception entries", () => {
    const matcher = createAppRscRouteMatcher([
      route("/feed", ["feed"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: ["modal-layout"],
              page: "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
      route("/gallery", ["gallery"]),
    ]);

    expect(matcher.findIntercept("/photos/42", "/gallery")).toBeNull();
  });

  it("matches static source segments on the raw path, like a direct request", () => {
    const matcher = createAppRscRouteMatcher([
      route("/_sites/:tenant", ["_sites", ":tenant"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: ["modal-layout"],
              page: "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/a%2Fb", "/_sites/acme")).toMatchObject({
      targetPattern: "/photos/:id",
      matchedParams: { tenant: "acme", id: "a%2Fb" },
    });
    // A direct request to `/%5Fsites/acme` does not reach `/_sites/:tenant`.
    expect(matcher.matchRequestRoute("/%5Fsites/acme")).toBeNull();
    expect(matcher.findIntercept("/photos/a%2Fb", "/%5Fsites/acme")).toBeNull();
  });

  it("does not decode a static interception source", () => {
    const matcher = createAppRscRouteMatcher([
      route("/admin", ["admin"], {
        modal: {
          intercepts: [
            {
              sourceMatchPattern: "/admin",
              targetPattern: "/photos/:id",
              interceptLayouts: ["modal-layout"],
              page: "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/1", "/admin")).not.toBeNull();
    expect(matcher.findIntercept("/photos/1", "/%61dmin")).toBeNull();
    expect(matcher.findIntercept("/photos/1", "/%2561dmin")).toBeNull();
  });

  it.each(["caf%C3%A9", "caf%c3%a9", "a%2Fb", "%2561", "%252561", "100%25", "plain"])(
    "gives source %s the params a direct request to it gets",
    (tag) => {
      const matcher = createAppRscRouteMatcher([
        route("/tags/:tag", ["tags", ":tag"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/tags/:tag",
                targetPattern: "/photos/:id",
                interceptLayouts: ["modal-layout"],
                page: "photo-page",
                params: ["id"],
              },
            ],
          },
        }),
      ]);
      const source = `/tags/${tag}`;

      const intercept = matcher.findIntercept("/photos/1", source);

      expect(intercept?.sourceRouteIsConcrete).toBe(true);
      expect({ ...intercept?.sourceMatchedParams }).toEqual({
        ...matcher.matchRequestRoute(source)?.params,
      });
    },
  );

  it("renders a root-slot interception from the concrete matched source route", () => {
    const matcher = createAppRscRouteMatcher([
      route("/", [], {
        modal: {
          intercepts: [
            {
              sourceMatchPattern: "/",
              targetPattern: "/org/:orgId/team/:teamId/settings",
              interceptLayouts: ["modal-layout"],
              page: "settings-modal",
              params: ["orgId", "teamId"],
            },
          ],
        },
      }),
      route("/org/:orgId/team/:teamId", ["org", ":orgId", "team", ":teamId"], {
        modal: {
          intercepts: [
            {
              sourceMatchPattern: "/",
              targetPattern: "/org/:orgId/team/:teamId/settings",
              interceptLayouts: ["modal-layout"],
              page: "settings-modal",
              params: ["orgId", "teamId"],
            },
          ],
        },
      }),
    ]);

    expect(
      matcher.findIntercept("/org/acme/team/engineering/settings", "/org/acme/team/engineering"),
    ).toMatchObject({
      sourceRouteIndex: 1,
      matchedParams: { orgId: "acme", teamId: "engineering" },
    });
  });

  it("tells whether the target's own route renders the intercepting route's layouts", () => {
    const pics = (sourcePageSegments: string[]) => ({
      modal: {
        intercepts: [
          {
            sourceMatchPattern: "/teams/:team",
            sourcePageSegments,
            targetPattern: "/teams/:team/pics/:id",
            interceptLayouts: [],
            page: "pic-modal",
            params: ["team", "id"],
          },
        ],
      },
    });
    const matcher = createAppRscRouteMatcher([
      {
        ...route(
          "/teams/:team",
          ["teams", ":team"],
          pics(["teams", "[team]", "@modal", "(.)pics", "[id]"]),
        ),
        routeSegments: ["teams", "[team]"],
      },
      {
        ...route("/teams/:team/pics/:id", ["teams", ":team", "pics", ":id"]),
        routeSegments: ["teams", "[team]", "pics", "[id]"],
      },
      {
        ...route("/feed", ["feed"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/feed",
                sourcePageSegments: ["feed", "@modal", "(...)photos", "[id]"],
                targetPattern: "/photos/:id",
                interceptLayouts: [],
                page: "photo-modal",
                params: ["id"],
              },
            ],
          },
        }),
        routeSegments: ["feed"],
      },
      {
        ...route("/photos/:id", ["photos", ":id"]),
        routeSegments: ["photos", "[id]"],
      },
    ] as any);

    // Same layout directories, same team.
    expect(matcher.findIntercept("/teams/acme/pics/1", "/teams/acme")).toMatchObject({
      rendersTargetLayouts: true,
    });
    expect(matcher.findIntercept("/teams/a%2561/pics/1", "/teams/a%2561")).toMatchObject({
      rendersTargetLayouts: true,
    });
    // The source's team renders a layout the target's own request does not.
    expect(matcher.findIntercept("/teams/acme/pics/1", "/teams/other")).toMatchObject({
      rendersTargetLayouts: false,
    });
    // The target's route does not render /feed's layout.
    expect(matcher.findIntercept("/photos/1", "/feed")).toMatchObject({
      rendersTargetLayouts: false,
    });

    // Everything from the slot down is the intercepting branch, which renders
    // under the target's request; a param it binds must hold the target's value.
    const insideSlot = (
      slotSegments: string[],
      sourceMatchPattern: string,
      targetPattern: string,
      targetSegments: string[],
    ) => {
      const modal = {
        modal: {
          intercepts: [
            {
              sourceMatchPattern,
              sourcePageSegments: ["teams", "[team]", "@modal", ...slotSegments, "(.)pics", "[id]"],
              targetPattern,
              interceptLayouts: [],
              page: "pic-modal",
              params: ["team", "id"],
            },
          ],
        },
      };
      return createAppRscRouteMatcher([
        {
          ...route("/teams/:team", ["teams", ":team"], modal),
          routeSegments: ["teams", "[team]"],
        },
        // The page the source shows below the owner, beneath the same slot.
        ...(sourceMatchPattern === "/teams/:team"
          ? []
          : [
              {
                ...route(sourceMatchPattern, sourceMatchPattern.split("/").filter(Boolean), modal),
                routeSegments: ["teams", "[team]", ...slotSegments],
              },
            ]),
        {
          ...route(targetPattern, targetPattern.split("/").filter(Boolean)),
          routeSegments: targetSegments,
        },
      ] as any);
    };
    expect(
      insideSlot(["(organize-only)"], "/teams/:team", "/teams/:team/pics/:id", [
        "teams",
        "[team]",
        "pics",
        "[id]",
      ]).findIntercept("/teams/acme/pics/1", "/teams/acme"),
    ).toMatchObject({ rendersTargetLayouts: true });
    expect(
      insideSlot(["nested"], "/teams/:team/nested", "/teams/:team/nested/pics/:id", [
        "teams",
        "[team]",
        "nested",
        "pics",
        "[id]",
      ]).findIntercept("/teams/acme/nested/pics/1", "/teams/acme/nested"),
    ).toMatchObject({ rendersTargetLayouts: true });
    const dynamicInsideSlot = insideSlot(
      ["[album]"],
      "/teams/:team/:album",
      "/teams/:team/:album/pics/:id",
      ["teams", "[team]", "[album]", "pics", "[id]"],
    );
    expect(
      dynamicInsideSlot.findIntercept("/teams/acme/one/pics/1", "/teams/acme/one"),
    ).toMatchObject({ rendersTargetLayouts: true });
    expect(
      dynamicInsideSlot.findIntercept("/teams/acme/one/pics/1", "/teams/acme/two"),
    ).toMatchObject({ rendersTargetLayouts: false });
    // Static routes beside the dynamic folder bind no album, but the rewrite
    // still captures it from both paths.
    const albumModal = {
      modal: {
        intercepts: [
          {
            sourceMatchPattern: "/teams/:team/:album",
            sourcePageSegments: ["teams", "[team]", "@modal", "[album]", "(.)pics", "[id]"],
            targetPattern: "/teams/:team/:album/pics/:id",
            interceptLayouts: [],
            page: "pic-modal",
            params: ["team", "album", "id"],
          },
        ],
      },
    };
    const staticAlbum = createAppRscRouteMatcher([
      {
        ...route("/teams/:team", ["teams", ":team"], albumModal),
        routeSegments: ["teams", "[team]"],
      },
      {
        ...route("/teams/:team/featured", ["teams", ":team", "featured"], albumModal),
        routeSegments: ["teams", "[team]", "featured"],
      },
      {
        ...route("/teams/:team/featured/pics/:id", ["teams", ":team", "featured", "pics", ":id"]),
        routeSegments: ["teams", "[team]", "featured", "pics", "[id]"],
      },
    ] as any);
    expect(
      staticAlbum.findIntercept("/teams/acme/featured/pics/1", "/teams/acme/featured"),
    ).toMatchObject({ rendersTargetLayouts: true });
    expect(
      staticAlbum.findIntercept("/teams/acme/featured/pics/1", "/teams/acme/other"),
    ).toMatchObject({ rendersTargetLayouts: false });
    // An encoded spelling renders a static page beside the dynamic target, but
    // draft mode and server actions render the raw match, which doesn't share
    // the owner's layouts.
    const groupedModal = {
      modal: {
        intercepts: [
          {
            sourceMatchPattern: "/teams",
            sourcePageSegments: ["(private)", "teams", "@modal", "(.)[slug]"],
            targetPattern: "/teams/:slug",
            interceptLayouts: [],
            page: "slug-modal",
            params: ["slug"],
          },
        ],
      },
    };
    const groupedTeams = createAppRscRouteMatcher(
      [
        { ...route("/teams", ["teams"], groupedModal), routeSegments: ["(private)", "teams"] },
        {
          ...route("/teams/café", ["teams", "café"]),
          routeSegments: ["(private)", "teams", "café"],
        },
        {
          ...route("/teams/:slug", ["teams", ":slug"]),
          routeSegments: ["(public)", "teams", "[slug]"],
        },
      ] as any,
      ["/teams/café"],
    );
    expect(groupedTeams.matchRequestRoute("/teams/caf%C3%A9")?.route.pattern).toBe("/teams/café");
    expect(groupedTeams.findIntercept("/teams/caf%C3%A9", "/teams")).toMatchObject({
      rawRendersTargetLayouts: false,
      rendersTargetLayouts: true,
    });
    // A slot nested in another renders beneath that slot's branch, even
    // behind a route group that only looks like a marker.
    for (const slotSegments of [["@sidebar"], ["(....)", "@sidebar"]]) {
      expect(
        insideSlot(slotSegments, "/teams/:team", "/teams/:team/pics/:id", [
          "teams",
          "[team]",
          "pics",
          "[id]",
        ]).findIntercept("/teams/acme/pics/1", "/teams/acme"),
      ).toMatchObject({ rendersTargetLayouts: false });
    }
    // The target binds no album, and the source has no route of its own below the owner.
    expect(
      insideSlot(["[album]"], "/teams/:team", "/teams/:team/pics/:id", [
        "teams",
        "[team]",
        "pics",
        "[id]",
      ]).findIntercept("/teams/acme/pics/1", "/teams/acme"),
    ).toMatchObject({ rendersTargetLayouts: false });
  });

  it("never lets a source without the slot skip source authorization", () => {
    // A root owner's segments are empty, so the layout check alone would pass
    // for a sibling page that lacks the slot.
    const matcher = createAppRscRouteMatcher([
      {
        ...route("/", [], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/",
                sourcePageSegments: ["@modal", "(.)pics", "[id]"],
                targetPattern: "/pics/:id",
                interceptLayouts: [],
                page: "pic-modal",
                params: ["id"],
              },
            ],
          },
        }),
        routeSegments: [],
      },
      { ...route("/static", ["static"]), routeSegments: ["static"] },
      { ...route("/pics/:id", ["pics", ":id"]), routeSegments: ["pics", "[id]"] },
    ] as any);

    expect(matcher.findIntercept("/pics/1", "/static", null, true)).toMatchObject({
      rawRendersTargetLayouts: false,
      rendersTargetLayouts: false,
      sourceRouteLacksSlot: true,
    });
  });

  it("preserves bracket-shaped literal segments in intercept target patterns", () => {
    const matcher = createAppRscRouteMatcher([
      route("/feed", ["feed"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/[literal]",
              interceptLayouts: ["modal-layout"],
              page: "literal-photo-page",
              params: [],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/[literal]", "/feed")).toMatchObject({
      targetPattern: "/photos/[literal]",
      page: "literal-photo-page",
      matchedParams: {},
    });
    expect(matcher.findIntercept("/photos/anything", "/feed")).toBeNull();
  });

  // Ported from Next.js: lib/generate-interception-routes-rewrites.test.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.test.ts
  //
  // Interception is implemented in Next.js as a rewrite that only fires when
  // the Next-URL header matches the *intercepting route* regex (the path that
  // owns the slot, with route groups and @slot segments stripped).
  //
  // vinext must enforce the same constraint at the matcher boundary: an
  // intercept entry whose targetPattern matches the request URL is only valid
  // when the provided source pathname matches its declared sourceMatchPattern.
  // Otherwise the matcher must fall through to null so the direct route is
  // rendered.
  describe("source-pathname filtering (mirrors Next.js Next-URL header rewrite)", () => {
    it("returns null when the source pathname does not match the intercepting route", () => {
      // Slot lives at root (`/@modal`) and intercepts `/groups/[id]/new`.
      // Intercepting route = `/` so any source under `/` is allowed.
      // But for a slot at `/templates`, only `/templates(?:/.*)?` sources qualify.
      const matcher = createAppRscRouteMatcher([
        route("/templates/:catchAll+", ["templates", ":catchAll+"], {
          modal: {
            intercepts: [
              {
                // (..)showcase/[...catchAll] from `app/templates`
                sourceMatchPattern: "/templates",
                targetPattern: "/showcase/:catchAll+",
                interceptLayouts: ["layout"],
                page: "intercept-page",
                params: ["catchAll"],
              },
            ],
          },
        }),
      ]);

      // Source under /templates — should intercept.
      expect(matcher.findIntercept("/showcase/multi/slug", "/templates/multi/slug")).toMatchObject({
        targetPattern: "/showcase/:catchAll+",
      });

      // Source NOT under /templates — must not intercept.
      expect(matcher.findIntercept("/showcase/single", "/")).toBeNull();
      expect(matcher.findIntercept("/showcase/single", "/other")).toBeNull();
    });

    it("returns null when no source pathname is provided (no Next-URL header)", () => {
      // Without a Next-URL header the rewrite cannot fire in Next.js, so the
      // direct page must render. vinext should mirror that.
      const matcher = createAppRscRouteMatcher([
        route("/templates/:catchAll+", ["templates", ":catchAll+"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/templates",
                targetPattern: "/showcase/:catchAll+",
                interceptLayouts: ["layout"],
                page: "intercept-page",
                params: ["catchAll"],
              },
            ],
          },
        }),
      ]);

      expect(matcher.findIntercept("/showcase/multi/slug", null)).toBeNull();
      expect(matcher.findIntercept("/showcase/multi/slug")).toBeNull();
    });

    it("accepts descendants of the intercepting route as valid sources", () => {
      // Header regex appends `(?:/.*)?` to allow any descendant of the
      // intercepting route to trigger the rewrite.
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.ts
      const matcher = createAppRscRouteMatcher([
        route("/feed/:id", ["feed", ":id"], {
          modal: {
            intercepts: [
              {
                // (.)photos/[id] from `app/feed/[id]`
                sourceMatchPattern: "/feed/:id",
                targetPattern: "/feed/:id/photos/:photoId",
                interceptLayouts: ["layout"],
                page: "modal-photo",
                params: ["id", "photoId"],
              },
            ],
          },
        }),
      ]);

      // Exact match on intercepting route.
      expect(matcher.findIntercept("/feed/abc/photos/1", "/feed/abc")).not.toBeNull();
      // Descendant of intercepting route.
      expect(matcher.findIntercept("/feed/abc/photos/1", "/feed/abc/nested/deep")).not.toBeNull();
      // Parent of intercepting route — should NOT intercept.
      expect(matcher.findIntercept("/feed/abc/photos/1", "/")).toBeNull();
      // Sibling — should NOT intercept.
      expect(matcher.findIntercept("/feed/abc/photos/1", "/other")).toBeNull();
    });

    it("does not leak descendant source params into the interception branch", () => {
      const intercept = {
        sourceMatchPattern: "/:locale/feed",
        targetPattern: "/photos/:photoId",
        interceptLayouts: ["layout"],
        page: "modal-photo",
        params: ["photoId"],
      };
      const matcher = createAppRscRouteMatcher([
        route("/:locale/feed", [":locale", "feed"], {
          modal: { intercepts: [intercept] },
        }),
        route("/:locale/feed/:tab", [":locale", "feed", ":tab"], {
          modal: { intercepts: [intercept] },
        }),
      ]);

      expect(matcher.findIntercept("/photos/42", "/en/feed/recent")).toMatchObject({
        sourceRouteIndex: 1,
        matchedParams: { locale: "en", photoId: "42" },
        sourceMatchedParams: { locale: "en", tab: "recent" },
      });
    });

    // A source outside the owner's tree, such as a static sibling in another
    // route group, has no slot to render the intercept into. Without an owner
    // route of its own to render whole, the request renders the target
    // directly. A Route Handler owner never renders.
    it("does not intercept from a source without the intercepted slot", () => {
      const matcher = createAppRscRouteMatcher([
        route("/club/:slug", ["club", ":slug"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/club/:slug",
                targetPattern: "/club/:slug/pics/:id",
                interceptLayouts: [],
                page: "pics-modal",
                params: ["slug", "id"],
              },
            ],
          },
        }),
        route("/club/static", ["club", "static"]),
      ]);

      expect(matcher.findIntercept("/club/static/pics/1", "/club/static")).toBeNull();
      expect(matcher.findIntercept("/club/acme/pics/1", "/club/acme")).toMatchObject({
        sourceRouteIndex: 0,
        sourceRouteLacksSlot: false,
      });
      // The request handler accepts it until source middleware has run, since
      // a rewrite can still reach a route that has the slot.
      expect(
        matcher.findIntercept("/club/static/pics/1", "/club/static", null, true),
      ).toMatchObject({
        page: "pics-modal",
        sourceRouteIndex: 1,
        sourceRouteLacksSlot: true,
      });

      const handlerMatcher = createAppRscRouteMatcher([
        {
          ...route("/feed", ["feed"], {
            modal: {
              intercepts: [
                {
                  sourceMatchPattern: "/feed",
                  targetPattern: "/feed/hidden",
                  interceptLayouts: [],
                  page: "hidden-modal",
                  params: [],
                },
              ],
            },
          }),
          routeHandler: {},
        },
        route("/feed/about", ["feed", "about"]),
      ]);
      expect(handlerMatcher.findIntercept("/feed/hidden", "/feed/about")).toBeNull();
    });

    // Next.js's interception rewrite applies to any source under the
    // intercepting route's path and renders that route's tree whole, so a
    // static sibling without the slot renders the slot owner's route, taking
    // the owner's params from the source pathname.
    it("renders the slot owner's route whole for a source without the slot", () => {
      const clubModal = {
        sourceMatchPattern: "/club/:slug",
        sourcePageSegments: ["(shared)", "club", "[slug]", "@modal", "(.)pics", "[id]"],
        targetPattern: "/club/:slug/pics/:id",
        interceptLayouts: [],
        page: "pics-modal",
        params: ["slug", "id"],
      };
      const staticRoute = {
        ...route("/club/static", ["club", "static"]),
        routeSegments: ["(other)", "club", "static"],
      };
      const matcher = createAppRscRouteMatcher([
        {
          ...route("/club/:slug", ["club", ":slug"], { modal: { intercepts: [clubModal] } }),
          routeSegments: ["(shared)", "club", "[slug]"],
        },
        staticRoute,
      ]);

      for (const target of ["/club/static/pics/1", "/club/acme/pics/1"]) {
        expect(matcher.findIntercept(target, "/club/static")).toMatchObject({
          page: "pics-modal",
          sourceRouteIndex: 0,
          sourceRouteLacksSlot: true,
          rendersWholeInterceptingRoute: true,
          // The source is still authorized, since its middleware can rewrite
          // it to a route with the slot.
          rendersTargetLayouts: false,
          authorizationSourceRouteIndex: 1,
          matchedParams: { slug: "static", id: "1" },
          sourceMatchedParams: { slug: "static" },
        });
      }
      expect(matcher.findIntercept("/club/acme/pics/1", "/club/acme")).toMatchObject({
        sourceRouteIndex: 0,
        sourceRouteLacksSlot: false,
        rendersWholeInterceptingRoute: false,
        matchedParams: { slug: "acme", id: "1" },
      });

      // A Route Handler at the owner's path has no tree to render.
      const handlerMatcher = createAppRscRouteMatcher([
        {
          ...route("/club/:slug", ["club", ":slug"], { modal: { intercepts: [clubModal] } }),
          routeSegments: ["(shared)", "club", "[slug]"],
          routeHandler: {},
        },
        staticRoute,
      ]);
      expect(handlerMatcher.findIntercept("/club/static/pics/1", "/club/static")).toBeNull();
    });

    // The interception rewrite captures every param of the intercepting route
    // from the source, those of the slot's folders above the marker too.
    it("takes the params of the slot's folders from the source of a whole intercepting route", () => {
      const matcher = createAppRscRouteMatcher([
        {
          ...route("/teams/:team", ["teams", ":team"], {
            modal: {
              intercepts: [
                {
                  sourceMatchPattern: "/teams/:team/:album",
                  sourcePageSegments: [
                    "(shared)",
                    "teams",
                    "[team]",
                    "@modal",
                    "[album]",
                    "(.)pics",
                    "[id]",
                  ],
                  targetPattern: "/teams/:team/:album/pics/:id",
                  interceptLayouts: [],
                  page: "pics-modal",
                  params: ["team", "album", "id"],
                },
              ],
            },
          }),
          routeSegments: ["(shared)", "teams", "[team]"],
        },
        {
          ...route("/teams/:team/:album", ["teams", ":team", ":album"]),
          routeSegments: ["(other)", "teams", "[team]", "[album]"],
        },
      ]);

      expect(matcher.findIntercept("/teams/other/two/pics/1", "/teams/acme/one")).toMatchObject({
        sourceRouteIndex: 0,
        rendersWholeInterceptingRoute: true,
        matchedParams: { team: "acme", album: "one", id: "1" },
        sourceMatchedParams: { team: "acme", album: "one" },
      });
    });

    // An unmatched URL's not-found page sends /_not-found and shows none of
    // the intercepting route's tree, so the intercept renders that tree
    // whole, as Next.js's client shows it: the owner's layouts with the
    // params /_not-found gives them, and nothing in the owner's children.
    it("renders the slot owner's route whole from an unmatched URL's not-found page", () => {
      const modal = (targetPattern: string, marker: string, params: string[]) => ({
        sourceMatchPattern: "/:slug",
        sourcePageSegments: ["[slug]", "@modal", marker, "[id]"],
        targetPattern,
        interceptLayouts: [],
        page: `${marker}-modal`,
        params,
      });
      const slugRoute = {
        ...route("/:slug", [":slug"], {
          modal: {
            intercepts: [
              modal("/photos/:id", "(..)photos", ["id"]),
              modal("/:slug/pics/:id", "(.)pics", ["slug", "id"]),
            ],
          },
        }),
        routeSegments: ["[slug]"],
      };
      const matcher = createAppRscRouteMatcher([slugRoute]);

      expect(matcher.findIntercept("/photos/1", "/_not-found")).toMatchObject({
        page: "(..)photos-modal",
        sourceRouteIndex: 0,
        sourceRouteLacksSlot: false,
        rendersWholeInterceptingRoute: true,
        authorizationSourceRouteIndex: 0,
        matchedParams: { slug: "_not-found", id: "1" },
        sourceMatchedParams: { slug: "_not-found" },
      });
      expect(matcher.findIntercept("/x/pics/3", "/_not-found")).toMatchObject({
        page: "(.)pics-modal",
        rendersWholeInterceptingRoute: true,
        matchedParams: { slug: "_not-found", id: "3" },
      });
      // A page that shows the tree keeps its own segments.
      expect(matcher.findIntercept("/photos/1", "/acme")).toMatchObject({
        rendersWholeInterceptingRoute: false,
        matchedParams: { slug: "acme", id: "1" },
      });

      // Without the owner's own route to render, the target renders directly.
      const ownerless = createAppRscRouteMatcher([
        {
          ...slugRoute,
          slots: {
            modal: {
              intercepts: [
                { ...modal("/photos/:id", "(..)photos", ["id"]), sourcePageSegments: undefined },
              ],
            },
          },
        },
      ]);
      expect(ownerless.findIntercept("/photos/1", "/_not-found")).toBeNull();
      expect(ownerless.findIntercept("/photos/1", "/acme")).not.toBeNull();
    });

    it("renders a catch-all slot owner's route whole from an unmatched URL's not-found page", () => {
      const matcher = createAppRscRouteMatcher([
        {
          ...route("/:rest+", [":rest+"], {
            modal: {
              intercepts: [
                {
                  sourceMatchPattern: "/:rest+",
                  sourcePageSegments: ["[...rest]", "@modal", "(..)photos", "[id]"],
                  targetPattern: "/photos/:id",
                  interceptLayouts: [],
                  page: "photos-modal",
                  params: ["id"],
                },
              ],
            },
          }),
          routeSegments: ["[...rest]"],
        },
      ]);

      expect(matcher.findIntercept("/photos/1", "/_not-found")).toMatchObject({
        page: "photos-modal",
        sourceRouteIndex: 0,
        sourceRouteLacksSlot: false,
        rendersWholeInterceptingRoute: true,
        matchedParams: { rest: ["_not-found"], id: "1" },
        sourceMatchedParams: { rest: ["_not-found"] },
      });
    });

    // A sibling intercept renders the intercepting route itself, from any
    // source, so /_not-found is simply its concrete source, as Next.js's
    // interception rewrite captures the owner's params from `Next-Url`.
    it("renders a sibling intercept from an unmatched URL's not-found page as its own route", () => {
      const matcher = createAppRscRouteMatcher([
        {
          ids: { route: "graph-route:/:slug" },
          pattern: "/:slug",
          patternParts: [":slug"],
          routeSegments: ["[slug]"],
          siblingIntercepts: [
            {
              targetPattern: "/photos/:id",
              sourceMatchPattern: "/:slug",
              sourcePageSegments: ["[slug]", "(..)photos", "[id]"],
              slotId: "slot:__vinext_sibling_intercept:/:slug",
              interceptLayouts: [],
              page: "photos-intercept",
              params: ["id"],
            },
          ],
        },
      ] as any);

      expect(matcher.findIntercept("/photos/1", "/_not-found")).toMatchObject({
        page: "photos-intercept",
        slotKey: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
        sourceRouteIndex: 0,
        sourceRouteIsConcrete: true,
        sourceRouteLacksSlot: false,
        rendersWholeInterceptingRoute: false,
        authorizationSourceRouteIndex: 0,
        matchedParams: { slug: "_not-found", id: "1" },
        sourceMatchedParams: { slug: "_not-found" },
      });
    });

    // Next.js's interception rewrites are tried in order, and a root-level
    // intercept's header regex matches any `Next-Url`, /_not-found included.
    // Over a shared target, the earlier root-level intercept wins from an
    // unmatched URL's not-found page as from any matched page.
    it("selects the earlier root-level intercept over a shared target from an unmatched URL's not-found page", () => {
      const rootRoute = {
        ids: { route: "graph-route:/" },
        pattern: "/",
        patternParts: [],
        routeSegments: [],
        siblingIntercepts: [
          {
            targetPattern: "/photos/:id",
            sourceMatchPattern: "/",
            sourcePageSegments: ["(.)photos", "[id]"],
            slotId: "slot:__vinext_sibling_intercept:/",
            interceptLayouts: [],
            page: "root-photos-intercept",
            params: ["id"],
          },
        ],
      };
      const matcher = createAppRscRouteMatcher([
        rootRoute,
        {
          ...route("/:slug", [":slug"], {
            modal: {
              intercepts: [
                {
                  sourceMatchPattern: "/:slug",
                  sourcePageSegments: ["[slug]", "@modal", "(..)photos", "[id]"],
                  targetPattern: "/photos/:id",
                  interceptLayouts: [],
                  page: "slug-photos-modal",
                  params: ["id"],
                },
              ],
            },
          }),
          routeSegments: ["[slug]"],
        },
      ] as any);

      for (const sourcePathname of ["/_not-found", "/acme"]) {
        expect(matcher.findIntercept("/photos/1", sourcePathname)).toMatchObject({
          page: "root-photos-intercept",
          slotKey: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
          sourceRouteIndex: 0,
          matchedParams: { id: "1" },
        });
      }
      expect(
        createAppRscRouteMatcher([rootRoute] as any).findIntercept("/photos/1", "/_not-found"),
      ).toMatchObject({ page: "root-photos-intercept", sourceRouteIndex: 0 });
    });

    it("prefers the whole intercepting route among intercepts whose source lacks the slot", () => {
      const intercept = (page: string, sourcePageSegments?: string[]) => ({
        sourceMatchPattern: "/club/:slug",
        ...(sourcePageSegments ? { sourcePageSegments } : {}),
        targetPattern: "/club/:slug/pics/:id",
        interceptLayouts: [],
        page,
        params: ["slug", "id"],
      });
      const matcher = createAppRscRouteMatcher([
        {
          ...route("/club/:slug", ["club", ":slug"], {
            // Only a rewrite of the source can give it this slot.
            drawer: { intercepts: [intercept("pics-drawer")] },
            modal: {
              intercepts: [
                intercept("pics-modal", [
                  "(shared)",
                  "club",
                  "[slug]",
                  "@modal",
                  "(.)pics",
                  "[id]",
                ]),
              ],
            },
          }),
          routeSegments: ["(shared)", "club", "[slug]"],
        },
        route("/club/static", ["club", "static"]),
      ]);

      for (const acceptsSourceWithoutSlot of [false, true]) {
        expect(
          matcher.findIntercept(
            "/club/static/pics/1",
            "/club/static",
            null,
            acceptsSourceWithoutSlot,
          ),
        ).toMatchObject({
          page: "pics-modal",
          sourceRouteIndex: 0,
          sourceRouteLacksSlot: true,
          rendersWholeInterceptingRoute: true,
        });
      }
    });

    it("prefers an intercept whose source has the slot over one whose source lacks it", () => {
      const matcher = createAppRscRouteMatcher([
        route("/club/:slug", ["club", ":slug"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/club/:slug",
                targetPattern: "/club/:slug/pics/:id",
                interceptLayouts: [],
                page: "pics-modal",
                params: ["slug", "id"],
              },
            ],
          },
        }),
        route("/club/static", ["club", "static"], {
          drawer: {
            intercepts: [
              {
                sourceMatchPattern: "/club/static",
                targetPattern: "/club/:slug/pics/:id",
                interceptLayouts: [],
                page: "pics-drawer",
                params: ["slug", "id"],
              },
            ],
          },
        }),
      ]);

      expect(
        matcher.findIntercept("/club/static/pics/1", "/club/static", null, true),
      ).toMatchObject({
        page: "pics-drawer",
        sourceRouteIndex: 1,
        sourceRouteLacksSlot: false,
      });
    });

    it("never promotes a Route Handler as the concrete interception source", () => {
      // The source pathname arrives as an unauthenticated client header
      // (X-Vinext-Interception-Context / Next-URL), and the resolved source
      // route is what later renders or dispatches. A `route.ts` has no page,
      // layouts, or slots, so it can never own an interception source tree;
      // resolving one would let a crafted context execute a Route Handler that
      // merely lives under the intercepting route. Next.js rewrites the
      // intercepted target to a fixed destination (the intercepting route), so
      // falling back to the slot owner is also the parity-correct choice.
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.ts
      const feedModal = {
        modal: {
          intercepts: [
            {
              sourceMatchPattern: "/feed",
              targetPattern: "/hidden",
              interceptLayouts: ["layout"],
              page: "modal-hidden",
              params: [],
            },
          ],
        },
      };
      const matcher = createAppRscRouteMatcher([
        route("/feed", ["feed"], feedModal),
        { ...route("/feed/admin", ["feed", "admin"]), routeHandler: {} },
        // A page beneath the owner's layout carries its slot.
        route("/feed/:tab", ["feed", ":tab"], feedModal),
      ]);

      // A Route Handler descendant falls back to the slot owner (index 0).
      expect(matcher.findIntercept("/hidden", "/feed/admin")).toMatchObject({
        sourceRouteIsConcrete: false,
        sourceRouteIndex: 0,
      });
      // A lazy Route Handler is classified the same before its first load.
      const lazyMatcher = createAppRscRouteMatcher([
        route("/feed", ["feed"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/feed",
                targetPattern: "/hidden",
                interceptLayouts: ["layout"],
                page: "modal-hidden",
                params: [],
              },
            ],
          },
        }),
        { ...route("/feed/admin", ["feed", "admin"]), __loadRouteHandler: async () => ({}) },
      ]);
      expect(lazyMatcher.findIntercept("/hidden", "/feed/admin")).toMatchObject({
        sourceRouteIndex: 0,
      });
      // Page descendants still resolve concretely, preserving their params.
      expect(matcher.findIntercept("/hidden", "/feed/recent")).toMatchObject({
        sourceRouteIsConcrete: true,
        sourceRouteIndex: 2,
        sourceMatchedParams: { tab: "recent" },
      });
    });

    it.each([
      {
        ownerPattern: "/feed",
        ownerParts: ["feed"],
        sourcePathname: "/feed",
        targetPattern: "/feed/hidden",
        targetPathname: "/feed/hidden",
      },
      {
        ownerPattern: "/:locale/feed",
        ownerParts: [":locale", "feed"],
        sourcePathname: "/en/feed",
        targetPattern: "/:locale/feed/hidden",
        targetPathname: "/en/feed/hidden",
      },
      {
        ownerPattern: "/docs/:slug+",
        ownerParts: ["docs", ":slug+"],
        sourcePathname: "/docs/a/b",
        targetPattern: "/hidden",
        targetPathname: "/hidden",
      },
      {
        ownerPattern: "/:locale*",
        ownerParts: [":locale*"],
        sourcePathname: "/en/us",
        targetPattern: "/hidden",
        targetPathname: "/hidden",
      },
    ])(
      "never promotes a Route Handler slot owner for $ownerPattern",
      ({ ownerParts, ownerPattern, sourcePathname, targetPathname, targetPattern }) => {
        // The route graph retains parallel slots discovered beside `route.ts`.
        // Next.js accepts this filesystem shape and rewrites the intercepted
        // target to the modal page; it never executes the owning handler.
        // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.ts
        const matcher = createAppRscRouteMatcher([
          {
            ...route(ownerPattern, ownerParts, {
              modal: {
                intercepts: [
                  {
                    sourceMatchPattern: ownerPattern,
                    targetPattern,
                    interceptLayouts: ["layout"],
                    page: "modal-page",
                    params: [],
                  },
                ],
              },
            }),
            __loadRouteHandler: async () => ({}),
          },
        ]);

        expect(matcher.findIntercept(targetPathname, sourcePathname)).toBeNull();
      },
    );

    it("keeps the slot owner's dynamic params when falling back from a descendant", () => {
      // The slot owner is what renders once a descendant source is rejected, and
      // `matchInterceptRoute` reads the promoted route's params solely from
      // `sourceMatchedParams`. An exact pattern match against the owner cannot
      // succeed here — the approved source carries extra segments by definition —
      // so the owner's params come from the prefix the source gate already
      // approved. Otherwise `/:locale/feed` would render with no `locale`.
      const matcher = createAppRscRouteMatcher([
        route("/:locale/feed", [":locale", "feed"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/:locale/feed",
                targetPattern: "/:locale/hidden",
                interceptLayouts: ["layout"],
                page: "modal-hidden",
                params: ["locale"],
              },
            ],
          },
        }),
        { ...route("/:locale/feed/admin", [":locale", "feed", "admin"]), routeHandler: {} },
      ]);

      expect(matcher.findIntercept("/en/hidden", "/en/feed/admin")).toMatchObject({
        sourceRouteIsConcrete: false,
        sourceRouteIndex: 0,
        sourceMatchedParams: { locale: "en" },
      });
      // A descendant with no concrete route at all takes the same fallback.
      expect(matcher.findIntercept("/en/hidden", "/en/feed/unknown/deep")).toMatchObject({
        sourceRouteIsConcrete: false,
        sourceRouteIndex: 0,
        sourceMatchedParams: { locale: "en" },
      });
      // An exact source still matches the owner directly.
      expect(matcher.findIntercept("/en/hidden", "/en/feed")).toMatchObject({
        sourceRouteIsConcrete: true,
        sourceRouteIndex: 0,
        sourceMatchedParams: { locale: "en" },
      });
    });

    it("treats a sourceMatchPattern of `/` as matching any source", () => {
      // Slot at root (`/@modal/(.)groups/[id]/new`) yields intercepting route `/`,
      // which Next.js implements as `^/.*$` — i.e. any source.
      const matcher = createAppRscRouteMatcher([
        route("/", [], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/",
                targetPattern: "/groups/:id/new",
                interceptLayouts: ["layout"],
                page: "modal-new",
                params: ["id"],
              },
            ],
          },
        }),
      ]);

      expect(matcher.findIntercept("/groups/123/new", "/")).not.toBeNull();
      expect(matcher.findIntercept("/groups/123/new", "/groups/123")).not.toBeNull();
      expect(matcher.findIntercept("/groups/123/new", "/anything/else/deep")).not.toBeNull();
      // But still must require a source pathname (Next-URL header) to fire.
      expect(matcher.findIntercept("/groups/123/new", null)).toBeNull();
    });

    it("findIntercept matches sibling intercept on soft-nav and misses on hard-nav", () => {
      const routes: TestRoute[] = [
        {
          ids: { route: "graph-route:/foo/bar" },
          pattern: "/foo/bar",
          patternParts: ["foo", "bar"],
          siblingIntercepts: [
            {
              targetPattern: "/hoge",
              sourceMatchPattern: "/foo/bar",
              sourcePageSegments: ["foo", "bar", "(..)(..)hoge"],
              slotId: "slot:__vinext_sibling_intercept:/foo/bar",
              interceptLayouts: [{ default: () => null }],
              interceptLayoutSegments: [["[photo]"]],
              interceptBranchSegments: ["[photo]", "[comment]"],
              page: { default: () => null },
              params: [],
            },
          ],
        },
        {
          ids: { route: "graph-route:/hoge" },
          pattern: "/hoge",
          patternParts: ["hoge"],
        },
      ];
      const matcher = createAppRscRouteMatcher(routes as any);

      // Soft-nav from /foo/bar: should match
      const hit = matcher.findIntercept("/hoge", "/foo/bar");
      expect(hit).not.toBeNull();
      expect(hit?.slotKey).toBe(SIBLING_PAGE_INTERCEPT_SLOT_KEY);
      expect(hit?.sourcePageSegments).toEqual(["foo", "bar", "(..)(..)hoge"]);
      expect(hit?.interceptLayoutSegments).toEqual([["[photo]"]]);
      expect(hit?.interceptBranchSegments).toEqual(["[photo]", "[comment]"]);
      expect(hit?.targetRouteGraphId).toBe("graph-route:/hoge");

      // Hard-nav (no source): must return null
      expect(matcher.findIntercept("/hoge", null)).toBeNull();

      // Wrong source: must return null
      expect(matcher.findIntercept("/hoge", "/other")).toBeNull();
    });

    it("renders a sibling intercept's owner route from a deeper source", () => {
      // Next.js rewrites a sibling interception to the fixed intercepting route,
      // shots/(.)[id], so a source like /shots/1 never lends it its own route.
      // The handler still authorizes the source the context names.
      const matcher = createAppRscRouteMatcher([
        {
          ids: { route: "graph-route:/shots" },
          pattern: "/shots",
          patternParts: ["shots"],
          routeSegments: ["shots"],
          siblingIntercepts: [
            {
              targetPattern: "/shots/:id",
              sourceMatchPattern: "/shots",
              sourcePageSegments: ["shots", "(.)[id]"],
              slotId: "slot:__vinext_sibling_intercept:/shots",
              interceptLayouts: [],
              page: "shot-modal",
              params: ["id"],
            },
          ],
        },
        {
          ids: { route: "graph-route:/shots/:id" },
          pattern: "/shots/:id",
          patternParts: ["shots", ":id"],
          routeSegments: ["shots", "[id]"],
        },
      ] as any);

      expect(matcher.findIntercept("/shots/2", "/shots")).toMatchObject({
        authorizationSourceParams: {},
        authorizationSourceRouteIndex: 0,
        matchedParams: { id: "2" },
        sourceMatchedParams: {},
        sourceRouteIndex: 0,
        sourceRouteIsConcrete: true,
      });
      expect(matcher.findIntercept("/shots/2", "/shots/1")).toMatchObject({
        authorizationSourceParams: { id: "1" },
        authorizationSourceRouteIndex: 1,
        // A sibling intercept renders its whole source route.
        rendersTargetLayouts: false,
        matchedParams: { id: "2" },
        sourceMatchedParams: {},
        sourceRouteIndex: 0,
        sourceRouteIsConcrete: true,
      });
    });

    it("keeps a deeper source's route for a sibling intercept whose owner is a stand-in", () => {
      // gallery/(.)photo has no gallery page, so the graph picks another route
      // under gallery/ to carry it. That route is not the intercepting route,
      // so a concrete source renders as before.
      const matcher = createAppRscRouteMatcher([
        {
          ids: { route: "graph-route:/gallery/list" },
          pattern: "/gallery/list",
          patternParts: ["gallery", "list"],
          routeSegments: ["gallery", "list"],
          siblingIntercepts: [
            {
              targetPattern: "/gallery/photo/:id",
              sourceMatchPattern: "/gallery",
              sourcePageSegments: ["gallery", "(.)photo", "[id]"],
              slotId: "slot:__vinext_sibling_intercept:/gallery/list",
              interceptLayouts: [],
              page: "photo-modal",
              params: ["id"],
            },
          ],
        },
        {
          ids: { route: "graph-route:/gallery/photo/:id" },
          pattern: "/gallery/photo/:id",
          patternParts: ["gallery", "photo", ":id"],
          routeSegments: ["gallery", "photo", "[id]"],
        },
      ] as any);

      expect(matcher.findIntercept("/gallery/photo/2", "/gallery/photo/1")).toMatchObject({
        authorizationSourceRouteIndex: 1,
        sourceMatchedParams: { id: "1" },
        sourceRouteIndex: 1,
        // The source's own route renders, under the target's request.
        rendersTargetLayouts: false,
      });
    });

    it("never renders a Route Handler owner for a sibling intercept", () => {
      // app/shots/route.ts owns shots/(.)[id], which has no page beside it.
      const matcher = createAppRscRouteMatcher([
        {
          pattern: "/shots",
          patternParts: ["shots"],
          routeHandler: { GET() {} },
          routeSegments: ["shots"],
          siblingIntercepts: [
            {
              targetPattern: "/shots/:id",
              sourceMatchPattern: "/shots",
              sourcePageSegments: ["shots", "(.)[id]"],
              slotId: "slot:__vinext_sibling_intercept:/shots",
              interceptLayouts: [],
              page: "shot-modal",
              params: ["id"],
            },
          ],
        },
        {
          pattern: "/shots/:id",
          patternParts: ["shots", ":id"],
          routeSegments: ["shots", "[id]"],
        },
      ] as any);

      expect(matcher.findIntercept("/shots/2", "/shots/1")).toMatchObject({
        authorizationSourceRouteIndex: 1,
        sourceRouteIndex: 1,
      });
    });

    it("resolves intercepted graph identities across different parameter names", () => {
      // Ported from Next.js: packages/next/src/build/validate-app-paths.test.ts
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/validate-app-paths.test.ts
      const routes: TestRoute[] = [
        {
          ids: { route: "graph-route:/feed" },
          pattern: "/feed",
          patternParts: ["feed"],
          slots: {
            modal: {
              intercepts: [
                {
                  sourceMatchPattern: "/feed",
                  targetPattern: "/blog/:slug/post",
                  interceptLayouts: ["layout"],
                  page: "modal-post",
                  params: ["slug"],
                },
                {
                  sourceMatchPattern: "/feed",
                  targetPattern: "/files/:path+",
                  interceptLayouts: ["layout"],
                  page: "modal-file",
                  params: ["path"],
                },
              ],
            },
          },
        },
        {
          ids: { route: "graph-route:/blog/:id/post" },
          pattern: "/blog/:id/post",
          patternParts: ["blog", ":id", "post"],
        },
        {
          ids: { route: "graph-route:/files/:segments+" },
          pattern: "/files/:segments+",
          patternParts: ["files", ":segments+"],
        },
      ];
      const matcher = createAppRscRouteMatcher(routes as any);

      expect(matcher.findIntercept("/blog/value/post", "/feed")?.targetRouteGraphId).toBe(
        "graph-route:/blog/:id/post",
      );
      expect(matcher.findIntercept("/files/a/b", "/feed")?.targetRouteGraphId).toBe(
        "graph-route:/files/:segments+",
      );
    });

    it("carries sibling interception identity when the direct target uses a broader catch-all", () => {
      // Ported from Next.js: test/e2e/app-dir/interception-routes-multiple-catchall
      // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-routes-multiple-catchall/interception-routes-multiple-catchall.test.ts
      const interceptionGraphId =
        "interception:slot:__vinext_sibling_intercept:/templates:/templates->/showcase/:catchAll+";
      const matcher = createAppRscRouteMatcher([
        {
          ids: { route: "graph-route:/templates/:source+" },
          pattern: "/templates/:source+",
          patternParts: ["templates", ":source+"],
          siblingIntercepts: [
            {
              id: interceptionGraphId,
              targetPattern: "/showcase/:catchAll+",
              sourceMatchPattern: "/templates",
              sourcePageSegments: ["templates", "(..)showcase", "[...catchAll]"],
              slotId: "slot:__vinext_sibling_intercept:/templates",
              interceptLayouts: [],
              page: "intercept-page",
              params: ["catchAll"],
            },
          ],
        },
        {
          ids: { route: "graph-route:/:catchAll+" },
          pattern: "/:catchAll+",
          patternParts: [":catchAll+"],
        },
      ] as any);

      const hit = matcher.findIntercept("/showcase/single", "/templates/multi/slug");
      expect(hit?.targetRouteGraphId).toBeNull();
      expect(hit?.interceptionGraphId).toBe(interceptionGraphId);
    });

    it("matches dynamic segments in the intercepting route pattern", () => {
      // /[lang]/foo/(..)photos has interceptingRoute `/[lang]/foo`,
      // header regex `^/(?<lang>[^/]+)/foo(?:/.*)?$`.
      const matcher = createAppRscRouteMatcher([
        route("/:lang/foo", [":lang", "foo"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/:lang/foo",
                targetPattern: "/:lang/photos",
                interceptLayouts: ["layout"],
                page: "modal-photos",
                params: ["lang"],
              },
            ],
          },
        }),
      ]);

      expect(matcher.findIntercept("/en/photos", "/en/foo")).not.toBeNull();
      expect(matcher.findIntercept("/en/photos", "/en/foo/bar")).not.toBeNull();
      // Wrong dynamic value — still a descendant in URL terms but the
      // intercepting route requires `/<lang>/foo`, so `/en/bar` should fail.
      expect(matcher.findIntercept("/en/photos", "/en/bar")).toBeNull();
      expect(matcher.findIntercept("/en/photos", "/en")).toBeNull();
    });
  });
});

function route(
  pattern: string,
  patternParts: string[],
  slots?: Record<string, { id?: string; intercepts?: TestIntercept[] }>,
): TestRoute {
  return {
    pattern,
    patternParts,
    slots,
  };
}

type TestSiblingIntercept = {
  targetPattern: string;
  sourceMatchPattern: string | null;
  sourcePageSegments?: readonly string[];
  slotId: string | null;
  interceptLayouts: readonly unknown[];
  interceptLayoutSegments?: readonly (readonly string[])[];
  interceptBranchSegments?: readonly string[];
  page: unknown;
  params: string[];
};

type TestRoute = {
  __loadRouteHandler?: unknown;
  ids?: { route: string };
  pattern: string;
  patternParts: string[];
  routeHandler?: unknown;
  routeSegments?: string[];
  slots?: Record<string, { id?: string; intercepts?: TestIntercept[] }>;
  siblingIntercepts?: TestSiblingIntercept[];
};

type TestIntercept = {
  targetPattern: string;
  /**
   * URL pattern of the intercepting route (the path that owns the slot,
   * with route groups and `@slot` segments stripped). Mirrors Next.js'
   * `interceptingRoute` from `extractInterceptionRouteInformation` and is
   * used to gate `findIntercept` against the Next-URL header.
   */
  sourceMatchPattern?: string;
  sourcePageSegments?: readonly string[];
  interceptLayouts: readonly unknown[];
  interceptLayoutSegments?: readonly (readonly string[])[];
  interceptBranchSegments?: readonly string[];
  __loadInterceptLayouts?: readonly (() => Promise<unknown>)[];
  page: unknown;
  __pageLoader?: () => Promise<unknown>;
  params: string[];
};
