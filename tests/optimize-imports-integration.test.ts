import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, createServer, type Plugin, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { toSlash } from "pathslash";
import vinext from "../packages/vinext/src/index.js";

type BuiltHandler = (request: Request) => Promise<Response>;

function linkWorkspaceDependencies(root: string): void {
  const source = path.resolve(import.meta.dirname, "../node_modules");
  const target = path.join(root, "node_modules");
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".vite") continue;
    const sourceEntry = path.join(source, entry.name);
    fs.symlinkSync(
      sourceEntry,
      path.join(target, entry.name),
      fs.statSync(sourceEntry).isDirectory() ? "junction" : "file",
    );
  }
}

function createFixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-imports-")));
  linkWorkspaceDependencies(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "app", "layout.tsx"),
    `export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}`,
  );
  fs.writeFileSync(
    path.join(root, "app", "client.tsx"),
    `"use client";
import { Button } from "custom-icons";
export default function Client() { return <Button label="client" />; }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "page.tsx"),
    `import { Button } from "custom-icons";
import Client from "./client";
export default function Page() {
  return <main><Button label="server" /><Client /></main>;
}`,
  );

  const packageRoot = path.join(root, "node_modules", "custom-icons");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "custom-icons", version: "1.0.0", type: "module", main: "./index.js" }),
  );
  fs.writeFileSync(path.join(packageRoot, "index.js"), `export { Button } from "./button";`);
  fs.writeFileSync(
    path.join(packageRoot, "button.js"),
    `import React from "react";
export function Button({ label }) {
  return React.createElement("span", null, "extensionless-button-" + label);
}`,
  );
  return root;
}

function createPlugins(root: string, transformed?: Map<string, string>): Plugin[] {
  const plugins: Plugin[] = [
    ...(vinext({
      appDir: root,
      nextConfig: { experimental: { optimizePackageImports: ["custom-icons"] } },
    }) as Plugin[]),
  ];
  if (transformed) {
    plugins.push({
      name: "capture-extensionless-optimized-imports",
      transform(code, id) {
        const cleanId = id.split("?", 1)[0].replaceAll("\\", "/");
        if (/\/app\/(?:page|client)\.tsx$/.test(cleanId)) {
          transformed.set(`${this.environment.name}:${path.basename(cleanId)}`, code);
        }
      },
    });
  }
  return plugins;
}

describe("optimizePackageImports extensionless re-exports", () => {
  let root = "";
  let server: ViteDevServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("lets Vite resolve extensionless optimized targets in RSC, SSR, and production", async () => {
    root = createFixture();
    const transformed = new Map<string, string>();

    server = await createServer({
      root,
      configFile: false,
      plugins: createPlugins(root, transformed),
      server: { port: 0 },
      logLevel: "silent",
    });
    await server.listen();
    const address = server.httpServer?.address();
    expect(address && typeof address === "object").toBe(true);
    if (!address || typeof address !== "object") return;

    const devResponse = await fetch(`http://localhost:${address.port}/`);
    expect(devResponse.status).toBe(200);
    const devHtml = await devResponse.text();
    expect(devHtml).toContain("extensionless-button-server");
    expect(devHtml).toContain("extensionless-button-client");

    const extensionlessTarget = toSlash(path.join(root, "node_modules", "custom-icons", "button"));
    expect(transformed.get("rsc:page.tsx")).toContain(extensionlessTarget);
    expect(transformed.get("ssr:client.tsx")).toContain(extensionlessTarget);

    await server.close();
    server = null;

    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: createPlugins(root),
      logLevel: "silent",
    });
    await builder.buildApp();
    const built = (await import(
      `${pathToFileURL(path.join(root, "dist", "server", "index.js")).href}?t=${Date.now()}`
    )) as { default: BuiltHandler };
    const productionResponse = await built.default(new Request("http://localhost/"));
    expect(productionResponse.status).toBe(200);
    const productionHtml = await productionResponse.text();
    expect(productionHtml).toContain("extensionless-button-server");
    expect(productionHtml).toContain("extensionless-button-client");
  }, 120000);
});
