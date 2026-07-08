/**
 * Verifies that vinext inlines `process.env.NEXT_DEPLOYMENT_ID` into the
 * global Vite `define` map.
 *
 * This define must be present in all bundles (client, SSR, RSC, and Vite
 * worker bundles) so that user code such as:
 *
 *   new Worker(new URL('./worker.ts', import.meta.url));
 *
 * — and the `worker.ts` it loads — can read the deployment id via
 * `process.env.NEXT_DEPLOYMENT_ID`. Web Workers can't easily share a
 * `globalThis` with the main thread, so inlining at compile time is the
 * only reliable channel. Mirrors Next.js' DefinePlugin behavior in
 * `packages/next/src/build/define-env.ts`.
 *
 * Regression test for cloudflare/vinext#1538.
 */
import { describe, it, expect } from "vite-plus/test";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";

type VinextPlugin = {
  name: string;
  config?: (config: unknown, env: { command: string }) => unknown;
};

async function setupTmpProject(nextConfigBody: string): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-deployment-id-define-"));
  const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
  await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
  await fsp.writeFile(
    path.join(tmpDir, "pages", "index.tsx"),
    `export default function Home() { return <h1>Home</h1>; }`,
  );
  await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), nextConfigBody);
  return tmpDir;
}

async function runConfig(tmpDir: string): Promise<Record<string, string>> {
  const vinext = (await import("../packages/vinext/src/index.js")).default;
  const plugins = vinext() as VinextPlugin[];
  const mainPlugin = plugins.find(
    (p) => p.name === "vinext:config" && typeof p.config === "function",
  );
  expect(mainPlugin).toBeDefined();
  const result = (await mainPlugin!.config!(
    { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
    { command: "build" },
  )) as { define?: Record<string, string> };
  expect(result.define).toBeDefined();
  return result.define!;
}

describe("process.env.NEXT_DEPLOYMENT_ID is inlined via Vite define", () => {
  it("inlines the configured deploymentId as a JSON string literal", async () => {
    const tmpDir = await setupTmpProject(`export default { deploymentId: "deploy-123" };`);
    try {
      const define = await runConfig(tmpDir);
      // The value is fed to Vite as a JSON-encoded source replacement, so
      // the user's worker code `process.env.NEXT_DEPLOYMENT_ID` becomes the
      // literal string `"deploy-123"`.
      expect(define["process.env.NEXT_DEPLOYMENT_ID"]).toBe('"deploy-123"');
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("falls back to NEXT_DEPLOYMENT_ID env var when next.config has no deploymentId", async () => {
    const previous = process.env.NEXT_DEPLOYMENT_ID;
    process.env.NEXT_DEPLOYMENT_ID = "env-deploy-456";
    const tmpDir = await setupTmpProject(`export default {};`);
    try {
      const define = await runConfig(tmpDir);
      expect(define["process.env.NEXT_DEPLOYMENT_ID"]).toBe('"env-deploy-456"');
    } finally {
      if (previous === undefined) delete process.env.NEXT_DEPLOYMENT_ID;
      else process.env.NEXT_DEPLOYMENT_ID = previous;
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("inlines `false` when no deploymentId is configured (matches Next.js parity)", async () => {
    const previous = process.env.NEXT_DEPLOYMENT_ID;
    delete process.env.NEXT_DEPLOYMENT_ID;
    const tmpDir = await setupTmpProject(`export default {};`);
    try {
      const define = await runConfig(tmpDir);
      expect(define["process.env.NEXT_DEPLOYMENT_ID"]).toBe("false");
    } finally {
      if (previous !== undefined) process.env.NEXT_DEPLOYMENT_ID = previous;
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});

describe("image optimization define", () => {
  it("inlines global unoptimized mode from next.config", async () => {
    const tmpDir = await setupTmpProject(`export default { images: { unoptimized: true } };`);
    try {
      const define = await runConfig(tmpDir);
      expect(define["process.env.__VINEXT_IMAGE_UNOPTIMIZED"]).toBe('"true"');
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});
