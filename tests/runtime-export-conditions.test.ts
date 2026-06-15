// Ported from Next.js: test/e2e/import-conditions/import-conditions.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/import-conditions/import-conditions.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "vite";
import { describe, expect, it } from "vite-plus/test";
import {
  runtimeExportConditionsPlugin,
  withRuntimeExportCondition,
  type RuntimeExportCondition,
} from "../packages/vinext/src/plugins/runtime-export-conditions.js";

async function writeFile(filePath: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source, "utf8");
}

async function createFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-runtime-conditions-"));
  const packageDir = path.join(root, "node_modules", "library-with-exports");

  await writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "library-with-exports",
      version: "1.0.0",
      type: "module",
      exports: {
        "./server-favoring-edge": {
          worker: "./worker.js",
          workerd: "./workerd.js",
          "edge-light": "./edge-light.js",
          node: "./node.js",
          browser: "./browser.js",
          default: "./default.js",
        },
        "./server-favoring-browser": {
          worker: "./worker.js",
          workerd: "./workerd.js",
          browser: "./browser.js",
          node: "./node.js",
          "edge-light": "./edge-light.js",
          default: "./default.js",
        },
        "./react": {
          "react-server": "./react-server.js",
          default: "./default.js",
        },
        "./node-first": {
          node: "./node.js",
          "node-addons": "./node-addons.js",
          "edge-light": "./edge-light.js",
          browser: "./browser.js",
          default: "./default.js",
        },
        "./module-kind": {
          "edge-light": {
            import: "./edge-import.js",
            require: "./edge-require.cjs",
          },
          default: "./default.js",
        },
      },
    }),
  );

  for (const condition of [
    "browser",
    "default",
    "edge-light",
    "node",
    "node-addons",
    "react-server",
    "worker",
    "workerd",
  ]) {
    await writeFile(
      path.join(packageDir, `${condition}.js`),
      `export default ${JSON.stringify(condition)};`,
    );
  }
  await writeFile(path.join(packageDir, "edge-import.js"), 'export default "edge-import";');
  await writeFile(path.join(packageDir, "edge-require.cjs"), 'module.exports = "edge-require";');

  return root;
}

async function buildConditions(
  root: string,
  condition: RuntimeExportCondition | null,
  resolveConditions?: string[],
  ssr = true,
): Promise<string> {
  const virtualEntry = "\0runtime-export-conditions-entry";
  const entryId = condition ? withRuntimeExportCondition(virtualEntry, condition) : virtualEntry;
  const entryPlugin: Plugin = {
    name: "runtime-export-conditions-entry",
    resolveId(source) {
      if (source === entryId) return source;
      return null;
    },
    load(id) {
      if (id !== entryId) return null;
      return `
        import react from "library-with-exports/react";
        import serverFavoringBrowser from "library-with-exports/server-favoring-browser";
        import serverFavoringEdge from "library-with-exports/server-favoring-edge";
        console.log(JSON.stringify({ react, serverFavoringBrowser, serverFavoringEdge }));
      `;
    },
  };

  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    resolve: resolveConditions ? { conditions: resolveConditions } : undefined,
    plugins: [entryPlugin, runtimeExportConditionsPlugin()],
    ssr: { noExternal: true },
    build: {
      write: false,
      ssr,
      minify: false,
      rollupOptions: { input: entryId },
    },
  });
  if (!Array.isArray(result) && !("output" in result)) {
    throw new Error("Unexpected watch result from one-shot build");
  }
  const output = Array.isArray(result) ? result[0]!.output : result.output;
  return output.find((item) => item.type === "chunk")!.code;
}

async function buildModuleKind(root: string, kind: "import" | "require"): Promise<string> {
  const entryPath = path.join(root, kind === "import" ? "entry.mjs" : "entry.cjs");
  const source =
    kind === "import"
      ? 'import value from "library-with-exports/module-kind"; console.log(value);'
      : 'const value = require("library-with-exports/module-kind"); console.log(value);';
  await writeFile(entryPath, source);
  const entryId = withRuntimeExportCondition(entryPath, "edge-light");

  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [runtimeExportConditionsPlugin()],
    ssr: { noExternal: true },
    build: {
      write: false,
      ssr: true,
      minify: false,
      rollupOptions: { input: entryId },
    },
  });
  if (!Array.isArray(result) && !("output" in result)) {
    throw new Error("Unexpected watch result from one-shot build");
  }
  const output = Array.isArray(result) ? result[0]!.output : result.output;
  return output.find((item) => item.type === "chunk")!.code;
}

describe("runtime-specific package export conditions", () => {
  it("keeps the default node server conditions", async () => {
    const code = await buildConditions(await createFixture(), null);
    expect(code).toContain('var default_default = "default";');
    expect(code).toContain('var node_default = "node";');
    expect(code).toMatch(/react:\s*default_default/);
    expect(code).toMatch(/serverFavoringBrowser:\s*node_default/);
    expect(code).toMatch(/serverFavoringEdge:\s*node_default/);
  });

  it("uses react-server, browser, and edge-light for App edge graphs", async () => {
    const code = await buildConditions(await createFixture(), "edge-light-react-server");
    expect(code).toMatch(/react:\s*"react-server"/);
    expect(code).toMatch(/serverFavoringBrowser:\s*"browser"/);
    expect(code).toMatch(/serverFavoringEdge:\s*"edge-light"/);
  });

  it("does not leak edge server conditions into client graphs", async () => {
    const code = await buildConditions(
      await createFixture(),
      "edge-light-react-server",
      undefined,
      false,
    );
    expect(code).toContain('var default_default = "default"');
    expect(code).toContain('var browser_default = "browser"');
    expect(code).not.toContain('var react_server_default = "react-server"');
    expect(code).not.toContain('var edge_light_default = "edge-light"');
  });

  it("uses browser and edge-light without react-server for Pages edge graphs", async () => {
    const code = await buildConditions(await createFixture(), "edge-light");
    expect(code).toMatch(/react:\s*"default"/);
    expect(code).toMatch(/serverFavoringBrowser:\s*"browser"/);
    expect(code).toMatch(/serverFavoringEdge:\s*"edge-light"/);
  });

  it("does not let worker or workerd override Next edge conditions", async () => {
    const code = await buildConditions(await createFixture(), "middleware", [
      "module",
      "worker",
      "workerd",
      "browser",
      "node",
    ]);
    expect(code).toMatch(/react:\s*"react-server"/);
    expect(code).toMatch(/serverFavoringBrowser:\s*"browser"/);
    expect(code).toMatch(/serverFavoringEdge:\s*"edge-light"/);
    expect(code).not.toContain('"serverFavoringEdge":"worker"');
    expect(code).not.toContain('"serverFavoringEdge":"workerd"');
  });

  it("removes node and node-addons from edge condition graphs", async () => {
    const root = await createFixture();
    const virtualEntry = "\0runtime-export-node-first";
    const entryId = withRuntimeExportCondition(virtualEntry, "edge-light");
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      resolve: {
        conditions: ["module", "node", "node-addons", "edge-light", "browser"],
      },
      plugins: [
        {
          name: "runtime-export-node-first-entry",
          resolveId(source) {
            return source === entryId ? source : null;
          },
          load(id) {
            return id === entryId
              ? 'import value from "library-with-exports/node-first"; console.log(value);'
              : null;
          },
        },
        runtimeExportConditionsPlugin(),
      ],
      ssr: { noExternal: true },
      build: { write: false, ssr: true, minify: false, rollupOptions: { input: entryId } },
    });
    if (!Array.isArray(result) && !("output" in result)) {
      throw new Error("Unexpected watch result from one-shot build");
    }
    const output = Array.isArray(result) ? result[0]!.output : result.output;
    const code = output.find((item) => item.type === "chunk")!.code;
    expect(code).toContain('console.log("edge-light")');
    expect(code).not.toContain('console.log("node")');
    expect(code).not.toContain('console.log("node-addons")');
  });

  it("preserves import versus require package export branches", async () => {
    const root = await createFixture();
    expect(await buildModuleKind(root, "import")).toContain('console.log("edge-import")');
    expect(await buildModuleKind(root, "require")).toContain('module.exports = "edge-require"');
  });

  it("does not append runtime markers to unresolved bare externals", async () => {
    const root = await createFixture();
    const virtualEntry = "\0runtime-export-external";
    const entryId = withRuntimeExportCondition(virtualEntry, "edge-light-react-server");
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "runtime-export-external-entry",
          resolveId(source) {
            return source === entryId ? source : null;
          },
          load(id) {
            return id === entryId
              ? 'import external from "external-only"; console.log(external);'
              : null;
          },
        },
        runtimeExportConditionsPlugin(),
      ],
      build: {
        write: false,
        ssr: true,
        minify: false,
        rolldownOptions: { external: ["external-only"], input: entryId },
      },
    });
    if (!Array.isArray(result) && !("output" in result)) {
      throw new Error("Unexpected watch result from one-shot build");
    }
    const output = Array.isArray(result) ? result[0]!.output : result.output;
    const code = output.find((item) => item.type === "chunk")!.code;
    expect(code).toContain('from "external-only"');
    expect(code).not.toContain("external-only?__vinext_runtime_condition");
  });

  it("preserves ssr.external metadata in marked edge graphs", async () => {
    const root = await createFixture();
    const entryPath = path.join(root, "external-entry.js");
    await writeFile(
      entryPath,
      'import value from "library-with-exports/server-favoring-edge"; console.log(value);',
    );

    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [runtimeExportConditionsPlugin()],
      ssr: { external: ["library-with-exports"] },
      build: {
        write: false,
        ssr: true,
        minify: false,
        rolldownOptions: {
          input: withRuntimeExportCondition(entryPath, "edge-light"),
        },
      },
    });
    if (!Array.isArray(result) && !("output" in result)) {
      throw new Error("Unexpected watch result from one-shot build");
    }
    const output = Array.isArray(result) ? result[0]!.output : result.output;
    const code = output.find((item) => item.type === "chunk")!.code;
    expect(code).toContain('from "library-with-exports/server-favoring-edge"');
    expect(code).not.toContain("server-favoring-edge?__vinext_runtime_condition");
  });

  it("preserves downstream ownership of virtual package resolutions", async () => {
    const root = await createFixture();
    const entryPath = path.join(root, "loader-owned-entry.js");
    const virtualId = "\0loader-owned-package";
    await writeFile(
      entryPath,
      'import value from "library-with-exports/server-favoring-edge"; console.log(value);',
    );

    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      resolve: {
        alias: {
          "library-with-exports/server-favoring-edge": virtualId,
        },
      },
      plugins: [
        runtimeExportConditionsPlugin(),
        {
          name: "loader-owned-package",
          resolveId(source) {
            if (source === virtualId) return virtualId;
            return null;
          },
          load(id) {
            return id === virtualId ? 'export default "loader-owned";' : null;
          },
        },
      ],
      ssr: { noExternal: true },
      build: {
        write: false,
        ssr: true,
        minify: false,
        rolldownOptions: { input: withRuntimeExportCondition(entryPath, "edge-light") },
      },
    });
    if (!Array.isArray(result) && !("output" in result)) {
      throw new Error("Unexpected watch result from one-shot build");
    }
    const output = Array.isArray(result) ? result[0]!.output : result.output;
    const code = output.find((item) => item.type === "chunk")!.code;
    expect(code).toContain('console.log("loader-owned")');
  });

  it("preserves shared virtual module identities", async () => {
    const root = await createFixture();
    const nodeEntry = path.join(root, "virtual-node-entry.js");
    const edgeEntry = path.join(root, "virtual-edge-entry.js");
    const virtualDependency = "virtual:runtime-export-dependency";
    const resolvedVirtualDependency = `\0${virtualDependency}`;
    await writeFile(
      nodeEntry,
      `import value from ${JSON.stringify(virtualDependency)}; console.log("node", value);`,
    );
    await writeFile(
      edgeEntry,
      `import value from ${JSON.stringify(virtualDependency)}; console.log("edge", value);`,
    );
    const loadedIds: string[] = [];
    let virtualLoadCount = 0;

    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        runtimeExportConditionsPlugin(),
        {
          name: "runtime-export-virtual-modules",
          resolveId(source) {
            if (source === resolvedVirtualDependency) return source;
            if (source === virtualDependency) return resolvedVirtualDependency;
            return null;
          },
          load(id) {
            loadedIds.push(id);
            if (id === resolvedVirtualDependency) {
              virtualLoadCount++;
              return 'import value from "library-with-exports/server-favoring-edge"; export default value;';
            }
            return null;
          },
        },
      ],
      ssr: { noExternal: true },
      build: {
        write: false,
        ssr: true,
        minify: false,
        rolldownOptions: {
          input: {
            node: nodeEntry,
            edge: withRuntimeExportCondition(edgeEntry, "edge-light-react-server"),
          },
          output: { entryFileNames: "[name].js" },
        },
      },
    });
    if (!Array.isArray(result) && !("output" in result)) {
      throw new Error("Unexpected watch result from one-shot build");
    }
    const output = Array.isArray(result) ? result[0]!.output : result.output;
    const nodeCode = output.find((item) => item.type === "chunk" && item.fileName === "node.js")!;
    const edgeCode = output.find((item) => item.type === "chunk" && item.fileName === "edge.js")!;
    expect(nodeCode.type === "chunk" && nodeCode.code).toContain('console.log("node",');
    expect(edgeCode.type === "chunk" && edgeCode.code).toContain('console.log("edge",');
    expect(loadedIds).toContain(resolvedVirtualDependency);
    expect(loadedIds.filter((id) => id.includes("runtime-export-dependency"))).toEqual([
      resolvedVirtualDependency,
    ]);
    expect(virtualLoadCount).toBe(1);
  });

  it("preserves arbitrary NUL virtual IDs without appending runtime queries", async () => {
    const root = await createFixture();
    const nodeEntry = path.join(root, "nul-node-entry.js");
    const edgeEntry = path.join(root, "nul-edge-entry.js");
    const virtualDependency = "virtual:dep";
    const resolvedVirtualDependency = "\0dep";
    await writeFile(
      nodeEntry,
      `import value from ${JSON.stringify(virtualDependency)}; console.log("node", value);`,
    );
    await writeFile(
      edgeEntry,
      `import value from ${JSON.stringify(virtualDependency)}; console.log("edge", value);`,
    );
    const loadedIds: string[] = [];
    let virtualLoadCount = 0;

    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        runtimeExportConditionsPlugin(),
        {
          name: "runtime-export-arbitrary-nul-module",
          resolveId(source) {
            if (source === resolvedVirtualDependency) return source;
            if (source === virtualDependency) return resolvedVirtualDependency;
            return null;
          },
          load(id) {
            loadedIds.push(id);
            if (id === resolvedVirtualDependency) {
              virtualLoadCount++;
              return 'import value from "library-with-exports/server-favoring-edge"; export default value;';
            }
            return null;
          },
        },
      ],
      ssr: { noExternal: true },
      build: {
        write: false,
        ssr: true,
        minify: false,
        rolldownOptions: {
          input: {
            node: nodeEntry,
            edge: withRuntimeExportCondition(edgeEntry, "edge-light-react-server"),
          },
          output: { entryFileNames: "nul-[name].js" },
        },
      },
    });
    if (!Array.isArray(result) && !("output" in result)) {
      throw new Error("Unexpected watch result from one-shot build");
    }
    const output = Array.isArray(result) ? result[0]!.output : result.output;
    const nodeCode = output.find(
      (item) => item.type === "chunk" && item.fileName === "nul-node.js",
    )!;
    const edgeCode = output.find(
      (item) => item.type === "chunk" && item.fileName === "nul-edge.js",
    )!;
    expect(nodeCode.type === "chunk" && nodeCode.code).toContain('console.log("node",');
    expect(edgeCode.type === "chunk" && edgeCode.code).toContain('console.log("edge",');
    expect(loadedIds.filter((id) => id.startsWith("\0"))).toEqual([resolvedVirtualDependency]);
    expect(
      loadedIds.some((id) => id.startsWith("\0") && id.includes("?__vinext_runtime_condition")),
    ).toBe(false);
    expect(virtualLoadCount).toBe(1);
  });
});

async function symlinkWorkspaceNodeModules(root: string): Promise<void> {
  const workspaceNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  const fixtureNodeModules = path.join(root, "node_modules");
  await fs.mkdir(fixtureNodeModules, { recursive: true });

  for (const entry of await fs.readdir(workspaceNodeModules, { withFileTypes: true })) {
    if (entry.name === "library-with-exports") continue;
    await fs.symlink(
      path.join(workspaceNodeModules, entry.name),
      path.join(fixtureNodeModules, entry.name),
      "junction",
    );
  }
}

async function createVinextFixture(): Promise<string> {
  const root = await createFixture();
  await symlinkWorkspaceNodeModules(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    path.join(root, "app", "layout.tsx"),
    `export const runtime = "edge";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
  );
  await writeFile(
    path.join(root, "app", "node-route", "route.ts"),
    `import react from "library-with-exports/react";
import serverFavoringBrowser from "library-with-exports/server-favoring-browser";
import serverFavoringEdge from "library-with-exports/server-favoring-edge";
export const runtime = "nodejs";
export function GET() {
  return Response.json({ react, serverFavoringBrowser, serverFavoringEdge });
}`,
  );
  await writeFile(
    path.join(root, "app", "edge-route", "route.ts"),
    `import react from "library-with-exports/react";
import serverFavoringBrowser from "library-with-exports/server-favoring-browser";
import serverFavoringEdge from "library-with-exports/server-favoring-edge";
export const runtime = "edge";
export function GET() {
  return Response.json({ react, serverFavoringBrowser, serverFavoringEdge });
}`,
  );
  await writeFile(
    path.join(root, "app", "inherited-edge-route", "route.ts"),
    `import react from "library-with-exports/react";
import serverFavoringBrowser from "library-with-exports/server-favoring-browser";
import serverFavoringEdge from "library-with-exports/server-favoring-edge";
export function GET() {
  return Response.json({ react, serverFavoringBrowser, serverFavoringEdge });
}`,
  );
  await writeFile(
    path.join(root, "app", "client.tsx"),
    `'use client';
import react from "library-with-exports/react";
import serverFavoringBrowser from "library-with-exports/server-favoring-browser";
import serverFavoringEdge from "library-with-exports/server-favoring-edge";
export default function Client() {
  return <output>{JSON.stringify({ react, serverFavoringBrowser, serverFavoringEdge })}</output>;
}`,
  );
  await writeFile(
    path.join(root, "app", "page.tsx"),
    `import Client from "./client";
export default function Page() { return <Client />; }`,
  );
  await writeFile(
    path.join(root, "middleware.ts"),
    `import react from "library-with-exports/react";
import serverFavoringBrowser from "library-with-exports/server-favoring-browser";
import serverFavoringEdge from "library-with-exports/server-favoring-edge";
import { NextResponse } from "next/server";
export function middleware() {
  const response = NextResponse.next();
  response.headers.set("x-react-condition", react);
  response.headers.set("x-server-favoring-browser-condition", serverFavoringBrowser);
  response.headers.set("x-server-favoring-edge-condition", serverFavoringEdge);
  return response;
}`,
  );
  await writeFile(
    path.join(root, "pages", "api", "node-route.ts"),
    `import react from "library-with-exports/react";
import serverFavoringBrowser from "library-with-exports/server-favoring-browser";
import serverFavoringEdge from "library-with-exports/server-favoring-edge";
export const config = { runtime: "nodejs" };
export default function handler(_request: unknown, response: { status(code: number): typeof response; json(value: unknown): void }) {
  response.status(200).json({ react, serverFavoringBrowser, serverFavoringEdge });
}`,
  );
  await writeFile(
    path.join(root, "pages", "api", "edge-route.ts"),
    `import react from "library-with-exports/react";
import serverFavoringBrowser from "library-with-exports/server-favoring-browser";
import serverFavoringEdge from "library-with-exports/server-favoring-edge";
export const config = { runtime: "experimental-edge" };
export default function handler() {
  return Response.json({ react, serverFavoringBrowser, serverFavoringEdge });
}`,
  );
  return root;
}

async function readAllJavaScript(directory: string): Promise<string> {
  let source = "";
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) source += await readAllJavaScript(entryPath);
    else if (entry.name.endsWith(".js")) source += await fs.readFile(entryPath, "utf8");
  }
  return source;
}

describe("vinext runtime-specific package export integration", () => {
  it("matches node, edge, middleware, and client conditions", async () => {
    const root = await createVinextFixture();
    const { createBuilder } = await import("vite");
    const { default: vinext } = await import("../packages/vinext/src/index.js");
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: root })],
    });
    await builder.buildApp();

    const serverEntryUrl = pathToFileURL(path.join(root, "dist", "server", "index.js"));
    serverEntryUrl.searchParams.set("t", String(Date.now()));
    const serverEntry = await import(serverEntryUrl.href);
    const handler = serverEntry.default as (request: Request) => Promise<Response>;

    const nodeResponse = await handler(new Request("http://localhost/node-route"));
    expect(await nodeResponse.json()).toEqual({
      react: "react-server",
      serverFavoringBrowser: "node",
      serverFavoringEdge: "node",
    });
    expect(nodeResponse.headers.get("x-react-condition")).toBe("react-server");
    expect(nodeResponse.headers.get("x-server-favoring-browser-condition")).toBe("browser");
    expect(nodeResponse.headers.get("x-server-favoring-edge-condition")).toBe("edge-light");

    const edgeResponse = await handler(new Request("http://localhost/edge-route"));
    expect(await edgeResponse.json()).toEqual({
      react: "react-server",
      serverFavoringBrowser: "browser",
      serverFavoringEdge: "edge-light",
    });

    const inheritedEdgeResponse = await handler(
      new Request("http://localhost/inherited-edge-route"),
    );
    expect(await inheritedEdgeResponse.json()).toEqual({
      react: "react-server",
      serverFavoringBrowser: "browser",
      serverFavoringEdge: "edge-light",
    });

    const clientSource = await readAllJavaScript(path.join(root, "dist", "client"));
    expect(clientSource).toContain("browser");
    expect(clientSource).not.toContain("edge-light-react-server");

    const pagesOutDir = path.join(root, "dist", "pages-server");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ disableAppRouter: true })],
      build: {
        outDir: pagesOutDir,
        ssr: "virtual:vinext-server-entry",
        rollupOptions: { output: { entryFileNames: "entry.js" } },
      },
    });

    const pagesEntryUrl = pathToFileURL(path.join(pagesOutDir, "entry.js"));
    pagesEntryUrl.searchParams.set("t", String(Date.now()));
    const pagesEntry = await import(pagesEntryUrl.href);
    const middlewareResult = await pagesEntry.runMiddleware(
      new Request("http://localhost/api/node-route"),
    );
    expect(middlewareResult.responseHeaders?.get("x-react-condition")).toBe("react-server");
    expect(middlewareResult.responseHeaders?.get("x-server-favoring-browser-condition")).toBe(
      "browser",
    );
    expect(middlewareResult.responseHeaders?.get("x-server-favoring-edge-condition")).toBe(
      "edge-light",
    );

    const nodeApiResponse = await pagesEntry.handleApiRoute(
      new Request("http://localhost/api/node-route"),
      "/api/node-route",
    );
    expect(await nodeApiResponse.json()).toEqual({
      react: "default",
      serverFavoringBrowser: "node",
      serverFavoringEdge: "node",
    });

    const edgeApiResponse = await pagesEntry.handleApiRoute(
      new Request("http://localhost/api/edge-route"),
      "/api/edge-route",
    );
    expect(await edgeApiResponse.json()).toEqual({
      react: "default",
      serverFavoringBrowser: "browser",
      serverFavoringEdge: "edge-light",
    });
  }, 60_000);
});
