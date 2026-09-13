/**
 * Next.js compiles process.browser per target. Verify vinext does the same in
 * dev application transforms and in each environment's dependency optimizer.
 *
 * Ported from Next.js:
 * - test/unit/next-babel-loader-prod.test.ts
 * - test/production/pages-dir/production/test/process-env.ts
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { startFixtureServer } from "./helpers.js";

describe("process.browser define (dev environments)", () => {
  let root: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-process-browser-dev-"));
    const workspaceNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    const nodeModules = path.join(root, "node_modules");
    await fsp.mkdir(nodeModules);
    for (const entry of await fsp.readdir(workspaceNodeModules)) {
      if (entry === ".vite" || entry === ".cache" || entry === "process-browser-probe") continue;
      await fsp.symlink(
        path.join(workspaceNodeModules, entry),
        path.join(nodeModules, entry),
        "junction",
      );
    }

    const dependency = path.join(nodeModules, "process-browser-probe");
    await fsp.mkdir(dependency);
    await fsp.writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({
        name: "process-browser-probe",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
    );
    await fsp.writeFile(
      path.join(dependency, "index.js"),
      `export const dependencyBranch = process.browser ? "__DEP_BROWSER__" : "__DEP_SERVER__";`,
    );

    await fsp.mkdir(path.join(root, "app"));
    await fsp.writeFile(
      path.join(root, "app", "layout.tsx"),
      `export default function Layout({ children }) { return <html><body>{children}</body></html> }`,
    );
    await fsp.writeFile(
      path.join(root, "app", "client.tsx"),
      `"use client";
import { dependencyBranch } from "process-browser-probe";
export function ClientProbe() {
  return <p>{process.browser ? "__CLIENT_BROWSER__" : "__CLIENT_SERVER__"}:{dependencyBranch}</p>;
}`,
    );
    await fsp.writeFile(
      path.join(root, "app", "page.tsx"),
      `import { dependencyBranch } from "process-browser-probe";
import { ClientProbe } from "./client";
export default function Page() {
  return <main>{process.browser ? "__RSC_BROWSER__" : "__RSC_SERVER__"}:{dependencyBranch}<ClientProbe /></main>;
}`,
    );

    ({ server, baseUrl } = await startFixtureServer(root, { appRouter: true }));
  }, 60_000);

  afterAll(async () => {
    try {
      (server?.httpServer as { closeAllConnections?: () => void })?.closeAllConnections?.();
      await server?.close();
    } finally {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses false while rendering RSC and SSR", async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("__RSC_SERVER__");
    expect(html).toContain("__CLIENT_SERVER__");
    expect(html).toContain("__DEP_SERVER__");
    expect(html).not.toContain("__RSC_BROWSER__");
    expect(html).not.toContain("__CLIENT_BROWSER__");
    expect(html).not.toContain("__DEP_BROWSER__");
  });

  it("uses the client runtime define and replaces RSC and SSR references", async () => {
    const clientRuntime = await fetch(`${baseUrl}/@vite/env`);
    expect(clientRuntime.status).toBe(200);
    expect(await clientRuntime.text()).toMatch(/["']process\.browser["']:\s*true/);

    const cases = [
      ["rsc", "/app/page.tsx", "__RSC_SERVER__"],
      ["ssr", "/app/client.tsx", "__CLIENT_SERVER__"],
    ] as const;
    for (const [environmentName, url, expected] of cases) {
      const result = await server.environments[environmentName].transformRequest(url);
      expect(result?.code, environmentName).toContain(expected);
      expect(result?.code, `${environmentName} replacement`).not.toContain("process.browser");
    }
  });

  it("replaces process.browser inside optimized client dependencies", async () => {
    await Promise.all([
      server.environments.client.transformRequest("/app/client.tsx"),
      server.environments.rsc.transformRequest("/app/page.tsx"),
      server.environments.ssr.transformRequest("/app/client.tsx"),
    ]);

    const environment = server.environments.client;
    await environment.waitForRequestsIdle();
    const dependency = environment.depsOptimizer?.metadata.depInfoList.find(
      (entry) => entry.id === "process-browser-probe",
    );
    expect(dependency, "client optimized dependency").toBeDefined();
    if (dependency?.processing) await dependency.processing;
    const code = await fsp.readFile(dependency!.file, "utf8");
    expect(code).toContain("__DEP_BROWSER__");
    expect(code).not.toContain("__DEP_SERVER__");
    expect(code).not.toContain("process.browser");
  }, 30_000);
});
