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
 * Fix: vinext configures the dep optimizer to treat `.js`/`.mjs` as JSX via
 * an optimizer-wide extension mapping (`optimizeDeps.rolldownOptions.moduleTypes`
 * on Vite 8, `optimizeDeps.esbuildOptions.loader` on Vite 7). This is broader
 * than `vinext:jsx-in-js` because it can also apply to optimized dependencies.
 *
 * The motivating real-world symptom (issue #5) is that, once the scan aborts,
 * pre-bundling is skipped and UMD/CJS deps can fail to interop under SSR
 * ("window is not defined"). That downstream cascade runs through a different
 * optimizer path and is NOT asserted here — these tests only verify that the
 * scan itself no longer aborts on JSX-in-`.js`/`.mjs`.
 */

import { describe, it, expect } from "vite-plus/test";
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

type OptimizerConfig = {
  rolldownOptions?: { moduleTypes?: Record<string, string> };
  esbuildOptions?: { loader?: Record<string, string> };
};

type VinextConfigResult = {
  optimizeDeps?: OptimizerConfig;
  environments?: Record<
    string,
    {
      optimizeDeps?: OptimizerConfig & { entries?: string[] };
    }
  >;
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

async function setupPagesProject(): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-optdeps-pages-jsx-"));
  await linkRootNodeModulesWithPlainJsDep(tmpDir);
  await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
  await fsp.writeFile(
    path.join(tmpDir, "pages/index.js"),
    `import { plainJsValue } from "plain-js-dep";

export default function Page() {
      return <main>{plainJsValue} pages jsx in js</main>;
    }`,
  );
  await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);
  return tmpDir;
}

async function linkRootNodeModulesWithPlainJsDep(tmpDir: string): Promise<void> {
  const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  const tmpNodeModules = path.join(tmpDir, "node_modules");
  await fsp.mkdir(tmpNodeModules, { recursive: true });

  for (const entry of await fsp.readdir(rootNodeModules, { withFileTypes: true })) {
    if (entry.name === "plain-js-dep") continue;
    await fsp.symlink(
      path.join(rootNodeModules, entry.name),
      path.join(tmpNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }

  const plainJsDepDir = path.join(tmpNodeModules, "plain-js-dep");
  await fsp.mkdir(plainJsDepDir, { recursive: true });
  await fsp.writeFile(
    path.join(plainJsDepDir, "package.json"),
    JSON.stringify({ name: "plain-js-dep", version: "1.0.0", type: "module", main: "index.js" }),
  );
  await fsp.writeFile(
    path.join(plainJsDepDir, "index.js"),
    `export const plainJsValue = 1 < 2 > 0 ? "plain-js-dep-ok" : "plain-js-dep-bad";`,
  );
}

async function expectDevScanAllowsJsxInJs(tmpDir: string, expectedTexts: string[]): Promise<void> {
  let server: ViteDevServer | null = null;
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
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(response.status).toBe(200);
    for (const expectedText of expectedTexts) {
      expect(html).toContain(expectedText);
    }
    const scanFailed = scanErrors.some((e) => e.includes("Failed to run dependency scan"));
    expect(scanFailed).toBe(false);
    // The specific OXC parse error must not surface for the .js file.
    expect(scanErrors.some((e) => e.includes("Unexpected JSX expression"))).toBe(false);
  } finally {
    await server?.close();
  }
}

function expectJsxDotJs(optimizeDeps: OptimizerConfig, viteMajor: number) {
  if (viteMajor >= 8) {
    expect(optimizeDeps.rolldownOptions?.moduleTypes?.[".js"]).toBe("jsx");
    expect(optimizeDeps.rolldownOptions?.moduleTypes?.[".mjs"]).toBe("jsx");
  } else {
    expect(optimizeDeps.esbuildOptions?.loader?.[".js"]).toBe("jsx");
    expect(optimizeDeps.esbuildOptions?.loader?.[".mjs"]).toBe("jsx");
  }
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
      )) as VinextConfigResult;

      // Top-level optimizeDeps (Pages Router default + client inheritance).
      expect(result.optimizeDeps).toBeDefined();
      expectJsxDotJs(result.optimizeDeps!, viteMajor);

      // App Router environments each run their own scanner over app/ sources.
      for (const envName of ["rsc", "ssr", "client"] as const) {
        const envOptimizeDeps = result.environments?.[envName]?.optimizeDeps;
        expect(envOptimizeDeps, `${envName} optimizeDeps`).toBeDefined();
        expectJsxDotJs(envOptimizeDeps!, viteMajor);
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);

  it("configures Pages Router build client optimizers to treat .js as JSX", async () => {
    const tmpDir = await setupPagesProject();
    try {
      const getConfig = async (plugins: unknown[]): Promise<VinextConfigResult> => {
        const vinextPlugins = vinext({ appDir: tmpDir }) as VinextPlugin[];
        const mainPlugin = vinextPlugins.find(
          (p) => p.name === "vinext:config" && typeof p.config === "function",
        );
        expect(mainPlugin).toBeDefined();

        return (await mainPlugin!.config!(
          { root: tmpDir, build: {}, plugins, optimizeDeps: {} },
          { command: "build" },
        )) as VinextConfigResult;
      };

      for (const [label, config] of [
        ["plain", await getConfig([])],
        ["cloudflare", await getConfig([{ name: "vite-plugin-cloudflare" }])],
      ] as const) {
        const clientOptimizeDeps = config.environments?.client?.optimizeDeps;
        expect(clientOptimizeDeps, `${label} client optimizeDeps`).toBeDefined();
        expect(clientOptimizeDeps?.entries).toContain("pages/**/*.{tsx,ts,jsx,js}");
        expectJsxDotJs(clientOptimizeDeps!, viteMajor);
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);

  describe("dev server", () => {
    it("renders when a pages .js file uses JSX", async () => {
      const tmpDir = await setupPagesProject();
      try {
        await expectDevScanAllowsJsxInJs(tmpDir, ["plain-js-dep-ok", "pages jsx in js"]);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }, 60_000);
  });
});
