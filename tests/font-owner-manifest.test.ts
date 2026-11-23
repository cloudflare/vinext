import { describe, expect, it } from "vite-plus/test";
import { buildFontOwnerManifest } from "../packages/vinext/src/build/font-owner-manifest.js";

// Issue #4810: the route font manifest lists, for each App Router route, the
// modules whose fonts its render carries, like Next.js' next-font-manifest.
describe("buildFontOwnerManifest", () => {
  const owners = new Set([
    "/app/a/fonts.ts",
    "/app/b/client.tsx",
    "/app/c/lazy.ts",
    "/app/fonts.ts",
  ]);
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
        ["/a", ["/app/a/page.tsx", "/app/a/layout.tsx", "/app/layout.tsx"]],
        ["/b", ["/app/b/page.tsx", "/app/layout.tsx"]],
        ["/c", ["/app/c/page.tsx", "/app/layout.tsx"]],
        ["/empty", ["/app/layout.tsx"]],
      ]),
      routelessFiles: ["/app/layout.tsx"],
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
        ["/a", ["/app/a/page.tsx", "/app/layout.tsx"]],
        ["/", ["/app/layout.tsx"]],
      ]),
    });
    expect(manifest).toEqual({
      routes: { "/a": ["app/fonts.ts"], "/": ["app/fonts.ts"] },
      routeless: ["app/fonts.ts"],
    });
  });

  it("reads a client reference that is itself a route file from the SSR graph", () => {
    const manifest = build({
      rsc: new Map([["/app/b/client.tsx", []]]),
      ssr: new Map([["/app/b/client.tsx", []]]),
      routes: new Map([["/b", ["/app/b/client.tsx"]]]),
      routelessFiles: [],
    });
    expect(manifest.routes).toEqual({ "/b": ["app/b/client.tsx"] });
  });
});
