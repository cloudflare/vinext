import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { cdnAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.js";
import { resolveBuiltRscEntryPath } from "../packages/vinext/src/build/server-entry.js";
import vinext from "../packages/vinext/src/index.js";
import {
  importServerEntryModule,
  startProdServer,
} from "../packages/vinext/src/server/prod-server.js";

/**
 * Regression coverage for cloudflare/vinext#3318 on a multi-stage Cloudflare
 * build (`cache.cdn`), where `dist/server/index.js` is the Worker entry rather
 * than a Node-loadable App handler:
 *
 * 1. The App handler must still resolve, or `vinext build --prerender-all` dies
 *    on the Worker entry with a raw `ERR_UNSUPPORTED_ESM_URL_SCHEME` before it
 *    renders anything.
 * 2. A pre-renderable route that imports a Workers-runtime module
 *    (`cloudflare:workers`) cannot render in the local Node prerender server,
 *    and the harness must be told why instead of reporting a bare 500.
 *
 * The end-to-end message (`/cf-binding: RSC handler returned 500 — Cloudflare
 * runtime modules ...`) is covered by the CLI path: this suite asserts the
 * server-side classification that the message is built from, because driving
 * `prerenderApp` against a Workers bundle inside the Vitest module runner does
 * not terminate.
 */
const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "fixtures/cf-app-basic/node_modules",
);
const CLOUDFLARE_PLUGIN_PATH = path.join(
  CLOUDFLARE_NODE_MODULES,
  "@cloudflare/vite-plugin/dist/index.mjs",
);

describe("Cloudflare multi-stage prerender inputs", () => {
  let root: string;
  let serverDir: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-cf-runtime-prerender-"));
    await fs.symlink(CLOUDFLARE_NODE_MODULES, path.join(root, "node_modules"), "dir");
    await fs.mkdir(path.join(root, "app/cf-binding"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "cf-runtime-prerender", type: "module" }),
    );
    await fs.writeFile(
      path.join(root, "app/layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
    );
    await fs.writeFile(
      path.join(root, "app/page.tsx"),
      "export default function Page() { return <main>home</main>; }\n",
    );
    await fs.writeFile(
      path.join(root, "app/cf-binding/page.tsx"),
      'import { env } from "cloudflare:workers";\n' +
        "\n" +
        "export const revalidate = 60;\n" +
        "\n" +
        "export default function Page() {\n" +
        '  return <main>binding: {typeof env === "object" ? "yes" : "no"}</main>;\n' +
        "}\n",
    );
    await fs.writeFile(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        name: "cf-runtime-prerender",
        compatibility_date: "2026-09-02",
        compatibility_flags: ["nodejs_compat"],
        main: "vinext/server/fetch-handler",
        assets: { not_found_handling: "none", binding: "ASSETS" },
      }),
    );

    const { cloudflare } = (await import(pathToFileURL(CLOUDFLARE_PLUGIN_PATH).href)) as {
      cloudflare: (options: {
        viteEnvironment: { name: string; childEnvironments: string[] };
      }) => import("vite").Plugin;
    };
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext({ appDir: root, cache: { cdn: cdnAdapter() } }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
    });
    await builder.buildApp();
    serverDir = path.join(root, "dist/server");
  }, 180_000);

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("resolves an App handler Node can load, not the Worker entry", async () => {
    const entryPath = resolveBuiltRscEntryPath(serverDir);
    const entry = await importServerEntryModule(entryPath);

    expect(typeof entry.default).toBe("function");
  });

  it("tells the prerender harness why a Workers-runtime route cannot render", async () => {
    // The render failure is the point of the test; keep the server's own
    // `[vinext] Server error` report out of the run output.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
      rscEntryPath: resolveBuiltRscEntryPath(serverDir),
      serverDir,
      noCompression: true,
      purpose: "prerender",
    });

    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/cf-binding`);
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(response.headers.get("x-vinext-prerender-render-error")).toBe("1");
      expect(response.headers.get("x-vinext-prerender-render-error-reason")).toBe(
        "cloudflare-runtime",
      );
      // Body is drained above so the keep-alive socket does not outlive `close()`.
      expect(body.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
      consoleError.mockRestore();
    }
  }, 120_000);
});
