import { describe, expect, it } from "vite-plus/test";
import {
  buildFontOwnerManifest,
  fontRouteFiles,
} from "../packages/vinext/src/build/font-owner-manifest.js";

// Issue #4810: the route font manifest lists, for each App Router route, the
// modules whose fonts its render carries, like Next.js' next-font-manifest.
describe("buildFontOwnerManifest", () => {
  const owners = new Set([
    "/app/a/fonts.ts",
    "/app/b/client.tsx",
    "/app/c/lazy.ts",
    "/app/fonts.ts",
    "/app/@modal/(.)photo/page.tsx",
  ]);
  const files = (...paths: string[]) => ({ files: paths, interceptFiles: [] as string[] });
  const build = (overrides: Partial<Parameters<typeof buildFontOwnerManifest>[0]> = {}) =>
    buildFontOwnerManifest({
      rsc: new Map([
        ["/app/layout.tsx", []],
        ["/app/a/layout.tsx", ["/app/a/fonts.ts", "/app/shared.ts"]],
        ["/app/a/page.tsx", []],
        ["/app/a/fonts.ts", []],
        // Reached only through a client reference's RSC proxy: not this route's.
        ["/app/b/page.tsx", ["/app/b/client.tsx"]],
        ["/app/b/client.tsx", ["/app/fonts.ts"]],
        ["/app/c/page.tsx", ["/app/c/lazy.ts"]],
        ["/app/c/lazy.ts", []],
        ["/app/fonts.ts", []],
        ["/app/shared.ts", []],
      ]),
      ssr: new Map([
        ["/app/b/client.tsx", ["/app/b/button.tsx"]],
        ["/app/b/button.tsx", ["/app/b/client.tsx"]],
      ]),
      clientReferences: new Map([["/app/b/client.tsx", "/app/b/client.tsx"]]),
      isOwner: (id) => owners.has(id),
      ownerKey: (id) => id.slice(1),
      routes: new Map([
        ["/a", files("/app/a/page.tsx", "/app/a/layout.tsx", "/app/layout.tsx")],
        ["/b", files("/app/b/page.tsx", "/app/layout.tsx")],
        ["/c", files("/app/c/page.tsx", "/app/layout.tsx")],
        ["/empty", files("/app/layout.tsx")],
      ]),
      routelessFiles: ["/app/layout.tsx"],
      globalNotFoundFiles: [],
      ...overrides,
    });

  it("lists the owners each route's files reach", () => {
    expect(build()).toEqual({
      routes: {
        "/a": ["app/a/fonts.ts"],
        // A client reference's fonts load in its SSR graph, cycles included.
        "/b": ["app/b/client.tsx"],
        "/c": ["app/c/lazy.ts"],
      },
      routeless: [],
      globalNotFound: [],
      // The browser loads a client component's fonts itself, so the payload
      // carries only server modules' fonts.
      navigation: {
        "/a": { route: ["app/a/fonts.ts"] },
        "/c": { route: ["app/c/lazy.ts"] },
      },
    });
  });

  it("gives every route the owners of a file they share", () => {
    const manifest = build({
      rsc: new Map([
        ["/app/layout.tsx", ["/app/fonts.ts"]],
        ["/app/a/page.tsx", []],
        ["/app/fonts.ts", []],
      ]),
      ssr: new Map(),
      clientReferences: new Map(),
      routes: new Map([
        ["/a", files("/app/a/page.tsx", "/app/layout.tsx")],
        ["/", files("/app/layout.tsx")],
      ]),
    });
    expect(manifest.routes).toEqual({ "/a": ["app/fonts.ts"], "/": ["app/fonts.ts"] });
    expect(manifest.routeless).toEqual(["app/fonts.ts"]);
    expect(manifest.globalNotFound).toEqual([]);
  });

  it("reads a client reference that is itself a route file from the SSR graph", () => {
    const manifest = build({
      rsc: new Map([["/app/b/client.tsx", []]]),
      ssr: new Map([["/app/b/client.tsx", []]]),
      routes: new Map([["/b", files("/app/b/client.tsx")]]),
      routelessFiles: [],
    });
    expect(manifest.routes).toEqual({ "/b": ["app/b/client.tsx"] });
    expect(manifest.navigation).toEqual({});
  });

  it("keeps an intercepting route's fonts out of the documents but in the payload", () => {
    const manifest = build({
      rsc: new Map([
        ["/app/layout.tsx", []],
        ["/app/page.tsx", []],
        ["/app/@modal/(.)photo/page.tsx", []],
      ]),
      ssr: new Map(),
      clientReferences: new Map(),
      routes: new Map([
        [
          "/",
          {
            files: ["/app/page.tsx", "/app/layout.tsx"],
            interceptFiles: ["/app/@modal/(.)photo/page.tsx"],
          },
        ],
      ]),
    });
    expect(manifest.routes).toEqual({});
    expect(manifest.navigation).toEqual({
      "/": { intercepts: ["app/@modal/(.)photo/page.tsx"] },
    });
  });

  it("gives the standalone global-not-found render only its own fonts", () => {
    const manifest = build({
      rsc: new Map([
        ["/app/layout.tsx", ["/app/fonts.ts"]],
        ["/app/global-not-found.tsx", ["/app/a/fonts.ts"]],
        ["/app/fonts.ts", []],
        ["/app/a/fonts.ts", []],
      ]),
      ssr: new Map(),
      clientReferences: new Map(),
      routes: new Map(),
      globalNotFoundFiles: ["/app/global-not-found.tsx"],
    });
    expect(manifest.routeless).toEqual(["app/fonts.ts"]);
    expect(manifest.globalNotFound).toEqual(["app/a/fonts.ts"]);
  });
});

describe("fontRouteFiles", () => {
  const slot = (name: string, pagePath: string | null) => ({
    defaultPath: `/app/@${name}/default.tsx`,
    errorPath: null,
    hasPage: pagePath !== null,
    interceptingRoutes: [
      {
        convention: ".",
        layoutPaths: [],
        notFoundPath: null,
        pagePath: `/app/@${name}/(.)item/page.tsx`,
        params: [],
        sourceMatchPattern: "/",
        targetPattern: "/item",
      },
    ],
    key: `${name}:/app/@${name}`,
    layoutIndex: 0,
    layoutPath: `/app/@${name}/layout.tsx`,
    loadingPath: null,
    name,
    notFoundPath: null,
    ownerDir: "/app",
    ownerTreePath: "/app",
    pagePath,
    routeSegments: [],
  });

  // A slot renders its page when it has one, and its default only otherwise.
  it("takes a slot's default, without its layout, only when the slot has no page", () => {
    const files = fontRouteFiles({
      errorPath: null,
      layouts: ["/app/layout.tsx"],
      loadingPath: null,
      notFoundPath: null,
      pagePath: "/app/page.tsx",
      parallelSlots: [slot("modal", "/app/@modal/page.tsx"), slot("side", null)],
      pattern: "/",
      siblingIntercepts: [],
      templates: [],
    } as unknown as Parameters<typeof fontRouteFiles>[0]);
    expect(files).toContain("/app/@modal/page.tsx");
    expect(files).not.toContain("/app/@modal/default.tsx");
    expect(files).toContain("/app/@side/default.tsx");
    // The slot's layout wraps its page, never its default.
    expect(files).toContain("/app/@modal/layout.tsx");
    expect(files).not.toContain("/app/@side/layout.tsx");
    expect(files.some((file) => file.includes("(.)item"))).toBe(false);
  });
});
