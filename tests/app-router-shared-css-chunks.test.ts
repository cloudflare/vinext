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
 * the client preload helper hands stylesheets to the App Router runtime, which
 * still holds the chunk until its stylesheet has been fetched.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  assignSharedCssChunkNames,
  hoistIsolatedCss,
} from "../packages/vinext/src/plugins/shared-css-chunks.js";
import { patchPreloadHelperForAppStylesheets } from "../packages/vinext/src/plugins/app-stylesheet-preload.js";
import {
  installAppStylesheetLoader,
  toDocumentStylesheetHref,
} from "../packages/vinext/src/server/app-browser-stylesheets.js";
import { APP_STYLESHEET_LOADER_KEY } from "../packages/vinext/src/utils/app-stylesheet-loader.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function writeFile(file: string, source: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, source);
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
  const helper = `const links = document.getElementsByTagName("link");
		const cspNonceMeta = document.querySelector("meta[property=csp-nonce]");
		const cspNonce = cspNonceMeta?.nonce || cspNonceMeta?.getAttribute("nonce");
		promise = allSettled(deps.map((dep) => {
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
    // The hand-off reads `dep`, `isCss` and `cspNonce`; renamed bindings would
    // otherwise throw a ReferenceError for every CSS dependency at runtime.
    expect(patchPreloadHelperForAppStylesheets(helper.replaceAll("cspNonce", "nonce"))).toBeNull();
    expect(
      patchPreloadHelperForAppStylesheets(helper.replace("const isCss = dep.", "const isCss = d.")),
    ).toBeNull();
  });
});

describe("App Router stylesheet loader", () => {
  class FakeLink extends EventTarget {
    rel = "";
    as = "";
    crossOrigin: string | null = null;
    href = "";
    readonly attributes = new Map<string, string>();
    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }
  }

  function installFakeDocument() {
    const appended: FakeLink[] = [];
    vi.stubGlobal("document", {
      baseURI: "https://example.com/page",
      createElement: () => new FakeLink(),
      head: { appendChild: (link: FakeLink) => appended.push(link) },
    });
    installAppStylesheetLoader();
    const load = (globalThis as Record<symbol, unknown>)[Symbol.for(APP_STYLESHEET_LOADER_KEY)] as (
      url: string,
      nonce?: string,
    ) => Promise<void> | undefined;
    return { appended, load };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(APP_STYLESHEET_LOADER_KEY)];
  });

  it("holds the chunk until the stylesheet has been fetched, like Vite's helper", async () => {
    const { appended, load } = installFakeDocument();
    const url = "https://example.com/_next/static/css/loader-wait.abc.css";

    const loaded = load(url, "nonce-value");
    expect(loaded).toBeInstanceOf(Promise);
    expect(appended).toHaveLength(1);
    const [link] = appended;
    expect(link.rel).toBe("preload");
    expect(link.as).toBe("style");
    expect(link.crossOrigin).toBe("");
    expect(link.href).toBe("/_next/static/css/loader-wait.abc.css");
    expect(link.attributes.get("nonce")).toBe("nonce-value");

    let settled = false;
    void loaded!.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    link.dispatchEvent(new Event("load"));
    await loaded;
    expect(settled).toBe(true);

    // A later chunk sharing the stylesheet waits on the same fetch.
    expect(load(url)).toBe(loaded);
    expect(appended).toHaveLength(1);
  });

  it("rejects like Vite's helper when the stylesheet fails to load", async () => {
    const { appended, load } = installFakeDocument();
    const url = "https://example.com/_next/static/css/loader-error.abc.css";

    const loaded = load(url);
    appended[0].dispatchEvent(new Event("error"));
    await expect(loaded).rejects.toThrow(`Unable to preload CSS for ${url}`);

    // A retried import fetches again rather than replaying the failure.
    const retried = load(url);
    expect(retried).not.toBe(loaded);
    expect(appended).toHaveLength(2);
    appended[1].dispatchEvent(new Event("load"));
    await expect(retried).resolves.toBeUndefined();
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
  // 1x1 PNG, well under Vite's default 4 KiB `assetsInlineLimit`.
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );

  /**
   * Build an app whose root layout (Server Component) and a next/dynamic
   * client component both import `app/shared.css`, then return the client
   * output and plugin-rsc's assets manifest.
   */
  async function buildSharedStylesheetApp(
    fixtureRoot: string,
    options: { sharedCss: string; files?: Record<string, string | Buffer> },
  ) {
    await fsp.symlink(ROOT_NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");
    const files: Record<string, string | Buffer> = {
      "package.json": `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
      "app/shared.css": options.sharedCss,
      "app/layout.module.css": ".layout { color: rgb(4, 5, 6); }\n",
      "app/layout.tsx": `import "./shared.css";
import styles from "./layout.module.css";
import Client from "./client";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body className={styles.layout}><Client />{children}</body></html>;
}
`,
      "app/client.tsx": `"use client";
import dynamic from "next/dynamic";

const Lazy = dynamic(() => import("./lazy"));

export default function Client() {
  return <Lazy />;
}
`,
      "app/lazy.tsx": `import "./shared.css";

export default function Lazy() {
  return <p className="shared-marker">lazy</p>;
}
`,
      "app/page.tsx": `export default function Page() {
  return <p>home</p>;
}
`,
      ...options.files,
    };
    for (const [file, source] of Object.entries(files)) {
      await writeFile(path.join(fixtureRoot, file), source);
    }

    const builder = await createBuilder({
      root: fixtureRoot,
      configFile: false,
      plugins: [vinext({ appDir: fixtureRoot })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const clientDir = path.join(fixtureRoot, "dist", "client");
    const clientFiles = await listFiles(clientDir);
    const sharedCss = clientFiles.filter((file) =>
      /\/_next\/static\/css\/shared\.[\w-]+\.css$/.test(file),
    );
    const assetsManifest = (
      await import(
        pathToFileURL(path.join(fixtureRoot, "dist", "server", "__vite_rsc_assets_manifest.js"))
          .href
      )
    ).default as { serverResources: Record<string, { css: string[] }> };
    const layoutResources = Object.entries(assetsManifest.serverResources).find(([key]) =>
      key.endsWith("app/layout.tsx"),
    )?.[1];
    const chunkSources = await Promise.all(
      clientFiles.filter((file) => file.endsWith(".js")).map((file) => fsp.readFile(file, "utf8")),
    );
    const toHref = (file: string) => `/${path.relative(clientDir, file).split(path.sep).join("/")}`;
    return { clientFiles, sharedCss, layoutResources, chunkSources, toHref };
  }

  it("emits one stylesheet href for both builds and orders it before the layout CSS", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-shared-css-"));
    try {
      const { clientFiles, sharedCss, layoutResources, chunkSources, toHref } =
        await buildSharedStylesheetApp(fixtureRoot, {
          sharedCss: ".shared-marker { color: rgb(1, 2, 3); }\n",
        });

      expect(sharedCss).toHaveLength(1);
      const sharedHref = toHref(sharedCss[0]);
      expect(await fsp.readFile(sharedCss[0], "utf8")).toContain(".shared-marker");

      // The shared rules live only in the isolated file on both sides.
      for (const file of clientFiles.filter((candidate) => candidate.endsWith(".css"))) {
        if (file === sharedCss[0]) continue;
        expect(await fsp.readFile(file, "utf8")).not.toContain(".shared-marker");
      }

      expect(layoutResources?.css[0]).toBe(sharedHref);
      expect(layoutResources?.css.length).toBeGreaterThan(1);
      expect(chunkSources.some((code) => code.includes(APP_STYLESHEET_LOADER_KEY))).toBe(true);
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);

  it("keeps one href when the RSC and client builds compile the stylesheet differently", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-shared-css-url-"));
    try {
      // Only the client environment disables asset inlining, so the RSC copy
      // of this stylesheet inlines the image as a data URL and the client copy
      // references a file. The client chunk must still point at the RSC file.
      const { clientFiles, sharedCss, layoutResources, chunkSources, toHref } =
        await buildSharedStylesheetApp(fixtureRoot, {
          sharedCss: ".shared-marker { color: rgb(1, 2, 3); background: url(./dot.png); }\n",
          files: { "app/dot.png": TINY_PNG },
        });

      expect(sharedCss).toHaveLength(1);
      const sharedHref = toHref(sharedCss[0]);
      expect(layoutResources?.css[0]).toBe(sharedHref);
      const sharedFileName = path.basename(sharedCss[0]);
      expect(chunkSources.some((code) => code.includes(sharedFileName))).toBe(true);
      for (const file of clientFiles.filter((candidate) => candidate.endsWith(".css"))) {
        if (file === sharedCss[0]) continue;
        expect(await fsp.readFile(file, "utf8")).not.toContain(".shared-marker");
      }
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
});
