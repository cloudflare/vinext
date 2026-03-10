import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { appRouter, invalidateAppRouteCache } from "../packages/vinext/src/routing/app-router.js";
import {
  apiRouter,
  invalidateRouteCache,
  pagesRouter,
} from "../packages/vinext/src/routing/pages-router.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("pageExtensions route discovery", () => {
  it("discovers app/page.mdx routes when pageExtensions includes mdx", async () => {
    // Ported from Next.js MDX e2e setup:
    // test/e2e/app-dir/mdx/next.config.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/mdx/next.config.ts
    const tmpRoot = await makeTempDir("vinext-app-ext-mdx-");
    const appDir = path.join(tmpRoot, "app");
    try {
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

      invalidateAppRouteCache();
      const routes = await appRouter(appDir, ["tsx", "ts", "jsx", "js", "mdx"]);
      const patterns = routes.filter((r) => r.pagePath).map((r) => r.pattern);
      expect(patterns).toContain("/about");
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateAppRouteCache();
    }
  });

  it("does not discover app/page.mdx routes when mdx is not configured", async () => {
    const tmpRoot = await makeTempDir("vinext-app-ext-no-mdx-");
    const appDir = path.join(tmpRoot, "app");
    try {
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

      invalidateAppRouteCache();
      const routes = await appRouter(appDir, ["tsx", "ts", "jsx", "js"]);
      const patterns = routes.filter((r) => r.pagePath).map((r) => r.pattern);
      expect(patterns).not.toContain("/about");
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateAppRouteCache();
    }
  });

  it("discovers pages and api files using configured pageExtensions", async () => {
    const tmpRoot = await makeTempDir("vinext-pages-ext-mdx-");
    const pagesDir = path.join(tmpRoot, "pages");
    try {
      await fs.mkdir(path.join(pagesDir, "api"), { recursive: true });
      await fs.writeFile(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return <div>home</div>; }",
      );
      await fs.writeFile(path.join(pagesDir, "about.mdx"), "# About");
      await fs.writeFile(
        path.join(pagesDir, "api", "hello.mdx"),
        "export default function handler() {}",
      );

      invalidateRouteCache(pagesDir);
      const pageRoutes = await pagesRouter(pagesDir, ["tsx", "ts", "jsx", "js", "mdx"]);
      const apiRoutes = await apiRouter(pagesDir, ["tsx", "ts", "jsx", "js", "mdx"]);

      expect(pageRoutes.map((r) => r.pattern)).toContain("/about");
      expect(apiRoutes.map((r) => r.pattern)).toContain("/api/hello");
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      invalidateRouteCache(pagesDir);
    }
  });
});
