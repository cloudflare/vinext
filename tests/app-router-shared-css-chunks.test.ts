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
  computeStylesheetOrders,
  expandIsolatedStylesheets,
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

  it("keeps build-specific names off the shared ones", () => {
    const names = assignSharedCssChunkNames(["/app/other/global.css"], ["global"]);
    expect(Object.fromEntries(names)).toEqual({ "/app/other/global.css": "global-2" });
  });
});

describe("computeStylesheetOrders", () => {
  const graph: Record<string, string[]> = {
    "/app/layout.tsx": ["/app/base.css", "/app/nav.tsx", "/app/b.css"],
    "/app/nav.tsx": ["/app/shared.css", "/app/base.css", "/app/icons.ts"],
    "/app/icons.ts": [],
    // An import cycle must not hang or throw.
    "/app/a.ts": ["/app/a.css", "/app/b.ts"],
    "/app/b.ts": ["/app/a.ts", "/app/b.css"],
  };
  const getImportedIds = (id: string) => graph[id] ?? [];

  it("lists reachable stylesheets in evaluation order, each at its first import", () => {
    const orders = computeStylesheetOrders(Object.keys(graph), getImportedIds);
    expect(orders.get("/app/layout.tsx")).toEqual([
      "/app/base.css",
      "/app/shared.css",
      "/app/b.css",
    ]);
    expect(orders.get("/app/nav.tsx")).toEqual(["/app/shared.css", "/app/base.css"]);
    expect(orders.get("/app/icons.ts")).toEqual([]);
    expect(orders.get("/app/base.css")).toEqual(["/app/base.css"]);
    expect(orders.get("/app/a.ts")).toEqual(["/app/a.css", "/app/b.css"]);
  });
});

describe("expandIsolatedStylesheets", () => {
  const orders = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

  it("isolates nothing extra when shared stylesheets are imported first", () => {
    expect([
      ...expandIsolatedStylesheets(
        orders({ "/app/layout.tsx": ["/app/shared.css", "/app/layout.module.css"] }),
        ["/app/shared.css"],
      ),
    ]).toEqual(["/app/shared.css"]);
  });

  it("isolates stylesheets that precede a shared one so the importer keeps its order", () => {
    // Ported case from review: `base.css` then `shared.css` then `b.css`.
    const isolated = expandIsolatedStylesheets(
      orders({ "/app/layout.tsx": ["/app/base.css", "/app/shared.css", "/app/b.css"] }),
      ["/app/shared.css"],
    );
    expect([...isolated].sort()).toEqual(["/app/base.css", "/app/shared.css"]);
  });

  it("repeats until no importer lists a remaining stylesheet before an isolated one", () => {
    const isolated = expandIsolatedStylesheets(
      orders({
        "/app/a.tsx": ["/app/c1.css", "/app/shared.css"],
        // Isolating c1.css for a.tsx would put it ahead of d1.css here.
        "/app/d.tsx": ["/app/d1.css", "/app/c1.css", "/app/d2.css"],
      }),
      ["/app/shared.css"],
    );
    expect([...isolated].sort()).toEqual(["/app/c1.css", "/app/d1.css", "/app/shared.css"]);
  });
});

describe("hoistIsolatedCss", () => {
  const isolatedIds = new Set(["/app/global.css", "/app/shared.module.css"]);
  const isIsolatedChunk = (chunk: { moduleIds: readonly string[] }) =>
    chunk.moduleIds.length > 0 && chunk.moduleIds.every((id) => isolatedIds.has(id));
  const isolatedCssFiles = new Map([
    ["css/global.css", "/app/global.css"],
    ["css/shared.module.css", "/app/shared.module.css"],
  ]);

  it("orders isolated stylesheets ahead of the importer's own CSS, in import order", () => {
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

    hoistIsolatedCss(bundle, isIsolatedChunk, isolatedCssFiles, () => [
      "/app/global.css",
      "/app/shared.module.css",
      "/app/server.module.css",
    ]);

    expect([...bundle["layout.js"].viteMetadata.importedCss]).toEqual([
      "css/global.css",
      "css/shared.module.css",
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
      isolatedCssFiles,
      () => [],
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

  function installFakeDocument(baseURI = "https://example.com/page") {
    const appended: FakeLink[] = [];
    vi.stubGlobal("location", new URL("https://example.com/page"));
    vi.stubGlobal("document", {
      baseURI,
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

  it("classifies same-origin assets by the page URL, not a cross-origin <base>", () => {
    const { appended, load } = installFakeDocument("https://other.example.net/");
    void load("https://example.com/_next/static/css/loader-base.abc.css");
    expect(appended[0].href).toBe("/_next/static/css/loader-base.abc.css");
  });
});

describe("toDocumentStylesheetHref", () => {
  const page = "https://app.example.com/docs/page";

  it("uses root-relative hrefs for same-origin assets without an asset prefix", () => {
    // plugin-rsc renders `base + file`, e.g. with a `/docs` basePath.
    expect(
      toDocumentStylesheetHref("https://app.example.com/docs/_next/static/css/g.abc.css", page),
    ).toBe("/docs/_next/static/css/g.abc.css");
  });

  it("keeps a path asset prefix root-relative", () => {
    expect(
      toDocumentStylesheetHref(
        "https://app.example.com/cdn/_next/static/css/g.abc.css",
        page,
        "/cdn/_next/static/",
      ),
    ).toBe("/cdn/_next/static/css/g.abc.css");
  });

  it("keeps an absolute same-origin asset prefix absolute, as the server renders it", () => {
    expect(
      toDocumentStylesheetHref(
        "https://app.example.com/cdn/_next/static/css/g.abc.css",
        page,
        "https://app.example.com/cdn/_next/static/",
      ),
    ).toBe("https://app.example.com/cdn/_next/static/css/g.abc.css");
  });

  it("keeps a cross-origin CDN asset prefix absolute", () => {
    expect(
      toDocumentStylesheetHref(
        "https://cdn.example.com/_next/static/css/g.abc.css",
        page,
        "https://cdn.example.com/_next/static/",
      ),
    ).toBe("https://cdn.example.com/_next/static/css/g.abc.css");
    // Without the build-time prefix, cross-origin URLs still stay absolute.
    expect(
      toDocumentStylesheetHref("https://cdn.example.com/_next/static/css/g.abc.css", page),
    ).toBe("https://cdn.example.com/_next/static/css/g.abc.css");
  });

  it("reproduces a protocol-relative asset prefix literally", () => {
    expect(
      toDocumentStylesheetHref(
        "https://cdn.example.com/_next/static/css/g.abc.css",
        page,
        "//cdn.example.com/_next/static/",
      ),
    ).toBe("//cdn.example.com/_next/static/css/g.abc.css");
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
    const clientManifest = JSON.parse(
      await fsp.readFile(path.join(clientDir, ".vite", "manifest.json"), "utf8"),
    ) as Record<string, { src?: string; css?: string[] }>;
    /** Concatenate CSS files (hrefs or client-relative names) in order. */
    const readCss = async (files: readonly string[]) => {
      const sources = await Promise.all(
        files.map((file) =>
          fsp.readFile(path.join(clientDir, new URL(file, "https://x/").pathname), "utf8"),
        ),
      );
      return sources.join("\n");
    };
    return {
      clientFiles,
      sharedCss,
      layoutResources,
      chunkSources,
      toHref,
      clientManifest,
      readCss,
    };
  }

  /** Assert that `markers` occur in `css` in the given order. */
  function expectMarkerOrder(css: string, markers: readonly string[]) {
    const positions = markers.map((marker) => css.indexOf(marker));
    for (const [index, position] of positions.entries()) {
      expect(position, markers[index]).toBeGreaterThanOrEqual(0);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
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

      // Imported first, the shared stylesheet needs nothing else split out.
      expect(layoutResources?.css).toHaveLength(2);
      expect(layoutResources?.css[0]).toBe(sharedHref);
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

  it("keeps a Server Component's import order when the shared stylesheet is not first", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-shared-css-server-"));
    try {
      // Source order is base.css, shared.css, b.css: shared's rules must beat
      // base's, and b's must beat shared's, exactly as without isolation.
      const { sharedCss, layoutResources, toHref, readCss } = await buildSharedStylesheetApp(
        fixtureRoot,
        {
          sharedCss: ".shared-marker { color: rgb(1, 2, 3); }\n",
          files: {
            "app/base.css": ".base-marker { color: rgb(7, 8, 9); }\n",
            "app/b.css": ".b-marker { color: rgb(10, 11, 12); }\n",
            "app/layout.tsx": `import "./base.css";
import "./shared.css";
import "./b.css";
import Client from "./client";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body><Client />{children}</body></html>;
}
`,
          },
        },
      );

      expect(sharedCss).toHaveLength(1);
      expect(layoutResources?.css).toContain(toHref(sharedCss[0]));
      expectMarkerOrder(await readCss(layoutResources?.css ?? []), [
        ".base-marker",
        ".shared-marker",
        ".b-marker",
      ]);
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);

  it("keeps a client component's import order when the shared stylesheet is not first", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-shared-css-client-"));
    try {
      const { sharedCss, layoutResources, toHref, clientManifest, readCss } =
        await buildSharedStylesheetApp(fixtureRoot, {
          sharedCss: ".shared-marker { color: rgb(1, 2, 3); }\n",
          files: {
            "app/x.module.css": ".x-marker { color: rgb(7, 8, 9); }\n",
            "app/y.css": ".y-marker { color: rgb(10, 11, 12); }\n",
            "app/lazy.tsx": `import x from "./x.module.css";
import "./shared.css";
import "./y.css";

export default function Lazy() {
  return <p className={"shared-marker " + x["x-marker"]}>lazy</p>;
}
`,
          },
        });

      expect(sharedCss).toHaveLength(1);
      // The layout imports the shared stylesheet first, so the server side
      // splits nothing else out.
      expect(layoutResources?.css).toHaveLength(2);
      expect(layoutResources?.css[0]).toBe(toHref(sharedCss[0]));

      const lazyCss = Object.values(clientManifest).find((entry) =>
        entry.src?.endsWith("app/lazy.tsx"),
      )?.css;
      expect(lazyCss).toContain(toHref(sharedCss[0]).slice(1));
      expectMarkerOrder(await readCss(lazyCss ?? []), ["x-marker", ".shared-marker", ".y-marker"]);
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);

  it("spells client-chunk stylesheet hrefs like the server with an absolute asset prefix", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-shared-css-prefix-"));
    try {
      const assetUrlPrefix = "https://app.example.com/cdn/_next/static/";
      const { sharedCss, layoutResources, chunkSources } = await buildSharedStylesheetApp(
        fixtureRoot,
        {
          sharedCss: ".shared-marker { color: rgb(1, 2, 3); }\n",
          files: {
            "next.config.mjs": `export default { assetPrefix: "https://app.example.com/cdn" };\n`,
          },
        },
      );

      expect(sharedCss).toHaveLength(1);
      const serverHref = layoutResources?.css[0];
      expect(serverHref).toBe(`${assetUrlPrefix}css/${path.basename(sharedCss[0])}`);
      // The loader's prefix is inlined into the client bundle (the minifier
      // may pick any quote style).
      const inlinedPrefix = new RegExp(`["'\`]${assetUrlPrefix.replaceAll(".", "\\.")}["'\`]`);
      expect(chunkSources.some((code) => inlinedPrefix.test(code))).toBe(true);
      // Vite's helper hands the loader an absolute URL; on a page served from
      // the prefix's own origin it must map back to the server's literal href.
      const clientDep = chunkSources
        .flatMap((code) => [...code.matchAll(/["'`]([^"'`]*\/css\/shared\.[\w-]+\.css)["'`]/g)])
        .map((match) => match[1])[0];
      expect(clientDep).toBeDefined();
      const resolved = new URL(clientDep!, `${assetUrlPrefix}chunks/client.js`).href;
      expect(
        toDocumentStylesheetHref(resolved, "https://app.example.com/page", assetUrlPrefix),
      ).toBe(serverHref);
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
});
