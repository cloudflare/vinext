import { describe, it, expect } from "vite-plus/test";
import { createLogger, createServer, type ViteDevServer } from "vite-plus";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import vinext from "../packages/vinext/src/index.js";
import { generateRouteTypes } from "../packages/vinext/src/typegen.js";

const EMPTY_PAGE = "export default function Page() { return null; }\n";
const EMPTY_LAYOUT = "export default function Layout({ children }: any) { return children; }\n";
const EMPTY_ROUTE = "export async function GET() { return Response.json({ ok: true }); }\n";

async function withTempProject<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vinext-typegen-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeProjectFile(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

async function eventually(run: () => Promise<void>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await run();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

describe("generateRouteTypes", () => {
  it("generates Next-compatible global route helper types from the App Router tree", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/blog/[slug]/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/docs/[...slug]/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/shop/[[...slug]]/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/api/items/[id]/route.ts", EMPTY_ROUTE);
      await writeProjectFile(root, "app/dashboard/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/dashboard/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/dashboard/@analytics/default.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/%5Fsites/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/%5Fsites/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/%5Bslug%5D/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/%5Bslug%5D/page.tsx", EMPTY_PAGE);

      const outputPath = await generateRouteTypes({ root });
      const generated = await readFile(outputPath, "utf-8");

      expect(outputPath).toBe(path.join(root, ".next/types/routes.d.ts"));
      expect(generated).toContain("declare namespace VinextRouteTypes");
      expect(generated).toContain(
        'type PageRoute = "/" | "/[slug]" | "/_sites" | "/blog/[slug]" | "/dashboard" | "/docs/[...slug]" | "/shop/[[...slug]]";',
      );
      expect(generated).toContain('type LayoutRoute = "/" | "/[slug]" | "/_sites" | "/dashboard";');
      expect(generated).toContain('type RouteHandlerRoute = "/api/items/[id]";');
      expect(generated).toContain('"/[slug]": {};');
      expect(generated).toContain('"/blog/[slug]": { slug: string; };');
      expect(generated).toContain('"/docs/[...slug]": { slug: string[]; };');
      expect(generated).toContain('"/shop/[[...slug]]": { slug?: string[]; };');
      expect(generated).toContain('"/dashboard": "analytics";');
      expect(generated).toContain(
        "type PageProps<Route extends VinextRouteTypes.PageRoute = VinextRouteTypes.PageRoute>",
      );
      expect(generated).toContain("type LayoutProps<Route extends VinextRouteTypes.LayoutRoute>");
      expect(generated).toContain(
        "type RouteContext<Route extends VinextRouteTypes.RouteHandlerRoute = VinextRouteTypes.RouteHandlerRoute>",
      );
    });
  });

  it("keeps layout slots scoped to their root route group", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/(marketing)/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/(marketing)/marketing/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/(marketing)/@modal/default.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/(shop)/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/(shop)/shop/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/(shop)/@cart/default.tsx", EMPTY_PAGE);

      const outputPath = await generateRouteTypes({ root });
      const generated = await readFile(outputPath, "utf-8");

      expect(generated).toContain('type LayoutRoute = "/(marketing)" | "/(shop)";');
      expect(generated).toContain('"/(marketing)": "modal";');
      expect(generated).toContain('"/(shop)": "cart";');
      expect(generated).not.toContain('"/": "cart" | "modal";');
    });
  });

  it("maps slots to the owning layout when the slot directory has no layout", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/dashboard/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/dashboard/@analytics/default.tsx", EMPTY_PAGE);

      const outputPath = await generateRouteTypes({ root });
      const generated = await readFile(outputPath, "utf-8");

      expect(generated).toContain('type LayoutRoute = "/";');
      expect(generated).toContain('"/": "analytics";');
      expect(generated).not.toContain('"/dashboard": "analytics";');
    });
  });

  it("keeps slot-local layouts separate from their owning layout", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, "app/@modal/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/@modal/page.tsx", EMPTY_PAGE);

      const outputPath = await generateRouteTypes({ root });
      const generated = await readFile(outputPath, "utf-8");

      expect(generated).toContain('type LayoutRoute = "/" | "/@modal";');
      expect(generated).toContain('"/": "modal";');
      expect(generated).toContain('"/@modal": never;');
    });
  });

  it("writes a Next-compatible next-env.d.ts stub when one is missing", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);

      await generateRouteTypes({ root });
      const generated = await readFile(path.join(root, "next-env.d.ts"), "utf-8");

      expect(generated).toContain('/// <reference types="next" />');
      expect(generated).toContain('/// <reference types="next/image-types/global" />');
      expect(generated).toContain('import "./.next/types/routes.d.ts";');
      expect(generated).not.toContain('/// <reference path="./.next/types/routes.d.ts" />');
    });
  });

  it("preserves an existing next-env.d.ts", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      const customContent = '/// <reference types="custom" />\n';
      await writeProjectFile(root, "next-env.d.ts", customContent);

      await generateRouteTypes({ root });
      const preserved = await readFile(path.join(root, "next-env.d.ts"), "utf-8");

      expect(preserved).toBe(customContent);
    });
  });

  it("updates generated route helper types when App Router files are added in dev", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);

      let server: ViteDevServer | null = null;
      try {
        // `appDir` in the vinext plugin options names the project root, not
        // the App Router directory; the plugin auto-detects `app/` (or
        // `src/app/`) under it. Pass the project root explicitly here so
        // the dev server uses the same root path for both Vite and vinext.
        server = await createServer({
          root,
          logLevel: "silent",
          plugins: [vinext({ appDir: root })],
        });

        const generatedPath = path.join(root, ".next", "types", "routes.d.ts");
        await eventually(async () => {
          expect(await readFile(generatedPath, "utf-8")).toContain('type PageRoute = "/";');
        });

        const aboutPage = path.join(root, "app/about/page.tsx");
        await writeProjectFile(root, "app/about/page.tsx", EMPTY_PAGE);
        server.watcher.emit("add", aboutPage);

        await eventually(async () => {
          expect(await readFile(generatedPath, "utf-8")).toContain(
            'type PageRoute = "/" | "/about";',
          );
        });

        const blogPage = path.join(root, "app/blog/page.tsx");
        const docsPage = path.join(root, "app/docs/page.tsx");
        await writeProjectFile(root, "app/blog/page.tsx", EMPTY_PAGE);
        await writeProjectFile(root, "app/docs/page.tsx", EMPTY_PAGE);
        server.watcher.emit("add", blogPage);
        server.watcher.emit("add", docsPage);

        await eventually(async () => {
          expect(await readFile(generatedPath, "utf-8")).toContain(
            'type PageRoute = "/" | "/about" | "/blog" | "/docs";',
          );
        });
      } finally {
        await server?.close();
      }
    });
  });

  it("does not block dev server startup when initial route type generation fails", async () => {
    await withTempProject(async (root) => {
      await writeProjectFile(root, "app/layout.tsx", EMPTY_LAYOUT);
      await writeProjectFile(root, "app/page.tsx", EMPTY_PAGE);
      await writeProjectFile(root, ".next", "not a directory\n");
      const warnings: string[] = [];
      const logger = createLogger("silent");
      logger.warn = (message) => {
        warnings.push(message);
      };

      let server: ViteDevServer | null = null;
      try {
        server = await createServer({
          root,
          customLogger: logger,
          plugins: [vinext({ appDir: root })],
        });

        expect(server).toBeTruthy();
        await eventually(async () => {
          expect(
            warnings.some((warning) => warning.includes("Failed to regenerate route types")),
          ).toBe(true);
        });
      } finally {
        await server?.close();
      }
    });
  });
});
