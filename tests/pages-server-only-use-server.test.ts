/**
 * A `"use server"` directive must not exempt a module from the `server-only`
 * boundary in a Pages Router client graph. With App Router, @vitejs/plugin-rsc
 * replaces such a module with server reference proxies in the browser build,
 * but Pages-only builds have no such transform, so the module and everything
 * it imports would ship to public client chunks as-is.
 *
 * These builds copy checked-in Pages Router apps (the Cloudflare Workers
 * example and the Node fixture) and add a page that imports a harmless export
 * through a barrel from a `"use server"` module importing `server-only` and a
 * source-held signing key. Next.js 16.2.7 fails the build for this graph with
 * both webpack ("'server-only' cannot be imported from a Client Component
 * module", import trace through the barrel) and Turbopack.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const CF_EXAMPLE_DIR = path.resolve(import.meta.dirname, "../examples/pages-router-cloudflare");
const PAGES_FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/pages-basic");
const WORKSPACE_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const SIGNING_KEY = "__VINEXT_PAGES_USE_SERVER_SIGNING_KEY__";
const SERVER_ONLY_ERROR =
  /server[\\/]session\.ts[\s\S]*depends on "server-only".*reachable from a client bundle/;

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(root: string, filePath: string, content: string) {
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function copyFixture(fixtureDir: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-use-server-only-"));
  tmpDirs.push(root);
  fs.cpSync(fixtureDir, root, {
    recursive: true,
    filter: (source) => !/[\\/](?:node_modules|dist|\.wrangler)$/.test(source),
  });
  // The fixture's own dependencies, plus `next`, which the checked-in copy
  // resolves from the workspace root.
  const nodeModules = path.join(root, "node_modules");
  fs.mkdirSync(nodeModules);
  for (const entry of fs.readdirSync(path.join(fixtureDir, "node_modules"))) {
    fs.symlinkSync(
      path.join(fixtureDir, "node_modules", entry),
      path.join(nodeModules, entry),
      "junction",
    );
  }
  if (!fs.existsSync(path.join(nodeModules, "next"))) {
    fs.symlinkSync(
      path.join(WORKSPACE_NODE_MODULES, "next"),
      path.join(nodeModules, "next"),
      "junction",
    );
  }

  writeFile(
    root,
    "server/session-key.ts",
    `export const SESSION_SIGNING_KEY = new TextEncoder().encode(${JSON.stringify(SIGNING_KEY)});\n`,
  );
  writeFile(
    root,
    "server/session.ts",
    `"use server";
import "server-only";
import { SESSION_SIGNING_KEY } from "./session-key";

export async function greet(name: string) {
  return "hello " + name;
}

export async function signSession(payload: string) {
  return payload + "." + SESSION_SIGNING_KEY.length;
}
`,
  );
  writeFile(root, "server/index.ts", 'export { greet } from "./session";\n');
  writeFile(
    root,
    "pages/use-server-greet.tsx",
    `import { greet } from "../server";

export default function UseServerGreetPage() {
  return <button onClick={() => void greet("visitor")}>greet</button>;
}
`,
  );
  return root;
}

async function buildFixture(root: string, plugins: Plugin[] = []): Promise<void> {
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root }), ...plugins],
    logLevel: "silent",
  });
  await builder.buildApp();
}

describe("Pages Router client builds reject server-only behind a 'use server' directive", () => {
  it("fails the Cloudflare Workers build when a page imports a barrel export", async () => {
    const root = copyFixture(CF_EXAMPLE_DIR);
    const { cloudflare } = (await import(
      pathToFileURL(
        path.join(CF_EXAMPLE_DIR, "node_modules/@cloudflare/vite-plugin/dist/index.mjs"),
      ).href
    )) as { cloudflare: () => Plugin };

    await expect(buildFixture(root, [cloudflare()])).rejects.toThrow(SERVER_ONLY_ERROR);
  }, 120_000);

  it("fails the Node build when a page imports a barrel export", async () => {
    const root = copyFixture(PAGES_FIXTURE_DIR);

    await expect(buildFixture(root)).rejects.toThrow(SERVER_ONLY_ERROR);
  }, 120_000);
});
