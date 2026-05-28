/**
 * compiler.define / compiler.defineServer tests.
 *
 * Verifies that vinext forwards `next.config.compiler.define` to Vite's
 * top-level `define` (applies to client + server) and forwards
 * `compiler.defineServer` only to non-client Vite environments via the
 * `configEnvironment` hook.
 *
 * Ported from Next.js: test/e2e/define/define.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/define/define.test.ts
 */
import { describe, it, expect } from "vite-plus/test";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";

// Standard `@types/...` for these Node built-ins live in the workspace, so
// the imports above are fully typed without explicit casts.

type VinextPlugin = {
  name: string;
  config?: (config: unknown, env: { command: string }) => unknown;
  configEnvironment?: (
    name: string,
    config: unknown,
    env: { command: string },
  ) => { define?: Record<string, string> } | null | void;
};

async function setupTmpProject(nextConfigBody: string): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-compiler-define-"));
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

describe("compiler.define forwarding to Vite", () => {
  it("merges `compiler.define` entries into the top-level Vite `define`", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as VinextPlugin[];
    const mainPlugin = plugins.find(
      (p) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await setupTmpProject(
      `export default {
        compiler: {
          define: {
            MY_MAGIC_VARIABLE: "foobar",
            "process.env.MY_MAGIC_EXPR": "barbaz",
            MY_NUMBER_VARIABLE: 42,
            MY_BOOLEAN_VARIABLE: true,
          },
        },
      };`,
    );

    try {
      const result = (await mainPlugin!.config!(
        { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
        { command: "build" },
      )) as { define?: Record<string, string> };

      expect(result.define).toBeDefined();
      expect(result.define!.MY_MAGIC_VARIABLE).toBe('"foobar"');
      expect(result.define!["process.env.MY_MAGIC_EXPR"]).toBe('"barbaz"');
      expect(result.define!.MY_NUMBER_VARIABLE).toBe("42");
      expect(result.define!.MY_BOOLEAN_VARIABLE).toBe("true");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("does NOT merge `compiler.defineServer` into the top-level Vite `define`", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as VinextPlugin[];
    const mainPlugin = plugins.find(
      (p) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await setupTmpProject(
      `export default {
        compiler: {
          defineServer: { MY_SERVER_VARIABLE: "server" },
        },
      };`,
    );

    try {
      const result = (await mainPlugin!.config!(
        { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
        { command: "build" },
      )) as { define?: Record<string, string> };

      // Server-only defines must not leak into the global Vite define;
      // they're layered in per-environment instead.
      expect(result.define?.MY_SERVER_VARIABLE).toBeUndefined();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("applies `compiler.defineServer` to non-client environments via configEnvironment", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as VinextPlugin[];
    const mainPlugin = plugins.find(
      (p) => p.name === "vinext:config" && typeof p.config === "function",
    );
    const serverDefinePlugin = plugins.find((p) => p.name === "vinext:compiler-define-server");
    expect(mainPlugin).toBeDefined();
    expect(serverDefinePlugin).toBeDefined();

    const tmpDir = await setupTmpProject(
      `export default {
        compiler: {
          define: { CLIENT_SAFE: "shared" },
          defineServer: {
            MY_SERVER_VARIABLE: "server",
            "process.env.MY_MAGIC_SERVER_EXPR": "serverbarbaz",
          },
        },
      };`,
    );

    try {
      // `config` must run first so the plugin reads nextConfig.
      await mainPlugin!.config!(
        { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
        { command: "build" },
      );

      const rscResult = serverDefinePlugin!.configEnvironment!("rsc", {}, { command: "build" });
      const ssrResult = serverDefinePlugin!.configEnvironment!("ssr", {}, { command: "build" });
      const clientResult = serverDefinePlugin!.configEnvironment!(
        "client",
        {},
        { command: "build" },
      );

      expect(rscResult?.define).toEqual({
        MY_SERVER_VARIABLE: '"server"',
        "process.env.MY_MAGIC_SERVER_EXPR": '"serverbarbaz"',
      });
      expect(ssrResult?.define).toEqual({
        MY_SERVER_VARIABLE: '"server"',
        "process.env.MY_MAGIC_SERVER_EXPR": '"serverbarbaz"',
      });
      // Client environment must never receive server-only defines.
      expect(clientResult).toBeNull();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  // Mirrors Next.js: packages/next/src/build/define-env.ts (collision check)
  it("throws when `compiler.define` collides with a vinext built-in", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as VinextPlugin[];
    const mainPlugin = plugins.find(
      (p) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await setupTmpProject(
      `export default {
        compiler: {
          define: { "process.env.NODE_ENV": "evil" },
        },
      };`,
    );

    try {
      await expect(
        mainPlugin!.config!(
          { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
          { command: "build" },
        ),
      ).rejects.toThrow(/compiler\.define.*process\.env\.NODE_ENV/);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("throws when `compiler.defineServer` collides with `compiler.define` or a built-in", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as VinextPlugin[];
    const mainPlugin = plugins.find(
      (p) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await setupTmpProject(
      `export default {
        compiler: {
          define: { SHARED: "client" },
          defineServer: { SHARED: "server" },
        },
      };`,
    );

    try {
      await expect(
        mainPlugin!.config!(
          { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
          { command: "build" },
        ),
      ).rejects.toThrow(/compiler\.defineServer.*SHARED/);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("no-ops the configEnvironment hook when `defineServer` is not configured", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as VinextPlugin[];
    const mainPlugin = plugins.find(
      (p) => p.name === "vinext:config" && typeof p.config === "function",
    );
    const serverDefinePlugin = plugins.find((p) => p.name === "vinext:compiler-define-server");
    expect(mainPlugin).toBeDefined();
    expect(serverDefinePlugin).toBeDefined();

    const tmpDir = await setupTmpProject(`export default {};`);
    try {
      await mainPlugin!.config!(
        { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
        { command: "build" },
      );
      const rscResult = serverDefinePlugin!.configEnvironment!("rsc", {}, { command: "build" });
      expect(rscResult).toBeNull();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});
