/**
 * Test: JSX in plain .js/.mjs files must not break the optimizeDeps scanner.
 *
 * Next.js allows JSX syntax in plain `.js`/`.mjs` files (Babel/SWC handle it
 * transparently). vinext's main transform handles this via the
 * `vinext:jsx-in-js` plugin (which matches `/\.m?js$/`) — but the dep optimizer
 * (scanner + pre-bundler) runs its own Rolldown/esbuild pipeline that does NOT
 * go through the Vite plugin pipeline. The scanner crawls the app's source
 * entries to discover dependencies, so a `.js`/`.mjs` source file containing JSX
 * makes the scan fail with "[PARSE_ERROR] Unexpected JSX expression" and aborts
 * pre-bundling.
 *
 * Fix: vinext configures the dep optimizer to treat `.js`/`.mjs` as JSX
 * (`optimizeDeps.rolldownOptions.moduleTypes` on Vite 8,
 * `optimizeDeps.esbuildOptions.loader` on Vite 7), mirroring how the main
 * transform treats `.js`/`.mjs`.
 *
 * The motivating real-world symptom (issue #5) is that, once the scan aborts,
 * pre-bundling is skipped and UMD/CJS deps can fail to interop under SSR
 * ("window is not defined"). That downstream cascade runs through a different
 * optimizer path and is NOT asserted here — these tests only verify that the
 * scan itself no longer aborts on JSX-in-`.js`/`.mjs`.
 */

import { describe, it, expect, afterAll } from "vite-plus/test";
import { createLogger, createServer, type ViteDevServer } from "vite";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";
import { getViteMajorVersion } from "../packages/vinext/src/utils/vite-version.js";

type VinextPlugin = {
  name: string;
  config?: (config: unknown, env: { command: string }) => unknown;
};

async function setupAppProject(): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-optdeps-jsx-"));
  const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
  await fsp.mkdir(path.join(tmpDir, "app"), { recursive: true });
  await fsp.writeFile(
    path.join(tmpDir, "app/layout.tsx"),
    `export default function L({ children }: { children: React.ReactNode }) {
      return (<html><body>{children}</body></html>);
    }`,
  );
  // page.tsx imports a plain .js module that contains JSX.
  await fsp.writeFile(
    path.join(tmpDir, "app/page.tsx"),
    `import Comp from "./comp.js";\nexport default function P() { return <Comp />; }`,
  );
  await fsp.writeFile(
    path.join(tmpDir, "app/comp.js"),
    `export default function Comp() { return <div className="x">jsx in js</div>; }`,
  );
  await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);
  return tmpDir;
}

describe("optimizeDeps: JSX in plain .js files", () => {
  const viteMajor = getViteMajorVersion();

  it("configures the dep optimizer to treat .js as JSX in every environment", async () => {
    const tmpDir = await setupAppProject();
    try {
      const plugins = vinext({ appDir: tmpDir }) as VinextPlugin[];
      const mainPlugin = plugins.find(
        (p) => p.name === "vinext:config" && typeof p.config === "function",
      );
      expect(mainPlugin).toBeDefined();

      const result = (await mainPlugin!.config!(
        { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
        { command: "serve" },
      )) as {
        optimizeDeps?: {
          rolldownOptions?: { moduleTypes?: Record<string, string> };
          esbuildOptions?: { loader?: Record<string, string> };
        };
        environments?: Record<
          string,
          {
            optimizeDeps?: {
              rolldownOptions?: { moduleTypes?: Record<string, string> };
              esbuildOptions?: { loader?: Record<string, string> };
            };
          }
        >;
      };

      const expectJsxDotJs = (optimizeDeps: {
        rolldownOptions?: { moduleTypes?: Record<string, string> };
        esbuildOptions?: { loader?: Record<string, string> };
      }) => {
        // Mirror the main transform's `/\.m?js$/` filter: both .js and .mjs.
        if (viteMajor >= 8) {
          expect(optimizeDeps.rolldownOptions?.moduleTypes?.[".js"]).toBe("jsx");
          expect(optimizeDeps.rolldownOptions?.moduleTypes?.[".mjs"]).toBe("jsx");
        } else {
          expect(optimizeDeps.esbuildOptions?.loader?.[".js"]).toBe("jsx");
          expect(optimizeDeps.esbuildOptions?.loader?.[".mjs"]).toBe("jsx");
        }
      };

      // Top-level optimizeDeps (Pages Router default + client inheritance).
      expect(result.optimizeDeps).toBeDefined();
      expectJsxDotJs(result.optimizeDeps!);

      // App Router environments each run their own scanner over app/ sources.
      for (const envName of ["rsc", "ssr", "client"] as const) {
        const envOptimizeDeps = result.environments?.[envName]?.optimizeDeps;
        expect(envOptimizeDeps, `${envName} optimizeDeps`).toBeDefined();
        expectJsxDotJs(envOptimizeDeps!);
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);

  describe("dev server", () => {
    let server: ViteDevServer | null = null;
    afterAll(async () => {
      await server?.close();
    });

    it("does not fail the dependency scan when an app .js file uses JSX", async () => {
      const tmpDir = await setupAppProject();
      const scanErrors: string[] = [];
      const logger = createLogger("silent");
      logger.error = (msg: string) => {
        scanErrors.push(String(msg));
      };

      try {
        server = await createServer({
          root: tmpDir,
          configFile: false,
          customLogger: logger,
          plugins: [vinext({ appDir: tmpDir })],
          logLevel: "silent",
        });
        await server.listen();
        const addr = server.httpServer?.address();
        const baseUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";

        // Trigger the cold-start dependency scan.
        await fetch(`${baseUrl}/`).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        const scanFailed = scanErrors.some((e) => e.includes("Failed to run dependency scan"));
        expect(scanFailed).toBe(false);
        // The specific OXC parse error must not surface for the .js file.
        expect(scanErrors.some((e) => e.includes("Unexpected JSX expression"))).toBe(false);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }, 60_000);
  });
});
