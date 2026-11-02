import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, createServer, type Plugin, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { toSlash } from "pathslash";
import vinext from "../packages/vinext/src/index.js";

type BuiltHandler = (request: Request) => Promise<Response>;

const FONT = Buffer.from("linked-package-font-bytes");

// A `file:` dependency as npm and pnpm install it: node_modules/linked-og is a
// symlink to a package outside the app root, so Vite resolves it to that
// realpath and the OG plugin has to learn the package root from the import.
function createWorkspace(): { workspaceRoot: string; root: string } {
  const workspaceRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "vinext-og-resolve-")),
  );
  const root = path.join(workspaceRoot, "app");
  const packageRoot = path.join(workspaceRoot, "packages", "linked-og");
  fs.mkdirSync(path.join(root, "app", "api", "font"), { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });

  const nodeModules = path.join(root, "node_modules");
  fs.mkdirSync(nodeModules);
  const workspaceNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  for (const entry of fs.readdirSync(workspaceNodeModules, { withFileTypes: true })) {
    if (entry.name === ".vite") continue;
    const sourceEntry = path.join(workspaceNodeModules, entry.name);
    fs.symlinkSync(
      sourceEntry,
      path.join(nodeModules, entry.name),
      fs.statSync(sourceEntry).isDirectory() ? "junction" : "file",
    );
  }
  fs.symlinkSync(packageRoot, path.join(nodeModules, "linked-og"), "junction");

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      type: "module",
      dependencies: { "linked-og": "file:../packages/linked-og", react: "*" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "app", "layout.tsx"),
    `export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}`,
  );
  fs.writeFileSync(
    path.join(root, "app", "page.tsx"),
    `import { version } from "react";
import Client from "./client";
export default function Page() { return <main>react {version}<Client /></main>; }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "client.tsx"),
    `"use client";
import { useState } from "react";
import { label } from "linked-og";
export default function Client() {
  const [text] = useState(label);
  return <p>{text}</p>;
}`,
  );
  fs.writeFileSync(
    path.join(root, "app", "api", "font", "route.ts"),
    `import { loadFont } from "linked-og";
export async function GET() {
  const font = await loadFont();
  return new Response(Buffer.from(font).toString("base64"));
}`,
  );

  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "linked-og", type: "module", main: "./index.js" }),
  );
  fs.writeFileSync(path.join(packageRoot, "font.ttf"), FONT);
  fs.writeFileSync(
    path.join(packageRoot, "index.js"),
    `export const label = "linked-og-label";
export function loadFont() {
  return fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());
}`,
  );
  return { workspaceRoot, root };
}

// Counts how often the resolver chain after vinext's pre plugins sees each
// dependency import of the page and client component. vinext must hand Vite
// one resolution, not ask for it twice. The route handler's RSC import is left
// out: @vitejs/plugin-rsc re-resolves RSC bare imports outside node_modules
// itself.
function createPlugins(root: string, resolutions: Map<string, number>): Plugin[] {
  const countedImporters = new Set(
    ["page.tsx", "client.tsx"].map((file) => toSlash(path.join(root, "app", file))),
  );
  return [
    ...(vinext({ appDir: root }) as Plugin[]),
    {
      name: "count-dependency-resolutions",
      enforce: "pre",
      // The production build compiles the server environments twice (an RSC
      // scan pass, then the real build), so only the latest pass is counted.
      buildStart() {
        for (const key of resolutions.keys()) {
          if (key.startsWith(`${this.environment.name} `)) resolutions.delete(key);
        }
      },
      resolveId(source, importer) {
        if (source !== "linked-og" && source !== "react") return null;
        if (!importer || !countedImporters.has(importer.split("?", 1)[0])) return null;
        const key = `${this.environment.name} ${source} ${path.basename(importer)}`;
        resolutions.set(key, (resolutions.get(key) ?? 0) + 1);
        return null;
      },
    },
  ];
}

function expectSingleResolutions(resolutions: Map<string, number>): void {
  expect(resolutions.get("rsc react page.tsx")).toBe(1);
  expect(resolutions.get("ssr linked-og client.tsx")).toBe(1);
  expect([...resolutions].filter(([, count]) => count !== 1)).toEqual([]);
}

describe("OG asset import resolution", () => {
  let workspaceRoot = "";
  let server: ViteDevServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = "";
  });

  it("resolves tracked dependency imports once and still inlines linked package assets", async () => {
    const workspace = createWorkspace();
    workspaceRoot = workspace.workspaceRoot;
    const { root } = workspace;

    const devResolutions = new Map<string, number>();
    server = await createServer({
      root,
      configFile: false,
      plugins: createPlugins(root, devResolutions),
      server: { port: 0 },
      logLevel: "silent",
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address !== "object") throw new Error("dev server has no port");

    const devPage = await fetch(`http://localhost:${address.port}/`);
    expect(devPage.status).toBe(200);
    expect(await devPage.text()).toContain("linked-og-label");
    const devFont = await fetch(`http://localhost:${address.port}/api/font`);
    expect(devFont.status).toBe(200);
    expect(await devFont.text()).toBe(FONT.toString("base64"));
    expectSingleResolutions(devResolutions);

    await server.close();
    server = null;

    const buildResolutions = new Map<string, number>();
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: createPlugins(root, buildResolutions),
      logLevel: "silent",
    });
    await builder.buildApp();
    expectSingleResolutions(buildResolutions);

    const built = (await import(
      `${pathToFileURL(path.join(root, "dist", "server", "index.js")).href}?t=${Date.now()}`
    )) as { default: BuiltHandler };
    const productionFont = await built.default(new Request("http://localhost/api/font"));
    expect(productionFont.status).toBe(200);
    expect(await productionFont.text()).toBe(FONT.toString("base64"));
  }, 120000);

  it("keeps the require export for require() calls to a tracked dependency", async () => {
    const workspace = createWorkspace();
    workspaceRoot = workspace.workspaceRoot;
    const { root } = workspace;
    const packageRoot = path.join(root, "node_modules", "conditional-dep");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "conditional-dep",
        exports: { ".": { import: "./index.mjs", require: "./index.cjs" } },
      }),
    );
    fs.writeFileSync(path.join(packageRoot, "index.mjs"), "export const kind = 'import';");
    fs.writeFileSync(path.join(packageRoot, "index.cjs"), "exports.kind = 'require';");
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.dependencies["conditional-dep"] = "*";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    server = await createServer({
      root,
      configFile: false,
      plugins: vinext({ appDir: root }),
      server: { middlewareMode: true, watch: null },
      logLevel: "silent",
    });
    const container = server.environments.ssr.pluginContainer;
    const importer = toSlash(path.join(root, "app", "page.tsx"));

    const required = await container.resolveId("conditional-dep", importer, {
      kind: "require-call",
    });
    expect(required?.id.split("?", 1)[0]).toMatch(/\/conditional-dep\/index\.cjs$/);
    const imported = await container.resolveId("conditional-dep", importer);
    expect(imported?.id.split("?", 1)[0]).toMatch(/\/conditional-dep\/index\.mjs$/);
  }, 60000);
});
