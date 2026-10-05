import fs from "node:fs";
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

    // https://github.com/cloudflare/vinext/issues/3672: the packaged cache is
    // read-only, so a rewritten URL that is not packaged renders on every request.
    write(
      root,
      "next.config.mjs",
      `export default {
  async rewrites() {
    return { afterFiles: [{ source: "/about", destination: "/en/about" }] };
  },
};
`,
    );
    write(
      root,
      "app/[locale]/about/page.tsx",
      `export function generateStaticParams() {
  return [{ locale: "en" }];
}

export default function Page() {
  return <main>about served from prerender assets</main>;
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

  it.each(["/en/about", "/about"])(
    "serves the prerendered page at %s as a cache hit, directly and through a rewrite",
    async (pathname) => {
      const html = await fetch(`${baseUrl}${pathname}`);
      expect(html.status).toBe(200);
      expect(html.headers.get("x-vinext-cache")).toBe("HIT");
      expect(await html.text()).toContain("about served from prerender assets");

      const rsc = await fetch(`${baseUrl}${pathname}`, {
        headers: { Accept: "text/x-component", RSC: "1" },
      });
      expect(rsc.status).toBe(200);
      expect(rsc.headers.get("x-vinext-cache")).toBe("HIT");
      expect(await rsc.text()).toContain("about served from prerender assets");
    },
  );

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
