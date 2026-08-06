import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findClientEntryFile,
  findClientEntryFileFromManifest,
  findPagesClientEntryFile,
  findPagesClientEntryFileFromManifest,
  readClientBuildManifest,
} from "../packages/vinext/src/utils/client-build-manifest.js";
import {
  buildNextClientBuildManifestContent,
  buildNextClientSsgManifestContent,
  emitNextClientRuntimeManifests,
} from "../packages/vinext/src/build/next-client-runtime-manifests.js";
import type { ClientRewrites } from "../packages/vinext/src/client/client-rewrites.js";
import {
  findClientEntryFileFromVinextManifest,
  findPagesClientEntryFileFromVinextManifest,
  readClientEntryManifest,
  VINEXT_CLIENT_ENTRY_MANIFEST,
} from "../packages/vinext/src/utils/client-entry-manifest.js";
import { computeClientRuntimeMetadata } from "../packages/vinext/src/utils/client-runtime-metadata.js";
import type { HasCondition } from "../packages/vinext/src/config/next-config.js";

describe("client build manifest helpers", () => {
  let tmpDir: string;
  let clientDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-client-build-manifest-"));
    clientDir = path.join(tmpDir, "client");
    await fsp.mkdir(path.join(clientDir, ".vite"), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads Vite manifest entries used for client entry and lazy chunk computation", async () => {
    const manifestPath = path.join(clientDir, ".vite", "manifest.json");
    await fsp.writeFile(
      manifestPath,
      JSON.stringify({
        "pages-client-entry.ts": {
          file: "_next/static/vinext-client-entry-abcd.js",
          isEntry: true,
          imports: ["shared"],
          dynamicImports: ["lazy"],
          css: ["_next/static/client.css"],
          assets: ["_next/static/logo.svg"],
        },
      }),
    );

    const manifest = readClientBuildManifest(manifestPath);

    expect(manifest).toEqual({
      "pages-client-entry.ts": {
        file: "_next/static/vinext-client-entry-abcd.js",
        isEntry: true,
        imports: ["shared"],
        dynamicImports: ["lazy"],
        css: ["_next/static/client.css"],
        assets: ["_next/static/logo.svg"],
      },
    });
  });

  it("finds the client entry from the manifest before scanning disk", () => {
    const entry = findClientEntryFileFromManifest(
      {
        "pages-client-entry.ts": {
          file: "_next/static/vinext-client-entry-abcd.js",
          isEntry: true,
        },
      },
      "/docs/",
    );

    expect(entry).toBe("docs/_next/static/vinext-client-entry-abcd.js");
  });

  it("prefers the marked client entry over other isEntry chunks regardless of order", () => {
    const entry = findClientEntryFileFromManifest(
      {
        "instrumentation-client.ts": {
          file: "_next/static/vinext-instrumentation-client-0001.js",
          isEntry: true,
        },
        "pages-client-entry.ts": {
          file: "_next/static/vinext-client-entry-abcd.js",
          isEntry: true,
        },
      },
      "/",
    );

    expect(entry).toBe("_next/static/vinext-client-entry-abcd.js");
  });

  it("prefers the Pages client entry over the App browser entry in hybrid manifests", () => {
    const entry = findClientEntryFileFromManifest(
      {
        "virtual:vinext-app-browser-entry": {
          file: "_next/static/vinext-app-browser-entry-0001.js",
          isEntry: true,
        },
        "virtual:vinext-client-entry": {
          file: "_next/static/vinext-client-entry-abcd.js",
          isEntry: true,
        },
      },
      "/",
    );

    expect(entry).toBe("_next/static/vinext-client-entry-abcd.js");
  });

  it("finds only the Pages client entry when requested for Pages fallback rendering", () => {
    const manifest = {
      "virtual:vinext-app-browser-entry": {
        file: "_next/static/vinext-app-browser-entry-0001.js",
        isEntry: true,
      },
      "virtual:vinext-client-entry": {
        file: "_next/static/vinext-client-entry-abcd.js",
        isEntry: true,
      },
    };

    expect(findPagesClientEntryFileFromManifest(manifest, "/")).toBe(
      "_next/static/vinext-client-entry-abcd.js",
    );
  });

  it("reads vinext's entry manifest for hashed client entry names", async () => {
    await fsp.writeFile(
      path.join(clientDir, VINEXT_CLIENT_ENTRY_MANIFEST),
      JSON.stringify({
        appBrowserEntry: "_next/static/index-app.js",
        pagesClientEntry: "_next/static/index-pages.js",
      }),
    );

    const manifest = readClientEntryManifest(clientDir);

    expect(findClientEntryFileFromVinextManifest(manifest, "/docs/")).toBe(
      "docs/_next/static/index-pages.js",
    );
    expect(findPagesClientEntryFileFromVinextManifest(manifest, "/")).toBe(
      "_next/static/index-pages.js",
    );
  });

  it("falls back to the on-disk assets directory when the manifest has no entry", async () => {
    const assetsSubdir = "_next/static";
    await fsp.mkdir(path.join(clientDir, assetsSubdir), { recursive: true });
    await fsp.writeFile(path.join(clientDir, assetsSubdir, "shared.js"), "");
    await fsp.writeFile(path.join(clientDir, assetsSubdir, "vinext-client-entry-1234.js"), "");

    const entry = findClientEntryFile({
      buildManifest: {},
      clientDir,
      assetsSubdir,
      assetBase: "/docs/",
    });

    expect(entry).toBe("docs/_next/static/vinext-client-entry-1234.js");
  });

  it("uses the asset-prefix assets subdirectory for fallback entry lookup", async () => {
    const assetsSubdir = "cdn/_next/static";
    await fsp.mkdir(path.join(clientDir, assetsSubdir), { recursive: true });
    await fsp.writeFile(path.join(clientDir, assetsSubdir, "vinext-client-entry-5678.js"), "");

    const entry = findClientEntryFile({
      clientDir,
      assetsSubdir,
      assetBase: "/",
    });

    expect(entry).toBe("cdn/_next/static/vinext-client-entry-5678.js");
  });

  it("emits Next.js runtime manifests under the configured assets directory and build ID", async () => {
    emitNextClientRuntimeManifests({
      clientDir,
      assetsSubdir: "base/_next/static",
      buildId: "build-123",
      rewrites: {
        beforeFiles: [
          {
            source: "/header",
            destination: "/emitted-header-target-canary",
            has: [{ type: "header", key: "x-origin-auth", value: "emitted-header-secret-canary" }],
          },
        ],
        afterFiles: [
          {
            source: "/external",
            destination: "//example.com/emitted-protocol-relative-canary",
          },
        ],
        fallback: [],
      },
    });

    const buildManifest = await fsp.readFile(
      path.join(clientDir, "base", "_next", "static", "build-123", "_buildManifest.js"),
      "utf-8",
    );
    expect(buildManifest).toContain("self.__BUILD_MANIFEST = ");
    expect(buildManifest).toContain("__BUILD_MANIFEST_CB");
    expect(buildManifest).toContain('"requiresServerEvaluation":true');
    expect(buildManifest).not.toContain("emitted-header-target-canary");
    expect(buildManifest).not.toContain("emitted-header-secret-canary");
    expect(buildManifest).not.toContain("emitted-protocol-relative-canary");

    const ssgManifest = await fsp.readFile(
      path.join(clientDir, "base", "_next", "static", "build-123", "_ssgManifest.js"),
      "utf-8",
    );
    expect(ssgManifest).toBe(buildNextClientSsgManifestContent());
  });

  it("publishes only client-safe rewrites in the Next.js runtime build manifest", () => {
    const content = buildNextClientBuildManifestContent({
      beforeFiles: [
        {
          source: "/query/:path*",
          destination: "/rewritten/:path*",
          has: [{ type: "query", key: "preview", value: "1" }],
        },
        {
          source: "/header",
          destination: "/header-target-canary",
          has: [{ type: "header", key: "x-origin-auth", value: "header-secret-canary" }],
        },
        {
          source: "/host",
          destination: "/host-target",
          has: [{ type: "host", key: "host", value: "example.com" }],
        },
      ],
      afterFiles: [
        {
          source: "/cookie",
          destination: "/cookie-target-canary",
          has: [{ type: "cookie", key: "internal-access", value: "cookie-secret-canary" }],
        },
        {
          source: "/external",
          destination: "//example.com/protocol-relative-destination-canary",
        },
        {
          source: "/future-condition",
          destination: "/future-target-canary",
          has: [
            {
              type: "future-condition",
              key: "future-key",
              value: "future-secret-canary",
            } as unknown as HasCondition,
          ],
        },
      ],
      fallback: [
        {
          source: "/only-without-cookie",
          destination: "/target",
          missing: [{ type: "cookie", key: "seen" }],
        },
      ],
    });

    const serializedManifest = content.slice(
      "self.__BUILD_MANIFEST = ".length,
      content.indexOf(";self.__BUILD_MANIFEST_CB"),
    );
    const manifest = JSON.parse(serializedManifest) as {
      __rewrites: ClientRewrites;
      sortedPages: string[];
    };

    expect(manifest).toEqual({
      __rewrites: {
        beforeFiles: [
          {
            source: "/query/:path*",
            destination: "/rewritten/:path*",
            has: [{ type: "query", key: "preview", value: "1" }],
          },
          { source: "/header", requiresServerEvaluation: true },
          {
            source: "/host",
            destination: "/host-target",
            has: [{ type: "host", key: "host", value: "example.com" }],
          },
        ],
        afterFiles: [
          { source: "/cookie", requiresServerEvaluation: true },
          { source: "/external", requiresServerEvaluation: true },
          { source: "/future-condition", requiresServerEvaluation: true },
        ],
        fallback: [{ source: "/only-without-cookie", requiresServerEvaluation: true }],
      },
      sortedPages: [],
    });
    expect(content).not.toContain("header-target-canary");
    expect(content).not.toContain("header-secret-canary");
    expect(content).not.toContain("cookie-target-canary");
    expect(content).not.toContain("cookie-secret-canary");
    expect(content).not.toContain("protocol-relative-destination-canary");
    expect(content).not.toContain("future-target-canary");
    expect(content).not.toContain("future-secret-canary");
    expect(content).not.toContain('"missing"');
  });

  it("prefers the Pages client entry over the App browser entry in on-disk fallback lookup", async () => {
    const assetsSubdir = "_next/static";
    await fsp.mkdir(path.join(clientDir, assetsSubdir), { recursive: true });
    await fsp.writeFile(path.join(clientDir, assetsSubdir, "vinext-app-browser-entry-1234.js"), "");
    await fsp.writeFile(path.join(clientDir, assetsSubdir, "vinext-client-entry-5678.js"), "");

    const entry = findClientEntryFile({
      clientDir,
      assetsSubdir,
      assetBase: "/",
    });

    expect(entry).toBe("_next/static/vinext-client-entry-5678.js");
  });

  it("does not return the App browser entry for Pages fallback lookup", async () => {
    const assetsSubdir = "_next/static";
    await fsp.mkdir(path.join(clientDir, assetsSubdir), { recursive: true });
    await fsp.writeFile(path.join(clientDir, assetsSubdir, "vinext-app-browser-entry-1234.js"), "");

    const entry = findPagesClientEntryFile({
      clientDir,
      assetsSubdir,
      assetBase: "/",
    });

    expect(entry).toBeUndefined();
  });
});

describe("computeClientRuntimeMetadata", () => {
  let tmpDir: string;
  let clientDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-client-runtime-metadata-"));
    clientDir = path.join(tmpDir, "client");
    await fsp.mkdir(path.join(clientDir, ".vite"), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  const baseManifest = {
    "entry.js": {
      file: "_next/static/entry-abc123.js",
      isEntry: true,
      imports: ["shared.js"],
      dynamicImports: ["LazyComponent"],
    },
    "shared.js": {
      file: "_next/static/shared-def456.js",
    },
    LazyComponent: {
      file: "_next/static/lazy-ghi789.js",
      isDynamicEntry: true,
      css: ["_next/static/lazy-jkl012.css"],
    },
  };

  it("returns empty metadata when no manifest exists", () => {
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/",
      assetPrefix: "",
    });
    expect(result).toEqual({});
  });

  it("returns empty metadata when manifest is malformed", async () => {
    await fsp.writeFile(path.join(clientDir, ".vite", "manifest.json"), "not json");
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/",
      assetPrefix: "",
    });
    expect(result).toEqual({});
  });

  it("computes client entry, lazy chunks, and dynamic preloads without base path or asset prefix", async () => {
    await fsp.writeFile(
      path.join(clientDir, ".vite", "manifest.json"),
      JSON.stringify(baseManifest),
    );
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/",
      assetPrefix: "",
      includeClientEntry: true,
    });
    expect(result).toEqual({
      clientEntryFile: "_next/static/entry-abc123.js",
      lazyChunks: ["_next/static/lazy-ghi789.js"],
      dynamicPreloads: {
        LazyComponent: ["_next/static/lazy-ghi789.js", "_next/static/lazy-jkl012.css"],
      },
    });
  });

  it("computes App Router bootstrap module preinitialization from the browser entry imports", async () => {
    await fsp.writeFile(
      path.join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({
        "virtual:vinext-app-browser-entry": {
          file: "_next/static/app-entry.js",
          isEntry: true,
          imports: ["shared.js", "runtime.js"],
        },
        "shared.js": {
          file: "_next/static/shared.js",
          imports: ["runtime.js", "styles.css"],
        },
        "runtime.js": {
          file: "_next/static/runtime.js",
        },
        "styles.css": {
          file: "_next/static/styles.css",
        },
      }),
    );
    await fsp.writeFile(
      path.join(clientDir, "vinext-client-entry-manifest.json"),
      JSON.stringify({ appBrowserEntry: "_next/static/app-entry.js" }),
    );

    expect(
      computeClientRuntimeMetadata({
        clientDir,
        assetBase: "/docs/",
        assetPrefix: "https://cdn.example.com/assets",
      }).appBootstrapPreinitModules,
    ).toEqual([
      "https://cdn.example.com/assets/_next/static/shared.js",
      "https://cdn.example.com/assets/_next/static/runtime.js",
    ]);

    expect(
      computeClientRuntimeMetadata({
        clientDir,
        assetBase: "/",
        assetPrefix: "",
      }).appBootstrapPreinitModules,
    ).toEqual(["/_next/static/shared.js", "/_next/static/runtime.js"]);
    expect(
      computeClientRuntimeMetadata({
        clientDir,
        assetBase: "/docs/",
        assetPrefix: "",
      }).appBootstrapPreinitModules,
    ).toEqual(["/docs/_next/static/shared.js", "/docs/_next/static/runtime.js"]);
    expect(
      computeClientRuntimeMetadata({
        clientDir,
        assetBase: "/docs/",
        assetPrefix: "/cdn",
      }).appBootstrapPreinitModules,
    ).toEqual(["/cdn/_next/static/shared.js", "/cdn/_next/static/runtime.js"]);
  });

  it("applies base path to all paths", async () => {
    await fsp.writeFile(
      path.join(clientDir, ".vite", "manifest.json"),
      JSON.stringify(baseManifest),
    );
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/docs/",
      assetPrefix: "",
      includeClientEntry: true,
    });
    expect(result).toEqual({
      clientEntryFile: "docs/_next/static/entry-abc123.js",
      lazyChunks: ["docs/_next/static/lazy-ghi789.js"],
      dynamicPreloads: {
        LazyComponent: ["docs/_next/static/lazy-ghi789.js", "docs/_next/static/lazy-jkl012.css"],
      },
    });
  });

  it("applies path-based asset prefix", async () => {
    await fsp.writeFile(
      path.join(clientDir, ".vite", "manifest.json"),
      JSON.stringify(baseManifest),
    );
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/",
      assetPrefix: "/cdn",
      includeClientEntry: true,
    });
    // lazyChunks stay base-only (SSR-manifest key-space for the modulepreload
    // exclusion); only dynamicPreloads get the assetPrefix.
    expect(result).toEqual({
      clientEntryFile: "_next/static/entry-abc123.js",
      lazyChunks: ["_next/static/lazy-ghi789.js"],
      dynamicPreloads: {
        LazyComponent: ["cdn/_next/static/lazy-ghi789.js", "cdn/_next/static/lazy-jkl012.css"],
      },
    });
  });

  it("applies absolute URL asset prefix", async () => {
    await fsp.writeFile(
      path.join(clientDir, ".vite", "manifest.json"),
      JSON.stringify(baseManifest),
    );
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/",
      assetPrefix: "https://cdn.example.com/assets",
      includeClientEntry: true,
    });
    // lazyChunks must NOT take an absolute-URL prefix — the Pages Router
    // modulepreload-exclusion compares them against base-relative SSR-manifest
    // values, so an absolute URL here would leak lazy chunks into modulepreload.
    // Only dynamicPreloads (real <link> hrefs) get the absolute prefix.
    expect(result).toEqual({
      clientEntryFile: "_next/static/entry-abc123.js",
      lazyChunks: ["_next/static/lazy-ghi789.js"],
      dynamicPreloads: {
        LazyComponent: [
          "https://cdn.example.com/assets/_next/static/lazy-ghi789.js",
          "https://cdn.example.com/assets/_next/static/lazy-jkl012.css",
        ],
      },
    });
  });

  it("does not double-prefix when manifest already has asset-prefix paths", async () => {
    await fsp.writeFile(
      path.join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({
        "entry.js": {
          file: "cdn/_next/static/entry-abc123.js",
          isEntry: true,
          imports: ["shared.js"],
          dynamicImports: ["LazyComponent"],
        },
        "shared.js": {
          file: "cdn/_next/static/shared-def456.js",
        },
        LazyComponent: {
          file: "cdn/_next/static/lazy-ghi789.js",
          isDynamicEntry: true,
          css: ["cdn/_next/static/lazy-jkl012.css"],
        },
      }),
    );
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/",
      assetPrefix: "/cdn",
      includeClientEntry: true,
    });
    expect(result).toEqual({
      clientEntryFile: "cdn/_next/static/entry-abc123.js",
      lazyChunks: ["cdn/_next/static/lazy-ghi789.js"],
      dynamicPreloads: {
        LazyComponent: ["cdn/_next/static/lazy-ghi789.js", "cdn/_next/static/lazy-jkl012.css"],
      },
    });
  });

  it("omits client entry when includeClientEntry is false", async () => {
    await fsp.writeFile(
      path.join(clientDir, ".vite", "manifest.json"),
      JSON.stringify(baseManifest),
    );
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/",
      assetPrefix: "",
      includeClientEntry: false,
    });
    expect(result.clientEntryFile).toBeUndefined();
    expect(result.lazyChunks).toBeDefined();
    expect(result.dynamicPreloads).toBeDefined();
  });

  it("falls back to on-disk client entry scan when manifest has no entry", async () => {
    await fsp.mkdir(path.join(clientDir, "_next", "static"), { recursive: true });
    await fsp.writeFile(path.join(clientDir, "_next", "static", "vinext-client-entry-abcd.js"), "");
    await fsp.writeFile(
      path.join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({
        "lazy-chunk.js": {
          file: "_next/static/lazy-1234.js",
          isDynamicEntry: true,
        },
      }),
    );
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/",
      assetPrefix: "",
      includeClientEntry: true,
    });
    expect(result.clientEntryFile).toBe("_next/static/vinext-client-entry-abcd.js");
    expect(result.lazyChunks).toBeDefined();
  });

  it("falls back to on-disk client entry under _next/static/chunks/ (real build layout)", async () => {
    // The real build emits client JS under `_next/static/chunks/`
    // (createClientFileNameConfig), so the on-disk fallback must recurse into it.
    // A flat scan of `_next/static` would miss the entry entirely.
    await fsp.mkdir(path.join(clientDir, "_next", "static", "chunks"), { recursive: true });
    await fsp.writeFile(
      path.join(clientDir, "_next", "static", "chunks", "vinext-client-entry-abcd.js"),
      "",
    );
    await fsp.writeFile(
      path.join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({
        "lazy-chunk.js": {
          file: "_next/static/chunks/lazy-1234.js",
          isDynamicEntry: true,
        },
      }),
    );
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/",
      assetPrefix: "",
      includeClientEntry: true,
    });
    expect(result.clientEntryFile).toBe("_next/static/chunks/vinext-client-entry-abcd.js");
  });

  it("normalises lazy chunks (basePath only) and dynamic preloads (assetPrefix) into distinct key-spaces", async () => {
    await fsp.writeFile(
      path.join(clientDir, ".vite", "manifest.json"),
      JSON.stringify(baseManifest),
    );
    const result = computeClientRuntimeMetadata({
      clientDir,
      assetBase: "/docs/",
      assetPrefix: "/cdn",
      includeClientEntry: true,
    });
    // Regression guard for the absolute/path assetPrefix lazy-chunk leak: the two
    // consumers expect DIFFERENT key-spaces, so the same source chunk is
    // normalised differently. lazyChunks keep the SSR-manifest key-space
    // (basePath only) so the Pages Router modulepreload-exclusion membership test
    // matches; dynamicPreloads get the full assetPrefix because they render real
    // <link> hrefs.
    expect(result.lazyChunks).toEqual(["docs/_next/static/lazy-ghi789.js"]);
    expect(result.dynamicPreloads!.LazyComponent).toContain("cdn/_next/static/lazy-ghi789.js");
    expect(result.dynamicPreloads!.LazyComponent).not.toContain("docs/_next/static/lazy-ghi789.js");
  });
});
