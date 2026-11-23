import { describe, expect, it } from "vite-plus/test";
import {
  appendToChunkCode,
  collectPagesPageStylesheets,
  pagesStylesheetUrl,
  withoutPreloadedStylesheets,
} from "../packages/vinext/src/build/pages-page-stylesheets.js";
import { collectAssetTags } from "../packages/vinext/src/server/pages-asset-tags.js";
import { withAbsoluteUrls } from "../packages/vinext/src/shims/internal/pages-stylesheets.js";
import { manifestFileWithBase } from "../packages/vinext/src/utils/manifest-paths.js";

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
    ).toEqual({
      routes: { "/alpha": ["alpha.css"] },
      shared: [],
      routeChunks: { "/alpha": "alpha.js", "/bare": "bare.js" },
    });
  });

  // Next.js lists these in its dynamic CSS manifest, which keeps their server
  // links. That includes a page that another page imports with `import()`.
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
      shared: ["card.css", "beta.css"],
      routeChunks: { "/alpha": "alpha.js", "/beta": "beta.js" },
    });
  });

  it("leaves out the dynamic imports of a hybrid build's App Router chunks", () => {
    expect(
      collect([
        chunk("entry.js", { module: "entry", dynamicImports: ["alpha.js"] }),
        chunk("alpha.js", { module: "/pages/alpha.tsx", imports: ["card.js"] }),
        chunk("card.js", { css: ["card.css"] }),
        chunk("app-browser.js", { module: "app-browser-entry", dynamicImports: ["dialog.js"] }),
        chunk("dialog.js", { module: "/app/dialog.tsx", imports: ["card.js"] }),
      ]).shared,
    ).toEqual([]);
  });
});

describe("withoutPreloadedStylesheets", () => {
  const code =
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["/_next/static/chunks/alpha.js","/_next/static/css/alpha.css?dpl=1","/_next/static/css/app.css?dpl=1"])))=>i.map(i=>d[i]);\n' +
    'const p=window.__VINEXT_PAGE_LOADERS__={"/alpha":()=>a(()=>import("./alpha.js"),__vite__mapDeps([0,1,2])),"/beta":()=>b(()=>import(`./beta.js`),__vite__mapDeps([1]))};';
  const strip = (
    source: string,
    stylesheets: string[],
    renderBuiltUrl?: Parameters<typeof withoutPreloadedStylesheets>[1]["renderBuiltUrl"],
  ) =>
    withoutPreloadedStylesheets(
      { code: source, fileName: "_next/static/chunks/entry.js" },
      {
        stylesheets: new Set(stylesheets),
        routeChunks: {
          "/alpha": "_next/static/chunks/alpha.js",
          "/beta": "_next/static/chunks/beta.js",
        },
        renderBuiltUrl,
      },
    );

  it("keeps page stylesheets out of what page loaders preload", () => {
    const result = strip(code, ["_next/static/css/alpha.css"]);
    expect(result).toContain("__vite__mapDeps([0,2  ])");
    expect(result).toContain("__vite__mapDeps([ ])");
    // The same length on each line keeps the source map lined up.
    expect(result.split("\n").map((line) => line.length)).toEqual(
      code.split("\n").map((line) => line.length),
    );
  });

  // Such as a `next/dynamic` component that `instrumentation-client` imports.
  it("lets the chunk's other dynamic imports preload them", () => {
    const widget = `${code}c(()=>import("./widget.js"),__vite__mapDeps([1]));`;
    expect(strip(widget, ["_next/static/css/alpha.css"])).toContain(
      'c(()=>import("./widget.js"),__vite__mapDeps([1]))',
    );
  });

  // No router stylesheet load follows them.
  it("lets other imports of a page preload its stylesheets", () => {
    const other = `${code}c(()=>import("./alpha.js"),__vite__mapDeps([0,1,2]));`;
    expect(strip(other, ["_next/static/css/alpha.css"])).toContain(
      'c(()=>import("./alpha.js"),__vite__mapDeps([0,1,2]))',
    );
    const map = `${code}const m={"/alpha":()=>c(()=>import("./alpha.js"),__vite__mapDeps([0,1,2]))};`;
    expect(strip(map, ["_next/static/css/alpha.css"])).toContain(
      'const m={"/alpha":()=>c(()=>import("./alpha.js"),__vite__mapDeps([0,1,2]))}',
    );
  });

  it("leaves strings and comments alone", () => {
    const text = `${code}\nconst s="__vite__mapDeps([1])";/* __vite__mapDeps([1]) */`;
    const result = strip(text, ["_next/static/css/alpha.css"]);
    expect(result).toContain('const s="__vite__mapDeps([1])";/* __vite__mapDeps([1]) */');
  });

  it("resolves relative preload URLs against the chunk", () => {
    const relative = code.replaceAll("/_next/static/css/", "../css/");
    expect(strip(relative, ["_next/static/css/app.css"])).toContain("__vite__mapDeps([0,1  ])");
  });

  // Vite adds the runtime expressions that `renderBuiltUrl` returns as they are.
  it("finds stylesheets that renderBuiltUrl renders at runtime", () => {
    const runtime = (file: string) =>
      `__assetUrl(\n  ${JSON.stringify(file)}.replace(/[)\\]]/g, "") /* ] */,\n  "a,b",\n)`;
    const table = [
      "_next/static/chunks/alpha.js",
      "_next/static/css/alpha.css",
      "_next/static/css/app.css",
    ]
      .map(runtime)
      .join(",");
    const runtimeCode =
      `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=[${table}])))=>i.map(i=>d[i]);\n` +
      'window.__VINEXT_PAGE_LOADERS__={"/alpha":()=>a(()=>import("./alpha.js"),__vite__mapDeps([0,1,2]))};';
    expect(
      strip(runtimeCode, ["_next/static/css/alpha.css"], (file) => ({ runtime: runtime(file) })),
    ).toContain("__vite__mapDeps([0,2  ])");
  });

  it("finds stylesheets that renderBuiltUrl renders as other URLs", () => {
    const cdnCode = code.replace(
      '"/_next/static/css/alpha.css?dpl=1"',
      '"https://cdn.example.com/page.css"',
    );
    expect(
      strip(cdnCode, ["_next/static/css/alpha.css"], (file) =>
        file === "_next/static/css/alpha.css" ? "https://cdn.example.com/page.css" : undefined,
      ),
    ).toContain("__vite__mapDeps([0,2  ])");
  });

  it("leaves chunks without preloads alone", () => {
    const plain = 'a(()=>import("./alpha.js"),[]);';
    expect(strip(plain, ["_next/static/css/alpha.css"])).toBe(plain);
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

describe("pagesStylesheetUrl", () => {
  const file = "_next/static/css/alpha.css";
  const options: Parameters<typeof pagesStylesheetUrl>[1] = {
    base: "/",
    basePath: "",
    assetPrefix: "",
  };

  // As the server links them.
  it.each([
    [options, "/_next/static/css/alpha.css"],
    [{ ...options, base: "/docs/", basePath: "/docs" }, "/docs/_next/static/css/alpha.css"],
    [
      { ...options, base: "/docs/", basePath: "/docs", assetPrefix: "https://cdn.example.com" },
      "https://cdn.example.com/_next/static/css/alpha.css",
    ],
    [{ ...options, deploymentId: "1" }, "/_next/static/css/alpha.css?dpl=1"],
  ])("links %o's stylesheets at %s", (config, url) => {
    expect(pagesStylesheetUrl(file, config)).toBe(url);
    const tags = collectAssetTags({
      manifest: { "pages/alpha.tsx": [manifestFileWithBase(file, config.base)] },
      moduleIds: ["pages/alpha.tsx"],
      disableOptimizedLoading: false,
      basePath: config.basePath,
      assetPrefix: config.assetPrefix,
      deploymentId: config.deploymentId,
    });
    expect(tags).toContain(`<link rel="stylesheet" href="${url}" />`);
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

  it("decodes the escapes in url()s", () => {
    expect(
      withAbsoluteUrls('.a{x:url(a\\).png)}.b{x:url("b\\"c.png")}.c{x:url(\\64 .png)}', href),
    ).toBe(
      '.a{x:url("https://example.com/_next/static/css/a).png")}' +
        '.b{x:url("https://example.com/_next/static/css/b%22c.png")}' +
        '.c{x:url("https://example.com/_next/static/css/d.png")}',
    );
  });

  it("leaves root-relative, fragment and absolute url()s alone", () => {
    const text =
      ".a{x:url(/a.png)}.b{x:url(//cdn.example.com/b.png)}.c{x:url(#c)}" +
      '.d{x:url("data:image/png;base64,AA==")}.e{x:url(https://cdn.example.com/e.png)}';
    expect(withAbsoluteUrls(text, href)).toBe(text);
  });
});
