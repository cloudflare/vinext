import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import {
  collectNitroRouteRules,
  convertToNitroPattern,
  generateNitroRouteRules,
  mergeNitroRouteRules,
  type NitroRouteRuleConfig,
} from "../packages/vinext/src/build/nitro-route-rules.js";

const tempDirs: string[] = [];

interface NitroSetupTarget {
  options: {
    dev?: boolean;
    routeRules?: Record<string, NitroRouteRuleConfig>;
  };
  logger?: {
    warn?: (message: string) => void;
  };
}

interface NitroSetupPlugin extends Plugin {
  nitro?: {
    setup?: (nitro: NitroSetupTarget) => Promise<void> | void;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function isPlugin(plugin: unknown): plugin is Plugin {
  return !!plugin && !Array.isArray(plugin) && typeof plugin === "object" && "name" in plugin;
}

function findNamedPlugin(plugins: ReturnType<typeof vinext>, name: string) {
  return plugins.find((plugin): plugin is Plugin => isPlugin(plugin) && plugin.name === name);
}

function makeTempProject(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-project", private: true }, null, 2),
  );
  return root;
}

function writeProjectFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createAppProject(): string {
  const root = makeTempProject("vinext-nitro-app-");
  writeProjectFile(
    root,
    "app/layout.tsx",
    "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  writeProjectFile(
    root,
    "app/page.tsx",
    "export default function Home() { return <div>home</div>; }\n",
  );
  writeProjectFile(
    root,
    "app/blog/[slug]/page.tsx",
    [
      "export const revalidate = 60;",
      "export default async function BlogPage() {",
      "  return <div>blog</div>;",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

function createPagesProject(): string {
  const root = makeTempProject("vinext-nitro-pages-");
  writeProjectFile(
    root,
    "pages/index.tsx",
    "export default function Home() { return <div>home</div>; }\n",
  );
  writeProjectFile(
    root,
    "pages/blog/[slug].tsx",
    [
      "export async function getStaticProps() {",
      "  return { props: {}, revalidate: 45 };",
      "}",
      "",
      "export default function BlogPage() {",
      "  return <div>blog</div>;",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

async function initializeNitroSetupPlugin(root: string): Promise<NitroSetupPlugin> {
  const plugins = vinext({ appDir: root, rsc: false }) as ReturnType<typeof vinext>;
  const configPlugin = findNamedPlugin(plugins, "vinext:config") as Plugin & {
    config?: (
      config: { root: string; plugins: unknown[] },
      env: { command: "build"; mode: string },
    ) => Promise<unknown>;
  };
  if (!configPlugin?.config) {
    throw new Error("vinext:config plugin not found");
  }

  // Passing empty plugins array means hasNitroPlugin=false in the closure,
  // but the nitro.setup hook doesn't gate on hasNitroPlugin (Nitro calls it directly).
  await configPlugin.config({ root, plugins: [] }, { command: "build", mode: "production" });

  const nitroPlugin = findNamedPlugin(plugins, "vinext:nitro-route-rules") as NitroSetupPlugin;
  if (!nitroPlugin?.nitro?.setup) {
    throw new Error("vinext:nitro-route-rules plugin not found");
  }

  return nitroPlugin;
}

describe("convertToNitroPattern", () => {
  it("leaves static routes unchanged", () => {
    expect(convertToNitroPattern("/")).toBe("/");
    expect(convertToNitroPattern("/about")).toBe("/about");
    expect(convertToNitroPattern("/blog/featured")).toBe("/blog/featured");
  });

  it("converts :param segments to /* single-segment wildcards", () => {
    expect(convertToNitroPattern("/blog/:slug")).toBe("/blog/*");
    expect(convertToNitroPattern("/users/:id/posts")).toBe("/users/*/posts");
  });

  it("converts :param+ catch-all segments to /** globs", () => {
    expect(convertToNitroPattern("/docs/:slug+")).toBe("/docs/**");
  });

  it("converts :param* optional catch-all segments to /** globs", () => {
    expect(convertToNitroPattern("/docs/:slug*")).toBe("/docs/**");
  });

  it("handles consecutive dynamic segments correctly", () => {
    expect(convertToNitroPattern("/:a/:b")).toBe("/*/*");
    expect(convertToNitroPattern("/blog/:year/:month/:slug")).toBe("/blog/*/*/*");
    expect(convertToNitroPattern("/api/:version/:resource/:id")).toBe("/api/*/*/*");
  });

  it("distinguishes single-segment params from catch-all params", () => {
    // Mixed: single segment followed by catch-all
    expect(convertToNitroPattern("/blog/:year/:slug+")).toBe("/blog/*/**");
    // Optional catch-all behaves like catch-all
    expect(convertToNitroPattern("/shop/:category/:id*")).toBe("/shop/*/**");
  });
});

describe("generateNitroRouteRules", () => {
  it("returns empty object when no ISR routes exist", () => {
    const rows = [
      { pattern: "/", type: "static" as const },
      { pattern: "/about", type: "ssr" as const },
      { pattern: "/api/data", type: "api" as const },
    ];

    expect(generateNitroRouteRules(rows)).toEqual({});
  });

  it("converts dynamic segments to Nitro glob patterns", () => {
    const rows = [
      { pattern: "/", type: "isr" as const, revalidate: 120 },
      { pattern: "/blog/:slug", type: "isr" as const, revalidate: 60 },
      { pattern: "/docs/:slug+", type: "isr" as const, revalidate: 30 },
      { pattern: "/products/:id*", type: "isr" as const, revalidate: 15 },
    ];

    expect(generateNitroRouteRules(rows)).toEqual({
      "/": { swr: 120 },
      "/blog/*": { swr: 60 },
      "/docs/**": { swr: 30 },
      "/products/**": { swr: 15 },
    });
  });

  // In practice, buildReportRows never produces an ISR row with Infinity
  // (classifyAppRoute maps Infinity to "static"), but generateNitroRouteRules
  // should handle it defensively since Infinity serializes to null in JSON.
  it("ignores Infinity revalidate defensively", () => {
    const rows = [
      { pattern: "/isr", type: "isr" as const, revalidate: Infinity },
      { pattern: "/valid", type: "isr" as const, revalidate: 10 },
    ];

    expect(generateNitroRouteRules(rows)).toEqual({
      "/valid": { swr: 10 },
    });
  });
});

describe("mergeNitroRouteRules", () => {
  it("merges generated swr into existing exact rules with unrelated fields", () => {
    const result = mergeNitroRouteRules(
      {
        "/blog/**": { headers: { "x-test": "1" } },
      },
      {
        "/blog/**": { swr: 60 },
      },
    );

    expect(result.routeRules).toEqual({
      "/blog/**": {
        headers: { "x-test": "1" },
        swr: 60,
      },
    });
    expect(result.skippedRoutes).toEqual([]);
  });

  it("does not override explicit user cache rules on exact collisions", () => {
    const result = mergeNitroRouteRules(
      {
        "/blog/**": { cache: { swr: true, maxAge: 600 } },
      },
      {
        "/blog/**": { swr: 60 },
      },
    );

    expect(result.routeRules).toEqual({
      "/blog/**": { cache: { swr: true, maxAge: 600 } },
    });
    expect(result.skippedRoutes).toEqual(["/blog/**"]);
  });
});

describe("collectNitroRouteRules", () => {
  it("collects App Router ISR rules from scanned routes", async () => {
    const root = createAppProject();

    const routeRules = await collectNitroRouteRules({
      appDir: path.join(root, "app"),
      pagesDir: null,
      pageExtensions: ["tsx", "ts", "jsx", "js"],
    });

    expect(routeRules).toEqual({
      "/blog/*": { swr: 60 },
    });
  });

  it("collects Pages Router ISR rules from scanned routes", async () => {
    const root = createPagesProject();

    const routeRules = await collectNitroRouteRules({
      appDir: null,
      pagesDir: path.join(root, "pages"),
      pageExtensions: ["tsx", "ts", "jsx", "js"],
    });

    expect(routeRules).toEqual({
      "/blog/*": { swr: 45 },
    });
  });
});

describe("vinext Nitro setup integration", () => {
  it("merges generated route rules into Nitro before build", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const warn = vi.fn();
    const nitro = {
      options: {
        dev: false,
        routeRules: {
          "/blog/*": { headers: { "x-test": "1" } },
        },
      },
      logger: { warn },
    };

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.routeRules).toEqual({
      "/blog/*": {
        headers: { "x-test": "1" },
        swr: 60,
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps user cache rules intact and warns once", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const warn = vi.fn();
    const nitro = {
      options: {
        dev: false,
        routeRules: {
          "/blog/*": { swr: 600 },
        },
      },
      logger: { warn },
    };

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.routeRules).toEqual({
      "/blog/*": { swr: 600 },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("/blog/*");
  });

  it("skips route rule generation during Nitro dev", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro = {
      options: {
        dev: true,
        routeRules: {},
      },
    };

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.routeRules).toEqual({});
  });
});
