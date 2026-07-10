/**
 * Ported from Next.js: test/e2e/app-dir/worker/worker.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/worker/worker.test.ts
 */
import { afterAll, describe, expect, it } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder, type InlineConfig } from "vite";
import vinext from "../packages/vinext/src/index.js";

const temporaryDirectories: string[] = [];

async function createWorkerFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-web-worker-"));
  temporaryDirectories.push(root);
  await fs.symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  await fs.mkdir(path.join(root, "app"), { recursive: true });
  await fs.mkdir(path.join(root, "public"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  await fs.writeFile(
    path.join(root, "app", "layout.tsx"),
    "export default function Layout({ children }) { return <html><body>{children}</body></html> }",
  );
  await fs.writeFile(
    path.join(root, "app", "page.tsx"),
    `"use client";
+export default function Page() {
+  return <button onClick={() => {
+    new Worker(new URL("./worker", import.meta.url), { type: "module" });
+    new Worker(new URL("./classic-worker", import.meta.url));
+    new Worker(new URL("./png-worker", import.meta.url), { type: "module" });
+    new Worker("/docs/unbundled-worker.js");
+  }}>start</button>;
+}`.replaceAll("\n+", "\n"),
  );
  await fs.writeFile(path.join(root, "app", "worker-dep.ts"), 'export default "worker-dep"');
  await fs.writeFile(
    path.join(root, "app", "worker.ts"),
    'import("./worker-dep").then(({ default: dependency }) => self.postMessage({ deploymentId: process.env.NEXT_DEPLOYMENT_ID, dependency }));',
  );
  await fs.writeFile(
    path.join(root, "app", "classic-worker.ts"),
    'import("./worker-dep").then(({ default: dependency }) => self.postMessage(dependency));',
  );
  await fs.writeFile(
    path.join(root, "app", "png-worker.ts"),
    'import("./test-image.png").then(({ default: image }) => self.postMessage(image));',
  );
  await fs.writeFile(
    path.join(root, "app", "test-image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await fs.writeFile(
    path.join(root, "public", "unbundled-worker.js"),
    'self.postMessage("unbundled")',
  );
  return root;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("web worker production output", () => {
  it("preserves user worker output settings while namespacing worker files", async () => {
    const root = await createWorkerFixture();
    const plugins = vinext({
      appDir: root,
      nextConfig: { deploymentId: "worker-deploy-123" },
    }) as Array<{
      name: string;
      config?: (config: unknown, env: { command: string }) => Promise<unknown>;
    }>;
    const configPlugin = plugins.find((plugin) => plugin.name === "vinext:config");
    const config = (await configPlugin?.config?.(
      {
        root,
        build: {},
        plugins: [],
        worker: {
          plugins: () => [{ name: "user-worker-plugin" }],
          rolldownOptions: {
            output: { exports: "named", sourcemap: true },
          },
        },
      },
      { command: "build" },
    )) as {
      worker: {
        plugins: () => Array<{ name: string }>;
        rolldownOptions: { output: Record<string, unknown> };
      };
    };

    expect(config.worker.rolldownOptions.output).toMatchObject({
      exports: "named",
      sourcemap: true,
      entryFileNames: "_next/static/workers/[name]-[hash].js",
      chunkFileNames: "_next/static/workers/[name]-[hash].js",
    });
    expect(config.worker.plugins().map((plugin) => plugin.name)).toEqual([
      "user-worker-plugin",
      "vinext:worker-image-imports",
    ]);
  });

  it("versions bundled worker graphs and leaves string workers unbundled", async () => {
    const root = await createWorkerFixture();
    const config: InlineConfig = {
      root,
      configFile: false,
      plugins: [
        vinext({
          appDir: root,
          nextConfig: { basePath: "/docs", deploymentId: "worker-deploy-123" },
        }),
      ],
    };
    const builder = await createBuilder(config);
    await builder.buildApp();

    const files = await fs.readdir(
      path.join(root, "dist", "client", "docs", "_next", "static", "workers"),
    );
    const workerFiles = files.filter((file) => file.endsWith(".js"));
    expect(workerFiles).toHaveLength(3);

    const clientFiles = await fs.readdir(
      path.join(root, "dist", "client", "docs", "_next", "static", "chunks"),
    );
    const pageFile = clientFiles.find((file) => file.startsWith("page-"));
    expect(pageFile).toBeDefined();
    const pageCode = await fs.readFile(
      path.join(root, "dist", "client", "docs", "_next", "static", "chunks", pageFile!),
      "utf8",
    );
    for (const workerFile of workerFiles) {
      expect(pageCode).toContain(`/docs/_next/static/workers/${workerFile}?dpl=worker-deploy-123`);
    }
    expect(pageCode).toContain("globalThis.location.href");
    expect(pageCode).not.toContain("file:///ROOT/");
    expect(pageCode).toContain("new Worker(`/docs/unbundled-worker.js`)");

    const workerCode = (
      await Promise.all(
        workerFiles.map((workerFile) =>
          fs.readFile(
            path.join(root, "dist", "client", "docs", "_next", "static", "workers", workerFile),
            "utf8",
          ),
        ),
      )
    ).join("\n");
    expect(workerCode).toContain("worker-deploy-123");
    expect(workerCode).toContain("worker-dep");
    expect(workerCode).toContain("test-image-");
    expect(workerCode).toContain(".png?dpl=worker-deploy-123");
    expect(workerCode).toContain("width:1,height:1");
    expect(
      await fs.readFile(path.join(root, "dist", "client", "unbundled-worker.js"), "utf8"),
    ).toBe('self.postMessage("unbundled")');
  }, 30_000);
});
