import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createBuilder,
  createServer,
  type Plugin,
  type PluginOption,
  type ViteDevServer,
} from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import type { CacheLifeConfig } from "../packages/vinext/src/utils/cache-life-profiles.js";

const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "fixtures/cf-app-basic/node_modules",
);

type Worker = { url: Promise<URL>; dispose(): Promise<void> };
type Observation = {
  value: string;
  cacheLife: CacheLifeConfig;
  entry?: { cacheControl: CacheLifeConfig; tags: string[] };
};

function writeFile(root: string, name: string, content: string) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createApp(runtime: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vinext-cache-life-${runtime}-`));
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  writeFile(root, "package.json", JSON.stringify({ private: true, type: "module" }));
  writeFile(
    root,
    "next.config.mjs",
    `export default {
    cacheLife: {
      default: { stale: 90, revalidate: 30, expire: 7200 },
      blog: { stale: 60, revalidate: 300, expire: 3600 },
      seconds: { stale: 5, revalidate: 10, expire: 60 },
      partial: { expire: 600 },
      frozen: { stale: Infinity, revalidate: Infinity, expire: Infinity },
    },
  };\n`,
  );
  writeFile(
    root,
    "app/layout.tsx",
    `export default function Layout({ children }) {
    return <html><body>{children}</body></html>;
  }\n`,
  );
  writeFile(
    root,
    "app/page.tsx",
    `export default function Page() {
    return <p>Configured cache profiles</p>;
  }\n`,
  );
  writeFile(
    root,
    "recording-adapter.ts",
    `import { MemoryCacheHandler } from "next/cache";
  const writes = [];
  export function getWrite(profile) {
    return writes.findLast((entry) => entry.tags.includes("profile:" + profile));
  }
  class RecordingHandler extends MemoryCacheHandler {
    async set(key, data, context) {
      if (context?.cacheControl && Array.isArray(context.tags)) {
        writes.push({ cacheControl: context.cacheControl, tags: context.tags });
      }
      await super.set(key, data, context);
    }
  }
  export default function createHandler() { return new RecordingHandler(); }\n`,
  );
  writeFile(
    root,
    "app/api/profiles/route.ts",
    `import {
    cacheLife, cacheTag, unstable_cacheLife, _peekRequestScopedCacheLife,
  } from "next/cache";
  import { getWrite } from "../../../recording-adapter";
  export const dynamic = "force-dynamic";
  async function getValue(profile) {
    "use cache";
    if (profile === "alias") unstable_cacheLife("blog");
    else if (profile !== "default") cacheLife(profile);
    cacheTag("profile:" + profile);
    return crypto.randomUUID();
  }
  export async function GET(request) {
    const profile = new URL(request.url).searchParams.get("profile");
    const value = await getValue(profile);
    return Response.json({
      value, cacheLife: _peekRequestScopedCacheLife(), entry: getWrite(profile),
    });
  }\n`,
  );
  if (runtime === "workers") {
    writeFile(
      root,
      "wrangler.jsonc",
      JSON.stringify({
        name: "vinext-configured-cache-life",
        compatibility_date: "2026-04-01",
        compatibility_flags: ["nodejs_compat"],
        main: path.resolve(
          import.meta.dirname,
          "../packages/vinext/src/server/app-router-entry.ts",
        ),
        assets: { not_found_handling: "none", binding: "ASSETS" },
      }),
    );
  }
  return root;
}

// Adapted from Next.js's custom profile metadata and Infinity cache-hit tests:
// https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/test/e2e/app-dir/use-cache/use-cache.test.ts
// https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/test/e2e/app-dir/use-cache-infinity-profile/use-cache-infinity-profile.test.ts
describe.each(["dev", "node", "workers"] as const)("configured cacheLife on %s", (runtime) => {
  let root: string;
  let baseUrl: string;
  let dev: ViteDevServer | undefined;
  let node: Server | undefined;
  let worker: Worker | undefined;

  beforeAll(async () => {
    root = createApp(runtime);
    const plugins: PluginOption[] = vinext({
      appDir: root,
      // Dev skips shared storage. Avoid registering its adapter in the host's
      // shared handler registry before the production application's adapter.
      cache:
        runtime === "dev"
          ? undefined
          : {
              data: { adapter: path.join(root, "recording-adapter.ts") },
            },
    });
    if (runtime === "dev") {
      dev = await createServer({
        root,
        cacheDir: path.join(root, ".vite"),
        configFile: false,
        plugins,
        server: { port: 0, cors: false },
        logLevel: "silent",
      });
      await dev.listen();
      const address = dev.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("Missing dev server address");
      baseUrl = `http://localhost:${address.port}`;
      return;
    }

    if (runtime === "workers") {
      const { cloudflare } = (await import(
        pathToFileURL(path.join(CLOUDFLARE_NODE_MODULES, "@cloudflare/vite-plugin/dist/index.mjs"))
          .href
      )) as {
        cloudflare: (options: {
          viteEnvironment: { name: string; childEnvironments: string[] };
        }) => Plugin;
      };
      plugins.push(cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }));
    }
    const builder = await createBuilder({
      root,
      cacheDir: path.join(root, ".vite"),
      configFile: false,
      plugins,
      logLevel: "silent",
    });
    await builder.buildApp();
    if (runtime === "node") {
      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      const started = await startProdServer({ port: 0, outDir: path.join(root, "dist") });
      node = started.server;
      baseUrl = `http://localhost:${started.port}`;
    } else {
      // Same production Workerd harness used by after-response-close-worker.test.ts.
      const wrangler = (await import(
        pathToFileURL(path.join(CLOUDFLARE_NODE_MODULES, "wrangler/wrangler-dist/cli.js")).href
      )) as {
        unstable_startWorker(options: {
          config: string;
          dev: {
            remote: false;
            persist: false;
            logLevel: "none";
            watch: false;
            server: { port: 0 };
          };
        }): Promise<Worker>;
      };
      worker = await wrangler.unstable_startWorker({
        config: path.join(root, "dist/server/wrangler.json"),
        dev: { remote: false, persist: false, logLevel: "none", watch: false, server: { port: 0 } },
      });
      baseUrl = (await worker.url).origin;
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await dev?.close();
      if (node)
        await new Promise<void>((resolve, reject) => {
          node!.close((error) => (error ? reject(error) : resolve()));
        });
      await worker?.dispose();
    } finally {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["blog", { stale: 60, revalidate: 300, expire: 3600 }],
    ["seconds", { stale: 5, revalidate: 10, expire: 60 }],
    ["partial", { stale: 90, revalidate: 30, expire: 600 }],
    ["default", { stale: 90, revalidate: 30, expire: 7200 }],
    ["frozen", { stale: 4294967294, revalidate: 4294967294, expire: 4294967294 }],
    ["alias", { stale: 60, revalidate: 300, expire: 3600 }],
  ] as const)(
    "applies %s's durations and replays them on production hits",
    async (profile, expected) => {
      async function read(): Promise<Observation> {
        const response = await fetch(`${baseUrl}/api/profiles?profile=${profile}`);
        expect(response.status).toBe(200);
        return response.json() as Promise<Observation>;
      }
      const cold = await read();
      const warm = await read();
      expect(cold.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(cold.cacheLife).toStrictEqual(expected);
      expect(warm.cacheLife).toStrictEqual(expected);
      if (runtime !== "dev") {
        expect(cold.entry?.cacheControl).toStrictEqual(expected);
        expect(warm.entry?.cacheControl).toStrictEqual(expected);
        expect(warm.value).toBe(cold.value);
      }
    },
  );
});
