import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { staticAssetsAdapter } from "../packages/cloudflare/src/cache/static-assets-adapter.js";
import { runPrerender } from "../packages/vinext/src/build/run-prerender.js";
import { finalizeCacheAdapterPrerenderOutput } from "../packages/vinext/src/cache/cache-adapters-virtual.js";
import vinext from "../packages/vinext/src/index.js";
import { generateWranglerConfig } from "../packages/vinext/src/init-cloudflare.js";

const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "fixtures/cf-app-basic/node_modules",
);

function write(root: string, relativePath: string, contents: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

describe("staticAssetsAdapter on the Cloudflare Workers runtime", () => {
  let root = "";
  let worker: { url: Promise<URL>; dispose(): Promise<void> } | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-static-assets-worker-"));
    fs.symlinkSync(CLOUDFLARE_NODE_MODULES, path.join(root, "node_modules"), "junction");
    write(root, "package.json", JSON.stringify({ name: "static-assets-cache", type: "module" }));
    write(
      root,
      "wrangler.jsonc",
      generateWranglerConfig(
        {
          root,
          projectName: "vinext-static-assets-cache",
          isAppRouter: true,
          hasISR: false,
          hasMDX: false,
          nativeModulesToStub: [],
        },
        { cdnCache: "static-assets", dataCache: "none", imageOptimization: "none" },
        "2026-04-01",
      ),
    );
    write(
      root,
      "app/layout.tsx",
      `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
    );
    write(
      root,
      "app/page.tsx",
      `export default function Page() {
  return <main id="static-assets-cache">served from prerender assets</main>;
}
`,
    );

    const descriptor = staticAssetsAdapter();
    const cloudflarePluginPath = path.join(
      root,
      "node_modules/@cloudflare/vite-plugin/dist/index.mjs",
    );
    const { cloudflare } = (await import(pathToFileURL(cloudflarePluginPath).href)) as {
      cloudflare: (options: {
        viteEnvironment: { name: string; childEnvironments: string[] };
      }) => import("vite").Plugin;
    };
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root, prerender: true, cache: { cdn: descriptor } }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();
    const warn = vi.spyOn(console, "warn");
    try {
      await runPrerender({ root });
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("failed to initialize the configured CDN cache adapter"),
        ),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    await finalizeCacheAdapterPrerenderOutput({ cdn: descriptor }, root);

    const wranglerPath = path.join(root, "node_modules/wrangler/wrangler-dist/cli.js");
    const wrangler = (await import(pathToFileURL(wranglerPath).href)) as {
      unstable_startWorker(options: {
        config: string;
        dev: {
          remote: false;
          persist: false;
          logLevel: "none";
          watch: false;
          server: { port: 0 };
        };
      }): Promise<{ url: Promise<URL>; dispose(): Promise<void> }>;
    };
    worker = await wrangler.unstable_startWorker({
      config: path.join(root, "dist/server/wrangler.json"),
      dev: {
        remote: false,
        persist: false,
        logLevel: "none",
        watch: false,
        server: { port: 0 },
      },
    });
    baseUrl = (await worker.url).origin;
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves prerendered HTML and RSC as cache hits", async () => {
    const html = await fetch(baseUrl);
    expect(html.status).toBe(200);
    expect(html.headers.get("x-vinext-cache")).toBe("HIT");
    expect(await html.text()).toContain("served from prerender assets");

    const rsc = await fetch(baseUrl, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    expect(rsc.status).toBe(200);
    expect(rsc.headers.get("x-vinext-cache")).toBe("HIT");
    expect(rsc.headers.get("content-type")).toContain("text/x-component");
    expect(await rsc.text()).toContain("served from prerender assets");
  });

  it("serves prerendered HTML and RSC to query-bearing requests as cache hits", async () => {
    const html = await fetch(`${baseUrl}/?source=nav`);
    expect(html.status).toBe(200);
    expect(html.headers.get("x-vinext-cache")).toBe("HIT");
    expect(await html.text()).toContain("served from prerender assets");

    const rsc = await fetch(`${baseUrl}/?source=nav`, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    expect(rsc.status).toBe(200);
    expect(rsc.headers.get("x-vinext-cache")).toBe("HIT");
    expect(await rsc.text()).toContain("served from prerender assets");
  });

  it("keeps serving cache hits after a request is cancelled while loading the cache index", async () => {
    const require = createRequire(
      fs.realpathSync(path.join(CLOUDFLARE_NODE_MODULES, "wrangler/package.json")),
    );
    const { Miniflare } = (await import(pathToFileURL(require.resolve("miniflare")).href)) as {
      Miniflare: new (options: Record<string, unknown>) => {
        dispatchFetch(url: string): Promise<Response>;
        dispose(): Promise<void>;
      };
    };
    const dist = path.join(root, "dist/server");
    const config = JSON.parse(fs.readFileSync(path.join(dist, "wrangler.json"), "utf8")) as {
      compatibility_date: string;
      compatibility_flags?: string[];
    };
    const modules = fs
      .readdirSync(dist, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".js") && file !== "index.js");

    let indexRequested!: () => void;
    const indexRequest = new Promise<void>((resolve) => (indexRequested = resolve));
    let releaseIndex!: () => void;
    const indexReleased = new Promise<void>((resolve) => (releaseIndex = resolve));
    // Production cancels a request when its client disconnects. Workerd does
    // the same to a service-binding request whose caller has finished, so the
    // front worker abandons the first app request while it awaits the index.
    const miniflare = new Miniflare({
      workers: [
        {
          name: "front",
          modules: true,
          compatibilityDate: config.compatibility_date,
          serviceBindings: {
            APP: "app",
            INDEX_REQUESTED: () => indexRequest.then(() => new Response()),
          },
          script: `export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/abandon") return env.APP.fetch("https://app.local/");
    env.APP.fetch("https://app.local/").catch(() => {});
    await env.INDEX_REQUESTED.fetch("https://signal.local/");
    return new Response("abandoned");
  },
};`,
        },
        {
          name: "app",
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags ?? [],
          modules: ["index.js", ...modules].map((file) => ({
            path: file,
            type: "ESModule",
            contents: fs.readFileSync(path.join(dist, file), "utf8"),
          })),
          serviceBindings: {
            async ASSETS(request: Request) {
              const { pathname } = new URL(request.url);
              if (pathname.endsWith("/static-cache/index.json")) {
                indexRequested();
                await indexReleased;
              }
              const file = path.join(root, "dist/client", decodeURIComponent(pathname));
              return fs.existsSync(file) && fs.statSync(file).isFile()
                ? new Response(fs.readFileSync(file))
                : new Response(null, { status: 404 });
            },
          },
        },
      ],
    });
    try {
      const abandoned = await miniflare.dispatchFetch("https://front.local/abandon");
      expect(await abandoned.text()).toBe("abandoned");
      releaseIndex();

      const response = await Promise.race([
        miniflare.dispatchFetch("https://front.local/"),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
      expect(response, "request after the cancelled one never settled").not.toBeNull();
      expect(response!.status).toBe(200);
      expect(response!.headers.get("x-vinext-cache")).toBe("HIT");
      expect(await response!.text()).toContain("served from prerender assets");
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);

  it("does not expose the packaged cache through public asset URLs", async () => {
    const artifacts = fs.readdirSync(path.join(root, "dist/client/_vinext/static-cache"));
    expect(artifacts).toContain("index.json");
    expect(artifacts.some((file) => file.endsWith(".html"))).toBe(true);
    expect(artifacts.some((file) => file.endsWith(".rsc"))).toBe(true);
    for (const file of artifacts) {
      const response = await fetch(`${baseUrl}/_vinext/static-cache/${file}`);
      expect(response.status, file).toBe(404);
    }
  });
});
