/**
 * Build report tests — verifies route classification, formatting, and sorting.
 *
 * Tests the AST-based export detection helpers and the classification
 * logic for both Pages Router and App Router routes, using real fixture files
 * where integration testing is needed.
 */
import { describe, it, expect } from "vite-plus/test";
import path from "node:path";
import {
  hasNamedExport,
  extractExportConstString,
  extractExportConstNumber,
  extractGetStaticPropsRevalidate,
  classifyPagesRoute,
  classifyAppRoute,
  buildReportRows,
  formatBuildReport,
} from "../packages/vinext/src/build/report.js";

const FIXTURES_PAGES = path.resolve("tests/fixtures/pages-basic/pages");
const FIXTURES_BUILD_REPORT = path.resolve("tests/fixtures/build-report/pages");
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
    expect(hasNamedExport("export { getStaticProps as gsp };", "gsp")).toBe(true);
  });

  it("detects aliased export name from a local binding", () => {
    expect(hasNamedExport("const foo = 1; export { foo as revalidate };", "revalidate")).toBe(true);
  });

  it("does not treat the local side of an aliased export as the exported name", () => {
    expect(hasNamedExport("export { getStaticProps as helper };", "getStaticProps")).toBe(false);
  });

  it("returns false when export is absent", () => {
    expect(hasNamedExport("export default function Page() {}", "getStaticProps")).toBe(false);
  });

  it("does not treat default-exported getStaticProps as a named export", () => {
    expect(hasNamedExport("export default function getStaticProps() {}", "getStaticProps")).toBe(
      false,
    );
  });

  it("does not treat default-exported getServerSideProps as a named export", () => {
    expect(
      hasNamedExport("export default async function getServerSideProps() {}", "getServerSideProps"),
    ).toBe(false);
  });

  it("does not treat `export type` re-exports as named runtime exports", () => {
    expect(
      hasNamedExport('export type { getStaticProps } from "./shared";', "getStaticProps"),
    ).toBe(false);
  });

  it("does not treat `export { type ... }` specifiers as named runtime exports", () => {
    expect(
      hasNamedExport('export { type getServerSideProps } from "./shared";', "getServerSideProps"),
    ).toBe(false);
  });

  it("does not treat declared exports as named runtime exports", () => {
    expect(
      hasNamedExport(
        "export declare function getServerSideProps(): Promise<void>;",
        "getServerSideProps",
      ),
    ).toBe(false);
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

  it("extracts value from an `as const` string export", () => {
    expect(
      extractExportConstString("export const dynamic = 'force-static' as const;", "dynamic"),
    ).toBe("force-static");
  });

  it("extracts value from a `satisfies` string export", () => {
    expect(
      extractExportConstString(
        "export const dynamic = 'force-static' satisfies string;",
        "dynamic",
      ),
    ).toBe("force-static");
  });

  it("returns null when export is absent", () => {
    expect(extractExportConstString("export const revalidate = 60;", "dynamic")).toBeNull();
  });

  it("returns null for non-string value", () => {
    expect(extractExportConstString("export const revalidate = 60;", "revalidate")).toBeNull();
  });

  it("extracts string from a local const re-exported by specifier", () => {
    expect(
      extractExportConstString("const mode = 'error'; export { mode as dynamic };", "dynamic"),
    ).toBe("error");
  });

  it("extracts string from a local const identifier alias", () => {
    expect(
      extractExportConstString("const mode = 'error'; export const dynamic = mode;", "dynamic"),
    ).toBe("error");
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

  it("extracts negative value", () => {
    expect(extractExportConstNumber("export const revalidate = -1;", "revalidate")).toBe(-1);
  });

  it("extracts with TypeScript type annotation", () => {
    expect(extractExportConstNumber("export const revalidate: number = 120;", "revalidate")).toBe(
      120,
    );
  });

  it("extracts from an `as const` numeric export", () => {
    expect(extractExportConstNumber("export const revalidate = 60 as const;", "revalidate")).toBe(
      60,
    );
  });

  it("extracts from a `satisfies` numeric export", () => {
    expect(
      extractExportConstNumber("export const revalidate = 60 satisfies number;", "revalidate"),
    ).toBe(60);
  });

  it("returns null when export is absent", () => {
    expect(extractExportConstNumber("export const dynamic = 'auto';", "revalidate")).toBeNull();
  });

  it("extracts number from a local const re-exported by specifier", () => {
    expect(
      extractExportConstNumber(
        "const interval = 120; export { interval as revalidate };",
        "revalidate",
      ),
    ).toBe(120);
  });

  it("extracts number from a local const identifier alias", () => {
    expect(
      extractExportConstNumber(
        "const interval = 120; export const revalidate = interval;",
        "revalidate",
      ),
    ).toBe(120);
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

  it("extracts revalidate from an `as const` value inside getStaticProps", () => {
    const code = `export async function getStaticProps() {
  return { props: {}, revalidate: 60 as const };
}`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60);
  });

  it("extracts revalidate from a `satisfies` value inside getStaticProps", () => {
    const code = `export async function getStaticProps() {
  return { props: {}, revalidate: 60 satisfies number };
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

  it("extracts revalidate from a generic arrow-function getStaticProps", () => {
    const code = `export const getStaticProps = <T>() => ({ props: {}, revalidate: 60 });`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60);
  });

  it("respects the provided file extension when parsing generic arrow getStaticProps", () => {
    const code = `export const getStaticProps = <T>() => ({ props: {}, revalidate: 60 });`;
    expect(extractGetStaticPropsRevalidate(code, "page.ts")).toBe(60);
    expect(extractGetStaticPropsRevalidate(code, "page.tsx")).toBeNull();
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

  it("ignores fallback-path returns when an imported getStaticProps is re-exported locally", () => {
    const code = `import { getStaticProps } from "./shared";
export { getStaticProps };

return { props: {}, revalidate: 1 };`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
  });

  it("handles inline comment after value (fixture file style)", () => {
    // From tests/fixtures/pages-basic/pages/isr-test.tsx:
    //   revalidate: 1, // Revalidate every 1 second
    const code = `return { props: {}, revalidate: 1, // comment\n};`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(1);
  });

  it("extracts revalidate when getStaticProps is exported under an alias", () => {
    const code = `const loadStaticProps = async () => {
  return { props: {}, revalidate: 60 };
};

export { loadStaticProps as getStaticProps };`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60);
  });

  it("extracts revalidate when getStaticProps is exported before its local declaration", () => {
    const code = `export { getStaticProps };

const getStaticProps = async () => {
  return { props: {}, revalidate: 60 };
};`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60);
  });

  it("extracts revalidate when getStaticProps is exported via a local identifier alias", () => {
    const code = `const loadStaticProps = async () => ({ props: {}, revalidate: 60 });
export const getStaticProps = loadStaticProps;`;
    expect(extractGetStaticPropsRevalidate(code)).toBe(60);
  });

  it("does not fall back to unrelated top-level returns for non-analyzable local getStaticProps", () => {
    const code = `function createGSP() {
  return async function generatedGetStaticProps() {
    return { props: {}, revalidate: 60 };
  };
}

export const getStaticProps = createGSP();

return { props: {}, revalidate: 1 };`;
    expect(extractGetStaticPropsRevalidate(code)).toBeNull();
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

  it("does not classify an aliased local export as getStaticProps", () => {
    const filePath = path.join(FIXTURES_BUILD_REPORT, "build-report-alias-export.tsx");
    expect(classifyPagesRoute(filePath)).toEqual({ type: "static" });
  });

  it("classifies a generic-arrow getStaticProps in a .ts file as isr", () => {
    const filePath = path.join(FIXTURES_BUILD_REPORT, "build-report-generic-gsp.ts");
    expect(classifyPagesRoute(filePath)).toEqual({ type: "isr", revalidate: 60 });
  });

  it("does not classify a default-exported getStaticProps as data fetching", () => {
    const filePath = path.resolve(
      path.join(FIXTURES_BUILD_REPORT, "build-report-default-export-gsp.tsx"),
    );
    expect(classifyPagesRoute(filePath)).toEqual({ type: "static" });
  });

  it("does not classify a default-exported getServerSideProps as data fetching", () => {
    const filePath = path.resolve(
      path.join(FIXTURES_BUILD_REPORT, "build-report-default-export-gssp.tsx"),
    );
    expect(classifyPagesRoute(filePath)).toEqual({ type: "static" });
  });

  it("does not classify type-only getStaticProps exports as data fetching", () => {
    const filePath = path.resolve(
      path.join(FIXTURES_BUILD_REPORT, "build-report-type-only-gsp.tsx"),
    );
    expect(classifyPagesRoute(filePath)).toEqual({ type: "static" });
  });

  it("does not classify type-only getServerSideProps exports as data fetching", () => {
    const filePath = path.resolve(
      path.join(FIXTURES_BUILD_REPORT, "build-report-type-only-gssp.tsx"),
    );
    expect(classifyPagesRoute(filePath)).toEqual({ type: "static" });
  });

  it("classifies direct getStaticProps re-exports as unknown", () => {
    const filePath = path.join(FIXTURES_BUILD_REPORT, "build-report-reexport-gsp.tsx");
    expect(classifyPagesRoute(filePath)).toEqual({ type: "unknown" });
  });

  it("classifies imported getStaticProps re-exports as unknown", () => {
    const filePath = path.resolve(
      path.join(FIXTURES_BUILD_REPORT, "build-report-import-reexport-gsp.tsx"),
    );
    expect(classifyPagesRoute(filePath)).toEqual({ type: "unknown" });
  });

  it("classifies local identifier-aliased getStaticProps as isr", () => {
    const filePath = path.resolve(
      path.join(FIXTURES_BUILD_REPORT, "build-report-local-identifier-gsp.tsx"),
    );
    expect(classifyPagesRoute(filePath)).toEqual({ type: "isr", revalidate: 60 });
  });

  it("classifies non-analyzable local getStaticProps factories as unknown", () => {
    const filePath = path.join(FIXTURES_BUILD_REPORT, "build-report-factory-gsp.tsx");
    expect(classifyPagesRoute(filePath)).toEqual({ type: "unknown" });
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

  it("upgrades unknown Pages routes to static when speculative prerender rendered them", () => {
    const pageRoutes = [
      {
        pattern: "/reexported-gsp",
        patternParts: ["/reexported-gsp"],
        filePath: path.join(FIXTURES_BUILD_REPORT, "build-report-reexport-gsp.tsx"),
        isDynamic: false,
        params: [],
      },
    ];

    const rows = buildReportRows({
      pageRoutes,
      prerenderResult: {
        routes: [
          {
            route: "/reexported-gsp",
            status: "rendered",
            outputFiles: ["index.html"],
            revalidate: false,
          },
        ],
      },
    });

    expect(rows).toEqual([{ pattern: "/reexported-gsp", type: "static", prerendered: true }]);
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
