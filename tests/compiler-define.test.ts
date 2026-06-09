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
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
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

    // Explicitly clear the build-time revalidate secret env var so the hook has
    // no `defineServer` entries AND no baked revalidate-secret define — only
    // then is the truly-empty no-op path exercised. (Without this the test would
    // silently depend on the env var happening to be unset in the test process.)
    const prev = process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
    delete process.env.__VINEXT_SHARED_REVALIDATE_SECRET;

    const tmpDir = await setupTmpProject(`export default {};`);
    try {
      await mainPlugin!.config!(
        { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
        { command: "build" },
      );
      const rscResult = serverDefinePlugin!.configEnvironment!("rsc", {}, { command: "build" });
      expect(rscResult).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
      else process.env.__VINEXT_SHARED_REVALIDATE_SECRET = prev;
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});

describe("build-time revalidate secret define (security: server-only)", () => {
  // The on-demand ISR revalidation secret is baked into server bundles via a
  // SERVER-ONLY define so all Workers isolates share it. The whole security
  // model depends on it NEVER reaching the client bundle — a leak would ship the
  // secret to every browser and re-open the cache-stampede/DoS vector that the
  // equality check exists to prevent. These tests pin that invariant.
  const TEST_SECRET = "a".repeat(64);
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
    process.env.__VINEXT_SHARED_REVALIDATE_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
    else process.env.__VINEXT_SHARED_REVALIDATE_SECRET = prevSecret;
  });

  async function getServerDefinePlugin(): Promise<VinextPlugin> {
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
      // `config` must run first so the plugin reads nextConfig.
      await mainPlugin!.config!(
        { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
        { command: "build" },
      );
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    return serverDefinePlugin!;
  }

  it("bakes the secret into server environments (rsc, ssr)", async () => {
    const serverDefinePlugin = await getServerDefinePlugin();
    for (const env of ["rsc", "ssr"]) {
      const result = serverDefinePlugin.configEnvironment!(env, {}, { command: "build" });
      expect(result?.define?.["process.env.__VINEXT_REVALIDATE_SECRET"]).toBe(
        JSON.stringify(TEST_SECRET),
      );
    }
  }, 15000);

  it("NEVER bakes the secret into the client environment", async () => {
    const serverDefinePlugin = await getServerDefinePlugin();
    const clientResult = serverDefinePlugin.configEnvironment!("client", {}, { command: "build" });
    // The client env returns null outright — no define object at all — so the
    // secret cannot reach the browser bundle. Assert both the null return and
    // (defensively) the absence of the key in any returned define.
    expect(clientResult).toBeNull();
    expect(clientResult?.define?.["process.env.__VINEXT_REVALIDATE_SECRET"]).toBeUndefined();
  }, 15000);
});
