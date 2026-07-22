import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createBuilder, resolveConfig } from "vite";
import { describe, expect, it } from "vite-plus/test";
import {
  buildViteResolveExtensions,
  normalizeViteResolveExtensions,
} from "../packages/vinext/src/routing/file-matcher.js";

// Ported in spirit from Next.js: test/e2e/app-dir/resolve-extensions/
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/resolve-extensions/
//
// When users configure custom module extensions via `turbopack.resolveExtensions`
// (e.g. `.web.tsx` or `.png`), Vite must know to attempt those extensions when
// resolving extensionless imports.
// Otherwise extensionless imports of files with those custom extensions
// fail to resolve and the build crashes.
//
// Regression test for cloudflare/vinext#1502.
describe("buildViteResolveExtensions", () => {
  it("appends CJS config extensions to vinext defaults", () => {
    const extensions = buildViteResolveExtensions();
    expect(extensions).toEqual([
      ".tsx",
      ".ts",
      ".jsx",
      ".js",
      ".mjs",
      ".mts",
      ".json",
      ".cjs",
      ".cts",
    ]);
  });

  it("preserves configured Vite extensions and removes duplicates", () => {
    expect(buildViteResolveExtensions([".web.tsx", ".tsx", ".cjs"])).toEqual([
      ".web.tsx",
      ".tsx",
      ".cjs",
      ".cts",
    ]);
  });
});

describe("normalizeViteResolveExtensions", () => {
  it("treats explicit resolver extensions as a replacement list", () => {
    expect(normalizeViteResolveExtensions(["", ".png", ".web.tsx", ".tsx"])).toEqual([
      ".png",
      ".web.tsx",
      ".tsx",
    ]);
  });
});

describe("vinext plugin configures Vite resolve.extensions", () => {
  it("keeps pageExtensions scoped to route discovery", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();
    // oxlint-disable-next-line typescript/no-explicit-any
    const mainPlugin = plugins.find(
      // oxlint-disable-next-line typescript/no-explicit-any
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();
    expect(typeof (mainPlugin as any).configEnvironment).toBe("function");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-ext-resolve-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fs.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fs.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default { pageExtensions: ["tsx", "ts", "jsx", "js", "md"] };`,
    );

    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
      };
      // oxlint-disable-next-line typescript/no-explicit-any
      await (mainPlugin as any).config(mockConfig, { command: "build" });
      const environmentConfig: any = { resolve: {} };
      (mainPlugin as any).configEnvironment("client", environmentConfig);
      const extensions: string[] = environmentConfig.resolve.extensions;
      expect(extensions).not.toContain(".md");
      expect(extensions).toContain(".tsx");
      expect(extensions).toContain(".cjs");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("builds the Next.js resolve-extensions fixture for server and client graphs", async () => {
    // Ported from Next.js: test/e2e/app-dir/resolve-extensions/resolve-extensions.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/resolve-extensions/resolve-extensions.test.ts
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-resolve-extensions-build-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
    await fs.mkdir(path.join(tmpDir, "app"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "app", "image.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/2p5WAAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "resolve-extensions-fixture", private: true, type: "module" }),
    );
    await fs.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default { turbopack: { resolveExtensions: ["", ".png", ".web.tsx", ".tsx", ".ts", ".jsx", ".js", ".json"] } };`,
    );
    await fs.writeFile(
      path.join(tmpDir, "app", "layout.tsx"),
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    );
    await fs.writeFile(
      path.join(tmpDir, "app", "component.jsx"),
      `'use client'; import image from './image'; import Image from 'next/image'; export default function Component() { return <p><Image src={image} alt="hello image 2" />hello world{typeof window !== 'undefined' ? 'hello client' : 'hello server'}</p>; }`,
    );
    await fs.writeFile(
      path.join(tmpDir, "app", "PlatformComponent.web.tsx"),
      `export default function PlatformComponent() { return <span>hello web platform</span>; }`,
    );
    await fs.writeFile(
      path.join(tmpDir, "app", "PlatformComponent.tsx"),
      `export default function PlatformComponent() { return <span>hello default platform</span>; }`,
    );
    await fs.writeFile(
      path.join(tmpDir, "app", "page.jsx"),
      `import image from './image'; import Image from 'next/image'; import Component from './component'; import PlatformComponent from './PlatformComponent'; export default function Page() { return <p><Image src={image} alt="hello image 1" /><Component /><PlatformComponent /></p>; }`,
    );

    try {
      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        logLevel: "silent",
      });
      await builder.buildApp();
      await expect(fs.stat(path.join(tmpDir, "dist", "client"))).resolves.toBeDefined();
      await expect(fs.stat(path.join(tmpDir, "dist", "server"))).resolves.toBeDefined();
      const builtFiles = await fs.readdir(path.join(tmpDir, "dist", "server"), {
        recursive: true,
        encoding: "utf8",
      });
      const serverOutput = (
        await Promise.all(
          builtFiles
            .filter((file) => file.endsWith(".js"))
            .map((file) => fs.readFile(path.join(tmpDir, "dist", "server", file), "utf8")),
        )
      ).join("\n");
      expect(serverOutput).toContain("hello web platform");
      expect(serverOutput).not.toContain("hello default platform");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30000);

  it("forwards turbopack.resolveExtensions for extensionless asset imports", async () => {
    // Ported from Next.js: test/e2e/app-dir/resolve-extensions/resolve-extensions.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/resolve-extensions/resolve-extensions.test.ts
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();
    // oxlint-disable-next-line typescript/no-explicit-any
    const mainPlugin = plugins.find(
      // oxlint-disable-next-line typescript/no-explicit-any
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();
    expect(typeof (mainPlugin as any).configEnvironment).toBe("function");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-resolve-extensions-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
    await fs.mkdir(path.join(tmpDir, "app"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "app", "page.jsx"),
      `import image from "./image"; export default function Page() { return image.src; }`,
    );
    await fs.writeFile(path.join(tmpDir, "app", "image.png"), "fixture");
    await fs.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default { turbopack: { resolveExtensions: ["", ".png", ".tsx", ".ts", ".jsx", ".js", ".json"] } };`,
    );

    try {
      const resolved = await resolveConfig(
        {
          root: tmpDir,
          configFile: false,
          resolve: { extensions: [".earlier", ".tsx"] },
          plugins: [vinext({ appDir: tmpDir })],
          logLevel: "silent",
        },
        "build",
      );
      const extensions: string[] = resolved.environments.client.resolve.extensions;
      expect(extensions[0]).toBe(".png");
      expect(extensions).toContain(".jsx");
      expect(extensions).not.toContain("");
      expect(extensions).not.toContain(".mjs");
      expect(extensions).not.toContain(".earlier");
      expect(extensions.filter((extension) => extension === ".tsx")).toHaveLength(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("applies conditional webpack extensions to the matching Vite environments", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-webpack-extensions-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
    await fs.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Page() { return <p>hello</p>; }`,
    );
    await fs.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default { webpack(config, { isServer, dev }) { config.resolve.extensions = [isServer ? ".server.ts" : ".client.ts", dev ? ".dev.ts" : ".prod.ts", ".ts"]; return config; } };`,
    );

    try {
      const resolved = await resolveConfig(
        {
          root: tmpDir,
          configFile: false,
          plugins: [vinext({ appDir: tmpDir })],
          logLevel: "silent",
        },
        "build",
      );
      expect(resolved.environments.client.resolve.extensions).toEqual([
        ".client.ts",
        ".prod.ts",
        ".ts",
      ]);
      expect(resolved.environments.ssr.resolve.extensions).toEqual([
        ".server.ts",
        ".prod.ts",
        ".ts",
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("uses production webpack extensions during Vite preview", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();
    const mainPlugin = plugins.find(
      // oxlint-disable-next-line typescript/no-explicit-any
      (plugin: any) => plugin.name === "vinext:config" && typeof plugin.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-preview-extensions-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
    await fs.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Page() { return <p>hello</p>; }`,
    );
    await fs.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default { webpack(config, { dev }) { config.resolve.extensions = [dev ? ".dev.ts" : ".prod.ts", ".ts"]; return config; } };`,
    );

    try {
      await (mainPlugin as any).config(
        { root: tmpDir, build: {}, plugins: [] },
        { command: "serve", mode: "production", isPreview: true },
      );
      const environmentConfig: any = { resolve: {} };
      (mainPlugin as any).configEnvironment("client", environmentConfig);
      expect(environmentConfig.resolve.extensions).toEqual([".prod.ts", ".ts"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});
