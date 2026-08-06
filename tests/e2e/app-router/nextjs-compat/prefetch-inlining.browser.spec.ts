import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "../../fixtures";

const HasRuntimePrefetch = 0b00001;
const ParentInlinedIntoSelf = 0b100000;
const InlinedIntoChild = 0b1000000;
const HeadInlinedIntoSelf = 0b10000000;
const HeadOutlined = 0b100000000;
const PrefetchDisabled = 0b10000000000;

type TreePrefetch = {
  name: string;
  param: null | {
    type: string;
    key: string | null;
    siblings: readonly string[] | null;
  };
  prefetchHints: number;
  slots: null | { [key: string]: TreePrefetch };
};

type RootTreePrefetch = {
  buildId?: string;
  staleTime: number;
  tree: TreePrefetch;
};

type ProductionApp = {
  baseUrl: string;
  buildId: string;
  fixtureRoot: string;
  server: Server;
};

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const sourceNodeModules = path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules");
  const targetNodeModules = path.join(fixtureRoot, "node_modules");

  await fs.mkdir(targetNodeModules, { recursive: true });
  for (const entry of await fs.readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === ".vite" || entry.name === ".vite-temp") continue;
    await fs.symlink(
      path.join(sourceNodeModules, entry.name),
      path.join(targetNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }
}

async function preparePrefetchInliningFixture(): Promise<string> {
  const sourceRoot = path.resolve(process.cwd(), "tests/fixtures/app-prefetch-inlining");
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-prefetch-inlining-"));
  await fs.cp(sourceRoot, fixtureRoot, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.next`) && !source.includes(`${path.sep}dist`),
  });
  await linkFixtureNodeModules(fixtureRoot);
  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );

  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  await fs.writeFile(
    path.join(fixtureRoot, "vite.config.ts"),
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({
  plugins: [vinext({ appDir: import.meta.dirname })],
});
`,
  );

  return fixtureRoot;
}

async function buildAndServePrefetchInliningFixture(): Promise<ProductionApp> {
  const fixtureRoot = await preparePrefetchInliningFixture();
  const outDir = path.join(fixtureRoot, "dist");
  await fs.rm(outDir, { recursive: true, force: true });

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
  });
  await builder.buildApp();
  const buildId = (await fs.readFile(path.join(outDir, "server", "BUILD_ID"), "utf8")).trim();

  const { runPrerender } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/build/run-prerender.js")).href
  );
  await runPrerender({ root: fixtureRoot });

  const { startProdServer } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
  );
  const started = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir,
    noCompression: true,
  });

  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    buildId,
    fixtureRoot,
    server: started.server,
  };
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks -- Playwright fixture `use`, not a React hook */
const test = base.extend<{ prefetchInliningApp: ProductionApp }>({
  prefetchInliningApp: async ({ page }, use) => {
    const app = await buildAndServePrefetchInliningFixture();

    try {
      await use(app);
    } finally {
      await page.close();
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  },
});
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

test.setTimeout(90_000);

async function fetchRouteTreePrefetch(
  baseUrl: string,
  pathname: string,
  expectedBuildId?: string,
): Promise<RootTreePrefetch> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      RSC: "1",
      "Next-Router-Prefetch": "1",
      "Next-Router-Segment-Prefetch": "/_tree",
    },
  });
  const text = await response.text();
  expect(response.headers.get("x-nextjs-postponed")).toBe("2");
  const jsonStart = text.indexOf(":");
  if (jsonStart === -1) {
    throw new Error(`Missing Flight row prefix in response: ${text.slice(0, 80)}`);
  }
  const data = JSON.parse(text.slice(jsonStart + 1));
  if (expectedBuildId !== undefined) {
    expect(data.buildId).toBe(expectedBuildId);
    expect(response.headers.get("x-nextjs-deployment-id") ?? data.buildId).toBe(expectedBuildId);
  }
  return data;
}

function renderInliningTree(tree: TreePrefetch): string {
  const lines: string[] = [];
  const isHeadOutlined = (tree.prefetchHints & HeadOutlined) !== 0;
  collectNodes(tree, "", !isHeadOutlined, false, lines);
  if (isHeadOutlined) {
    lines.push("outlined metadata");
  }
  return lines.join("\n");
}

function collectNodes(
  node: TreePrefetch,
  prefix: string,
  isLast: boolean,
  hasParent: boolean,
  lines: string[],
  slotKey?: string,
): void {
  const hasRuntimePrefetch = (node.prefetchHints & HasRuntimePrefetch) !== 0;
  const prefetchDisabled = (node.prefetchHints & PrefetchDisabled) !== 0;
  const inlinedIntoChild = (node.prefetchHints & InlinedIntoChild) !== 0;
  const headInlined = (node.prefetchHints & HeadInlinedIntoSelf) !== 0;

  const slotPrefix = slotKey !== undefined && slotKey !== "children" ? `@${slotKey}/` : "";
  const headSuffix = headInlined ? " (+metadata)" : "";
  const name = hasParent ? `${slotPrefix}"${node.name}"${headSuffix}` : "root";
  const tag = hasRuntimePrefetch
    ? "runtime"
    : prefetchDisabled
      ? "dynamic"
      : inlinedIntoChild
        ? "inlined"
        : "outlined";
  const connector = hasParent ? (isLast ? "`-- " : "|-- ") : "";
  lines.push(`${tag} ${prefix}${connector}${name}`);

  if (node.slots) {
    const children = Object.values(node.slots);
    const childrenWithParentInlined = children.filter(
      (child) => (child.prefetchHints & ParentInlinedIntoSelf) !== 0,
    );
    if (inlinedIntoChild && childrenWithParentInlined.length === 0) {
      throw new Error(`"${node.name}" has InlinedIntoChild but no inlined child`);
    }
    if (!inlinedIntoChild && childrenWithParentInlined.length > 0) {
      throw new Error(`"${node.name}" has inlined child without InlinedIntoChild`);
    }

    const childPrefix = prefix + (hasParent ? (isLast ? "    " : "|   ") : "");
    const keys = Object.keys(node.slots);
    const hasMultipleSlots = keys.length > 1;
    for (let i = 0; i < keys.length; i++) {
      collectNodes(
        node.slots[keys[i]],
        childPrefix,
        i === keys.length - 1,
        true,
        lines,
        hasMultipleSlots ? keys[i] : undefined,
      );
    }
  }
}

test.describe("App Router segment-cache prefetch inlining", () => {
  // Ported from Next.js: test/e2e/app-dir/segment-cache/prefetch-inlining/prefetch-inlining.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/prefetch-inlining/prefetch-inlining.test.ts
  test("emits route-tree inlining hints for static App Router prefetches", async ({
    prefetchInliningApp,
  }) => {
    const cases = [
      {
        pathname: "/test-small-chain",
        expected: [
          "inlined root",
          'inlined `-- "test-small-chain"',
          'outlined     `-- "__PAGE__" (+metadata)',
        ].join("\n"),
      },
      {
        pathname: "/test-outlined",
        expected: [
          "inlined root",
          'outlined `-- "test-outlined"',
          'outlined     `-- "__PAGE__" (+metadata)',
        ].join("\n"),
      },
      {
        pathname: "/test-parallel",
        expected: [
          "inlined root",
          'inlined `-- "test-parallel"',
          'outlined     |-- "__PAGE__" (+metadata)',
          'inlined     `-- @sidebar/"(__SLOT__)"',
          'outlined         `-- "__PAGE__"',
        ].join("\n"),
      },
      {
        pathname: "/",
        expected: ["inlined root", 'outlined `-- "__PAGE__" (+metadata)'].join("\n"),
      },
      {
        pathname: "/test-restart/large-middle/after",
        expected: [
          "inlined root",
          'inlined `-- "test-restart"',
          'outlined     `-- "large-middle"',
          'inlined         `-- "after"',
          'outlined             `-- "__PAGE__" (+metadata)',
        ].join("\n"),
      },
      {
        pathname: "/test-deep/a/b/c",
        expected: [
          "inlined root",
          'inlined `-- "test-deep"',
          'inlined     `-- "a"',
          'inlined         `-- "b"',
          'inlined             `-- "c"',
          'outlined                 `-- "__PAGE__" (+metadata)',
        ].join("\n"),
      },
      {
        pathname: "/test-compressible",
        expected: [
          "inlined root",
          'inlined `-- "test-compressible"',
          'outlined     `-- "__PAGE__" (+metadata)',
        ].join("\n"),
      },
      {
        pathname: "/test-dynamic/hello",
        expected: [
          "inlined root",
          'inlined `-- "test-dynamic"',
          'outlined     `-- "slug"',
          'outlined         `-- "__PAGE__" (+metadata)',
        ].join("\n"),
      },
    ];

    for (const { pathname, expected } of cases) {
      const data = await fetchRouteTreePrefetch(
        prefetchInliningApp.baseUrl,
        pathname,
        prefetchInliningApp.buildId,
      );
      expect(renderInliningTree(data.tree)).toBe(expected);
    }

    const firstDynamic = await fetchRouteTreePrefetch(
      prefetchInliningApp.baseUrl,
      "/test-dynamic/hello",
      prefetchInliningApp.buildId,
    );
    const secondDynamic = await fetchRouteTreePrefetch(
      prefetchInliningApp.baseUrl,
      "/test-dynamic/world",
      prefetchInliningApp.buildId,
    );
    const firstDynamicSegment = firstDynamic.tree.slots?.children?.slots?.children;
    expect(firstDynamicSegment?.name).toBe("slug");
    expect(firstDynamicSegment?.param).toEqual({ key: null, siblings: null, type: "d" });
    expect(renderInliningTree(secondDynamic.tree)).toBe(renderInliningTree(firstDynamic.tree));
  });
});
