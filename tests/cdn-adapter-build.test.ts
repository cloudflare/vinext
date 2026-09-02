import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { cdnAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.js";
import vinext from "../packages/vinext/src/index.js";

const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "fixtures/cf-app-basic/node_modules",
);
const CLOUDFLARE_PLUGIN_PATH = path.join(
  CLOUDFLARE_NODE_MODULES,
  "@cloudflare/vite-plugin/dist/index.mjs",
);

describe("Cloudflare CDN adapter build output", () => {
  let root: string;

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
    });
    await builder.buildApp();
  }, 120_000);

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("makes the emitted Wrangler config directly deployable without changing source config", async () => {
    const source = JSON.parse(await fs.readFile(path.join(root, "wrangler.jsonc"), "utf8"));
    const generated = JSON.parse(
      await fs.readFile(path.join(root, "dist/server/wrangler.json"), "utf8"),
    );

    expect(source.version_metadata).toBeUndefined();
    expect(generated.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
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
    } finally {
      await fs.rm(pagesRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
