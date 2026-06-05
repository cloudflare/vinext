import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findClientEntryFile,
  findClientEntryFileFromManifest,
  readClientBuildManifest,
} from "../packages/vinext/src/utils/client-build-manifest.js";
import {
  buildNextClientBuildManifestContent,
  buildNextClientSsgManifestContent,
  emitNextClientRuntimeManifests,
} from "../packages/vinext/src/build/next-client-runtime-manifests.js";

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
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
    });

    const buildManifest = await fsp.readFile(
      path.join(clientDir, "base", "_next", "static", "build-123", "_buildManifest.js"),
      "utf-8",
    );
    expect(buildManifest).toContain("self.__BUILD_MANIFEST = ");
    expect(buildManifest).toContain("__BUILD_MANIFEST_CB");

    const ssgManifest = await fsp.readFile(
      path.join(clientDir, "base", "_next", "static", "build-123", "_ssgManifest.js"),
      "utf-8",
    );
    expect(ssgManifest).toBe(buildNextClientSsgManifestContent());
  });

  it("normalizes rewrites in the Next.js runtime build manifest", () => {
    const content = buildNextClientBuildManifestContent({
      beforeFiles: [
        {
          source: "/internal/:path*",
          destination: "/rewritten/:path*",
          has: [{ type: "header", key: "x-test", value: "1" }],
        },
      ],
      afterFiles: [
        {
          source: "/external",
          destination: "https://example.com/external",
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

    expect(content).toContain('"source":"/internal/:path*"');
    expect(content).toContain('"destination":"/rewritten/:path*"');
    expect(content).toContain('"source":"/external"');
    expect(content).not.toContain("https://example.com/external");
    expect(content).toContain('"sortedPages":[]');
    expect(content).not.toContain('"missing"');
  });
});
