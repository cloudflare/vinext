/**
 * Production CSS identity for stylesheets shared by Server and Client
 * Components.
 *
 * Ported from Next.js: test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
 *
 * The browser-level cascade assertions live in
 * tests/e2e/cloudflare-workers/dynamic-preload.spec.ts. These tests pin the build
 * and runtime pieces that make them pass: the shared stylesheet gets one href
 * in both the RSC and client builds, it precedes its importer's own CSS, and
 * the client preload helper hands stylesheets to the App Router runtime.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  assignSharedCssChunkNames,
  hoistIsolatedCss,
} from "../packages/vinext/src/plugins/shared-css-chunks.js";
import { patchPreloadHelperForAppStylesheets } from "../packages/vinext/src/plugins/app-stylesheet-preload.js";
import { toDocumentStylesheetHref } from "../packages/vinext/src/server/app-browser-stylesheets.js";
import { APP_STYLESHEET_LOADER_KEY } from "../packages/vinext/src/utils/app-stylesheet-loader.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function writeFile(file: string, source: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, source, "utf8");
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("assignSharedCssChunkNames", () => {
  it("derives deterministic, unique chunk names from stylesheet basenames", () => {
    const names = assignSharedCssChunkNames([
      "/app/b/global.css",
      "/app/a/global.css",
      "/app/a/button.module.css",
    ]);
    expect(Object.fromEntries(names)).toEqual({
      "/app/a/button.module.css": "button.module",
      "/app/a/global.css": "global",
      "/app/b/global.css": "global-2",
    });
  });
});

describe("hoistIsolatedCss", () => {
  const isolatedIds = new Set(["/app/global.css", "/app/shared.module.css"]);
  const isIsolatedChunk = (chunk: { moduleIds: readonly string[] }) =>
    chunk.moduleIds.length > 0 && chunk.moduleIds.every((id) => isolatedIds.has(id));

  it("orders isolated stylesheets ahead of the importer's own CSS", () => {
    const bundle = {
      "layout.js": {
        type: "chunk",
        imports: ["shared.module.js", "framework.js"],
        moduleIds: ["/app/layout.tsx", "/app/server.module.css"],
        // Vite hoisted the pure-CSS global chunk after the layout's own CSS.
        viteMetadata: { importedCss: new Set(["css/layout.css", "css/global.css"]) },
      },
      "shared.module.js": {
        type: "chunk",
        imports: [],
        moduleIds: ["/app/shared.module.css"],
        viteMetadata: { importedCss: new Set(["css/shared.module.css"]) },
      },
      "framework.js": {
        type: "chunk",
        imports: [],
        moduleIds: ["/node_modules/react/index.js"],
        viteMetadata: { importedCss: new Set<string>() },
      },
      "css/layout.css": { type: "asset" },
    };

    hoistIsolatedCss(bundle, isIsolatedChunk, new Set(["css/global.css", "css/shared.module.css"]));

    expect([...bundle["layout.js"].viteMetadata.importedCss]).toEqual([
      "css/shared.module.css",
      "css/global.css",
      "css/layout.css",
    ]);
    expect([...bundle["shared.module.js"].viteMetadata.importedCss]).toEqual([
      "css/shared.module.css",
    ]);
  });

  it("leaves chunks without isolated stylesheets untouched", () => {
    const importedCss = new Set(["css/page.css", "css/other.css"]);
    hoistIsolatedCss(
      {
        "page.js": {
          type: "chunk",
          imports: [],
          moduleIds: ["/app/page.tsx"],
          viteMetadata: { importedCss },
        },
      },
      isIsolatedChunk,
      new Set(["css/global.css"]),
    );
    expect([...importedCss]).toEqual(["css/page.css", "css/other.css"]);
  });
});

describe("patchPreloadHelperForAppStylesheets", () => {
  // Mirrors the stylesheet branch of Vite's `preload()` helper source.
  const helper = `promise = allSettled(deps.map((dep) => {
			dep = assetsURL(dep, importerUrl);
			dep = importMetaResolve(dep);
			if (dep in seen) return;
			seen[dep] = true;
			const isCss = dep.endsWith(".css");
			for (let i = links.length - 1; i >= 0; i--) {
				const link = links[i];
				if (link.href === dep && (!isCss || link.rel === "stylesheet")) return;
			}
			const link = document.createElement("link");
			document.head.appendChild(link);
		}));`;

  it("hands stylesheets to the App Router loader after the existing-link check", () => {
    const patched = patchPreloadHelperForAppStylesheets(helper);
    expect(patched).not.toBeNull();
    const handOff = patched!.indexOf(`Symbol.for(${JSON.stringify(APP_STYLESHEET_LOADER_KEY)})`);
    expect(handOff).toBeGreaterThan(patched!.indexOf('link.rel === "stylesheet"'));
    expect(handOff).toBeLessThan(patched!.indexOf('document.createElement("link")'));
    expect(patched).toContain("return vinextLoadStylesheet(dep, cspNonce);");
  });

  it("returns null when Vite's helper changes shape", () => {
    expect(patchPreloadHelperForAppStylesheets("export const preload = () => {}")).toBeNull();
  });
});

describe("toDocumentStylesheetHref", () => {
  it("uses root-relative hrefs for same-origin assets to match server stylesheet resources", () => {
    expect(
      toDocumentStylesheetHref(
        "https://example.com/_next/static/css/global.abc.css",
        "https://example.com/page",
      ),
    ).toBe("/_next/static/css/global.abc.css");
  });

  it("keeps cross-origin asset prefixes absolute", () => {
    expect(
      toDocumentStylesheetHref(
        "https://cdn.example.com/_next/static/css/global.abc.css",
        "https://example.com/page",
      ),
    ).toBe("https://cdn.example.com/_next/static/css/global.abc.css");
  });
});

describe("shared Server/Client Component stylesheets in production", () => {
  it("emits one stylesheet href for both builds and orders it before the layout CSS", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-shared-css-"));
    try {
      await fsp.symlink(ROOT_NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");
      await writeFile(
        path.join(fixtureRoot, "package.json"),
        `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "shared.css"),
        ".shared-marker { color: rgb(1, 2, 3); }\n",
      );
      await writeFile(
        path.join(fixtureRoot, "app", "layout.module.css"),
        ".layout { color: rgb(4, 5, 6); }\n",
      );
      await writeFile(
        path.join(fixtureRoot, "app", "layout.tsx"),
        `import "./shared.css";
import styles from "./layout.module.css";
import Client from "./client";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body className={styles.layout}><Client />{children}</body></html>;
}
`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "client.tsx"),
        `"use client";
import dynamic from "next/dynamic";

const Lazy = dynamic(() => import("./lazy"));

export default function Client() {
  return <Lazy />;
}
`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "lazy.tsx"),
        `import "./shared.css";

export default function Lazy() {
  return <p className="shared-marker">lazy</p>;
}
`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "page.tsx"),
        `export default function Page() {
  return <p>home</p>;
}
`,
      );

      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        plugins: [vinext({ appDir: fixtureRoot })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const clientFiles = await listFiles(path.join(fixtureRoot, "dist", "client"));
      const sharedCss = clientFiles.filter((file) =>
        /\/_next\/static\/css\/shared\.[\w-]+\.css$/.test(file),
      );
      expect(sharedCss).toHaveLength(1);
      const sharedHref = `/${path
        .relative(path.join(fixtureRoot, "dist", "client"), sharedCss[0])
        .split(path.sep)
        .join("/")}`;
      expect(await fsp.readFile(sharedCss[0], "utf8")).toContain(".shared-marker");

      // The shared rules live only in the isolated file on both sides.
      for (const file of clientFiles.filter((candidate) => candidate.endsWith(".css"))) {
        if (file === sharedCss[0]) continue;
        expect(await fsp.readFile(file, "utf8")).not.toContain(".shared-marker");
      }

      const assetsManifest = (
        await import(
          pathToFileURL(path.join(fixtureRoot, "dist", "server", "__vite_rsc_assets_manifest.js"))
            .href
        )
      ).default as { serverResources: Record<string, { css: string[] }> };
      const layoutResources = Object.entries(assetsManifest.serverResources).find(([key]) =>
        key.endsWith("app/layout.tsx"),
      )?.[1];
      expect(layoutResources?.css[0]).toBe(sharedHref);
      expect(layoutResources?.css.length).toBeGreaterThan(1);

      const clientChunks = clientFiles.filter((file) => file.endsWith(".js"));
      const chunkSources = await Promise.all(
        clientChunks.map((file) => fsp.readFile(file, "utf8")),
      );
      expect(chunkSources.some((code) => code.includes(APP_STYLESHEET_LOADER_KEY))).toBe(true);
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
});
