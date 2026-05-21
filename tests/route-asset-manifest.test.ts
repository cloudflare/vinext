import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";
import {
  buildDevRouteAssetManifest,
  getRouteCssHrefsInRouteOrder,
} from "../packages/vinext/src/server/route-asset-manifest.js";

function createRoute(input: {
  routeId: string;
  pattern: string;
  pagePath: string;
  layoutPath: string;
  parallelSlots?: AppRoute["parallelSlots"];
}): AppRoute {
  return {
    ids: {
      route: input.routeId,
      page: `page:${input.pattern}`,
      routeHandler: null,
      rootBoundary: null,
      layouts: [`layout:${input.pattern}`],
      templates: [],
      slots: {},
    },
    errorPath: null,
    forbiddenPath: null,
    forbiddenPaths: [null],
    isDynamic: false,
    layoutErrorPaths: [null],
    layouts: [input.layoutPath],
    layoutTreePositions: [0],
    loadingPath: null,
    notFoundPath: null,
    notFoundPaths: [null],
    pagePath: input.pagePath,
    parallelSlots: input.parallelSlots ?? [],
    params: [],
    pattern: input.pattern,
    patternParts: [],
    routePath: null,
    routeSegments: [],
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [null],
  };
}

describe("route asset manifest", () => {
  it("returns an empty manifest for an empty route list", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-route-assets-"));
    try {
      const manifest = await buildDevRouteAssetManifest([], {
        projectRoot: root,
        aliases: {},
      });

      expect(manifest.routes).toEqual({});
      expect(getRouteCssHrefsInRouteOrder(manifest, [])).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("joins route module files with dev CSS href discovery by semantic route id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-route-assets-"));
    try {
      const appDir = path.join(root, "src", "app");
      const dashboardDir = path.join(appDir, "dashboard");
      await fs.mkdir(dashboardDir, { recursive: true });
      const rootLayout = path.join(appDir, "layout.tsx");
      const homePage = path.join(appDir, "page.tsx");
      const dashboardPage = path.join(dashboardDir, "page.tsx");
      await fs.writeFile(rootLayout, `import "#/app/globals.css";\nexport default function L() {}`);
      await fs.writeFile(homePage, `export default function Page() {}`);
      await fs.writeFile(
        dashboardPage,
        `import "./dashboard.css";\nexport default function Page() {}`,
      );
      await fs.writeFile(path.join(appDir, "globals.css"), `.global { color: red; }`);
      await fs.writeFile(path.join(dashboardDir, "dashboard.css"), `.dash { color: blue; }`);

      const routes = [
        createRoute({
          routeId: "route:/",
          pattern: "/",
          pagePath: homePage,
          layoutPath: rootLayout,
        }),
        createRoute({
          routeId: "route:/dashboard",
          pattern: "/dashboard",
          pagePath: dashboardPage,
          layoutPath: rootLayout,
        }),
      ];

      const manifest = await buildDevRouteAssetManifest(routes, {
        projectRoot: root,
        aliases: { "#": path.join(root, "src") },
      });

      expect(manifest.routes["route:/"]?.cssHrefs).toEqual(["/src/app/globals.css"]);
      expect(manifest.routes["route:/dashboard"]?.cssHrefs).toEqual([
        "/src/app/globals.css",
        "/src/app/dashboard/dashboard.css",
      ]);
      expect(getRouteCssHrefsInRouteOrder(manifest, routes)).toEqual([
        ["/src/app/globals.css"],
        ["/src/app/globals.css", "/src/app/dashboard/dashboard.css"],
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("falls back to route pattern when semantic route ids are absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-route-assets-"));
    try {
      const appDir = path.join(root, "app");
      await fs.mkdir(appDir, { recursive: true });
      const layoutPath = path.join(appDir, "layout.tsx");
      const pagePath = path.join(appDir, "page.tsx");
      await fs.writeFile(layoutPath, `export default function L() {}`);
      await fs.writeFile(pagePath, `import "./page.css";\nexport default function Page() {}`);
      await fs.writeFile(path.join(appDir, "page.css"), `.page { color: red; }`);

      const route = {
        ...createRoute({
          routeId: "unused",
          pattern: "/",
          pagePath,
          layoutPath,
        }),
        ids: undefined,
      };

      const manifest = await buildDevRouteAssetManifest([route], {
        projectRoot: root,
        aliases: {},
      });

      expect(manifest.routes["/"]?.cssHrefs).toEqual(["/app/page.css"]);
      expect(getRouteCssHrefsInRouteOrder(manifest, [route])).toEqual([["/app/page.css"]]);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("includes parallel slot assets after shared layout assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-route-assets-"));
    try {
      const appDir = path.join(root, "app");
      const slotDir = path.join(appDir, "@modal");
      await fs.mkdir(slotDir, { recursive: true });
      const layoutPath = path.join(appDir, "layout.tsx");
      const pagePath = path.join(appDir, "page.tsx");
      const slotLayoutPath = path.join(slotDir, "layout.tsx");
      const slotPagePath = path.join(slotDir, "page.tsx");
      await fs.writeFile(layoutPath, `import "./layout.css";\nexport default function L() {}`);
      await fs.writeFile(pagePath, `import "./page.css";\nexport default function Page() {}`);
      await fs.writeFile(
        slotLayoutPath,
        `import "./slot-layout.css";\nexport default function L() {}`,
      );
      await fs.writeFile(
        slotPagePath,
        `import "./slot-page.css";\nexport default function Page() {}`,
      );
      await fs.writeFile(path.join(appDir, "layout.css"), `.layout { color: red; }`);
      await fs.writeFile(path.join(appDir, "page.css"), `.page { color: blue; }`);
      await fs.writeFile(path.join(slotDir, "slot-layout.css"), `.slot-layout { color: green; }`);
      await fs.writeFile(path.join(slotDir, "slot-page.css"), `.slot-page { color: purple; }`);

      const route = createRoute({
        routeId: "route:/",
        pattern: "/",
        pagePath,
        layoutPath,
        parallelSlots: [
          {
            defaultPath: null,
            errorPath: null,
            hasPage: true,
            interceptingRoutes: [],
            key: "modal@/",
            layoutIndex: 0,
            layoutPath: slotLayoutPath,
            loadingPath: null,
            name: "modal",
            ownerDir: appDir,
            ownerTreePath: "/",
            pagePath: slotPagePath,
            routeSegments: [],
          },
        ],
      });

      const manifest = await buildDevRouteAssetManifest([route], {
        projectRoot: root,
        aliases: {},
      });

      expect(manifest.routes["route:/"]?.cssHrefs).toEqual([
        "/app/layout.css",
        "/app/page.css",
        "/app/@modal/slot-layout.css",
        "/app/@modal/slot-page.css",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
