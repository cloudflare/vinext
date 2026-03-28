/**
 * Route sorting and validation tests — unique cases NOT covered by routing.test.ts.
 *
 * Mirrors test cases from Next.js test/unit/page-route-sorter.test.ts,
 * adapted for vinext's route format (colon params instead of bracket params).
 *
 * Tests that dynamic sorts before catch-all, deterministic ordering,
 * static-over-dynamic preference, patternToNextFormat conversion,
 * App Router route type discovery, and API route sorting.
 *
 * NOTE: Basic matchRoute/matchAppRoute edge cases (root, static, dynamic param
 * extraction, query stripping, trailing slash, catch-all, @slot filtering) are
 * tested in routing.test.ts — not duplicated here.
 */
import { describe, it, expect } from "vite-plus/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  pagesRouter,
  matchRoute,
  apiRouter,
  patternToNextFormat,
  invalidateRouteCache,
} from "../packages/vinext/src/routing/pages-router.js";
import { appRouter, invalidateAppRouteCache } from "../packages/vinext/src/routing/app-router.js";
import { validateRoutePatterns } from "../packages/vinext/src/routing/route-validation.js";

const PAGES_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-basic/pages");
const APP_DIR = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ─── Pages Router sorting (mirrors Next.js page-route-sorter.test.ts) ───

describe("Pages Router route sorting", () => {
  it("dynamic routes come before catch-all routes", async () => {
    const routes = await pagesRouter(PAGES_DIR);
    const patterns = routes.map((r) => r.pattern);

    // Find positions of dynamic params vs catch-all
    const dynamicIdx = patterns.findIndex(
      (p) => p.includes(":") && !p.includes("+") && !p.includes("*"),
    );
    const catchAllIdx = patterns.findIndex((p) => p.includes("+"));

    if (dynamicIdx !== -1 && catchAllIdx !== -1) {
      expect(dynamicIdx).toBeLessThan(catchAllIdx);
    }
  });

  it("sorts deterministically (alphabetic tiebreaker)", async () => {
    const routes1 = await pagesRouter(PAGES_DIR);
    const routes2 = await pagesRouter(PAGES_DIR);
    expect(routes1.map((r) => r.pattern)).toEqual(routes2.map((r) => r.pattern));
  });

  it("rejects sibling dynamic routes that differ only by param name", async () => {
    // Ported from Next.js: test/unit/page-route-sorter.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/unit/page-route-sorter.test.ts
    const tmpRoot = await makeTempDir("vinext-pages-dynamic-conflict-");
    const pagesDir = path.join(tmpRoot, "pages");

    try {
      await fs.mkdir(path.join(pagesDir, "posts"), { recursive: true });
      await fs.writeFile(
        path.join(pagesDir, "posts", "[id].tsx"),
        "export default function Page() { return null; }",
      );
      await fs.writeFile(
        path.join(pagesDir, "posts", "[slug].tsx"),
        "export default function Page() { return null; }",
      );

      invalidateRouteCache(pagesDir);
      await expect(pagesRouter(pagesDir)).rejects.toThrow(/different slug names/);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateRouteCache(pagesDir);
    }
  });

  it("rejects sibling dynamic API routes that differ only by param name", async () => {
    const tmpRoot = await makeTempDir("vinext-api-dynamic-conflict-");
    const pagesDir = path.join(tmpRoot, "pages");

    try {
      await fs.mkdir(path.join(pagesDir, "api", "posts"), { recursive: true });
      await fs.writeFile(
        path.join(pagesDir, "api", "posts", "[id].ts"),
        "export default function handler() {}",
      );
      await fs.writeFile(
        path.join(pagesDir, "api", "posts", "[slug].ts"),
        "export default function handler() {}",
      );

      invalidateRouteCache(pagesDir);
      await expect(apiRouter(pagesDir)).rejects.toThrow(/different slug names/);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateRouteCache(pagesDir);
    }
  });
});

// ─── Pages Router matchRoute — unique edge cases ────────────────────────

describe("Pages Router matchRoute (additional)", () => {
  it("prefers static over dynamic match", async () => {
    const routes = await pagesRouter(PAGES_DIR);
    // If there's both /about (static) and /:slug (dynamic)
    const result = matchRoute("/about", routes);
    expect(result).not.toBeNull();
    expect(result!.route.isDynamic).toBe(false);
  });
});

// ─── patternToNextFormat ────────────────────────────────────────────────

describe("patternToNextFormat", () => {
  it("converts dynamic :id to [id]", () => {
    expect(patternToNextFormat("/posts/:id")).toBe("/posts/[id]");
  });

  it("converts catch-all :slug+ to [...slug]", () => {
    expect(patternToNextFormat("/docs/:slug+")).toBe("/docs/[...slug]");
  });

  it("converts optional catch-all :slug* to [[...slug]]", () => {
    expect(patternToNextFormat("/:slug*")).toBe("/[[...slug]]");
  });

  it("handles multiple dynamic segments", () => {
    expect(patternToNextFormat("/:category/:id")).toBe("/[category]/[id]");
  });

  it("preserves static segments", () => {
    expect(patternToNextFormat("/about")).toBe("/about");
    expect(patternToNextFormat("/")).toBe("/");
  });

  it("handles mixed static and dynamic", () => {
    expect(patternToNextFormat("/blog/:year/:month/:slug")).toBe("/blog/[year]/[month]/[slug]");
  });

  it("converts hyphenated dynamic :auth-method to [auth-method]", () => {
    expect(patternToNextFormat("/auth/:auth-method")).toBe("/auth/[auth-method]");
  });

  it("converts hyphenated catch-all :sign-in+ to [...sign-in]", () => {
    expect(patternToNextFormat("/login/:sign-in+")).toBe("/login/[...sign-in]");
  });

  it("converts hyphenated optional catch-all :sign-up* to [[...sign-up]]", () => {
    expect(patternToNextFormat("/register/:sign-up*")).toBe("/register/[[...sign-up]]");
  });
});

describe("validateRoutePatterns", () => {
  // Ported from Next.js: test/unit/page-route-sorter.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/unit/page-route-sorter.test.ts
  it("accepts representative valid route sets", () => {
    expect(() =>
      validateRoutePatterns([
        "/posts",
        "/:root-slug",
        "/",
        "/posts/:id",
        "/blog/:id/comments/:cid",
        "/blog/abc/:id",
        "/:rest+",
        "/blog/abc/post",
        "/blog/abc",
        "/p1/:incl*",
        "/p/:rest+",
        "/p2/:rest+",
        "/p2/:id",
        "/p2/:id/abc",
        "/p3/:rest*",
        "/p3/:id",
        "/p3/:id/abc",
        "/blog/:id",
        "/foo/:d/bar/baz/:f",
        "/apples/:ab/:cd/ef",
      ]),
    ).not.toThrow();
  });

  it("rejects mismatched param names at the same segment level", () => {
    expect(() =>
      validateRoutePatterns(["/", "/blog", "/blog/:id", "/blog/:id/comments/:cid", "/blog/:cid"]),
    ).toThrow(/different slug names/);
  });

  it("rejects reused param names in a single dynamic path", () => {
    expect(() =>
      validateRoutePatterns(["/", "/blog", "/blog/:id/comments/:id", "/blog/:id"]),
    ).toThrow(/the same slug name/);
  });

  it("rejects reused param names when a catch-all repeats the slug", () => {
    expect(() => validateRoutePatterns(["/blog/:id", "/blog/:id/:id+"])).toThrow(
      /the same slug name/,
    );
  });

  it("rejects catch-all segments that are not the final segment", () => {
    expect(() => validateRoutePatterns(["/blog/[...id]/[...id2]"])).toThrow(
      /Catch-all must be the last part of the URL/,
    );
    expect(() => validateRoutePatterns(["/blog/[...id]/abc"])).toThrow(
      /Catch-all must be the last part of the URL/,
    );
  });

  it("rejects malformed catch-all names with bad dot counts", () => {
    expect(() => validateRoutePatterns(["/blog/[....id]/abc"])).toThrow(
      /Segment names may not start with erroneous periods/,
    );
    expect(() => validateRoutePatterns(["/blog/[..id]/abc"])).toThrow(
      /Segment names may not start with erroneous periods/,
    );
  });

  it("rejects malformed optional-catch-all bracket syntax", () => {
    expect(() => validateRoutePatterns(["/blog/[[...id]"])).toThrow(
      /Segment names may not start or end with extra brackets/,
    );
    expect(() => validateRoutePatterns(["/blog/[[[...id]]"])).toThrow(
      /Segment names may not start or end with extra brackets/,
    );
    expect(() => validateRoutePatterns(["/blog/[...id]]"])).toThrow(
      /Segment names may not start or end with extra brackets/,
    );
    expect(() => validateRoutePatterns(["/blog/[[...id]]]"])).toThrow(
      /Segment names may not start or end with extra brackets/,
    );
    expect(() => validateRoutePatterns(["/blog/[[[...id]]]"])).toThrow(
      /Segment names may not start or end with extra brackets/,
    );
  });

  it("rejects optional route params", () => {
    expect(() => validateRoutePatterns(["/[[blog]]"])).toThrow(
      /Optional route parameters are not yet supported/,
    );
    expect(() => validateRoutePatterns(["/abc/[[blog]]"])).toThrow(
      /Optional route parameters are not yet supported/,
    );
    expect(() => validateRoutePatterns(["/abc/[[blog]]/def"])).toThrow(
      /Optional route parameters are not yet supported/,
    );
  });

  it("rejects mixing required and optional catch-all at the same level", () => {
    expect(() => validateRoutePatterns(["/:one+", "/:one*"])).toThrow(
      /required and optional catch-all route at the same level/,
    );
    expect(() => validateRoutePatterns(["/:one*", "/:one+"])).toThrow(
      /optional and required catch-all route at the same level/,
    );
  });

  it("rejects optional catch-all routes with the same specificity as a concrete route", () => {
    expect(() => validateRoutePatterns(["/", "/:all*"])).toThrow(
      /same specificity as a optional catch-all route/,
    );
    expect(() => validateRoutePatterns(["/:all*", "/"])).toThrow(
      /same specificity as a optional catch-all route/,
    );
    expect(() => validateRoutePatterns(["/sub", "/sub/:all*"])).toThrow(
      /same specificity as a optional catch-all route/,
    );
    expect(() => validateRoutePatterns(["/sub/:all*", "/sub"])).toThrow(
      /same specificity as a optional catch-all route/,
    );
  });

  it("rejects param names that differ only by non-word symbols", () => {
    expect(() =>
      validateRoutePatterns(["/blog/:helloworld", "/blog/:helloworld/:hello-world"]),
    ).toThrow(/differ only by non-word/);
  });

  it("rejects duplicate normalized patterns", () => {
    expect(() => validateRoutePatterns(["/about", "/about"])).toThrow(/same path/);
  });

  it("rejects slash-equivalent patterns", () => {
    expect(() => validateRoutePatterns(["/about", "/about/"])).toThrow(/same path/);
  });

  it("rejects the Unicode ellipsis in catch-all syntax", () => {
    expect(() => validateRoutePatterns(["/[…three-dots]"])).toThrow(
      /Detected a three-dot character/,
    );
  });
});

// ─── App Router route sorting ───────────────────────────────────────────

describe("App Router route sorting (additional)", () => {
  it("discovers all expected route types", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_DIR);
    const patterns = routes.map((r) => r.pattern);

    // Static routes
    expect(patterns).toContain("/");
    expect(patterns).toContain("/about");

    // Dynamic routes should exist
    const hasDynamic = patterns.some((p) => p.includes(":"));
    expect(hasDynamic).toBe(true);
  });

  it("rejects sibling dynamic app routes that differ only by param name", async () => {
    const tmpRoot = await makeTempDir("vinext-app-dynamic-conflict-");
    const appDir = path.join(tmpRoot, "app");

    try {
      await fs.mkdir(path.join(appDir, "posts", "[id]"), { recursive: true });
      await fs.mkdir(path.join(appDir, "posts", "[slug]"), { recursive: true });
      await fs.writeFile(
        path.join(appDir, "layout.tsx"),
        "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
      );
      await fs.writeFile(
        path.join(appDir, "posts", "[id]", "page.tsx"),
        "export default function Page() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "posts", "[slug]", "page.tsx"),
        "export default function Page() { return null; }",
      );

      invalidateAppRouteCache();
      await expect(appRouter(appDir)).rejects.toThrow(/different slug names/);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateAppRouteCache();
    }
  });

  it("rejects route groups that resolve to the same URL path", async () => {
    // Next.js validates normalized app paths after route groups are stripped:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/validate-app-paths.test.ts
    // Route-group conflicts are also documented here:
    // https://github.com/vercel/next.js/blob/canary/docs/01-app/03-api-reference/03-file-conventions/route-groups.mdx
    const tmpRoot = await makeTempDir("vinext-app-route-group-conflict-");
    const appDir = path.join(tmpRoot, "app");

    try {
      await fs.mkdir(path.join(appDir, "(a)", "about"), { recursive: true });
      await fs.mkdir(path.join(appDir, "(b)", "about"), { recursive: true });
      await fs.writeFile(
        path.join(appDir, "layout.tsx"),
        "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
      );
      await fs.writeFile(
        path.join(appDir, "(a)", "about", "page.tsx"),
        "export default function Page() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "(b)", "about", "page.tsx"),
        "export default function Page() { return null; }",
      );

      invalidateAppRouteCache();
      await expect(appRouter(appDir)).rejects.toThrow(/same path.*\/about/);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateAppRouteCache();
    }
  });

  it("rejects grouped slot sub-pages that resolve to the same URL path within one slot", async () => {
    const tmpRoot = await makeTempDir("vinext-app-slot-route-group-conflict-");
    const appDir = path.join(tmpRoot, "app");

    try {
      await fs.mkdir(path.join(appDir, "dashboard", "@team", "(a)", "members"), {
        recursive: true,
      });
      await fs.mkdir(path.join(appDir, "dashboard", "@team", "(b)", "members"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(appDir, "layout.tsx"),
        "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "page.tsx"),
        "export default function Page() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "default.tsx"),
        "export default function Default() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@team", "default.tsx"),
        "export default function Default() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@team", "(a)", "members", "page.tsx"),
        "export default function Page() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@team", "(b)", "members", "page.tsx"),
        "export default function Page() { return null; }",
      );

      invalidateAppRouteCache();
      await expect(appRouter(appDir)).rejects.toThrow(/same path.*\/dashboard\/members/);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateAppRouteCache();
    }
  });

  it("merges grouped slot sub-pages from different slots onto the same synthesized route", async () => {
    const tmpRoot = await makeTempDir("vinext-app-slot-route-group-merge-");
    const appDir = path.join(tmpRoot, "app");

    try {
      await fs.mkdir(path.join(appDir, "dashboard", "@team", "(a)", "members"), {
        recursive: true,
      });
      await fs.mkdir(path.join(appDir, "dashboard", "@analytics", "(b)", "members"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(appDir, "layout.tsx"),
        "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "page.tsx"),
        "export default function Page() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "default.tsx"),
        "export default function Default() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@team", "default.tsx"),
        "export default function Default() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@analytics", "default.tsx"),
        "export default function Default() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@team", "(a)", "members", "page.tsx"),
        "export default function TeamMembers() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@analytics", "(b)", "members", "page.tsx"),
        "export default function AnalyticsMembers() { return null; }",
      );

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const membersRoute = routes.find((route) => route.pattern === "/dashboard/members");

      expect(membersRoute).toBeDefined();
      expect(membersRoute!.parallelSlots.find((slot) => slot.name === "team")!.pagePath).toContain(
        path.join("@team", "(a)", "members"),
      );
      expect(
        membersRoute!.parallelSlots.find((slot) => slot.name === "analytics")!.pagePath,
      ).toContain(path.join("@analytics", "(b)", "members"));
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateAppRouteCache();
    }
  });

  it("rejects slot sub-pages that collide with route handlers at the same URL", async () => {
    const tmpRoot = await makeTempDir("vinext-app-slot-route-handler-conflict-");
    const appDir = path.join(tmpRoot, "app");

    try {
      await fs.mkdir(path.join(appDir, "dashboard", "@team", "members"), { recursive: true });
      await fs.mkdir(path.join(appDir, "dashboard", "members"), { recursive: true });
      await fs.writeFile(
        path.join(appDir, "layout.tsx"),
        "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "page.tsx"),
        "export default function Page() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "default.tsx"),
        "export default function Default() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@team", "default.tsx"),
        "export default function Default() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@team", "members", "page.tsx"),
        "export default function TeamMembers() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "members", "route.ts"),
        "export async function GET() { return new Response('ok'); }",
      );

      invalidateAppRouteCache();
      await expect(appRouter(appDir)).rejects.toThrow(/same path.*\/dashboard\/members/);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateAppRouteCache();
    }
  });

  it("does not overwrite a child slot with a parent slot sub-page that shares the same name", async () => {
    const tmpRoot = await makeTempDir("vinext-app-slot-shadowing-");
    const appDir = path.join(tmpRoot, "app");

    try {
      await fs.mkdir(path.join(appDir, "dashboard", "@team", "settings"), { recursive: true });
      await fs.mkdir(path.join(appDir, "dashboard", "settings", "@team"), { recursive: true });
      await fs.writeFile(
        path.join(appDir, "layout.tsx"),
        "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "page.tsx"),
        "export default function DashboardPage() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "default.tsx"),
        "export default function DashboardDefault() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@team", "default.tsx"),
        "export default function ParentTeamDefault() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "@team", "settings", "page.tsx"),
        "export default function ParentTeamSettings() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "settings", "page.tsx"),
        "export default function SettingsPage() { return null; }",
      );
      await fs.writeFile(
        path.join(appDir, "dashboard", "settings", "@team", "page.tsx"),
        "export default function ChildTeamPage() { return null; }",
      );

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const settingsRoute = routes.find((route) => route.pattern === "/dashboard/settings");

      expect(settingsRoute).toBeDefined();
      expect(settingsRoute!.parallelSlots.find((slot) => slot.name === "team")!.pagePath).toContain(
        path.join("settings", "@team", "page.tsx"),
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateAppRouteCache();
    }
  });
});

// ─── API Router ─────────────────────────────────────────────────────────

describe("Pages Router API routes", () => {
  it("discovers API routes", async () => {
    const routes = await apiRouter(PAGES_DIR);
    expect(routes.length).toBeGreaterThan(0);
    const patterns = routes.map((r) => r.pattern);
    expect(patterns.some((p) => p.startsWith("/api/"))).toBe(true);
  });

  it("sorts static API routes before dynamic", async () => {
    const routes = await apiRouter(PAGES_DIR);
    const staticRoutes = routes.filter((r) => !r.isDynamic);
    const dynamicRoutes = routes.filter((r) => r.isDynamic);

    if (staticRoutes.length > 0 && dynamicRoutes.length > 0) {
      const lastStaticIdx = routes.indexOf(staticRoutes[staticRoutes.length - 1]);
      const firstDynamicIdx = routes.indexOf(dynamicRoutes[0]);
      expect(lastStaticIdx).toBeLessThan(firstDynamicIdx);
    }
  });
});
