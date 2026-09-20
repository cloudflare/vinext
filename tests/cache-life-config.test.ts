import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import type { NextConfigInput } from "../packages/vinext/src/config/next-config.js";
import { createDirectRunner } from "../packages/vinext/src/server/dev-module-runner.js";
import { createDefaultCacheLifeProfiles } from "../packages/vinext/src/utils/cache-life-profiles.js";

type CacheModule = typeof import("../packages/vinext/src/shims/cache.js");
type CacheRuntime = typeof import("../packages/vinext/src/shims/cache-runtime.js");

describe("configured cacheLife in dev environments", () => {
  const roots: string[] = [];
  const servers: ViteDevServer[] = [];
  const runners: ReturnType<typeof createDirectRunner>[] = [];
  let first: { rsc: CacheModule; ssr: CacheModule };
  let second: { rsc: CacheModule; ssr: CacheModule };
  let hostEnvironment: NodeJS.ProcessEnv;

  async function createApp(nextConfig?: NextConfigInput): Promise<ViteDevServer> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cache-life-config-"));
    roots.push(root);
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    fs.mkdirSync(path.join(root, "app"));
    fs.writeFileSync(
      path.join(root, "app", "page.tsx"),
      "export default function Page() { return <p>Cache profiles</p>; }\n",
    );

    if (!nextConfig) {
      // Configuration shapes from Next.js's use-cache and infinity-profile fixtures:
      // https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/test/e2e/app-dir/use-cache/next.config.js
      // https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/test/e2e/app-dir/use-cache-infinity-profile/next.config.js
      fs.writeFileSync(
        path.join(root, "next.config.mjs"),
        `export default {
        cacheLife: {
          blog: { stale: 60, revalidate: 300, expire: 3600 },
          hours: { expire: 120 },
          default: { revalidate: 30 },
          frozen: { stale: Infinity, revalidate: Infinity, expire: Infinity },
        },
      };\n`,
      );
    }

    const server = await createServer({
      root,
      cacheDir: path.join(root, ".vite"),
      configFile: false,
      plugins: [vinext({ appDir: root, nextConfig })],
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { port: 0, cors: false },
      logLevel: "silent",
    });
    servers.push(server);
    return server;
  }

  async function loadCacheModules(server: ViteDevServer) {
    const rscRunner = createDirectRunner(server.environments.rsc);
    const ssrRunner = createDirectRunner(server.environments.ssr);
    runners.push(rscRunner, ssrRunner);
    return {
      rsc: await rscRunner.import<CacheModule>("next/cache"),
      ssr: await ssrRunner.import<CacheModule>("next/cache"),
    };
  }

  beforeAll(async () => {
    hostEnvironment = { ...process.env };
    const firstServer = await createApp();
    first = await loadCacheModules(firstServer);
    const secondServer = await createApp({
      cacheLife: {
        blog: { stale: 10, revalidate: 60, expire: 600 },
        secondOnly: { expire: 60 },
      },
    });
    second = await loadCacheModules(secondServer);
  }, 60_000);

  afterAll(async () => {
    try {
      for (const runner of runners) await runner.close();
      for (const server of servers) await server.close();
    } finally {
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads custom and overridden built-in profiles from the config file in a real dev module", () => {
    expect(first.rsc.cacheLifeProfiles.blog).toStrictEqual({
      stale: 60,
      revalidate: 300,
      expire: 3600,
    });
    expect(first.rsc.cacheLifeProfiles.hours).toStrictEqual({ expire: 120 });
    expect(first.rsc.cacheLifeProfiles.default).toStrictEqual({
      stale: 300,
      revalidate: 30,
      expire: 31_536_000,
    });
    expect(first.rsc.cacheLifeProfiles.frozen).toStrictEqual({
      stale: 4294967294,
      revalidate: 4294967294,
      expire: 4294967294,
    });
  });

  it("injects identical configuration into separate RSC and SSR module instances", () => {
    for (const [index, modules] of [first, second].entries()) {
      const server = servers[index];
      const rscDefine = server.config.environments.rsc.define?.__VINEXT_CACHE_LIFE_PROFILES__;
      const ssrDefine = server.config.environments.ssr.define?.__VINEXT_CACHE_LIFE_PROFILES__;
      expect(rscDefine).toBeDefined();
      expect(ssrDefine).toBe(rscDefine);
      expect(JSON.parse(JSON.parse(rscDefine))).toStrictEqual(modules.rsc.cacheLifeProfiles);
      expect(modules.ssr.cacheLifeProfiles).toStrictEqual(modules.rsc.cacheLifeProfiles);
      expect(modules.ssr.cacheLifeProfiles).not.toBe(modules.rsc.cacheLifeProfiles);
      expect(modules.ssr.cacheLifeProfiles.blog).not.toBe(modules.rsc.cacheLifeProfiles.blog);
    }
  });

  it("keeps two applications' profiles isolated in the same host process", () => {
    expect(second.rsc.cacheLifeProfiles.blog).toStrictEqual({
      stale: 10,
      revalidate: 60,
      expire: 600,
    });
    expect(second.rsc.cacheLifeProfiles.secondOnly).toStrictEqual({ expire: 60 });
    expect(second.rsc.cacheLifeProfiles.hours).toStrictEqual(
      createDefaultCacheLifeProfiles().hours,
    );
    expect(second.rsc.cacheLifeProfiles.default).toStrictEqual(
      createDefaultCacheLifeProfiles().default,
    );
    expect(second.rsc.cacheLifeProfiles.frozen).toBeUndefined();
    expect(first.rsc.cacheLifeProfiles.secondOnly).toBeUndefined();
    expect(first.rsc.cacheLifeProfiles.blog.expire).toBe(3600);
    expect(first.rsc.cacheLifeProfiles.hours).toStrictEqual({ expire: 120 });
  });

  it("uses built-in defaults for direct shim imports without Vite injection", async () => {
    const direct = await import("../packages/vinext/src/shims/cache.js");
    expect(direct.cacheLifeProfiles).toStrictEqual(createDefaultCacheLifeProfiles());
  });

  it("consumes the injected profiles consistently in real RSC and SSR dev execution", async () => {
    for (const [index, cache] of [first.rsc, first.ssr, second.rsc, second.ssr].entries()) {
      const runtime = await runners[index].import<CacheRuntime>(
        path.resolve(import.meta.dirname, "../packages/vinext/src/shims/cache-runtime.ts"),
      );
      const cached = runtime.registerCachedFunction(async () => {
        cache.cacheLife("hours");
        return "configured";
      }, `configured:dev:${index}`);
      await cache._runWithCacheState(async () => {
        expect(await cached()).toBe("configured");
        expect(cache._peekRequestScopedCacheLife()).toStrictEqual(
          index < 2
            ? { stale: 300, revalidate: 30, expire: 120 }
            : createDefaultCacheLifeProfiles().hours,
        );
      });
      const blog = runtime.registerCachedFunction(async () => {
        cache.cacheLife("blog");
        return "blog";
      }, `configured:dev:blog:${index}`);
      await cache._runWithCacheState(async () => {
        await blog();
        expect(cache._peekRequestScopedCacheLife()).toStrictEqual(cache.cacheLifeProfiles.blog);
      });
    }
  });

  it("does not publish application configuration into the host process environment", () => {
    // Existing vinext dev startup changes NODE_ENV from test to development.
    // Check the remaining keys without printing environment variable values.
    const keys = new Set([...Object.keys(hostEnvironment), ...Object.keys(process.env)]);
    const changedKeys = [...keys].filter(
      (key) => key !== "NODE_ENV" && process.env[key] !== hostEnvironment[key],
    );
    expect(changedKeys).toStrictEqual([]);
  });
});
