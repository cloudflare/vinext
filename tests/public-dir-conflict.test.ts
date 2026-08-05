import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer as createViteServer, resolveConfig } from "vite";
import vinext from "../packages/vinext/src/index.js";
import {
  assertNoPublicDirAssetConflict,
  assertNoPublicNextRequestConflict,
} from "../packages/vinext/src/build/public-dir-conflict.js";

// Regression for cloudflare/vinext#2778: Vite copies public files into the
// client output, so public/_next would otherwise collide with vinext's internal
// build-asset namespace and be served as a hashed asset ahead of middleware.
// Next.js rejects the same public/_next namespace during build:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/index.ts
// In dev it checks on each /_next request after stripping basePath:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/dev/next-dev-server.ts
describe("assertNoPublicDirAssetConflict", () => {
  const tmpDirs: string[] = [];

  function makeProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-dir-conflict-"));
    tmpDirs.push(dir);
    return dir;
  }

  function writeFile(root: string, relativePath: string): void {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "test", "utf-8");
  }

  function assertDefaultProject(root: string): void {
    assertNoPublicDirAssetConflict({
      root,
      publicDir: "public",
      assetsDir: "_next/static",
    });
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a missing public directory", () => {
    const root = makeProject();

    expect(() => assertDefaultProject(root)).not.toThrow();
  });

  it("allows ordinary files in the public directory", () => {
    const root = makeProject();
    writeFile(root, "public/private.txt");

    expect(() => assertDefaultProject(root)).not.toThrow();
  });

  it("rejects an empty public/_next directory", () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, "public", "_next"), { recursive: true });

    expect(() => assertDefaultProject(root)).toThrow(
      "You can not have a '_next' folder inside of your public folder.",
    );
  });

  it("rejects files under public/_next/static", () => {
    const root = makeProject();
    writeFile(root, "public/_next/static/private.txt");

    expect(() => assertDefaultProject(root)).toThrow(
      "https://nextjs.org/docs/messages/public-next-folder-conflict",
    );
  });

  it("resolves a custom public directory relative to the project root", () => {
    const root = makeProject();
    writeFile(root, "custom-public/_next/file.txt");

    expect(() =>
      assertNoPublicDirAssetConflict({
        root,
        publicDir: "custom-public",
        assetsDir: "_next/static",
      }),
    ).toThrow("This conflicts with the internal '/_next' route.");
  });

  it("supports an absolute public directory", () => {
    const root = makeProject();
    const publicDir = path.join(root, "custom-public");
    writeFile(publicDir, "_next/file.txt");

    expect(() =>
      assertNoPublicDirAssetConflict({
        root,
        publicDir,
        assetsDir: "_next/static",
      }),
    ).toThrow("You can not have a '_next' folder inside of your public folder.");
  });

  it("skips validation when the public directory is disabled", () => {
    const root = makeProject();
    writeFile(root, "public/_next/static/private.txt");

    expect(() =>
      assertNoPublicDirAssetConflict({
        root,
        publicDir: null,
        assetsDir: "_next/static",
      }),
    ).not.toThrow();
  });

  it("rejects a public path that collides with a custom assets directory", () => {
    const root = makeProject();
    writeFile(root, "public/cdn/_next/static/private.txt");

    expect(() =>
      assertNoPublicDirAssetConflict({
        root,
        publicDir: "public",
        assetsDir: "cdn/_next/static",
      }),
    ).toThrow(
      "[vinext] The public directory contains a path reserved for build assets: " +
        "cdn/_next/static",
    );
  });

  it("does not inspect an assets directory outside the public directory", () => {
    const root = makeProject();
    writeFile(root, "outside-assets/file.txt");

    expect(() =>
      assertNoPublicDirAssetConflict({
        root,
        publicDir: "public",
        assetsDir: "../outside-assets",
      }),
    ).not.toThrow();
  });

  it("checks public/_next only for dev requests in the internal namespace", () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, "public", "_next"), { recursive: true });

    expect(() =>
      assertNoPublicNextRequestConflict({
        root,
        publicDir: "public",
        basePath: "",
        requestUrl: "/ordinary-page",
      }),
    ).not.toThrow();
    expect(() =>
      assertNoPublicNextRequestConflict({
        root,
        publicDir: "public",
        basePath: "",
        requestUrl: "/_next/static/chunk.js?cache=1",
      }),
    ).toThrow("You can not have a '_next' folder inside of your public folder.");
    expect(() =>
      assertNoPublicNextRequestConflict({
        root,
        publicDir: "public",
        basePath: "",
        requestUrl: "//host/_next/static/chunk.js",
      }),
    ).not.toThrow();
  });

  it("strips basePath before checking dev /_next requests", () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, "public", "_next"), { recursive: true });

    expect(() =>
      assertNoPublicNextRequestConflict({
        root,
        publicDir: "public",
        basePath: "/docs",
        requestUrl: "/docs/_next/webpack-hmr",
      }),
    ).toThrow("This conflicts with the internal '/_next' route.");
    expect(() =>
      assertNoPublicNextRequestConflict({
        root,
        publicDir: "public",
        basePath: "/docs",
        requestUrl: "/_next/webpack-hmr",
      }),
    ).toThrow("This conflicts with the internal '/_next' route.");
  });

  it("rejects build configuration without preventing the dev server from starting", async () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, "public", "_next"), { recursive: true });
    const config = {
      root,
      configFile: false as const,
      logLevel: "silent" as const,
    };

    await expect(
      resolveConfig(
        {
          ...config,
          plugins: [vinext({ disableAppRouter: true })],
        },
        "build",
      ),
    ).rejects.toThrow("https://nextjs.org/docs/messages/public-next-folder-conflict");

    await expect(
      resolveConfig(
        {
          ...config,
          plugins: [vinext({ disableAppRouter: true })],
        },
        "serve",
      ),
    ).resolves.toMatchObject({ command: "serve" });
  });

  it("rechecks before public files are copied when a build plugin creates a conflict", async () => {
    const root = makeProject();
    const resolved = await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext({ disableAppRouter: true })],
      },
      "build",
    );
    fs.mkdirSync(path.join(root, "public", "_next"), { recursive: true });

    const configPlugin = resolved.plugins.find((plugin) => plugin.name === "vinext:config");
    const renderStart = configPlugin?.renderStart;
    const handler = typeof renderStart === "object" ? renderStart.handler : renderStart;
    expect(handler).toBeTypeOf("function");
    expect(() =>
      handler!.call({ environment: { name: "client" } } as any, {} as any, {} as any),
    ).toThrow("https://nextjs.org/docs/messages/public-next-folder-conflict");
  });

  it("runs the dev conflict guard before Vite serves public files", async () => {
    const root = makeProject();
    writeFile(root, "public/ordinary.txt");
    writeFile(root, "public/_next/static/private.txt");

    const viteServer = await createViteServer({
      root,
      configFile: false,
      appType: "custom",
      logLevel: "silent",
      plugins: [vinext({ disableAppRouter: true })],
      server: { middlewareMode: true },
    });
    const httpServer = createHttpServer(viteServer.middlewares);

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", resolve);
      });
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP address");
      const origin = `http://127.0.0.1:${address.port}`;

      const ordinaryResponse = await fetch(`${origin}/ordinary.txt`);
      expect(ordinaryResponse.status).toBe(200);
      expect(await ordinaryResponse.text()).toBe("test");

      const conflictResponse = await fetch(`${origin}/_next/static/private.txt`);
      expect(conflictResponse.status).not.toBe(200);
      expect(await conflictResponse.text()).not.toContain("test");
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      await viteServer.close();
    }
  });
});
