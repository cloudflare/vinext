/**
 * Cloudflare Pages Router builds render in the worker environment, and the
 * ASSETS binding serves files from the client build. The asset URLs the worker
 * renders must therefore follow the client environment's asset names, both
 * vinext's defaults and a user's client-environment `assetFileNames`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin, type UserConfig } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const CF_EXAMPLE_DIR = path.resolve(import.meta.dirname, "../examples/pages-router-cloudflare");
const WORKSPACE_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function copyExample(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cf-pages-asset-names-"));
  tmpDirs.push(root);
  fs.cpSync(CF_EXAMPLE_DIR, root, {
    recursive: true,
    filter: (source) => !/[\\/](?:node_modules|dist|\.wrangler)$/.test(source),
  });
  // The example's own dependencies, plus `next`, which the checked-in copy
  // resolves from the workspace root.
  const nodeModules = path.join(root, "node_modules");
  fs.mkdirSync(nodeModules);
  for (const entry of fs.readdirSync(path.join(CF_EXAMPLE_DIR, "node_modules"))) {
    fs.symlinkSync(
      path.join(CF_EXAMPLE_DIR, "node_modules", entry),
      path.join(nodeModules, entry),
      "junction",
    );
  }
  fs.symlinkSync(
    path.join(WORKSPACE_NODE_MODULES, "next"),
    path.join(nodeModules, "next"),
    "junction",
  );

  // Larger than Vite's default inline limit, so both builds emit a file.
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets", "release-notes.txt"), "notes\n".repeat(1000));
  fs.writeFileSync(
    path.join(root, "pages", "static-asset-url.tsx"),
    `import notesUrl from "../assets/release-notes.txt?url";
export default function StaticAssetUrl() {
  return <a href={notesUrl}>Release notes</a>;
}
`,
  );
  return root;
}

async function cloudflarePlugin(): Promise<Plugin> {
  const { cloudflare } = (await import(
    pathToFileURL(path.join(CF_EXAMPLE_DIR, "node_modules/@cloudflare/vite-plugin/dist/index.mjs"))
      .href
  )) as { cloudflare: () => Plugin };
  return cloudflare();
}

function renderedAssetUrls(dir: string): string[] {
  const urls = new Set<string>();
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf-8");
    for (const match of source.matchAll(/["'`](\/_next\/static\/[^"'`]*release-notes[^"'`]*)/g)) {
      urls.add(match[1]);
    }
  }
  return [...urls];
}

describe("Cloudflare Pages Router asset names", () => {
  it.each<[string, UserConfig, RegExp]>([
    ["vinext's default", {}, /^\/_next\/static\/media\/release-notes\.[\w-]{8}\.txt$/],
    [
      "a client-environment",
      {
        environments: {
          client: {
            build: {
              rolldownOptions: {
                output: { assetFileNames: "_next/static/media/client-[name]-[hash][extname]" },
              },
            },
          },
        },
      },
      /^\/_next\/static\/media\/client-release-notes-[\w-]+\.txt$/,
    ],
  ])(
    "renders %s asset name in the worker",
    async (_label, userConfig, expectedUrl) => {
      const root = copyExample();
      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [vinext({ appDir: root }), await cloudflarePlugin()],
        logLevel: "silent",
        ...userConfig,
      });
      await builder.buildApp();

      const distDir = path.join(root, "dist");
      const clientUrls = renderedAssetUrls(path.join(distDir, "client"));
      const workerDirs = fs
        .readdirSync(distDir)
        .filter((name) => name !== "client")
        .map((name) => path.join(distDir, name));
      const workerUrls = workerDirs.flatMap((dir) => renderedAssetUrls(dir));

      expect(clientUrls).toHaveLength(1);
      expect(clientUrls[0]).toMatch(expectedUrl);
      expect(workerUrls).toEqual(clientUrls);
      expect(fs.existsSync(path.join(distDir, "client", clientUrls[0]))).toBe(true);
    },
    120_000,
  );
});
