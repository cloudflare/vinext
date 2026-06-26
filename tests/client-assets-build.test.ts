import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  clearPagesClientAssetsBuildMetadata,
  setPagesClientAssetsBuildMetadata,
  takePagesClientAssetsBuildMetadata,
} from "../packages/vinext/src/build/pages-client-assets-module.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function writeFile(file: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

async function createFixture(): Promise<string> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-client-assets-build-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");
  await writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await writeFile(
    path.join(fixtureRoot, "app", "layout.tsx"),
    `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  await writeFile(
    path.join(fixtureRoot, "app", "page.tsx"),
    `"use client";
import { useState } from "react";
export default function Page() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
`,
  );
  return fixtureRoot;
}

describe("client asset sidecar builds", () => {
  it("clears unconsumed hybrid metadata at the end of a build session", () => {
    const buildSession = "aborted-hybrid-build";
    setPagesClientAssetsBuildMetadata(buildSession, 'export default {"clientEntry":"stale.js"};\n');
    clearPagesClientAssetsBuildMetadata(buildSession);
    expect(takePagesClientAssetsBuildMetadata(buildSession)).toBeNull();
  });

  it("keeps App Router metadata at the stable root of nested custom server outputs", async () => {
    const fixtureRoot = await createFixture();
    const outRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-client-assets-out-"));
    try {
      const serverRoot = path.join(outRoot, "custom", "server");
      const rscOutDir = path.join(serverRoot, "rsc");
      const ssrOutDir = serverRoot;
      const clientOutDir = path.join(outRoot, "custom", "client");
      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext({ appDir: fixtureRoot, rscOutDir, ssrOutDir, clientOutDir })],
      });
      await builder.buildApp();

      const rscSidecar = await fs.readFile(path.join(rscOutDir, "vinext-client-assets.js"), "utf8");
      const ssrSidecar = await fs.readFile(path.join(ssrOutDir, "vinext-client-assets.js"), "utf8");
      expect(rscSidecar).toContain('"appBootstrapPreinitModules"');
      expect(rscSidecar).not.toBe("export default {};\n");
      expect(ssrSidecar).toBe(rscSidecar);

      const rscEntry = await fs.readFile(path.join(rscOutDir, "index.js"), "utf8");
      expect(rscEntry).toContain("./vinext-client-assets.js");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
      await fs.rm(outRoot, { recursive: true, force: true });
    }
  });

  it("keeps disjoint App Router outputs self-contained", async () => {
    const fixtureRoot = await createFixture();
    const outRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-client-assets-disjoint-"));
    try {
      const rscOutDir = path.join(outRoot, "rsc-output");
      const ssrOutDir = path.join(outRoot, "ssr-output");
      const clientOutDir = path.join(outRoot, "client-output");
      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext({ appDir: fixtureRoot, rscOutDir, ssrOutDir, clientOutDir })],
      });
      await builder.buildApp();

      const rscSidecar = await fs.readFile(path.join(rscOutDir, "vinext-client-assets.js"), "utf8");
      const ssrSidecar = await fs.readFile(path.join(ssrOutDir, "vinext-client-assets.js"), "utf8");
      expect(rscSidecar).toContain('"appBootstrapPreinitModules"');
      expect(ssrSidecar).toBe(rscSidecar);
      await expect(fs.access(path.join(outRoot, "vinext-client-assets.js"))).rejects.toThrow();

      const rscEntry = await fs.readFile(path.join(rscOutDir, "index.js"), "utf8");
      expect(rscEntry).toContain("./vinext-client-assets.js");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
      await fs.rm(outRoot, { recursive: true, force: true });
    }
  });

  it("reuses client metadata for the separate Pages server build in hybrid apps", async () => {
    const fixtureRoot = await createFixture();
    const clientOutDir = path.join(fixtureRoot, "custom-client-output");
    const buildSession = `test-${path.basename(fixtureRoot)}`;
    const previousBuildSession = process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION;
    process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION = buildSession;
    try {
      await writeFile(
        path.join(fixtureRoot, "pages", "legacy.tsx"),
        `export default function Page() { return <p>legacy page</p>; }\n`,
      );

      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext({ appDir: fixtureRoot, clientOutDir })],
      });
      await builder.buildApp();

      await build({
        root: fixtureRoot,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext({ disableAppRouter: true })],
        build: {
          outDir: "dist/server",
          emptyOutDir: false,
          ssr: "virtual:vinext-server-entry",
          rolldownOptions: { output: { entryFileNames: "entry.js" } },
        },
      });

      const sidecar = await fs.readFile(
        path.join(fixtureRoot, "dist", "vinext-client-assets.js"),
        "utf8",
      );
      expect(sidecar).toContain('"clientEntry"');
      expect(sidecar).not.toBe("export default {};\n");
      const pagesEntry = await fs.readFile(
        path.join(fixtureRoot, "dist", "server", "entry.js"),
        "utf8",
      );
      expect(pagesEntry).toContain("../vinext-client-assets.js");
    } finally {
      if (previousBuildSession === undefined) {
        delete process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION;
      } else {
        process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION = previousBuildSession;
      }
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
