/**
 * Behavioral tests for the App Router entry-template code generators.
 *
 * Tests focus on observable behavior (structured API outputs and error paths),
 * not on the textual shape of the generated code.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { describe, it, expect } from "vite-plus/test";
import { buildAppRscManifestCode } from "../packages/vinext/src/entries/app-rsc-manifest.js";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import { buildAppRouteGraph } from "../packages/vinext/src/routing/app-route-graph.js";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";
import type { MetadataFileRoute } from "../packages/vinext/src/server/metadata-routes.js";

// ── Minimal App Router route fixtures ─────────────────────────────────
// Use stable absolute paths so tests don't depend on the machine.
const minimalAppRoutes: AppRoute[] = [
  {
    pattern: "/",
    patternParts: [],
    pagePath: "/tmp/test/app/page.tsx",
    routePath: null,
    layouts: ["/tmp/test/app/layout.tsx"],
    templates: [],
    parallelSlots: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [null],
    notFoundPath: null,
    notFoundPaths: [null],
    forbiddenPaths: [null],
    forbiddenPath: null,
    unauthorizedPaths: [null],
    unauthorizedPath: null,
    routeSegments: [],
    templateTreePositions: [],
    layoutTreePositions: [0],
    isDynamic: false,
    params: [],
  },
  {
    pattern: "/about",
    patternParts: ["about"],
    pagePath: "/tmp/test/app/about/page.tsx",
    routePath: null,
    layouts: ["/tmp/test/app/layout.tsx"],
    templates: [],
    parallelSlots: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [null],
    notFoundPath: null,
    notFoundPaths: [null],
    forbiddenPaths: [null],
    forbiddenPath: null,
    unauthorizedPaths: [null],
    unauthorizedPath: null,
    routeSegments: ["about"],
    templateTreePositions: [],
    layoutTreePositions: [0],
    isDynamic: false,
    params: [],
  },
  {
    pattern: "/blog/:slug",
    patternParts: ["blog", ":slug"],
    pagePath: "/tmp/test/app/blog/[slug]/page.tsx",
    routePath: null,
    layouts: ["/tmp/test/app/layout.tsx", "/tmp/test/app/blog/[slug]/layout.tsx"],
    templates: [],
    parallelSlots: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [null, null],
    notFoundPath: null,
    notFoundPaths: [null, null],
    forbiddenPaths: [null, null],
    forbiddenPath: null,
    unauthorizedPaths: [null, null],
    unauthorizedPath: null,
    routeSegments: ["blog", ":slug"],
    templateTreePositions: [],
    layoutTreePositions: [0, 1],
    isDynamic: true,
    params: ["slug"],
  },
  {
    pattern: "/dashboard",
    patternParts: ["dashboard"],
    pagePath: "/tmp/test/app/dashboard/page.tsx",
    routePath: null,
    layouts: ["/tmp/test/app/layout.tsx", "/tmp/test/app/dashboard/layout.tsx"],
    templates: ["/tmp/test/app/dashboard/template.tsx"],
    parallelSlots: [],
    loadingPath: "/tmp/test/app/dashboard/loading.tsx",
    errorPath: "/tmp/test/app/dashboard/error.tsx",
    layoutErrorPaths: [null, "/tmp/test/app/dashboard/error.tsx"],
    notFoundPath: "/tmp/test/app/dashboard/not-found.tsx",
    notFoundPaths: [null, "/tmp/test/app/dashboard/not-found.tsx"],
    forbiddenPaths: [null, "/tmp/test/app/dashboard/forbidden.tsx"],
    forbiddenPath: "/tmp/test/app/dashboard/forbidden.tsx",
    unauthorizedPaths: [null, "/tmp/test/app/dashboard/unauthorized.tsx"],
    unauthorizedPath: "/tmp/test/app/dashboard/unauthorized.tsx",
    routeSegments: ["dashboard"],
    templateTreePositions: [1],
    layoutTreePositions: [0, 1],
    isDynamic: false,
    params: [],
  },
];

// ── App Router manifest construction ─────────────────────────────────

describe("App Router generated manifest construction", () => {
  it("constructs route module imports and route entries from the scanned app shape", () => {
    const routes = [
      {
        pattern: "/",
        patternParts: [],
        pagePath: "/tmp/test/app/page.tsx",
        routePath: null,
        layouts: ["/tmp/test/app/layout.tsx"],
        templates: [],
        parallelSlots: [],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [null],
        notFoundPath: "/tmp/test/app/not-found.tsx",
        notFoundPaths: ["/tmp/test/app/not-found.tsx"],
        forbiddenPath: "/tmp/test/app/forbidden.tsx",
        forbiddenPaths: ["/tmp/test/app/forbidden.tsx"],
        unauthorizedPath: "/tmp/test/app/unauthorized.tsx",
        unauthorizedPaths: ["/tmp/test/app/unauthorized.tsx"],
        routeSegments: [],
        templateTreePositions: [],
        layoutTreePositions: [0],
        isDynamic: false,
        params: [],
      },
      {
        ids: {
          route: "route:/dashboard/:id",
          page: "page:/dashboard/:id",
          routeHandler: "route-handler:/dashboard/:id",
          layouts: ["layout:/", "layout:/dashboard"],
          templates: ["template:/dashboard"],
          slots: {
            "modal:/tmp/test/app/dashboard/@modal": "slot:modal:/dashboard",
          },
        },
        pattern: "/dashboard/:id",
        patternParts: ["dashboard", ":id"],
        pagePath: "/tmp/test/app/dashboard/[id]/page.tsx",
        routePath: "/tmp/test/app/dashboard/[id]/route.ts",
        layouts: ["/tmp/test/app/layout.tsx", "/tmp/test/app/dashboard/layout.tsx"],
        templates: ["/tmp/test/app/dashboard/template.tsx"],
        parallelSlots: [
          {
            id: "slot:modal:/dashboard",
            key: "modal:/tmp/test/app/dashboard/@modal",
            name: "modal",
            ownerDir: "/tmp/test/app/dashboard/@modal",
            pagePath: "/tmp/test/app/dashboard/@modal/page.tsx",
            defaultPath: "/tmp/test/app/dashboard/@modal/default.tsx",
            layoutPath: "/tmp/test/app/dashboard/@modal/layout.tsx",
            loadingPath: "/tmp/test/app/dashboard/@modal/loading.tsx",
            errorPath: "/tmp/test/app/dashboard/@modal/error.tsx",
            interceptingRoutes: [
              {
                convention: ".",
                targetPattern: "/photos/:photoId",
                pagePath: "/tmp/test/app/dashboard/@modal/(.)photos/[photoId]/page.tsx",
                layoutPaths: ["/tmp/test/app/dashboard/@modal/(.)photos/layout.tsx"],
                params: ["photoId"],
              },
            ],
            layoutIndex: 1,
            routeSegments: ["@modal"],
          },
        ],
        loadingPath: "/tmp/test/app/dashboard/loading.tsx",
        errorPath: "/tmp/test/app/dashboard/error.tsx",
        layoutErrorPaths: [null, "/tmp/test/app/dashboard/error.tsx"],
        notFoundPath: "/tmp/test/app/dashboard/not-found.tsx",
        notFoundPaths: ["/tmp/test/app/not-found.tsx", "/tmp/test/app/dashboard/not-found.tsx"],
        forbiddenPath: null,
        forbiddenPaths: ["/tmp/test/app/forbidden.tsx", null],
        unauthorizedPath: null,
        unauthorizedPaths: ["/tmp/test/app/unauthorized.tsx", null],
        routeSegments: ["dashboard", "[id]"],
        templateTreePositions: [1],
        layoutTreePositions: [0, 1],
        isDynamic: true,
        params: ["id"],
        rootParamNames: ["id"],
      },
    ] satisfies AppRoute[];

    const manifest = buildAppRscManifestCode({
      routes,
      metadataRoutes: [],
      globalErrorPath: "/tmp/test/app/global-error.tsx",
    });

    const imports = manifest.imports.join("\n");
    expect(imports.match(/\/tmp\/test\/app\/layout\.tsx/g)).toHaveLength(1);
    expect(imports).toContain('import * as mod_0 from "/tmp/test/app/page.tsx";');
    expect(imports).toContain(
      'import * as mod_17 from "/tmp/test/app/dashboard/@modal/(.)photos/[photoId]/page.tsx";',
    );
    expect(imports).toContain('import * as mod_19 from "/tmp/test/app/global-error.tsx";');

    expect(manifest.rootNotFoundVar).toBe("mod_2");
    expect(manifest.rootForbiddenVar).toBe("mod_3");
    expect(manifest.rootUnauthorizedVar).toBe("mod_4");
    expect(manifest.rootLayoutVars).toEqual(["mod_1"]);
    expect(manifest.globalErrorVar).toBe("mod_19");

    const dynamicRouteEntry = manifest.routeEntries[1];
    expect(dynamicRouteEntry).toContain('"route":"route:/dashboard/:id"');
    expect(dynamicRouteEntry).toContain(
      '"modal:/tmp/test/app/dashboard/@modal":"slot:modal:/dashboard"',
    );
    expect(dynamicRouteEntry).toContain('id: "slot:modal:/dashboard"');
    expect(dynamicRouteEntry).toContain('pattern: "/dashboard/:id"');
    expect(dynamicRouteEntry).toContain("routeHandler: mod_6");
    expect(dynamicRouteEntry).toContain("layouts: [mod_1, mod_7]");
    expect(dynamicRouteEntry).toContain('"modal:/tmp/test/app/dashboard/@modal": {');
    expect(dynamicRouteEntry).toContain("interceptLayouts: [mod_18]");
    expect(dynamicRouteEntry).toContain("page: mod_17");
    expect(dynamicRouteEntry).toContain('params: ["photoId"]');
    expect(manifest.generateStaticParamsEntries).toEqual([
      '  "/dashboard/:id": mod_5?.generateStaticParams ?? null,',
    ]);
  });

  it("serializes graph-minted ids without leaking the filesystem root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-app-rsc-manifest-"));
    const appDir = path.join(tmpDir, "app");
    try {
      fs.mkdirSync(path.join(appDir, "(marketing)", "blog", "[slug]", "@modal"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(appDir, "layout.tsx"), "export default function Layout() {}\n");
      fs.writeFileSync(
        path.join(appDir, "(marketing)", "layout.tsx"),
        "export default function Layout() {}\n",
      );
      fs.writeFileSync(
        path.join(appDir, "(marketing)", "blog", "[slug]", "layout.tsx"),
        "export default function Layout() {}\n",
      );
      fs.writeFileSync(
        path.join(appDir, "(marketing)", "blog", "[slug]", "template.tsx"),
        "export default function Template() {}\n",
      );
      fs.writeFileSync(
        path.join(appDir, "(marketing)", "blog", "[slug]", "page.tsx"),
        "export default function Page() {}\n",
      );
      fs.writeFileSync(
        path.join(appDir, "(marketing)", "blog", "[slug]", "@modal", "default.tsx"),
        "export default function Default() {}\n",
      );

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const manifest = buildAppRscManifestCode({
        routes: graph.routes,
        metadataRoutes: [],
        globalErrorPath: null,
      });

      const routeEntry = manifest.routeEntries.find((entry) =>
        entry.includes('pattern: "/blog/:slug"'),
      );

      expect(routeEntry).toBeDefined();
      expect(routeEntry).not.toContain(appDir);
      expect(routeEntry).toContain('"route":"route:/blog/:slug"');
      expect(routeEntry).toContain('"page":"page:/blog/:slug"');
      expect(routeEntry).toContain('"layout:/(marketing)/blog/[slug]"');
      expect(routeEntry).toContain('"template:/(marketing)/blog/[slug]"');
      expect(routeEntry).toContain(
        '"modal@(marketing)/blog/[slug]/@modal":"slot:modal:/(marketing)/blog/[slug]"',
      );
      expect(routeEntry).toContain('id: "slot:modal:/(marketing)/blog/[slug]"');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("embeds static metadata files and imports dynamic metadata modules", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-app-rsc-manifest-"));
    try {
      const staticManifestPath = path.join(tmpDir, "manifest.webmanifest");
      const dynamicOgPath = path.join(tmpDir, "blog", "[slug]", "opengraph-image.tsx");
      fs.mkdirSync(path.dirname(dynamicOgPath), { recursive: true });
      fs.writeFileSync(staticManifestPath, '{"name":"Vinext"}');
      fs.writeFileSync(dynamicOgPath, "export default function Image() {}");

      const manifest = buildAppRscManifestCode({
        routes: minimalAppRoutes,
        metadataRoutes: [
          {
            type: "manifest",
            isDynamic: false,
            filePath: staticManifestPath,
            routePrefix: "",
            routeSegments: [],
            servedUrl: "/manifest.webmanifest",
            contentType: "application/manifest+json",
          },
          {
            type: "opengraph-image",
            isDynamic: true,
            filePath: dynamicOgPath,
            routePrefix: "/blog/[slug]",
            routeSegments: ["blog", "[slug]"],
            servedUrl: "/blog/[slug]/opengraph-image",
            contentType: "image/png",
          },
        ],
        globalErrorPath: null,
      });

      const entries = manifest.metaRouteEntries.join("\n");
      expect(entries).toContain(
        `fileDataBase64: ${JSON.stringify(Buffer.from('{"name":"Vinext"}').toString("base64"))}`,
      );
      // Dynamic metadata modules get imported and referenced with a generated name
      expect(entries).toMatch(/module: mod_\d+/);
      expect(manifest.imports.some((imp) => imp.includes("opengraph-image.tsx"))).toBe(true);
      expect(entries).toContain('patternParts: ["blog",":slug","opengraph-image"]');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws a build-time error when a discovered static metadata file cannot be read", () => {
    expect(() =>
      buildAppRscManifestCode({
        routes: minimalAppRoutes,
        metadataRoutes: [
          {
            type: "manifest",
            isDynamic: false,
            filePath: "/tmp/test/app/missing-manifest.webmanifest",
            routePrefix: "",
            routeSegments: [],
            servedUrl: "/manifest.webmanifest",
            contentType: "application/manifest+json",
          },
        ],
        globalErrorPath: null,
      }),
    ).toThrow("[vinext] Failed to read metadata route file");
  });
});

// ── App Router entry template error paths ────────────────────────────

describe("App Router entry templates", () => {
  it("generateRscEntry fails with a path-specific error when a static metadata file cannot be read", () => {
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath: "/tmp/test/app/missing-icon.png",
        routePrefix: "",
        servedUrl: "/icon.png",
        contentType: "image/png",
      },
    ];

    expect(() =>
      generateRscEntry("/tmp/test/app", minimalAppRoutes, null, metadataRoutes, null, "", false),
    ).toThrow("[vinext] Failed to read metadata route file /tmp/test/app/missing-icon.png");
  });

  it("generateRscEntry fails with a path-specific error when a dynamic metadata file hash cannot be read", () => {
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/test/app/missing-icon.tsx",
        routePrefix: "",
        servedUrl: "/icon",
        contentType: "image/png",
      },
    ];

    expect(() =>
      generateRscEntry("/tmp/test/app", minimalAppRoutes, null, metadataRoutes, null, "", false),
    ).toThrow("[vinext] Failed to read metadata route file /tmp/test/app/missing-icon.tsx");
  });

  it("generateRscEntry fails with a path-specific error when static image dimensions cannot be read", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-entry-metadata-"));
    const filePath = path.join(tmpDir, "icon.png");
    fs.writeFileSync(filePath, "not a png");
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath,
        routePrefix: "",
        servedUrl: "/icon.png",
        contentType: "image/png",
      },
    ];

    try {
      expect(() =>
        generateRscEntry("/tmp/test/app", minimalAppRoutes, null, metadataRoutes, null, "", false),
      ).toThrow(`[vinext] Failed to read metadata image dimensions for ${filePath} (/icon.png)`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("generateRscEntry does not read image dimensions for static text metadata files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-entry-metadata-"));
    const filePath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(filePath, JSON.stringify({ name: "test" }));
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "manifest",
        isDynamic: false,
        filePath,
        routePrefix: "",
        servedUrl: "/manifest.webmanifest",
        contentType: "application/manifest+json",
      },
    ];

    try {
      expect(() =>
        generateRscEntry("/tmp/test/app", minimalAppRoutes, null, metadataRoutes, null, "", false),
      ).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("generateRscEntry delegates App Router request handling to the typed helper", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain("app-rsc-handler.js");
    expect(code).toContain("export default __createAppRscHandler({");
    expect(code).not.toContain("computeRscCacheBustingSearchParam(");
  });

  it("generateRscEntry delegates React Flight preload hint normalization", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain("createRscRenderer");
    expect(code).toContain(
      "const renderToReadableStream = createRscRenderer(_renderToReadableStream",
    );
    expect(code).not.toContain("const _hlFixRe =");
  });
});
