import { describe, expect, it } from "vite-plus/test";
import {
  appendToChunkCode,
  builtUrlExpression,
  collectPagesPageStylesheets,
  withoutPreloadedStylesheets,
} from "../packages/vinext/src/build/pages-page-stylesheets.js";
import { withAbsoluteUrls } from "../packages/vinext/src/shims/internal/pages-stylesheets.js";

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

  // Vite adds the runtime expressions that `renderBuiltUrl` returns as they are.
  it("finds stylesheets that renderBuiltUrl renders at runtime", () => {
    const runtime = (file: string) => `__assetUrl(\n  ${JSON.stringify(file)},\n  "a,b",\n)`;
    const table = [
      "_next/static/chunks/alpha.js",
      "_next/static/css/alpha.css",
      "_next/static/css/app.css",
    ]
      .map(runtime)
      .join(",");
    const runtimeCode =
      `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=[${table}])))=>i.map(i=>d[i]);\n` +
      'a(()=>import("./alpha.js"),__vite__mapDeps([0,1,2]));';
    expect(
      withoutPreloadedStylesheets(
        { code: runtimeCode, fileName: "_next/static/chunks/entry.js" },
        new Set(["_next/static/css/alpha.css"]),
        (file) => ({ runtime: runtime(file) }),
      ),
    ).toContain("__vite__mapDeps([0,2  ])");
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

describe("appendToChunkCode", () => {
  it("adds the code on its own line", () => {
    expect(appendToChunkCode("a();", "b();")).toBe("a();\nb();");
  });

  it("keeps the source map comment last", () => {
    expect(appendToChunkCode("a();\n//# sourceMappingURL=entry.js.map\n", "b();")).toBe(
      "a();\nb();\n//# sourceMappingURL=entry.js.map\n",
    );
  });
});

describe("builtUrlExpression", () => {
  const file = "_next/static/css/alpha.css";
  const hostId = "_next/static/chunks/entry.js";
  const relativeUrl = 'new URL("../css/alpha.css",import.meta.url).href';

  it("joins the base and the file", () => {
    expect(builtUrlExpression(file, hostId, { base: "/docs/" })).toBe(
      '"/docs/_next/static/css/alpha.css"',
    );
  });

  // Vite resolves relative-base URLs in JavaScript against the chunk, not the page.
  it.each(["./", ""])("resolves the file against the chunk with base %j", (base) => {
    expect(builtUrlExpression(file, hostId, { base })).toBe(relativeUrl);
  });

  it("uses what renderBuiltUrl returns", () => {
    const renderBuiltUrl = (filename: string, context: { hostId: string; hostType: string }) =>
      `https://cdn.example.com/${filename}?host=${context.hostType}:${context.hostId}`;
    expect(builtUrlExpression(file, hostId, { base: "/", renderBuiltUrl })).toBe(
      JSON.stringify(`https://cdn.example.com/${file}?host=js:${hostId}`),
    );
    expect(
      builtUrlExpression(file, hostId, {
        base: "/",
        renderBuiltUrl: () => ({ runtime: "assetUrl(name)" }),
      }),
    ).toBe("(assetUrl(name))");
    expect(
      builtUrlExpression(file, hostId, { base: "/", renderBuiltUrl: () => ({ relative: true }) }),
    ).toBe(relativeUrl);
    expect(
      builtUrlExpression(file, hostId, { base: "./", renderBuiltUrl: () => ({ relative: false }) }),
    ).toBe('"./_next/static/css/alpha.css"');
    expect(
      builtUrlExpression(file, hostId, { base: "/docs/", renderBuiltUrl: () => undefined }),
    ).toBe('"/docs/_next/static/css/alpha.css"');
  });
});

describe("withAbsoluteUrls", () => {
  const href = "https://example.com/_next/static/css/alpha.css";

  // A `<style>` tag resolves them against the page instead.
  it("resolves relative url()s against the stylesheet", () => {
    expect(
      withAbsoluteUrls(
        ".a{background:url(../media/a.png)}.b{src:url(\"./b.woff2\")}.c{x:url( 'c.svg#i' )}",
        href,
      ),
    ).toBe(
      '.a{background:url("https://example.com/_next/static/media/a.png")}' +
        '.b{src:url("https://example.com/_next/static/css/b.woff2")}' +
        '.c{x:url("https://example.com/_next/static/css/c.svg#i")}',
    );
  });

  it("skips strings and comments and reads quoted url()s whole", () => {
    expect(
      withAbsoluteUrls(
        '/* url(a.png) */.a{content:"url(b.png)"}.c{x:url("c (1).png")}.d{x:URL( d.png )}',
        href,
      ),
    ).toBe(
      '/* url(a.png) */.a{content:"url(b.png)"}' +
        '.c{x:url("https://example.com/_next/static/css/c%20(1).png")}' +
        '.d{x:url("https://example.com/_next/static/css/d.png")}',
    );
  });

  it("leaves root-relative, fragment and absolute url()s alone", () => {
    const text =
      ".a{x:url(/a.png)}.b{x:url(//cdn.example.com/b.png)}.c{x:url(#c)}" +
      '.d{x:url("data:image/png;base64,AA==")}.e{x:url(https://cdn.example.com/e.png)}';
    expect(withAbsoluteUrls(text, href)).toBe(text);
  });
});
