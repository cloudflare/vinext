/**
 * Import conditions tests — verifies that `resolve.conditions` is configured
 * correctly per Vite environment so package `exports` resolve to the right
 * file in each runtime context.
 *
 * Mirrors Next.js' behavior from `test/e2e/import-conditions/`:
 *   - RSC environment must include `react-server`
 *   - Edge / Cloudflare Workers environment must include `edge-light` (and `worker`)
 *   - Client environment must include `browser`
 *   - SSR/Node environment must include `node`
 *
 * Regression for: https://github.com/cloudflare/vinext/issues/1356
 * Ported behavior from: https://github.com/vercel/next.js/blob/canary/test/e2e/import-conditions/import-conditions.test.ts
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";

// The vinext config hook mutates process.env.NODE_ENV as a side effect.
let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
  }
});

async function makeAppDirFixture(prefix: string) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `vinext-import-conditions-${prefix}-`));
  const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

  await fsp.mkdir(path.join(tmpDir, "app"), { recursive: true });
  await fsp.writeFile(
    path.join(tmpDir, "app", "layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`,
  );
  await fsp.writeFile(
    path.join(tmpDir, "app", "page.tsx"),
    `export default function Home() { return <h1>Home</h1>; }`,
  );
  await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

  return tmpDir;
}

async function runConfigHook(mockConfig: unknown) {
  const vinext = (await import("../packages/vinext/src/index.js")).default;
  const plugins = vinext();
  const mainPlugin = plugins.find(
    (p: unknown) =>
      !!p &&
      typeof p === "object" &&
      (p as { name?: string }).name === "vinext:config" &&
      typeof (p as { config?: unknown }).config === "function",
  );
  if (!mainPlugin) throw new Error("vinext:config plugin not found");
  return await (mainPlugin as { config: (c: unknown, env: unknown) => Promise<any> }).config(
    mockConfig,
    { command: "build" },
  );
}

describe("resolve.conditions per environment (App Router)", () => {
  it("sets `react-server` condition on the RSC environment", async () => {
    const tmpDir = await makeAppDirFixture("rsc");
    try {
      const result = await runConfigHook({ root: tmpDir, build: {}, plugins: [] });
      const rscConditions = result.environments?.rsc?.resolve?.conditions ?? [];
      expect(
        rscConditions,
        `rsc env should include "react-server"; got: ${JSON.stringify(rscConditions)}`,
      ).toContain("react-server");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("sets `node` condition on the SSR environment", async () => {
    const tmpDir = await makeAppDirFixture("ssr");
    try {
      const result = await runConfigHook({ root: tmpDir, build: {}, plugins: [] });
      const ssrConditions = result.environments?.ssr?.resolve?.conditions ?? [];
      expect(
        ssrConditions,
        `ssr env should include "node"; got: ${JSON.stringify(ssrConditions)}`,
      ).toContain("node");
      expect(
        ssrConditions,
        `ssr env should NOT include "react-server"; got: ${JSON.stringify(ssrConditions)}`,
      ).not.toContain("react-server");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("sets `browser` condition on the client environment", async () => {
    const tmpDir = await makeAppDirFixture("client");
    try {
      const result = await runConfigHook({ root: tmpDir, build: {}, plugins: [] });
      const clientConditions = result.environments?.client?.resolve?.conditions ?? [];
      expect(
        clientConditions,
        `client env should include "browser"; got: ${JSON.stringify(clientConditions)}`,
      ).toContain("browser");
      expect(
        clientConditions,
        `client env should NOT include "react-server"; got: ${JSON.stringify(clientConditions)}`,
      ).not.toContain("react-server");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("adds `edge-light` and `worker` conditions to RSC environment when Cloudflare plugin is present", async () => {
    const tmpDir = await makeAppDirFixture("rsc-cf");
    try {
      // The vinext config hook detects the Cloudflare plugin by name.
      const fakeCloudflarePlugin = { name: "vite-plugin-cloudflare" };
      const result = await runConfigHook({
        root: tmpDir,
        build: {},
        plugins: [fakeCloudflarePlugin],
      });
      const rscConditions = result.environments?.rsc?.resolve?.conditions ?? [];
      // RSC on workerd: must keep `react-server` and add edge runtime conditions
      // so packages like `library-with-exports` resolve their edge-light exports.
      expect(
        rscConditions,
        `rsc env on cloudflare should include "react-server"; got: ${JSON.stringify(rscConditions)}`,
      ).toContain("react-server");
      expect(
        rscConditions,
        `rsc env on cloudflare should include "edge-light"; got: ${JSON.stringify(rscConditions)}`,
      ).toContain("edge-light");
      expect(
        rscConditions,
        `rsc env on cloudflare should include "worker"; got: ${JSON.stringify(rscConditions)}`,
      ).toContain("worker");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("adds `edge-light` and `worker` conditions to SSR environment when Cloudflare plugin is present", async () => {
    const tmpDir = await makeAppDirFixture("ssr-cf");
    try {
      const fakeCloudflarePlugin = { name: "vite-plugin-cloudflare" };
      const result = await runConfigHook({
        root: tmpDir,
        build: {},
        plugins: [fakeCloudflarePlugin],
      });
      const ssrConditions = result.environments?.ssr?.resolve?.conditions ?? [];
      expect(
        ssrConditions,
        `ssr env on cloudflare should include "edge-light"; got: ${JSON.stringify(ssrConditions)}`,
      ).toContain("edge-light");
      expect(
        ssrConditions,
        `ssr env on cloudflare should include "worker"; got: ${JSON.stringify(ssrConditions)}`,
      ).toContain("worker");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});

describe("resolve.conditions per environment (Pages Router on Node)", () => {
  async function makePagesDirFixture(prefix: string) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `vinext-import-conditions-${prefix}-`));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    return tmpDir;
  }

  it("sets `node` condition on the SSR environment", async () => {
    const tmpDir = await makePagesDirFixture("pages-ssr");
    try {
      const result = await runConfigHook({ root: tmpDir, build: {}, plugins: [] });
      const ssrConditions = result.environments?.ssr?.resolve?.conditions ?? [];
      expect(
        ssrConditions,
        `pages ssr env should include "node"; got: ${JSON.stringify(ssrConditions)}`,
      ).toContain("node");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("sets `browser` condition on the client environment", async () => {
    const tmpDir = await makePagesDirFixture("pages-client");
    try {
      const result = await runConfigHook({ root: tmpDir, build: {}, plugins: [] });
      const clientConditions = result.environments?.client?.resolve?.conditions ?? [];
      expect(
        clientConditions,
        `pages client env should include "browser"; got: ${JSON.stringify(clientConditions)}`,
      ).toContain("browser");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});
