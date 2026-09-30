import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createBuilder, type Plugin } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { createScanBuildCssPlugin } from "../packages/vinext/src/plugins/scan-build-css.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

type TransformFilter = { id: { include: RegExp; exclude: RegExp[] } };
type TransformHook = {
  order: string;
  filter: TransformFilter;
  handler: (this: unknown, code: string, id: string) => unknown;
};

function setupPlugin(isScanBuild: boolean | undefined) {
  const plugin = createScanBuildCssPlugin();
  const rscPlugins =
    isScanBuild === undefined ? [] : [{ name: "rsc:minimal", api: { manager: { isScanBuild } } }];
  (plugin.configResolved as (config: unknown) => void)({ plugins: rscPlugins });
  const transform = plugin.transform as TransformHook;
  return {
    transform,
    run(write: boolean) {
      const context = { environment: { config: { build: { write } } } };
      return transform.handler.call(context, ".title { color: red; }", "/app/page.module.css");
    },
  };
}

function matchesFilter(filter: TransformFilter, id: string): boolean {
  return filter.id.include.test(id) && !filter.id.exclude.some((pattern) => pattern.test(id));
}

describe("vinext:scan-build-css", () => {
  it("empties stylesheets only in plugin-rsc scan builds", () => {
    expect(setupPlugin(true).run(false)).toEqual({ code: "", map: null });
    // Real RSC/SSR/client builds after the scans.
    expect(setupPlugin(false).run(true)).toBeNull();
    // A write-less build that is not a plugin-rsc scan keeps its CSS output.
    expect(setupPlugin(false).run(false)).toBeNull();
    expect(setupPlugin(true).run(true)).toBeNull();
    expect(setupPlugin(undefined).run(false)).toBeNull();
  });

  it("runs before other stylesheet transforms", () => {
    const plugin = createScanBuildCssPlugin();
    expect(plugin.enforce).toBe("pre");
    expect(plugin.apply).toBe("build");
    expect((plugin.transform as TransformHook).order).toBe("pre");
  });

  it("matches the modules Vite compiles as CSS", () => {
    const { filter } = setupPlugin(true).transform;
    for (const id of [
      "/app/global.css",
      "/app/page.module.css",
      "/app/theme.scss",
      "/app/theme.module.sass",
      "/app/theme.less",
      "/app/theme.styl",
      "/app/theme.pcss",
      "/app/global.css?inline",
      "/app/global.css?transform-only",
    ]) {
      expect(matchesFilter(filter, id), id).toBe(true);
    }
    for (const id of [
      "/app/global.css?url",
      "/app/global.css?raw",
      "/app/global.css?worker",
      "\0vinext-data-css/0123456789abcdef.css",
      "/app/styles.css.ts",
      "/app/page.tsx",
    ]) {
      expect(matchesFilter(filter, id), id).toBe(false);
    }
  });

  it("skips CSS in scan builds without changing the real build's CSS or CSS Module exports", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scan-build-css-"));
    try {
      await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");
      const appDir = path.join(tmpDir, "app");
      await fs.mkdir(appDir, { recursive: true });
      await fs.writeFile(path.join(appDir, "global.css"), ".scan-global { color: green; }\n");
      await fs.writeFile(path.join(appDir, "page.module.css"), ".title { color: blue; }\n");
      await fs.writeFile(path.join(appDir, "inline.css"), ".scan-inline { color: red; }\n");
      await fs.writeFile(path.join(appDir, "linked.css"), ".scan-linked { color: teal; }\n");
      await fs.writeFile(
        path.join(appDir, "layout.tsx"),
        `import "./global.css";\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (<html><body>{children}</body></html>);\n}\n`,
      );
      await fs.writeFile(
        path.join(appDir, "page.tsx"),
        `import styles from "./page.module.css";\nimport inlineCss from "./inline.css?inline";\nimport linkedCssUrl from "./linked.css?url";\nexport default function Page() {\n  return (<><style>{inlineCss}</style><link rel="stylesheet" href={linkedCssUrl} /><p className={styles.title}>Hello</p></>);\n}\n`,
      );

      // Runs after vinext:scan-build-css (normal hook order), so it records the
      // source every later stylesheet transform receives.
      const seen: { id: string; write: boolean; code: string }[] = [];
      const spy: Plugin = {
        name: "test:css-spy",
        enforce: "pre",
        apply: "build",
        transform: {
          filter: { id: /\.css(?:$|\?)/ },
          handler(code, id) {
            seen.push({ id, write: this.environment.config.build.write, code });
            return null;
          },
        },
      };

      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [spy, vinext({ appDir: tmpDir })],
        logLevel: "silent",
      });
      await builder.buildApp();

      // `?url` CSS loads as JavaScript and is left alone, so only compiled stylesheets count.
      const compiled = seen.filter((entry) => !entry.id.includes("?url"));
      const scanned = compiled.filter((entry) => !entry.write);
      const built = compiled.filter((entry) => entry.write);
      expect(scanned.map((entry) => path.basename(entry.id))).toEqual(
        expect.arrayContaining(["global.css", "page.module.css", "inline.css?inline"]),
      );
      expect(scanned.every((entry) => entry.code === "")).toBe(true);
      expect(built.map((entry) => path.basename(entry.id))).toEqual(
        expect.arrayContaining(["global.css", "page.module.css", "inline.css?inline"]),
      );
      expect(built.every((entry) => entry.code.includes("color:"))).toBe(true);

      const readAll = async (dir: string, extension: RegExp) => {
        const files = await fs.readdir(dir, { recursive: true });
        const contents = await Promise.all(
          files
            .filter((file) => extension.test(file))
            .map((file) => fs.readFile(path.join(dir, file), "utf8")),
        );
        return contents.join("\n");
      };

      const clientCss = await readAll(path.join(tmpDir, "dist", "client"), /\.css$/);
      expect(clientCss).toContain(".scan-global");
      const moduleClass = /\.(_title_[\w-]+)/.exec(clientCss)?.[1];
      expect(moduleClass, "CSS Module class missing from client CSS").toBeDefined();
      const serverJs = await readAll(path.join(tmpDir, "dist", "server"), /\.[cm]?js$/);
      // The rendered page's class name comes from the real build's CSS Module exports.
      expect(serverJs).toContain(moduleClass);
      // `?inline` CSS is compiled into the real build's JS.
      expect(serverJs).toContain(".scan-inline");
      // `?url` CSS is emitted as an asset and referenced by URL.
      const clientDir = path.join(tmpDir, "dist", "client");
      const linkedAsset = (await fs.readdir(clientDir, { recursive: true })).find((file) =>
        /linked\.[\w-]+\.css$/.test(file),
      );
      expect(linkedAsset, "?url CSS asset missing from client output").toBeDefined();
      expect(await fs.readFile(path.join(clientDir, linkedAsset!), "utf8")).toContain(
        ".scan-linked",
      );
      expect(serverJs).toContain(path.basename(linkedAsset!));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 180_000);
});
