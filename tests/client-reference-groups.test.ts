import { describe, expect, it } from "vite-plus/test";
import { hasUserClientChunkGroups } from "../packages/vinext/src/build/client-build-config.js";
import {
  collectClientReferencePreloadPlan,
  collectClientReferenceRouteSignatures,
  measureClientReferenceGroupCosts,
  planClientReferenceGroups,
  readClientModuleBindings,
} from "../packages/vinext/src/build/client-reference-groups.js";

function route(pattern: string, pagePath: string, layouts: string[] = []) {
  return {
    errorPath: null,
    errorPaths: [],
    forbiddenPath: null,
    forbiddenPaths: [],
    layoutErrorPaths: [],
    layouts,
    loadingPath: null,
    notFoundPath: null,
    notFoundPaths: [],
    pagePath,
    parallelSlots: [],
    pattern,
    siblingIntercepts: [],
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [],
  };
}

function moduleInfo(graph: Record<string, string[]>, dynamicGraph: Record<string, string[]> = {}) {
  return (id: string) => ({
    dynamicallyImportedIds: dynamicGraph[id] ?? [],
    importedIds: graph[id] ?? [],
  });
}

function loader(modules: Record<string, { bytes: number; imports?: string[] }>) {
  return async (id: string) => {
    const module = modules[id];
    if (!module) throw new Error(`missing ${id}`);
    return { code: "x".repeat(module.bytes), importedIds: module.imports ?? [] };
  };
}

describe("collectClientReferenceRouteSignatures", () => {
  it("signs references by the routes that reach them, except below dynamic imports", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set([
        "/nav.tsx",
        "/theme.tsx",
        "/chart.tsx",
        "/lazy.tsx",
        "/lazy-panel.tsx",
        "/orphan",
      ]),
      getModuleInfo: moduleInfo(
        {
          "/app/layout.tsx": ["/header.tsx", "/theme.tsx"],
          "/header.tsx": ["/nav.tsx"],
          "/app/page.tsx": ["/chart.tsx", "/nav.tsx"],
          "/about/lazy-section.tsx": ["/lazy-panel.tsx"],
        },
        { "/app/about/page.tsx": ["/lazy.tsx", "/about/lazy-section.tsx"] },
      ),
      root: "/",
      routes: [
        route("/", "/app/page.tsx", ["/app/layout.tsx"]),
        route("/about", "/app/about/page.tsx", ["/app/layout.tsx"]),
      ],
    });

    expect(Object.fromEntries(signatures)).toEqual({
      "/chart.tsx": "/",
      "/nav.tsx": "/\n/about",
      "/theme.tsx": "/\n/about",
    });
  });

  it("gives intercepts and shared roots their own file owners", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set([
        "/retry.tsx",
        "/search.tsx",
        "/modal.tsx",
        "/drawer.tsx",
        "/grid.tsx",
        "/denied.tsx",
        "/sign-in.tsx",
        "/missing.tsx",
      ]),
      getModuleInfo: moduleInfo({
        "/repo/app/global-error.tsx": ["/retry.tsx"],
        "/repo/app/global-not-found.tsx": ["/search.tsx"],
        "/repo/app/photos/page.tsx": ["/grid.tsx"],
        "/repo/app/@modal/(.)photo/page.tsx": ["/modal.tsx"],
        "/repo/app/@modal/(.)photo/forbidden.tsx": ["/denied.tsx"],
        "/repo/app/@modal/(.)photo/unauthorized.tsx": ["/sign-in.tsx"],
        "/repo/app/photos/@drawer/(.)photo/page.tsx": ["/drawer.tsx"],
        "/repo/app/photos/@drawer/not-found.tsx": ["/missing.tsx"],
      }),
      root: "/repo",
      routes: [
        {
          ...route("/photos", "/repo/app/photos/page.tsx"),
          parallelSlots: [
            {
              interceptingRoutes: [
                {
                  layoutPaths: [],
                  notFoundPath: null,
                  notFoundPaths: ["/repo/app/photos/@drawer/not-found.tsx"],
                  pagePath: "/repo/app/photos/@drawer/(.)photo/page.tsx",
                },
              ],
            },
          ],
          siblingIntercepts: [
            {
              forbiddenPath: "/repo/app/@modal/(.)photo/forbidden.tsx",
              layoutPaths: [],
              notFoundPath: null,
              pagePath: "/repo/app/@modal/(.)photo/page.tsx",
              unauthorizedPath: "/repo/app/@modal/(.)photo/unauthorized.tsx",
            },
          ],
        } as never,
      ],
      sharedRoots: ["/repo/app/global-error.tsx", "/repo/app/global-not-found.tsx"],
    });

    expect(Object.fromEntries(signatures)).toEqual({
      "/grid.tsx": "/photos",
      "/modal.tsx": "app/@modal/(.)photo/page.tsx",
      "/denied.tsx": "app/@modal/(.)photo/page.tsx",
      "/sign-in.tsx": "app/@modal/(.)photo/page.tsx",
      "/drawer.tsx": "app/photos/@drawer/(.)photo/page.tsx",
      "/missing.tsx": "app/photos/@drawer/(.)photo/page.tsx",
      "/retry.tsx": "app/global-error.tsx",
      "/search.tsx": "app/global-not-found.tsx",
    });
  });

  it("does not walk through client references", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set(["/client.tsx", "/inner.tsx"]),
      getModuleInfo: moduleInfo({
        "/app/page.tsx": ["/client.tsx"],
        "/client.tsx": ["/inner.tsx"],
      }),
      root: "/",
      routes: [route("/", "/app/page.tsx")],
    });

    expect([...signatures.keys()]).toEqual(["/client.tsx"]);
  });

  it("orders references by module evaluation order", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set(["/a.tsx", "/b.tsx", "/c.tsx"]),
      getModuleInfo: moduleInfo({
        "/app/page.tsx": ["/helper.ts", "/a.tsx", "/c.tsx"],
        "/helper.ts": ["/b.tsx", "/c.tsx"],
      }),
      root: "/",
      routes: [route("/", "/app/page.tsx")],
    });

    expect([...signatures.keys()]).toEqual(["/b.tsx", "/c.tsx", "/a.tsx"]);
  });

  it("orders a route's references outer segment first", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set([
        "/page-ref.tsx",
        "/root-ref.tsx",
        "/shop-ref.tsx",
        "/tpl-ref.tsx",
        "/app/shop/loading.tsx",
        "/app/shop/not-found.tsx",
      ]),
      getModuleInfo: moduleInfo({
        "/app/shop/page.tsx": ["/page-ref.tsx", "/shop-ref.tsx"],
        "/app/shop/layout.tsx": ["/shop-ref.tsx"],
        "/app/shop/template.tsx": ["/tpl-ref.tsx"],
        "/app/layout.tsx": ["/root-ref.tsx"],
      }),
      root: "/",
      routes: [
        {
          ...route("/shop", "/app/shop/page.tsx", ["/app/layout.tsx", "/app/shop/layout.tsx"]),
          loadingPath: "/app/shop/loading.tsx",
          notFoundPath: "/app/shop/not-found.tsx",
          templates: ["/app/shop/template.tsx"],
        },
      ],
    });

    expect([...signatures.keys()]).toEqual([
      "/root-ref.tsx",
      "/shop-ref.tsx",
      "/tpl-ref.tsx",
      "/app/shop/not-found.tsx",
      "/app/shop/loading.tsx",
      "/page-ref.tsx",
    ]);
  });

  it("canonicalizes route files before walking the module graph", () => {
    const signatures = collectClientReferenceRouteSignatures({
      canonicalizeModuleId: (id) => id.replace("/var/", "/private/var/"),
      clientReferenceIds: new Set(["/nav.tsx"]),
      getModuleInfo: moduleInfo({ "/private/var/app/page.tsx": ["/nav.tsx"] }),
      root: "/var",
      routes: [route("/", "/var/app/page.tsx")],
    });

    expect(signatures.get("/nav.tsx")).toBe("/");
  });
});

describe("collectClientReferencePreloadPlan", () => {
  function preloads(plan: ReturnType<typeof collectClientReferencePreloadPlan>, files: number[]) {
    return [...new Set([...plan.always, ...files.flatMap((file) => plan.files[file]!)])].sort();
  }

  it("preloads what each route reaches, through dynamic imports too", () => {
    const plan = collectClientReferencePreloadPlan({
      clientReferenceIds: new Set(["/nav.tsx", "/chart.tsx", "/lazy.tsx", "/lazy-panel.tsx"]),
      entryIds: ["\0entry"],
      getModuleInfo: moduleInfo(
        {
          "\0entry": ["/app/layout.tsx", "/app/page.tsx", "/app/about/page.tsx"],
          "/app/layout.tsx": ["/nav.tsx"],
          "/app/page.tsx": ["/chart.tsx"],
          "/about/lazy-section.tsx": ["/lazy-panel.tsx"],
        },
        { "/app/about/page.tsx": ["/lazy.tsx", "/about/lazy-section.tsx"] },
      ),
      routes: [
        route("/", "/app/page.tsx", ["/app/layout.tsx"]),
        route("/about", "/app/about/page.tsx", ["/app/layout.tsx"]),
      ],
    });

    expect(plan.always).toEqual([]);
    expect(preloads(plan, plan.routes.get("/")!)).toEqual(["/chart.tsx", "/nav.tsx"]);
    expect(preloads(plan, plan.routes.get("/about")!)).toEqual([
      "/lazy-panel.tsx",
      "/lazy.tsx",
      "/nav.tsx",
    ]);
  });

  it("lets routes stream only references no dynamic import reaches", () => {
    const plan = collectClientReferencePreloadPlan({
      alwaysRoots: ["/app/global-error.tsx"],
      clientReferenceIds: new Set([
        "/nav.tsx",
        "/chart.tsx",
        "/lazy.tsx",
        "/shared.tsx",
        "/error-ref.tsx",
      ]),
      entryIds: ["\0entry"],
      getModuleInfo: moduleInfo(
        {
          "/app/layout.tsx": ["/nav.tsx"],
          "/app/page.tsx": ["/chart.tsx", "/shared.tsx"],
          "/app/global-error.tsx": ["/error-ref.tsx"],
        },
        {
          // The RSC entry imports route files lazily.
          "\0entry": ["/app/layout.tsx", "/app/page.tsx", "/app/about/page.tsx"],
          "/app/about/page.tsx": ["/lazy.tsx", "/shared.tsx"],
        },
      ),
      routes: [
        route("/", "/app/page.tsx", ["/app/layout.tsx"]),
        route("/about", "/app/about/page.tsx", ["/app/layout.tsx"]),
      ],
    });

    expect(plan.staticOnly.sort()).toEqual(["/chart.tsx", "/nav.tsx"]);
  });

  it("plans stylesheets from the static imports of the files that render with a route", () => {
    const plan = collectClientReferencePreloadPlan({
      clientReferenceIds: new Set([
        "/nav.tsx",
        "/spinner.tsx",
        "/panel.tsx",
        "/modal.tsx",
        "/retry.tsx",
        "/missing.tsx",
        "/lazy.tsx",
      ]),
      entryIds: [],
      getModuleInfo: moduleInfo(
        {
          "/app/layout.tsx": ["/nav.tsx"],
          "/app/loading.tsx": ["/spinner.tsx"],
          "/app/page.tsx": ["/panel.tsx"],
          "/app/error.tsx": ["/retry.tsx"],
          "/app/not-found.tsx": ["/missing.tsx"],
          "/app/@modal/page.tsx": ["/modal.tsx"],
        },
        { "/app/page.tsx": ["/lazy.tsx"] },
      ),
      routes: [
        {
          ...route("/", "/app/page.tsx", ["/app/layout.tsx"]),
          errorPath: "/app/error.tsx",
          loadingPath: "/app/loading.tsx",
          notFoundPath: "/app/not-found.tsx",
          parallelSlots: [{ interceptingRoutes: [], pagePath: "/app/@modal/page.tsx" }],
        } as never,
      ],
    });

    expect(plan.stylesheets.get("/")).toEqual([
      "/nav.tsx",
      "/spinner.tsx",
      "/panel.tsx",
      "/modal.tsx",
    ]);
  });

  it("always preloads references reached outside route files, from global-error or by nothing", () => {
    const plan = collectClientReferencePreloadPlan({
      alwaysRoots: ["/app/global-error.tsx"],
      clientReferenceIds: new Set([
        "/link.tsx",
        "/boundary.tsx",
        "/action-result.tsx",
        "/retry.tsx",
        "/chart.tsx",
        "/orphan.tsx",
      ]),
      entryIds: ["\0entry"],
      getModuleInfo: moduleInfo(
        {
          "\0entry": ["/runtime.ts", "/app/page.tsx", "/app/global-error.tsx"],
          "/runtime.ts": ["/boundary.tsx", "/default-not-found.tsx"],
          "/default-not-found.tsx": ["/link.tsx"],
          "/app/page.tsx": ["/link.tsx", "/chart.tsx"],
          "/app/global-error.tsx": ["/retry.tsx"],
          "/actions.ts": ["/action-result.tsx"],
        },
        { "\0entry": ["/actions.ts"] },
      ),
      routes: [route("/", "/app/page.tsx")],
    });

    // The page's own reference stays out of `always`, but one the runtime
    // also renders doesn't.
    expect([...plan.always].sort()).toEqual([
      "/action-result.tsx",
      "/boundary.tsx",
      "/link.tsx",
      "/orphan.tsx",
      "/retry.tsx",
    ]);
    expect(preloads(plan, plan.routes.get("/")!)).toContain("/chart.tsx");
  });

  it("preloads the routeless files for a render without a route", () => {
    const plan = collectClientReferencePreloadPlan({
      clientReferenceIds: new Set(["/nav.tsx", "/chart.tsx", "/search.tsx"]),
      entryIds: ["\0entry"],
      getModuleInfo: moduleInfo(
        {
          "\0entry": ["/app/layout.tsx", "/app/page.tsx"],
          "/app/layout.tsx": ["/nav.tsx"],
          "/app/page.tsx": ["/chart.tsx"],
          "/app/global-not-found.tsx": ["/search.tsx"],
        },
        { "\0entry": ["/app/global-not-found.tsx"] },
      ),
      routelessFiles: ["/app/layout.tsx", "/app/global-not-found.tsx"],
      routes: [route("/", "/app/page.tsx", ["/app/layout.tsx"])],
    });

    expect(plan.always).toEqual([]);
    expect(preloads(plan, plan.routeless)).toEqual(["/nav.tsx", "/search.tsx"]);
    expect(preloads(plan, plan.routes.get("/")!)).toEqual(["/chart.tsx", "/nav.tsx"]);
  });

  it("leaves intercepting routes out of every set", () => {
    const plan = collectClientReferencePreloadPlan({
      clientReferenceIds: new Set(["/grid.tsx", "/modal.tsx"]),
      entryIds: ["\0entry"],
      getModuleInfo: moduleInfo({
        "\0entry": ["/app/photos/page.tsx", "/app/@modal/(.)photo/page.tsx"],
        "/app/photos/page.tsx": ["/grid.tsx"],
        "/app/@modal/(.)photo/page.tsx": ["/modal.tsx"],
      }),
      routes: [
        {
          ...route("/photos", "/app/photos/page.tsx"),
          siblingIntercepts: [
            { layoutPaths: [], notFoundPath: null, pagePath: "/app/@modal/(.)photo/page.tsx" },
          ],
        } as never,
      ],
    });

    expect(plan.always).toEqual([]);
    expect(preloads(plan, plan.routes.get("/photos")!)).toEqual(["/grid.tsx"]);
  });

  it("leaves route files that are client references to their routes", () => {
    const plan = collectClientReferencePreloadPlan({
      clientReferenceIds: new Set([
        "/app/error.tsx",
        "/app/client/page.tsx",
        "/app/@modal/(.)photo/page.tsx",
      ]),
      entryIds: ["\0entry"],
      getModuleInfo: moduleInfo({
        "\0entry": [
          "/app/page.tsx",
          "/app/error.tsx",
          "/app/client/page.tsx",
          "/app/@modal/(.)photo/page.tsx",
        ],
      }),
      routes: [
        {
          ...route("/", "/app/page.tsx"),
          errorPath: "/app/error.tsx",
          siblingIntercepts: [
            { layoutPaths: [], notFoundPath: null, pagePath: "/app/@modal/(.)photo/page.tsx" },
          ],
        } as never,
        route("/client", "/app/client/page.tsx"),
      ],
    });

    expect(plan.always).toEqual([]);
    expect(preloads(plan, plan.routes.get("/")!)).toEqual(["/app/error.tsx"]);
    expect(preloads(plan, plan.routes.get("/client")!)).toEqual(["/app/client/page.tsx"]);
  });

  it("canonicalizes route files and entry stops", () => {
    const plan = collectClientReferencePreloadPlan({
      canonicalizeModuleId: (id) => id.replace("/link/", "/real/"),
      clientReferenceIds: new Set(["/chart.tsx"]),
      entryIds: ["\0entry"],
      getModuleInfo: moduleInfo({
        "\0entry": ["/real/app/page.tsx"],
        "/real/app/page.tsx": ["/chart.tsx"],
      }),
      routes: [route("/", "/link/app/page.tsx")],
    });

    expect(plan.always).toEqual([]);
    expect(preloads(plan, plan.routes.get("/")!)).toEqual(["/chart.tsx"]);
  });
});

describe("measureClientReferenceGroupCosts", () => {
  it("charges each reference for its own modules but not shared ones", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["a", "/a.tsx"],
        ["b", "/b.tsx"],
      ]),
      loadModule: loader({
        "/a.tsx": { bytes: 10, imports: ["/a-only.ts", "/shared.ts"] },
        "/b.tsx": { bytes: 20, imports: ["/shared.ts"] },
        "/a-only.ts": { bytes: 100 },
        "/shared.ts": { bytes: 1000 },
      }),
      isExcluded: () => false,
      isSideEffectFree: () => false,
    });

    expect(Object.fromEntries(costs)).toEqual({ a: 110, b: 20 });
  });

  it("charges a reference for the client references it statically imports", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["box", "/box.tsx"],
        ["code", "/code.tsx"],
      ]),
      loadModule: loader({
        "/box.tsx": { bytes: 10, imports: ["/code.tsx"] },
        "/code.tsx": { bytes: 50, imports: ["/highlighter.ts"] },
        "/highlighter.ts": { bytes: 5000 },
      }),
      isExcluded: () => false,
      isSideEffectFree: () => false,
    });

    expect(Object.fromEntries(costs)).toEqual({ box: 5060, code: 5050 });
  });

  it("finds imported references and unloadable modules below shared modules", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["a", "/a.tsx"],
        ["b", "/b.tsx"],
        ["code", "/code.tsx"],
        ["d", "/d.tsx"],
        ["e", "/e.tsx"],
      ]),
      loadModule: loader({
        "/a.tsx": { bytes: 10, imports: ["/ui.ts"] },
        "/b.tsx": { bytes: 20, imports: ["/ui.ts"] },
        "/ui.ts": { bytes: 1000, imports: ["/code.tsx"] },
        "/code.tsx": { bytes: 50, imports: ["/highlighter.ts"] },
        "/highlighter.ts": { bytes: 200 },
        "/d.tsx": { bytes: 10, imports: ["/flaky.ts"] },
        "/e.tsx": { bytes: 10, imports: ["/flaky.ts"] },
        "/flaky.ts": { bytes: 10, imports: ["/missing.ts"] },
      }),
      isExcluded: () => false,
      isSideEffectFree: () => false,
    });

    expect(Object.fromEntries(costs)).toEqual({ a: 260, b: 270, code: 250, d: null, e: null });
  });

  it("still charges modules shared only with a reference that failed to load", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["a", "/a.tsx"],
        ["broken", "/broken.tsx"],
      ]),
      loadModule: loader({
        "/a.tsx": { bytes: 10, imports: ["/shared.ts"] },
        "/broken.tsx": { bytes: 10, imports: ["/shared.ts", "/missing.ts"] },
        "/shared.ts": { bytes: 1000 },
      }),
      isExcluded: () => false,
      isSideEffectFree: () => false,
    });

    expect(Object.fromEntries(costs)).toEqual({ a: 1010, broken: null });
  });

  it("measures UTF-8 bytes", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([["a", "/a.tsx"]]),
      loadModule: async () => ({ code: "é".repeat(10), importedIds: [] }),
      isExcluded: () => false,
      isSideEffectFree: () => false,
    });

    expect(costs.get("a")).toBe(20);
  });

  it("skips excluded modules and reports unloadable graphs as unknown", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["a", "/a.tsx"],
        ["broken", "/broken.tsx"],
      ]),
      loadModule: loader({
        "/a.tsx": { bytes: 10, imports: ["/a.css", "/react.js"] },
        "/broken.tsx": { bytes: 10, imports: ["/missing.ts"] },
      }),
      isExcluded: (id) => id.endsWith(".css") || id === "/react.js",
      isSideEffectFree: () => false,
    });

    expect(Object.fromEntries(costs)).toEqual({ a: 10, broken: null });
  });
});

describe("measureClientReferenceGroupCosts with module bindings", () => {
  type TestModules = Record<string, { code: string; sideEffectFree?: boolean }>;

  // Builds each module's bindings from its code, resolving "./x.js" to "/x.js".
  function bindingLoader(modules: TestModules) {
    return async (id: string) => {
      const module = modules[id];
      if (!module) throw new Error(`missing ${id}`);
      const importedIds = [...module.code.matchAll(/from "\.(\/[^"]+)"|import "\.(\/[^"]+)"/g)].map(
        (match) => match[1] ?? match[2]!,
      );
      const bindings = await readClientModuleBindings({
        code: module.code,
        importedIds,
        resolve: async (specifier) => specifier.slice(1),
      });
      return { code: module.code, importedIds, bindings };
    };
  }

  const sideEffectFreeIn = (modules: TestModules) => (id: string) =>
    modules[id]?.sideEffectFree === true;

  const icon = (name: string) =>
    `export default function ${name}() { return "${name.repeat(50)}"; }`;

  it("charges only the re-exports a reference imports from a side-effect-free barrel", async () => {
    const modules = {
      "/a.js": { code: `import { Camera } from "./barrel.js";\nexport const A = () => Camera;` },
      "/barrel.js": {
        code: [
          `import * as all from "./icons.js";`,
          `export { all as icons };`,
          `export { default as Camera, default as CameraIcon } from "./camera.js";`,
          `export { default as Bell } from "./bell.js";`,
          `export { default as Siren } from "./siren.js";`,
          `export * from "./more.js";`,
        ].join("\n"),
        sideEffectFree: true,
      },
      "/icons.js": { code: icon("Everything"), sideEffectFree: true },
      "/camera.js": { code: icon("Camera"), sideEffectFree: true },
      "/bell.js": { code: icon("Bell"), sideEffectFree: true },
      "/siren.js": { code: `globalThis.siren = 1;\n${icon("Siren")}` },
      "/more.js": { code: `export * from "./polyfill.js";`, sideEffectFree: true },
      "/polyfill.js": { code: `globalThis.x = 1;` },
    };
    const loaded: string[] = [];
    const load = bindingLoader(modules);
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([["a", "/a.js"]]),
      loadModule: (id) => {
        loaded.push(id);
        return load(id);
      },
      isExcluded: () => false,
      isSideEffectFree: sideEffectFreeIn(modules),
    });

    // Side-effect-free modules nothing uses are not even loaded.
    expect(loaded).not.toContain("/bell.js");
    expect(loaded).not.toContain("/icons.js");
    const bytes = (code: string) => Buffer.byteLength(code, "utf8");
    // The barrel's statements emit no code, leaving only its newlines. Bell and
    // the namespace re-export are tree-shaken, but the side-effectful modules
    // behind the unused Siren re-export and `export *` stay.
    expect(costs.get("a")).toBe(
      bytes("\nexport const A = () => Camera;") +
        bytes(icon("Camera")) +
        bytes("\n\n\n\n\n") +
        bytes(modules["/siren.js"].code) +
        bytes(modules["/polyfill.js"].code),
    );
  });

  it("charges every re-export of a barrel imported as a namespace or with side effects", async () => {
    const modules: TestModules = {
      "/ns.js": { code: `import * as all from "./barrel.js";\nexport const N = all;` },
      "/effects.js": { code: `import { One } from "./effectful.js";\nexport const E = One;` },
      "/barrel.js": {
        code: `export { default as One } from "./one.js";\nexport { default as Two } from "./two.js";`,
        sideEffectFree: true,
      },
      "/effectful.js": {
        code: `export { default as One } from "./three.js";\nexport { default as Two } from "./four.js";`,
      },
      "/one.js": { code: icon("One"), sideEffectFree: true },
      "/two.js": { code: icon("Two"), sideEffectFree: true },
      "/three.js": { code: icon("Three"), sideEffectFree: true },
      "/four.js": { code: icon("Four"), sideEffectFree: true },
    };
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["ns", "/ns.js"],
        ["effects", "/effects.js"],
      ]),
      loadModule: bindingLoader(modules),
      isExcluded: () => false,
      isSideEffectFree: sideEffectFreeIn(modules),
    });

    const bytes = (code: string) => Buffer.byteLength(code, "utf8");
    expect(costs.get("ns")).toBe(
      bytes("\nexport const N = all;") + bytes("\n") + bytes(icon("One")) + bytes(icon("Two")),
    );
    expect(costs.get("effects")).toBe(
      bytes("\nexport const E = One;") + bytes("\n") + bytes(icon("Three")) + bytes(icon("Four")),
    );
  });

  it("keeps the side effects behind `export *` of a barrel imported only for its default", async () => {
    const modules: TestModules = {
      "/a.js": { code: `import Logo from "./barrel.js";\nexport const A = () => Logo;` },
      "/barrel.js": {
        code: `export default function Logo() { return "logo"; }\nexport * from "./effects.js";`,
        sideEffectFree: true,
      },
      "/effects.js": { code: `globalThis.effects = 1;` },
    };
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([["a", "/a.js"]]),
      loadModule: bindingLoader(modules),
      isExcluded: () => false,
      isSideEffectFree: sideEffectFreeIn(modules),
    });

    const bytes = (code: string) => Buffer.byteLength(code, "utf8");
    expect(costs.get("a")).toBe(
      bytes("\nexport const A = () => Logo;") +
        bytes(`export default function Logo() { return "logo"; }\n`) +
        bytes(modules["/effects.js"]!.code),
    );
  });

  it("counts every import in full when a specifier does not resolve to an imported id", async () => {
    await expect(
      readClientModuleBindings({
        code: `export { a } from "./a.js";`,
        importedIds: ["/elsewhere.js"],
        resolve: async () => "/a.js",
      }),
    ).resolves.toBeUndefined();
  });

  it("treats imported bindings that a module only re-exports as re-exports", async () => {
    const bindings = await readClientModuleBindings({
      code: `import a, { b as c } from "./a.js";\nexport { a as A, c };\nexport const d = 1;`,
      importedIds: ["/a.js"],
      resolve: async (specifier) => specifier.slice(1),
    });

    expect(bindings?.imports).toEqual([{ id: "/a.js", names: new Set() }]);
    expect(bindings?.reexports).toEqual([
      { id: "/a.js", exportName: "A", importName: "default" },
      { id: "/a.js", exportName: "c", importName: "b" },
    ]);
  });

  it("keeps imported bindings that the module also uses as plain imports", async () => {
    const bindings = await readClientModuleBindings({
      code: `import { a } from "./a.js";\nexport { a };\nexport const b = () => a();`,
      importedIds: ["/a.js"],
      resolve: async (specifier) => specifier.slice(1),
    });

    expect(bindings?.imports).toContainEqual({ id: "/a.js", names: new Set(["a"]) });
    expect(bindings?.reexports).toEqual([]);
  });
});

describe("planClientReferenceGroups", () => {
  const signatures = new Map([
    ["/b.tsx", "/"],
    ["/a.tsx", "/"],
    ["/heavy.tsx", "/"],
    ["/unknown.tsx", "/"],
    ["/solo.tsx", "/about"],
    ["/x.tsx", "/blog"],
    ["/y.tsx", "/blog"],
  ]);
  const costs = new Map<string, number | null>([
    ["/a.tsx", 10],
    ["/b.tsx", 10],
    ["/heavy.tsx", 1000],
    ["/unknown.tsx", null],
    ["/solo.tsx", 10],
    ["/x.tsx", 10],
    ["/y.tsx", 10],
  ]);
  const referenceKeys = new Map(
    [...signatures.keys(), "/unsigned.tsx"].map((id) => [id, `key${id}`]),
  );

  it("groups references that share a signature and stay under the cost cap", () => {
    const groups = planClientReferenceGroups({
      referenceIds: new Set([...signatures.keys(), "/unsigned.tsx"]),
      referenceKeys,
      signatures,
      costs,
      maxCostBytes: 100,
    });

    // Members keep signature (route walk) order.
    expect(groups.map((group) => group.referenceIds)).toEqual([
      ["/b.tsx", "/a.tsx"],
      ["/x.tsx", "/y.tsx"],
    ]);
    for (const group of groups) expect(group.key).toMatch(/^[0-9a-f]{10}$/);
  });

  it("derives stable keys from the members, not the routes that reach them", () => {
    const plan = (routeSignatures: ReadonlyMap<string, string>) =>
      planClientReferenceGroups({
        referenceIds: new Set([...signatures.keys()].reverse()),
        referenceKeys,
        signatures: routeSignatures,
        costs,
        maxCostBytes: 100,
      })
        .map((group) => group.key)
        .sort();

    expect(plan(signatures)).toEqual(plan(signatures));
    expect(new Set(plan(signatures)).size).toBe(2);
    // A new route reaching the same members keeps their group's key.
    const withNewRoute = new Map(
      [...signatures].map(([id, signature]) => [id, signature === "/" ? "/|/new" : signature]),
    );
    expect(plan(withNewRoute)).toEqual(plan(signatures));
  });
});

describe("hasUserClientChunkGroups", () => {
  const ownGroup = { name: () => null };
  const own = new Set<unknown>([ownGroup]);

  it("ignores vinext's own groups and code splitting options without groups", () => {
    expect(hasUserClientChunkGroups(undefined, own)).toBe(false);
    expect(
      hasUserClientChunkGroups({ codeSplitting: { minSize: 10_000, groups: [ownGroup] } }, own),
    ).toBe(false);
    expect(hasUserClientChunkGroups({ codeSplitting: true }, own)).toBe(false);
  });

  it("detects any other chunk group or manualChunks", () => {
    expect(
      hasUserClientChunkGroups({ codeSplitting: { groups: [ownGroup, { name: "vendor" }] } }, own),
    ).toBe(true);
    expect(hasUserClientChunkGroups([{ manualChunks: () => undefined }], own)).toBe(true);
    expect(hasUserClientChunkGroups({ advancedChunks: { groups: [{ name: "x" }] } }, own)).toBe(
      true,
    );
  });
});
