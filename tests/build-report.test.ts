/**
 * Build report tests — verifies route classification, formatting, and sorting.
 *
 * Tests the static export detection helpers and the classification
 * logic for both Pages Router and App Router routes, using real fixture files
 * where integration testing is needed.
 */
import { describe, it, expect, afterEach } from "vite-plus/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { parseSync } from "vite";
import {
  hasExportedName,
  hasNamedExport,
  extractExportConstString,
  extractExportConstNumber,
  extractGetStaticPropsRevalidate,
  classifyPagesRoute,
  classifyAppRoute,
  classifyLayoutSegmentConfig,
  buildReportRows,
  formatBuildReport,
  printBuildReport,
  validatePrefetchProgram,
  collectAppRouteConfigModulePaths,
} from "../packages/vinext/src/build/report.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";
import { appRouter, invalidateAppRouteCache } from "../packages/vinext/src/routing/app-router.js";
import { invalidateRouteCache } from "../packages/vinext/src/routing/pages-router.js";

const FIXTURES_PAGES = path.resolve("tests/fixtures/pages-basic/pages");
const FIXTURES_APP = path.resolve("tests/fixtures/app-basic/app");

// ─── hasNamedExport ───────────────────────────────────────────────────────────

describe("hasNamedExport", () => {
  it("detects async function declaration", () => {
    expect(hasNamedExport("export async function getStaticProps() {}", "getStaticProps")).toBe(
      true,
    );
  });

  it("detects sync function declaration", () => {
    expect(hasNamedExport("export function getServerSideProps() {}", "getServerSideProps")).toBe(
      true,
    );
  });

  it("detects const variable declaration", () => {
    expect(hasNamedExport("export const revalidate = 60;", "revalidate")).toBe(true);
  });

  it("detects let variable declaration", () => {
    expect(hasNamedExport("export let dynamic = 'auto';", "dynamic")).toBe(true);
  });

  it("detects re-export specifier", () => {
    expect(hasNamedExport("export { getStaticProps, foo };", "getStaticProps")).toBe(true);
  });

  it("detects re-export with alias", () => {
    expect(hasNamedExport("export { getStaticProps as gsp };", "getStaticProps")).toBe(true);
  });

  it("does not detect alias exported under the searched name", () => {
    expect(hasNamedExport("export { gsp as getStaticProps };", "getStaticProps")).toBe(false);
  });

  it("matches Next.js local-name handling for aliased exports", () => {
    expect(hasExportedName("export { gsp as getStaticProps };", "getStaticProps")).toBe(false);
    expect(hasExportedName("export { getStaticProps as gsp };", "getStaticProps")).toBe(true);
  });

  it("ignores type-only exports with a runtime data-fetching name", () => {
    expect(
      hasExportedName('export type { Loader as getStaticProps } from "./data";', "getStaticProps"),
    ).toBe(false);
    expect(
      hasExportedName(
        "type Loader = () => unknown; export { type Loader as getStaticProps };",
        "getStaticProps",
      ),
    ).toBe(false);
  });

  it("returns false when export is absent", () => {
    expect(hasNamedExport("export default function Page() {}", "getStaticProps")).toBe(false);
  });

  it("does not match partial names (false positive guard)", () => {
    // 'getStaticPropsExtra' should not match 'getStaticProps'
    expect(hasNamedExport("export function getStaticPropsExtra() {}", "getStaticProps")).toBe(
      false,
    );
  });

  it("detects export on a line following other code", () => {
    const code = `const x = 1;\nexport async function getStaticProps() {}`;
    expect(hasNamedExport(code, "getStaticProps")).toBe(true);
  });

  it("detects TypeScript-annotated const", () => {
    expect(hasNamedExport("export const dynamic: string = 'force-dynamic';", "dynamic")).toBe(true);
  });

  it("ignores export-shaped text inside block comments", () => {
    const code = `/*
export function getServerSideProps() {}
*/`;
    expect(hasNamedExport(code, "getServerSideProps")).toBe(false);
  });
});

// ─── extractExportConstString ─────────────────────────────────────────────────

describe("extractExportConstString", () => {
  it("extracts plain string value", () => {
    expect(extractExportConstString("export const dynamic = 'force-dynamic';", "dynamic")).toBe(
      "force-dynamic",
    );
  });

  it("extracts double-quoted string value", () => {
    expect(extractExportConstString('export const dynamic = "force-static";', "dynamic")).toBe(
      "force-static",
    );
  });

  it("extracts value with TypeScript type annotation", () => {
    expect(extractExportConstString("export const dynamic: string = 'error';", "dynamic")).toBe(
      "error",
    );
  });

  it("extracts no-substitution template literal values", () => {
    expect(extractExportConstString("export const dynamic = `force-dynamic`;", "dynamic")).toBe(
      "force-dynamic",
    );
  });

  it("ignores export-shaped string values inside block comments", () => {
    const code = `/*
export const dynamic = "force-dynamic";
*/`;
    expect(extractExportConstString(code, "dynamic")).toBeNull();
  });

  it("returns null when export is absent", () => {
    expect(extractExportConstString("export const revalidate = 60;", "dynamic")).toBeNull();
  });

  it("returns null for non-string value", () => {
    expect(extractExportConstString("export const revalidate = 60;", "revalidate")).toBeNull();
  });
});

// ─── extractExportConstNumber ─────────────────────────────────────────────────

describe("extractExportConstNumber", () => {
  it("extracts integer", () => {
    expect(extractExportConstNumber("export const revalidate = 60;", "revalidate")).toBe(60);
  });

  it("extracts zero", () => {
    expect(extractExportConstNumber("export const revalidate = 0;", "revalidate")).toBe(0);
  });

  it("extracts Infinity", () => {
    expect(extractExportConstNumber("export const revalidate = Infinity;", "revalidate")).toBe(
      Infinity,
    );
  });

  it("extracts false as Infinity (revalidate = false means cache indefinitely)", () => {
    expect(extractExportConstNumber("export const revalidate = false;", "revalidate")).toBe(
      Infinity,
    );
  });

  it("extracts negative value", () => {
    expect(extractExportConstNumber("export const revalidate = -1;", "revalidate")).toBe(-1);
  });

  it("extracts with TypeScript type annotation", () => {
    expect(extractExportConstNumber("export const revalidate: number = 120;", "revalidate")).toBe(
      120,
    );
  });

  it("extracts numeric separators", () => {
    expect(extractExportConstNumber("export const revalidate = 60_000;", "revalidate")).toBe(60000);
  });

  it("extracts config from TypeScript files with generic arrow syntax", () => {
    const code = `const identity = <T>(value: T) => value;
export const revalidate = 60;`;
    expect(extractExportConstNumber(code, "revalidate")).toBe(60);
  });

  it("returns null when export is absent", () => {
    expect(extractExportConstNumber("export const dynamic = 'auto';", "revalidate")).toBeNull();
  });
});

// ─── extractGetStaticPropsRevalidate ──────────────────────────────────────────

describe("extractGetStaticPropsRevalidate", () => {
  it("extracts positive integer revalidate", () => {
    const code = `export async function getStaticProps() {
  return { props: {}, revalidate: 60 };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60);
  });

  // These bare return-object cases intentionally exercise the whole-file
  // fallback path used when no local getStaticProps declaration is present.
  it("extracts revalidate: 0 (treat as SSR)", () => {
    const code = `return { props: {}, revalidate: 0 };`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(0);
  });

  it("extracts revalidate: false (fully static)", () => {
    const code = `return { props: {}, revalidate: false };`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(false);
  });

  it("extracts revalidate: Infinity (fully static)", () => {
    const code = `return { props: {}, revalidate: Infinity };`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(Infinity);
  });

  it("returns null when revalidate key is absent", () => {
    const code = `export async function getStaticProps() {
  return { props: { foo: 1 } };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("ignores unrelated revalidate values outside getStaticProps", () => {
    const code = `const defaults = { revalidate: 30 };

export async function getStaticProps() {
  return { props: { ok: true } };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("prefers revalidate inside getStaticProps over unrelated values elsewhere", () => {
    const code = `const defaults = { revalidate: 30 };

export async function getStaticProps() {
  return { props: {}, revalidate: 60 };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60);
  });

  it("finds revalidate in a later return when an earlier return redirects", () => {
    const code = `export async function getStaticProps(ctx) {
  if (!ctx.params?.slug) {
    return { redirect: { destination: "/", permanent: false } };
  }
  return { props: { data: 1 }, revalidate: 60 };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60);
  });

  it("ignores revalidate in a function defined after getStaticProps", () => {
    const code = `export function getStaticProps() {
  return { props: {} };
}

export function unrelated() {
  return { revalidate: 999 };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("extracts revalidate from a function declaration with destructured params", () => {
    const code = `export async function getStaticProps({ params }) {
  return { props: { slug: params?.slug ?? null }, revalidate: 60 };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60);
  });

  it("extracts revalidate from a function expression with destructured params", () => {
    const code = `export const getStaticProps = async function({ params }) {
  return { props: { slug: params?.slug ?? null }, revalidate: 60 };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60);
  });

  it("ignores revalidate in a nested helper function inside getStaticProps", () => {
    const code = `export function getStaticProps() {
  const helper = () => {
    return { revalidate: 999 };
  };

  return { props: {} };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("ignores revalidate in a nested named function inside getStaticProps", () => {
    const code = `export function getStaticProps() {
  function helper(paramOne, paramTwo, paramThree, paramFour, paramFive) {
    return { revalidate: 999 };
  }

  return { props: {} };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("ignores revalidate in a nested implicit-arrow helper inside block-body getStaticProps", () => {
    const code = `export const getStaticProps = async () => {
  const helper = () => ({ revalidate: 999 });

  return { props: {} };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("ignores revalidate in a nested implicit-arrow helper inside function-expression getStaticProps", () => {
    const code = `export const getStaticProps = async function() {
  const helper = () => ({ revalidate: 999 });

  return { props: {} };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("ignores revalidate nested inside props data", () => {
    const code = `export async function getStaticProps() {
  return {
    props: {
      config: {
        revalidate: 999,
      },
    },
  };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("ignores revalidate in an object-method helper inside getStaticProps", () => {
    const code = `export function getStaticProps() {
  const helper = {
    build() {
      return { revalidate: 999 };
    },
  };

  return { props: {} };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("ignores revalidate in object-method helpers named get and async", () => {
    const code = `export function getStaticProps() {
  const helper = {
    get() {
      return { revalidate: 999 };
    },
    async() {
      return { revalidate: 998 };
    },
  };

  return { props: {} };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("ignores unrelated revalidate when getStaticProps is re-exported from another file", () => {
    const code = `const defaults = { revalidate: 30 };

export { getStaticProps } from "./shared";
`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("ignores an alias exported under the getStaticProps name", () => {
    const code = `const gsp = async () => ({ props: {}, revalidate: 60 });

export { gsp as getStaticProps };
`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("handles inline comment after value (fixture file style)", () => {
    // From tests/fixtures/pages-basic/pages/isr-test.tsx:
    //   revalidate: 1, // Revalidate every 1 second
    const code = `return { props: {}, revalidate: 1, // comment\n};`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(1);
  });

  it("extracts revalidate from numeric separators in getStaticProps", () => {
    const code = `export async function getStaticProps() {
  return { props: {}, revalidate: 60_000 };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60000);
  });
});

// ─── classifyPagesRoute (integration — real fixture files) ────────────────────

describe("classifyPagesRoute", () => {
  it("classifies isr-test.tsx as isr with revalidate=1", () => {
    const filePath = path.join(FIXTURES_PAGES, "isr-test.tsx");
    expect(classifyPagesRoute(filePath)).toEqual({ type: "isr", revalidate: 1 });
  });

  it("classifies ssr.tsx as ssr", () => {
    const filePath = path.join(FIXTURES_PAGES, "ssr.tsx");
    expect(classifyPagesRoute(filePath)).toEqual({ type: "ssr" });
  });

  it("classifies index.tsx as static", () => {
    const filePath = path.join(FIXTURES_PAGES, "index.tsx");
    expect(classifyPagesRoute(filePath)).toEqual({ type: "static" });
  });

  it("classifies api routes by path segment", () => {
    // Path contains /pages/api/ → always api
    const filePath = path.join(FIXTURES_PAGES, "api", "hello.ts");
    expect(classifyPagesRoute(filePath)).toEqual({ type: "api" });
  });

  it("returns unknown on file read failure (consistent with classifyAppRoute)", () => {
    expect(classifyPagesRoute("/nonexistent/pages/page.tsx")).toEqual({ type: "unknown" });
  });
});

// ─── classifyAppRoute ─────────────────────────────────────────────────────────

describe("classifyAppRoute", () => {
  it("classifies route handler (routePath only) as api", () => {
    const routePath = path.join(FIXTURES_APP, "api", "route.ts");
    expect(classifyAppRoute(null, routePath, false)).toEqual({ type: "api" });
  });

  it("classifies force-dynamic page as ssr", () => {
    const pagePath = path.join(FIXTURES_APP, "dynamic-test", "page.tsx");
    expect(classifyAppRoute(pagePath, null, false)).toEqual({ type: "ssr" });
  });

  it("classifies force-static page as static", () => {
    const pagePath = path.join(FIXTURES_APP, "static-test", "page.tsx");
    expect(classifyAppRoute(pagePath, null, true)).toEqual({ type: "static" });
  });

  it("classifies dynamic=error page as static (enforces static, not dynamic)", () => {
    // dynamic="error" means "throw if dynamic APIs are used" — the page is
    // statically rendered, same as force-static for classification purposes.
    const pagePath = path.join(FIXTURES_APP, "error-static-test", "page.tsx");
    expect(classifyAppRoute(pagePath, null, false)).toEqual({ type: "static" });
  });

  it("classifies revalidate=60 page as isr", () => {
    const pagePath = path.join(FIXTURES_APP, "revalidate-test", "page.tsx");
    expect(classifyAppRoute(pagePath, null, false)).toEqual({
      type: "isr",
      revalidate: 60,
    });
  });

  it("classifies revalidate=0 page as ssr", () => {
    const pagePath = path.join(FIXTURES_APP, "revalidate-zero-test", "page.tsx");
    expect(classifyAppRoute(pagePath, null, false)).toEqual({ type: "ssr" });
  });

  it("classifies page with isDynamic=true and no config as ssr", () => {
    // blog/[slug]/page.tsx has no dynamic or revalidate exports, and the route
    // is dynamic (isDynamic=true). Without explicit config, falls back to ssr.
    const pagePath = path.join(FIXTURES_APP, "blog", "[slug]", "page.tsx");
    expect(classifyAppRoute(pagePath, null, true)).toEqual({ type: "ssr" });
  });

  it("classifies page with isDynamic=false and no config as unknown", () => {
    // No explicit config, no dynamic segments — cannot confirm static without
    // actually running the build. Reported as unknown.
    expect(classifyAppRoute("/nonexistent/page.tsx", null, false)).toEqual({
      type: "unknown",
    });
  });

  it("classifies revalidate=Infinity page as static", () => {
    const pagePath = path.join(FIXTURES_APP, "revalidate-infinity-test", "page.tsx");
    expect(classifyAppRoute(pagePath, null, false)).toEqual({ type: "static" });
  });

  it("classifies revalidate=false page as static", () => {
    // revalidate = false means "cache indefinitely" — same as Infinity.
    const pagePath = path.join(FIXTURES_APP, "revalidate-false-test", "page.tsx");
    expect(classifyAppRoute(pagePath, null, false)).toEqual({ type: "static" });
  });
});

// ─── buildReportRows ──────────────────────────────────────────────────────────

describe("buildReportRows", () => {
  it("returns empty array when no routes provided", () => {
    expect(buildReportRows({})).toEqual([]);
  });

  it("sorts routes by path (filesystem order)", () => {
    const pageRoutes = [
      {
        pattern: "/ssr",
        patternParts: ["/ssr"],
        filePath: path.join(FIXTURES_PAGES, "ssr.tsx"),
        isDynamic: false,
        params: [],
      },
      {
        pattern: "/isr-test",
        patternParts: ["/isr-test"],
        filePath: path.join(FIXTURES_PAGES, "isr-test.tsx"),
        isDynamic: false,
        params: [],
      },
      {
        pattern: "/",
        patternParts: ["/"],
        filePath: path.join(FIXTURES_PAGES, "index.tsx"),
        isDynamic: false,
        params: [],
      },
    ];
    const apiRoutes = [
      {
        pattern: "/api/hello",
        patternParts: ["/api/hello"],
        filePath: path.join(FIXTURES_PAGES, "api", "hello.ts"),
        isDynamic: false,
        params: [],
      },
    ];
    const rows = buildReportRows({ pageRoutes, apiRoutes });
    const patterns = rows.map((r) => r.pattern);
    // Alphabetical path order: /, /api/hello, /isr-test, /ssr
    expect(patterns).toEqual(["/", "/api/hello", "/isr-test", "/ssr"]);
  });

  it("sorts routes with mixed types alphabetically by path", () => {
    const pageRoutes = [
      {
        pattern: "/zzz",
        patternParts: [],
        filePath: path.join(FIXTURES_PAGES, "index.tsx"),
        isDynamic: false,
        params: [],
      },
      {
        pattern: "/aaa",
        patternParts: [],
        filePath: path.join(FIXTURES_PAGES, "about.tsx"),
        isDynamic: false,
        params: [],
      },
    ];
    const rows = buildReportRows({ pageRoutes });
    expect(rows[0].pattern).toBe("/aaa");
    expect(rows[1].pattern).toBe("/zzz");
  });

  it("classifies layout-only parallel-slot app routes from their render entry", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(FIXTURES_APP);
    const rows = buildReportRows({ appRoutes: routes });

    expect(rows.find((row) => row.pattern === "/parallel-nested/home")).toMatchObject({
      pattern: "/parallel-nested/home",
      type: "unknown",
    });
    expect(rows.find((row) => row.pattern === "/slot-collision")).toMatchObject({
      pattern: "/slot-collision",
      type: "unknown",
    });
  });
});

// ─── formatBuildReport ────────────────────────────────────────────────────────

describe("formatBuildReport", () => {
  it("returns empty string for empty rows", () => {
    expect(formatBuildReport([])).toBe("");
  });

  it("includes router label in header", () => {
    const rows = [{ pattern: "/", type: "static" as const }];
    expect(formatBuildReport(rows, "pages")).toContain("Route (pages)");
    expect(formatBuildReport(rows, "app")).toContain("Route (app)");
  });

  it("uses ○ symbol for static routes", () => {
    const rows = [{ pattern: "/", type: "static" as const }];
    expect(formatBuildReport(rows)).toContain("○");
  });

  it("uses ◐ symbol for ISR routes", () => {
    const rows = [{ pattern: "/blog", type: "isr" as const, revalidate: 60 }];
    expect(formatBuildReport(rows)).toContain("◐");
  });

  it("uses ƒ symbol for dynamic (SSR) routes", () => {
    const rows = [{ pattern: "/dashboard", type: "ssr" as const }];
    expect(formatBuildReport(rows)).toContain("ƒ");
  });

  it("uses λ symbol for API routes", () => {
    const rows = [{ pattern: "/api/hello", type: "api" as const }];
    expect(formatBuildReport(rows)).toContain("λ");
  });

  it("includes ISR revalidate interval in seconds", () => {
    const rows = [{ pattern: "/blog", type: "isr" as const, revalidate: 60 }];
    const out = formatBuildReport(rows);
    expect(out).toContain("60s");
  });

  it("uses ┌ for first row, ├ for middle rows, └ for last row", () => {
    const rows = [
      { pattern: "/", type: "static" as const },
      { pattern: "/about", type: "static" as const },
      { pattern: "/contact", type: "static" as const },
    ];
    const out = formatBuildReport(rows);
    const tableLines = out.split("\n").filter((l) => l.includes("○"));
    expect(tableLines[0]).toContain("┌");
    expect(tableLines[1]).toContain("├");
    expect(tableLines[2]).toContain("└");
  });

  it("uses - for a single-route table (not └)", () => {
    const rows = [{ pattern: "/", type: "static" as const }];
    const out = formatBuildReport(rows);
    expect(out).toContain("─ ○ /");
  });

  it("prints a legend line with only the types that appear", () => {
    const rows = [
      { pattern: "/", type: "static" as const },
      { pattern: "/api/x", type: "api" as const },
    ];
    const out = formatBuildReport(rows);
    expect(out).toContain("○ Static");
    expect(out).toContain("λ API");
    // ISR and Dynamic not in legend since no such rows
    expect(out).not.toContain("◐ ISR");
    expect(out).not.toContain("ƒ Dynamic");
  });

  it("sorts legend entries alphabetically by label", () => {
    const rows = [
      { pattern: "/", type: "static" as const },
      { pattern: "/blog", type: "isr" as const, revalidate: 60 },
      { pattern: "/dash", type: "ssr" as const },
      { pattern: "/api/x", type: "api" as const },
    ];
    const out = formatBuildReport(rows);
    const legendLine = out.split("\n").find((l) => l.includes("○") && l.includes("λ")) ?? "";
    // Alphabetical: API, Dynamic, ISR, Static
    expect(legendLine.indexOf("API")).toBeLessThan(legendLine.indexOf("Dynamic"));
    expect(legendLine.indexOf("Dynamic")).toBeLessThan(legendLine.indexOf("ISR"));
    expect(legendLine.indexOf("ISR")).toBeLessThan(legendLine.indexOf("Static"));
  });

  it("does not print unknown note when no unknown routes", () => {
    const rows = [{ pattern: "/", type: "static" as const }];
    expect(formatBuildReport(rows)).not.toContain("could not be classified");
  });

  it("prints explanatory note when unknown routes are present", () => {
    const rows = [
      { pattern: "/", type: "static" as const },
      { pattern: "/about", type: "unknown" as const },
    ];
    const out = formatBuildReport(rows);
    expect(out).toContain("? Unknown");
    expect(out).toContain("could not be classified");
    expect(out).toContain("future release");
  });

  it("produces the full expected format for a mixed set of routes", () => {
    // rows are pre-sorted by path (as buildReportRows would produce)
    const rows = [
      { pattern: "/", type: "static" as const },
      { pattern: "/api/posts", type: "api" as const },
      { pattern: "/blog/:slug", type: "isr" as const, revalidate: 60 },
      { pattern: "/dashboard", type: "ssr" as const },
    ];
    const out = formatBuildReport(rows, "pages");
    expect(out).toContain("Route (pages)");
    expect(out).toContain("┌ ○ /");
    expect(out).toContain("├ λ /api/posts");
    expect(out).toContain("├ ◐ /blog/:slug");
    expect(out).toContain("60s");
    expect(out).toContain("└ ƒ /dashboard");
    // Legend is alphabetical: API, Dynamic, ISR, Static
    expect(out).toContain("λ API  ƒ Dynamic  ◐ ISR  ○ Static");
  });
});

// ─── printBuildReport with pageExtensions ─────────────────────────────────────

describe("printBuildReport respects pageExtensions", () => {
  let tmpRoot: string;

  afterEach(async () => {
    if (tmpRoot) {
      // Invalidate both routers' caches — pages router tests set pagesDir at
      // tmpRoot/pages, so we invalidate that path too. This ensures a failing
      // test that skips its own finally-block cleanup doesn't pollute later tests.
      invalidateAppRouteCache();
      invalidateRouteCache(path.join(tmpRoot, "pages"));
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("app router: only reports routes matching configured pageExtensions", async () => {
    // Ported from Next.js MDX e2e pageExtensions behaviour:
    // test/e2e/app-dir/mdx/next.config.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/mdx/next.config.ts
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-report-app-"));
    const appDir = path.join(tmpRoot, "app");
    await fs.mkdir(path.join(appDir, "about"), { recursive: true });
    await fs.writeFile(
      path.join(appDir, "layout.tsx"),
      "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
    );
    await fs.writeFile(
      path.join(appDir, "page.tsx"),
      "export default function Page() { return <div>home</div>; }",
    );
    // This .mdx page should be excluded when mdx is not in pageExtensions
    await fs.writeFile(path.join(appDir, "about", "page.mdx"), "# About");

    // Capture stdout output from printBuildReport
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      invalidateAppRouteCache();
      await printBuildReport({ root: tmpRoot, pageExtensions: ["tsx", "ts", "jsx", "js"] });
    } finally {
      console.log = origLog;
    }

    const output = lines.join("\n");
    // / should appear (page.tsx matches)
    expect(output).toContain("/");
    // /about should NOT appear (page.mdx excluded — mdx not in pageExtensions)
    expect(output).not.toContain("/about");
  });

  it("app router: reports mdx routes when pageExtensions includes mdx", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-report-app-mdx-"));
    const appDir = path.join(tmpRoot, "app");
    await fs.mkdir(path.join(appDir, "about"), { recursive: true });
    await fs.writeFile(
      path.join(appDir, "layout.tsx"),
      "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
    );
    await fs.writeFile(
      path.join(appDir, "page.tsx"),
      "export default function Page() { return <div>home</div>; }",
    );
    await fs.writeFile(path.join(appDir, "about", "page.mdx"), "# About");

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      invalidateAppRouteCache();
      await printBuildReport({ root: tmpRoot, pageExtensions: ["tsx", "ts", "jsx", "js", "mdx"] });
    } finally {
      console.log = origLog;
    }

    const output = lines.join("\n");
    expect(output).toContain("/about");
  });

  it("pages router: only reports routes matching configured pageExtensions", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-report-pages-"));
    const pagesDir = path.join(tmpRoot, "pages");
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.writeFile(
      path.join(pagesDir, "index.tsx"),
      "export default function Page() { return <div>home</div>; }",
    );
    // This .mdx page should be excluded when mdx is not in pageExtensions
    await fs.writeFile(path.join(pagesDir, "about.mdx"), "# About");

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      invalidateRouteCache(pagesDir);
      await printBuildReport({ root: tmpRoot, pageExtensions: ["tsx", "ts", "jsx", "js"] });
    } finally {
      console.log = origLog;
      invalidateRouteCache(pagesDir);
    }

    const output = lines.join("\n");
    expect(output).toContain("/");
    expect(output).not.toContain("/about");
  });

  it("pages router: reports mdx routes when pageExtensions includes mdx", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-report-pages-mdx-"));
    const pagesDir = path.join(tmpRoot, "pages");
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.writeFile(
      path.join(pagesDir, "index.tsx"),
      "export default function Page() { return <div>home</div>; }",
    );
    await fs.writeFile(path.join(pagesDir, "about.mdx"), "# About");

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      invalidateRouteCache(pagesDir);
      await printBuildReport({
        root: tmpRoot,
        pageExtensions: ["tsx", "ts", "jsx", "js", "mdx"],
      });
    } finally {
      console.log = origLog;
      invalidateRouteCache(pagesDir);
    }

    const output = lines.join("\n");
    expect(output).toContain("/about");
  });
});

// ─── classifyLayoutSegmentConfig ─────────────────────────────────────────────

describe("classifyLayoutSegmentConfig", () => {
  it("returns kind=static with segment-config reason for force-static", () => {
    expect(classifyLayoutSegmentConfig('export const dynamic = "force-static";')).toEqual({
      kind: "static",
      reason: { layer: "segment-config", key: "dynamic", value: "force-static" },
    });
  });

  it('returns kind=static with segment-config reason for dynamic = "error"', () => {
    expect(classifyLayoutSegmentConfig("export const dynamic = 'error';")).toEqual({
      kind: "static",
      reason: { layer: "segment-config", key: "dynamic", value: "error" },
    });
  });

  it("returns kind=dynamic with segment-config reason for force-dynamic", () => {
    expect(classifyLayoutSegmentConfig('export const dynamic = "force-dynamic";')).toEqual({
      kind: "dynamic",
      reason: { layer: "segment-config", key: "dynamic", value: "force-dynamic" },
    });
  });

  it("returns kind=dynamic with revalidate reason for revalidate = 0", () => {
    expect(classifyLayoutSegmentConfig("export const revalidate = 0;")).toEqual({
      kind: "dynamic",
      reason: { layer: "segment-config", key: "revalidate", value: 0 },
    });
  });

  it("returns kind=static with revalidate reason for revalidate = Infinity", () => {
    expect(classifyLayoutSegmentConfig("export const revalidate = Infinity;")).toEqual({
      kind: "static",
      reason: { layer: "segment-config", key: "revalidate", value: Infinity },
    });
  });

  it("returns kind=static with revalidate reason for revalidate = false", () => {
    // revalidate = false means "cache indefinitely" — same as Infinity.
    expect(classifyLayoutSegmentConfig("export const revalidate = false;")).toEqual({
      kind: "static",
      reason: { layer: "segment-config", key: "revalidate", value: Infinity },
    });
  });

  it("returns kind=absent when no config is present (defers to module graph)", () => {
    expect(
      classifyLayoutSegmentConfig(
        "export default function Layout({ children }) { return children; }",
      ),
    ).toEqual({ kind: "absent" });
  });

  it("returns kind=absent for positive revalidate (ISR is a page concept)", () => {
    expect(classifyLayoutSegmentConfig("export const revalidate = 60;")).toEqual({
      kind: "absent",
    });
  });
});

// ─── validatePrefetchProgram ──────────────────────────────────────────────────

function parse(code: string) {
  return parseSync("page.tsx", code, { astType: "ts", lang: "tsx", sourceType: "module" }).program;
}

describe("validatePrefetchProgram", () => {
  it("throws for prefetch in a 'use client' module (valid value, cacheComponents on)", () => {
    expect(() =>
      validatePrefetchProgram(
        parse(`"use client";\nexport const prefetch = 'partial';`),
        "app/page.tsx",
        { cacheComponents: true },
      ),
    ).toThrow(
      '[vinext] "app/page.tsx": `prefetch` is a route segment config that can only be used in a Server Component module. Remove the "use client" directive to use it.',
    );
  });

  it("throws for any valid value without cacheComponents", () => {
    expect(() =>
      validatePrefetchProgram(parse("export const prefetch = 'auto';"), "app/page.tsx", {
        cacheComponents: false,
      }),
    ).toThrow(
      '[vinext] "app/page.tsx": `export const prefetch` requires `cacheComponents: true` in your next.config.',
    );
  });

  it("throws for invalid values, listing the valid set", () => {
    for (const value of ["static", "runtime", "nonsense"]) {
      expect(() =>
        validatePrefetchProgram(parse(`export const prefetch = '${value}';`), "app/page.tsx", {
          cacheComponents: true,
        }),
      ).toThrow(
        `[vinext] Invalid \`prefetch\` value "${value}" in "app/page.tsx". Must be "auto", "partial", "unstable_eager", "force-disabled", or "allow-runtime".`,
      );
    }
  });

  it("throws the no-value variant when the export is not a static string", () => {
    expect(() =>
      validatePrefetchProgram(parse("export const prefetch = 42;"), "app/page.tsx", {
        cacheComponents: true,
      }),
    ).toThrow(
      '[vinext] Invalid `prefetch` value in "app/page.tsx". Must be "auto", "partial", "unstable_eager", "force-disabled", or "allow-runtime".',
    );
  });

  it("does not throw for each valid value with cacheComponents and no 'use client'", () => {
    for (const value of ["auto", "partial", "unstable_eager", "force-disabled", "allow-runtime"]) {
      expect(() =>
        validatePrefetchProgram(parse(`export const prefetch = '${value}';`), "app/page.tsx", {
          cacheComponents: true,
        }),
      ).not.toThrow();
    }
  });

  it("does not throw when prefetch is absent", () => {
    expect(() =>
      validatePrefetchProgram(parse("export const dynamic = 'force-static';"), "app/page.tsx", {
        cacheComponents: false,
      }),
    ).not.toThrow();
  });

  it("throws the use-client error first when 'use client' and missing cacheComponents combine", () => {
    expect(() =>
      validatePrefetchProgram(
        parse(`"use client";\nexport const prefetch = 'partial';`),
        "app/page.tsx",
        { cacheComponents: false },
      ),
    ).toThrow(/Server Component/);
  });

  it("detects 'use client' anywhere in the directive prologue", () => {
    expect(() =>
      validatePrefetchProgram(
        parse(`"use strict";\n"use client";\nexport const prefetch = 'auto';`),
        "app/page.tsx",
        { cacheComponents: true },
      ),
    ).toThrow(/Server Component/);
  });

  it("ignores non-`export const` prefetch forms (specifier, re-export, type-only, let)", () => {
    // Mirrors upstream: only statically extractable `export const` is analyzed.
    for (const code of [
      "const prefetch = 'auto'; export { prefetch };",
      "export { prefetch } from './shared';",
      "export type { prefetch } from './types';",
      "export let prefetch = 'auto';",
    ]) {
      expect(() =>
        validatePrefetchProgram(parse(code), "app/page.tsx", { cacheComponents: false }),
      ).not.toThrow();
    }
  });
});

// ─── collectAppRouteConfigModulePaths ─────────────────────────────────────────

describe("collectAppRouteConfigModulePaths", () => {
  type ConfigRoute = Pick<AppRoute, "pagePath" | "layouts" | "parallelSlots">;
  type Slot = AppRoute["parallelSlots"][number];

  it("returns just the page path for a page-only route", () => {
    const route: ConfigRoute = { pagePath: "/app/page.tsx", layouts: [], parallelSlots: [] };
    expect(collectAppRouteConfigModulePaths(route)).toEqual(["/app/page.tsx"]);
  });

  it("includes layouts in order after the page", () => {
    const route: ConfigRoute = {
      pagePath: "/app/blog/page.tsx",
      layouts: ["/app/layout.tsx", "/app/blog/layout.tsx"],
      parallelSlots: [],
    };
    expect(collectAppRouteConfigModulePaths(route)).toEqual([
      "/app/blog/page.tsx",
      "/app/layout.tsx",
      "/app/blog/layout.tsx",
    ]);
  });

  it("includes slot layoutPath, configLayoutPaths, pagePath, defaultPath and drops nulls", () => {
    const route: ConfigRoute = {
      pagePath: null,
      layouts: ["/app/layout.tsx"],
      parallelSlots: [
        {
          layoutPath: "/app/@team/layout.tsx",
          configLayoutPaths: ["/app/@team/members/layout.tsx"],
          pagePath: "/app/@team/page.tsx",
          defaultPath: null,
        } as Slot,
        {
          layoutPath: null,
          pagePath: null,
          defaultPath: "/app/@analytics/default.tsx",
        } as Slot,
      ],
    };
    expect(collectAppRouteConfigModulePaths(route)).toEqual([
      "/app/layout.tsx",
      "/app/@team/layout.tsx",
      "/app/@team/members/layout.tsx",
      "/app/@team/page.tsx",
      "/app/@analytics/default.tsx",
    ]);
  });

  it("dedupes a path appearing in both layouts and a slot's configLayoutPaths", () => {
    const route: ConfigRoute = {
      pagePath: "/app/page.tsx",
      layouts: ["/app/layout.tsx"],
      parallelSlots: [
        {
          layoutPath: null,
          configLayoutPaths: ["/app/layout.tsx"],
          pagePath: null,
          defaultPath: null,
        } as Slot,
      ],
    };
    expect(collectAppRouteConfigModulePaths(route)).toEqual(["/app/page.tsx", "/app/layout.tsx"]);
  });

  it("includes intercepting-route pages/layouts and sibling intercept pages", () => {
    const route = {
      pagePath: "/app/page.tsx",
      layouts: [],
      parallelSlots: [
        {
          layoutPath: null,
          pagePath: null,
          defaultPath: null,
          interceptingRoutes: [
            {
              pagePath: "/app/@modal/(.)photos/[id]/page.tsx",
              layoutPaths: ["/app/@modal/(.)photos/layout.tsx"],
            },
          ],
        } as unknown as Slot,
      ],
      siblingIntercepts: [
        { pagePath: "/app/(.)settings/page.tsx" },
      ] as unknown as AppRoute["siblingIntercepts"],
    };
    expect(collectAppRouteConfigModulePaths(route)).toEqual([
      "/app/page.tsx",
      "/app/@modal/(.)photos/[id]/page.tsx",
      "/app/@modal/(.)photos/layout.tsx",
      "/app/(.)settings/page.tsx",
    ]);
  });
});
