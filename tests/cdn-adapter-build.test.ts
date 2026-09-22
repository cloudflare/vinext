import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { cdnAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.js";
import {
  VINEXT_BUILD_LIFECYCLE_CONFIG,
  type BuildLifecycleResult,
} from "../packages/vinext/src/build/lifecycle.js";
import vinext from "../packages/vinext/src/index.js";

const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "fixtures/cf-app-basic/node_modules",
);
const CLOUDFLARE_PLUGIN_PATH = path.join(
  CLOUDFLARE_NODE_MODULES,
  "@cloudflare/vite-plugin/dist/index.mjs",
);

type ManifestChunk = { file: string; imports?: string[]; src?: string };

async function readManifest(serverDir: string): Promise<Record<string, ManifestChunk>> {
  return JSON.parse(await fs.readFile(path.join(serverDir, ".vite/manifest.json"), "utf8"));
}

async function readStaticClosure(
  serverDir: string,
  manifest: Record<string, ManifestChunk>,
  entry: ManifestChunk,
): Promise<string> {
  const pending = [entry];
  const seen = new Set<string>();
  let source = "";
  while (pending.length > 0) {
    const chunk = pending.pop()!;
    if (seen.has(chunk.file)) continue;
    seen.add(chunk.file);
    source += await fs.readFile(path.join(serverDir, chunk.file), "utf8");
    for (const imported of chunk.imports ?? []) {
      const importedChunk = manifest[imported];
      if (!importedChunk) throw new Error(`missing manifest chunk ${imported}`);
      pending.push(importedChunk);
    }
  }
  return source;
}

describe("Cloudflare CDN adapter build output", () => {
  let root: string;
  let buildResult: BuildLifecycleResult | undefined;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-cdn-adapter-build-"));
    await fs.symlink(CLOUDFLARE_NODE_MODULES, path.join(root, "node_modules"), "dir");
    await fs.mkdir(path.join(root, "app"), { recursive: true });
    await fs.mkdir(path.join(root, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "cdn-adapter-build", type: "module" }),
    );
    await fs.writeFile(
      path.join(root, "app/layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
    );
    await fs.writeFile(
      path.join(root, "app/page.tsx"),
      "export default function Page() { return <main>home</main>; }\n",
    );
    await fs.writeFile(
      path.join(root, "pages/legacy.tsx"),
      "export default function LegacyPage() { return <main>legacy</main>; }\n",
    );
    await fs.writeFile(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        name: "cdn-adapter-build",
        compatibility_date: "2026-09-02",
        compatibility_flags: ["nodejs_compat"],
        main: "vinext/server/fetch-handler",
        assets: { not_found_handling: "none", binding: "ASSETS" },
      }),
    );

    const { cloudflare } = (await import(pathToFileURL(CLOUDFLARE_PLUGIN_PATH).href)) as {
      cloudflare: (options: {
        viteEnvironment: { name: string; childEnvironments: string[] };
      }) => import("vite").Plugin;
    };
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext({ appDir: root, cache: { cdn: cdnAdapter() } }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      [VINEXT_BUILD_LIFECYCLE_CONFIG]: {
        skipPrerender: true,
        onComplete(result: BuildLifecycleResult) {
          buildResult = result;
        },
      },
    } as Parameters<typeof createBuilder>[0]);
    await builder.buildApp();
  }, 120_000);

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports lifecycle completion without prerendering before deploy policy is known", () => {
    expect(buildResult).toEqual({ prerendered: false, standalone: false });
  });

  it("makes the emitted Wrangler config directly deployable without changing source config", async () => {
    const source = JSON.parse(await fs.readFile(path.join(root, "wrangler.jsonc"), "utf8"));
    const generated = JSON.parse(
      await fs.readFile(path.join(root, "dist/server/wrangler.json"), "utf8"),
    );

    expect(source.version_metadata).toBeUndefined();
    expect(generated.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
  });

  it("registers the native Workers tracing integration in the Worker entry", async () => {
    const serverDir = path.join(root, "dist/server");
    const manifest = await readManifest(serverDir);
    const workerEntry = Object.values(manifest).find((chunk) => chunk.file === "index.js");
    expect(workerEntry).toBeDefined();
    const workerClosure = await readStaticClosure(serverDir, manifest, workerEntry!);
    expect(workerClosure).toContain("cloudflare-workers");
    expect(workerClosure).toContain("enterSpan");
  });

  it("emits the pregenerated-paths sidecar only in the response-stage closure", async () => {
    const sidecarName = "__vinext_pregenerated_concrete_paths.js";
    const serverDir = path.join(root, "dist/server");
    const manifest = await readManifest(serverDir);

    const workerEntry = Object.values(manifest).find((chunk) => chunk.file === "index.js");
    const responseStageEntry = Object.values(manifest).find((chunk) =>
      chunk.src?.endsWith("virtual:vinext-response-stage"),
    );
    expect(workerEntry).toBeDefined();
    expect(responseStageEntry).toBeDefined();

    const sidecarImport = /import\s*["']\.\/__vinext_pregenerated_concrete_paths\.js["']/;
    expect(sidecarImport.test(await readStaticClosure(serverDir, manifest, workerEntry!))).toBe(
      false,
    );
    expect(
      sidecarImport.test(await readStaticClosure(serverDir, manifest, responseStageEntry!)),
    ).toBe(true);
    expect(await fs.readFile(path.join(root, "dist/server", sidecarName), "utf8")).toBe(
      "delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;\n",
    );
  });

  it("is the effective config selected by Wrangler's deploy redirect", async () => {
    const wranglerPath = createRequire(path.join(root, "package.json")).resolve("wrangler");
    const wrangler = (await import(pathToFileURL(wranglerPath).href)) as {
      unstable_readConfig(
        args: Record<string, never>,
        options: {
          hideWarnings: true;
          preserveOriginalMain: true;
          useRedirectIfAvailable: true;
        },
      ): { configPath?: string; version_metadata?: { binding: string } };
    };
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const config = wrangler.unstable_readConfig(
        {},
        {
          hideWarnings: true,
          preserveOriginalMain: true,
          useRedirectIfAvailable: true,
        },
      );
      expect(await fs.realpath(path.resolve(root, config.configPath ?? ""))).toBe(
        await fs.realpath(path.join(root, "dist/server/wrangler.json")),
      );
      expect(config.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("adds the binding to a Pages Router primary output", async () => {
    const pagesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-cdn-adapter-pages-"));
    try {
      await fs.symlink(CLOUDFLARE_NODE_MODULES, path.join(pagesRoot, "node_modules"), "dir");
      await fs.mkdir(path.join(pagesRoot, "pages"), { recursive: true });
      await fs.writeFile(
        path.join(pagesRoot, "package.json"),
        JSON.stringify({ name: "cdn-adapter-pages", type: "module" }),
      );
      await fs.writeFile(
        path.join(pagesRoot, "pages/index.tsx"),
        "export default function Page() { return <main>home</main>; }\n",
      );
      await fs.writeFile(
        path.join(pagesRoot, "wrangler.jsonc"),
        JSON.stringify({
          name: "cdn-adapter-pages",
          compatibility_date: "2026-09-02",
          compatibility_flags: ["nodejs_compat"],
          main: "vinext/server/fetch-handler",
          assets: { not_found_handling: "none", binding: "ASSETS" },
        }),
      );

      const { cloudflare } = (await import(pathToFileURL(CLOUDFLARE_PLUGIN_PATH).href)) as {
        cloudflare: () => import("vite").Plugin;
      };
      const builder = await createBuilder({
        root: pagesRoot,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext({ appDir: pagesRoot, cache: { cdn: cdnAdapter() } }), cloudflare()],
      });
      await builder.buildApp();

      const redirect = JSON.parse(
        await fs.readFile(path.join(pagesRoot, ".wrangler/deploy/config.json"), "utf8"),
      ) as { configPath: string };
      const generatedPath = path.resolve(pagesRoot, ".wrangler/deploy", redirect.configPath);
      const generated = JSON.parse(await fs.readFile(generatedPath, "utf8"));
      expect(generated.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
      const serverDir = path.dirname(generatedPath);
      const manifest = await readManifest(serverDir);
      const workerEntry = Object.values(manifest).find((chunk) => chunk.file === "index.js");
      expect(workerEntry).toBeDefined();
      const workerClosure = await readStaticClosure(serverDir, manifest, workerEntry!);
      expect(workerClosure).toContain("cloudflare-workers");
      expect(workerClosure).toContain("enterSpan");
      await expect(
        fs.readFile(path.join(pagesRoot, "dist/server/__vinext_pregenerated_concrete_paths.js")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(pagesRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
