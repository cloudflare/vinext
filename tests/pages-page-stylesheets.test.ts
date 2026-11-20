import { describe, expect, it } from "vite-plus/test";
import {
  collectPagesPageStylesheets,
  withoutPreloadedStylesheets,
} from "../packages/vinext/src/build/pages-page-stylesheets.js";

function chunk(
  fileName: string,
  options: {
    module?: string;
    imports?: string[];
    dynamicImports?: string[];
    css?: string[];
  } = {},
) {
  return {
    type: "chunk",
    fileName,
    facadeModuleId: options.module ?? null,
    imports: options.imports ?? [],
    dynamicImports: options.dynamicImports ?? [],
    viteMetadata: { importedCss: new Set(options.css ?? []) },
  };
}

const ROUTES: Record<string, string> = {
  "/pages/alpha.tsx": "/alpha",
  "/pages/beta.tsx": "/beta",
  "/pages/bare.tsx": "/bare",
};

function collect(chunks: ReturnType<typeof chunk>[]) {
  return collectPagesPageStylesheets(
    Object.fromEntries(chunks.map((item) => [item.fileName, item])),
    {
      routeOf: (id) => ROUTES[id],
      isAlwaysLoaded: (id) => id === "entry" || id === "/pages/_app.tsx",
      loaderChunk: "entry.js",
    },
  );
}

describe("collectPagesPageStylesheets", () => {
  // Ported from Next.js: test/e2e/css-features/css-modules-ordering.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/css-features/css-modules-ordering.test.ts
  it("lists the stylesheets of a page's imports before its own", () => {
    expect(
      collect([
        chunk("alpha.js", {
          module: "/pages/alpha.tsx",
          imports: ["panel.js"],
          css: ["alpha.css"],
        }),
        chunk("panel.js", { imports: ["base.js"], css: ["panel.css"] }),
        chunk("base.js", { css: ["base.css"] }),
      ]).routes,
    ).toEqual({ "/alpha": ["base.css", "panel.css", "alpha.css"] });
  });

  it("leaves out the stylesheets that every page loads with _app", () => {
    expect(
      collect([
        chunk("entry.js", { module: "entry", dynamicImports: ["app.js", "alpha.js", "bare.js"] }),
        chunk("app.js", { module: "/pages/_app.tsx", imports: ["shared.js"], css: ["app.css"] }),
        chunk("shared.js", { css: ["shared.css"] }),
        chunk("alpha.js", {
          module: "/pages/alpha.tsx",
          imports: ["shared.js"],
          css: ["alpha.css"],
        }),
        chunk("bare.js", { module: "/pages/bare.tsx", imports: ["shared.js"] }),
      ]),
    ).toEqual({ routes: { "/alpha": ["alpha.css"] }, shared: [], unpreloaded: ["alpha.css"] });
  });

  // Next.js lists these in its dynamic CSS manifest, which keeps their server links.
  it("keeps the links of page stylesheets that other dynamic imports load too", () => {
    expect(
      collect([
        chunk("entry.js", { module: "entry", dynamicImports: ["alpha.js", "beta.js"] }),
        chunk("alpha.js", {
          module: "/pages/alpha.tsx",
          imports: ["card.js"],
          dynamicImports: ["dialog.js", "beta.js"],
          css: ["alpha.css"],
        }),
        chunk("dialog.js", { module: "/components/dialog.tsx", imports: ["card.js"] }),
        chunk("card.js", { css: ["card.css"] }),
        chunk("beta.js", { module: "/pages/beta.tsx", css: ["beta.css"] }),
      ]),
    ).toEqual({
      routes: { "/alpha": ["card.css", "alpha.css"], "/beta": ["beta.css"] },
      shared: ["card.css"],
      unpreloaded: ["card.css", "alpha.css", "beta.css"],
    });
  });

  it("lets the loader chunk's other dynamic imports preload their stylesheets", () => {
    expect(
      collect([
        chunk("entry.js", { module: "entry", dynamicImports: ["alpha.js", "widget.js"] }),
        chunk("alpha.js", { module: "/pages/alpha.tsx", imports: ["card.js"] }),
        chunk("widget.js", { module: "/lib/widget.tsx", imports: ["card.js"] }),
        chunk("card.js", { css: ["card.css"] }),
      ]).unpreloaded,
    ).toEqual([]);
  });
});

describe("withoutPreloadedStylesheets", () => {
  const code =
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["/_next/static/chunks/alpha.js","/_next/static/css/alpha.css?dpl=1","/_next/static/css/app.css?dpl=1"])))=>i.map(i=>d[i]);\n' +
    'a(()=>import("./alpha.js"),__vite__mapDeps([0,1,2]));b(()=>import("./beta.js"),__vite__mapDeps([1]));';

  it("keeps page stylesheets out of what dynamic imports preload", () => {
    const result = withoutPreloadedStylesheets(
      { code, fileName: "_next/static/chunks/entry.js" },
      new Set(["_next/static/css/alpha.css"]),
    );
    expect(result).toContain("__vite__mapDeps([0,2  ])");
    expect(result).toContain("__vite__mapDeps([ ])");
    // The same length on each line keeps the source map lined up.
    expect(result.split("\n").map((line) => line.length)).toEqual(
      code.split("\n").map((line) => line.length),
    );
  });

  it("resolves relative preload URLs against the chunk", () => {
    const relative = code.replaceAll("/_next/static/css/", "../css/");
    expect(
      withoutPreloadedStylesheets(
        { code: relative, fileName: "_next/static/chunks/entry.js" },
        new Set(["_next/static/css/app.css"]),
      ),
    ).toContain("__vite__mapDeps([0,1  ])");
  });

  it("leaves chunks without preloads alone", () => {
    const plain = 'a(()=>import("./alpha.js"),[]);';
    expect(
      withoutPreloadedStylesheets(
        { code: plain, fileName: "entry.js" },
        new Set(["_next/static/css/alpha.css"]),
      ),
    ).toBe(plain);
  });
});
