import { describe, it, expect } from "vite-plus/test";
import {
  buildPagesDataPath,
  buildPagesDataHref,
  matchPagesPattern,
} from "../packages/vinext/src/shims/internal/pages-data-url.js";
import { parseNextDataPathname } from "../packages/vinext/src/server/pages-data-route.js";

describe("pages-data-url (client-side)", () => {
  const BUILD_ID = "abc123";

  describe("buildPagesDataPath", () => {
    it("encodes the root pathname as /index.json", () => {
      expect(buildPagesDataPath(BUILD_ID, "/")).toBe(`/_next/data/${BUILD_ID}/index.json`);
    });

    it("encodes a flat path", () => {
      expect(buildPagesDataPath(BUILD_ID, "/about")).toBe(`/_next/data/${BUILD_ID}/about.json`);
    });

    it("encodes a nested path", () => {
      expect(buildPagesDataPath(BUILD_ID, "/blog/foo")).toBe(
        `/_next/data/${BUILD_ID}/blog/foo.json`,
      );
    });

    it("disambiguates an explicit /index page from the root", () => {
      // Next.js denormalisation: `pages/index/index.tsx` would resolve to
      // `/index`. The data URL must distinguish this from `/`, so the asset
      // path becomes `/index/index.json`.
      expect(buildPagesDataPath(BUILD_ID, "/index")).toBe(
        `/_next/data/${BUILD_ID}/index/index.json`,
      );
    });

    it("disambiguates an /index/foo page from /foo", () => {
      // Matches Next.js' getAssetPathFromRoute: any path starting with
      // `/index` (`/index/...` or exactly `/index`) gets a second `/index`
      // prepended so it round-trips through the data URL parser.
      expect(buildPagesDataPath(BUILD_ID, "/index/foo")).toBe(
        `/_next/data/${BUILD_ID}/index/index/foo.json`,
      );
    });

    it("strips trailing slash before appending .json", () => {
      expect(buildPagesDataPath(BUILD_ID, "/about/")).toBe(`/_next/data/${BUILD_ID}/about.json`);
    });

    it("preserves locale prefix (callers are responsible for adding it)", () => {
      expect(buildPagesDataPath(BUILD_ID, "/en/about")).toBe(
        `/_next/data/${BUILD_ID}/en/about.json`,
      );
    });
  });

  describe("buildPagesDataHref", () => {
    it("includes the basePath prefix", () => {
      expect(buildPagesDataHref("/app", BUILD_ID, "/about", "")).toBe(
        `/app/_next/data/${BUILD_ID}/about.json`,
      );
    });

    it("omits the basePath prefix when empty", () => {
      expect(buildPagesDataHref("", BUILD_ID, "/about", "")).toBe(
        `/_next/data/${BUILD_ID}/about.json`,
      );
    });

    it("appends the search string verbatim", () => {
      expect(buildPagesDataHref("", BUILD_ID, "/about", "?a=1&b=2")).toBe(
        `/_next/data/${BUILD_ID}/about.json?a=1&b=2`,
      );
    });

    it("appends the search string for the root page", () => {
      expect(buildPagesDataHref("", BUILD_ID, "/", "?ref=home")).toBe(
        `/_next/data/${BUILD_ID}/index.json?ref=home`,
      );
    });
  });

  describe("round-trip with parseNextDataPathname", () => {
    // The server's parseNextDataPathname must agree with the client's
    // buildPagesDataPath for every shape the client can produce. This is the
    // wire-format contract between client navigation and the data endpoint.
    const cases = ["/", "/about", "/blog/foo", "/en/about", "/blog/post-1/comments"];

    for (const path of cases) {
      it(`parses ${path} back to itself`, () => {
        const built = buildPagesDataPath(BUILD_ID, path);
        const parsed = parseNextDataPathname(built, BUILD_ID);
        expect(parsed).not.toBeNull();
        expect(parsed?.pagePathname).toBe(path);
      });
    }

    it("round-trips /index by encoding as /index/index.json", () => {
      const built = buildPagesDataPath(BUILD_ID, "/index");
      expect(built).toBe(`/_next/data/${BUILD_ID}/index/index.json`);
      // Parser denormalises trailing `/index` back to the parent directory
      // (the `endsWith("/index")` branch in pages-data-route.ts).
      const parsed = parseNextDataPathname(built, BUILD_ID);
      expect(parsed?.pagePathname).toBe("/index");
    });

    it("round-trips /index/foo through both helpers", () => {
      const built = buildPagesDataPath(BUILD_ID, "/index/foo");
      expect(built).toBe(`/_next/data/${BUILD_ID}/index/index/foo.json`);
      const parsed = parseNextDataPathname(built, BUILD_ID);
      expect(parsed?.pagePathname).toBe("/index/foo");
    });
  });

  describe("matchPagesPattern", () => {
    it("matches a literal pattern", () => {
      expect(matchPagesPattern("/about", ["/about", "/contact"])).toEqual({
        pattern: "/about",
        params: {},
      });
    });

    it("matches a single dynamic segment", () => {
      expect(matchPagesPattern("/posts/42", ["/posts/[id]"])).toEqual({
        pattern: "/posts/[id]",
        params: { id: "42" },
      });
    });

    it("matches a catch-all segment", () => {
      expect(matchPagesPattern("/docs/intro/getting-started", ["/docs/[...slug]"])).toEqual({
        pattern: "/docs/[...slug]",
        params: { slug: ["intro", "getting-started"] },
      });
    });

    it("matches an optional catch-all with no segments at the root", () => {
      expect(matchPagesPattern("/shop", ["/shop/[[...path]]"])).toEqual({
        pattern: "/shop/[[...path]]",
        params: {},
      });
    });

    it("returns null when no pattern matches", () => {
      expect(matchPagesPattern("/unknown", ["/about", "/posts/[id]"])).toBeNull();
    });

    it("prefers earlier patterns when multiple could match", () => {
      // Patterns array is ordered by the caller; this test confirms the
      // function honours that order (does not re-sort internally).
      expect(matchPagesPattern("/posts/42", ["/posts/[id]", "/posts/[...rest]"])).toEqual({
        pattern: "/posts/[id]",
        params: { id: "42" },
      });
    });

    it("matches the root path", () => {
      expect(matchPagesPattern("/", ["/"])).toEqual({ pattern: "/", params: {} });
    });
  });
});
