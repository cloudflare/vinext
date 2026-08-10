/**
 * Client-side `global` polyfill tests.
 *
 * Next.js exposes the Node-style `global` alias in browser bundles: webpack
 * via its `node.global` runtime shim, Turbopack by compile-time rewriting the
 * free `global` identifier to its globalThis shortcut and folding
 * `typeof global` to "object" (turbopack/crates/turbopack-ecmascript/src/
 * references/mod.rs). Client dependencies such as use-dark-mode read `global`
 * directly and throw `ReferenceError: global is not defined` after hydration
 * without it (reproduced via nextjs-notion-starter-kit).
 *
 * vinext provides a client-environment-scoped
 * `define: { global: "globalThis" }`: statically rewritten in builds
 * (Turbopack-style), injected as a runtime global via /@vite/env in dev
 * (webpack-style), and layered into the client dep optimizer so pre-bundled
 * deps (which bypass plugin transforms) get the rewrite too.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite-plus";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import vinext from "../packages/vinext/src/index.js";

type VinextPlugin = {
  name: string;
  config?: (config: unknown, env: { command: string; mode?: string }) => unknown;
  configEnvironment?: (
    name: string,
    config: unknown,
    env: { command: string },
  ) => {
    define?: Record<string, string>;
    optimizeDeps?: {
      rolldownOptions?: { transform?: { define?: Record<string, string> } };
    };
  } | null | void;
};

async function setupTmpProject(nextConfigBody: string): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-client-global-define-"));
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

describe("client `global` define (config)", () => {
  it("defines `global` -> `globalThis` for the client environment only", async () => {
    const plugins = vinext() as VinextPlugin[];
    const mainPlugin = plugins.find(
      (p) => p.name === "vinext:config" && typeof p.config === "function",
    );
    const globalDefinePlugin = plugins.find((p) => p.name === "vinext:client-global-define");
    expect(mainPlugin).toBeDefined();
    expect(globalDefinePlugin).toBeDefined();

    const tmpDir = await setupTmpProject(`export default {};`);
    try {
      await mainPlugin!.config!(
        { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
        { command: "build" },
      );

      const clientResult = globalDefinePlugin!.configEnvironment!(
        "client",
        {},
        { command: "build" },
      );
      expect(clientResult?.define).toEqual({ global: "globalThis" });
      // Pre-bundled deps bypass the plugin transform pipeline, so the client
      // dep optimizer needs the same define.
      const optimizerDefine = clientResult?.optimizeDeps?.rolldownOptions?.transform?.define;
      expect(optimizerDefine).toEqual({ global: "globalThis" });

      // Server environments keep the real Node `global`.
      expect(globalDefinePlugin!.configEnvironment!("rsc", {}, { command: "build" })).toBeNull();
      expect(globalDefinePlugin!.configEnvironment!("ssr", {}, { command: "build" })).toBeNull();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("yields to a user-configured `compiler.define.global`", async () => {
    const plugins = vinext() as VinextPlugin[];
    const mainPlugin = plugins.find(
      (p) => p.name === "vinext:config" && typeof p.config === "function",
    );
    const globalDefinePlugin = plugins.find((p) => p.name === "vinext:client-global-define");

    const tmpDir = await setupTmpProject(
      `export default { compiler: { define: { global: "window" } } };`,
    );
    try {
      await mainPlugin!.config!(
        { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
        { command: "build" },
      );
      expect(globalDefinePlugin!.configEnvironment!("client", {}, { command: "build" })).toBeNull();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("excludes .env.local from NEXT_PUBLIC defines in test mode", async () => {
    const previousFromTest = process.env.NEXT_PUBLIC_FROM_TEST_MODE;
    const previousLocalOnly = process.env.NEXT_PUBLIC_LOCAL_ONLY;
    const previousFallback = process.env.NEXT_PUBLIC_WITH_FALLBACK;
    delete process.env.NEXT_PUBLIC_FROM_TEST_MODE;
    delete process.env.NEXT_PUBLIC_LOCAL_ONLY;
    delete process.env.NEXT_PUBLIC_WITH_FALLBACK;

    const plugins = vinext() as VinextPlugin[];
    const mainPlugin = plugins.find(
      (p) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await setupTmpProject(`export default {};`);
    try {
      await fsp.writeFile(path.join(tmpDir, ".env.local"), "NEXT_PUBLIC_LOCAL_ONLY=from-local\n");
      await fsp.writeFile(
        path.join(tmpDir, ".env.test"),
        "NEXT_PUBLIC_FROM_TEST_MODE=from-test\n" +
          "NEXT_PUBLIC_WITH_FALLBACK=${MISSING_VALUE:-fallback}\n",
      );

      const configResult = (await mainPlugin!.config!(
        { root: tmpDir, build: {}, plugins: [], optimizeDeps: {} },
        { command: "build", mode: "test" },
      )) as { define?: Record<string, string> };

      expect(configResult.define?.["process.env.NEXT_PUBLIC_FROM_TEST_MODE"]).toBe(
        JSON.stringify("from-test"),
      );
      expect(Object.hasOwn(configResult.define ?? {}, "process.env.NEXT_PUBLIC_LOCAL_ONLY")).toBe(
        false,
      );
      expect(configResult.define?.["process.env.NEXT_PUBLIC_WITH_FALLBACK"]).toBe(
        JSON.stringify("fallback"),
      );
      expect(process.env.NEXT_PUBLIC_FROM_TEST_MODE).toBe("from-test");
      expect(process.env.NEXT_PUBLIC_LOCAL_ONLY).toBeUndefined();
      expect(process.env.NEXT_PUBLIC_WITH_FALLBACK).toBe("fallback");
    } finally {
      if (previousFromTest === undefined) {
        delete process.env.NEXT_PUBLIC_FROM_TEST_MODE;
      } else {
        process.env.NEXT_PUBLIC_FROM_TEST_MODE = previousFromTest;
      }
      if (previousLocalOnly === undefined) {
        delete process.env.NEXT_PUBLIC_LOCAL_ONLY;
      } else {
        process.env.NEXT_PUBLIC_LOCAL_ONLY = previousLocalOnly;
      }
      if (previousFallback === undefined) {
        delete process.env.NEXT_PUBLIC_WITH_FALLBACK;
      } else {
        process.env.NEXT_PUBLIC_WITH_FALLBACK = previousFallback;
      }
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("defaults config NODE_ENV to production without overriding caller values", async () => {
    const tmpDir = await setupTmpProject(`export default {};`);
    const vinextEntryUrl = pathToFileURL(
      path.resolve(import.meta.dirname, "../packages/vinext/dist/index.js"),
    ).href;
    const cliPath = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
    const viteConfigNodeEnvLog = path.join(tmpDir, "vite-config-node-env.log");
    const nextConfigNodeEnvLog = path.join(tmpDir, "next-config-node-env.log");

    try {
      await fsp.writeFile(path.join(tmpDir, ".env.test"), "NODE_ENV=test\n");
      await fsp.writeFile(
        path.join(tmpDir, "next.config.mjs"),
        `
          import { appendFileSync } from "node:fs";
          appendFileSync(${JSON.stringify(nextConfigNodeEnvLog)}, \`\${process.env.NODE_ENV}\n\`);
          export default {};
        `,
      );
      await fsp.writeFile(
        path.join(tmpDir, "vite.config.mjs"),
        `
          import { appendFileSync } from "node:fs";
          import vinext from ${JSON.stringify(vinextEntryUrl)};
          export default ({ mode }) => {
            if (mode !== "test") throw new Error(\`vite.config saw mode=\${mode}\`);
            appendFileSync(${JSON.stringify(viteConfigNodeEnvLog)}, \`\${process.env.NODE_ENV}\n\`);
            return { plugins: [vinext()] };
          };
        `,
      );

      const childEnv = { ...process.env };
      Reflect.deleteProperty(childEnv, "NODE_ENV");
      const build = () =>
        execFileSync(process.execPath, [cliPath, "build", "--mode", "test"], {
          cwd: tmpDir,
          env: childEnv,
          stdio: "pipe",
          timeout: 30000,
        });

      expect(build).not.toThrow();
      expect((await fsp.readFile(viteConfigNodeEnvLog, "utf-8")).split("\n")[0]).toBe("production");
      expect((await fsp.readFile(nextConfigNodeEnvLog, "utf-8")).split("\n")[0]).toBe("production");

      await Promise.all([
        fsp.rm(viteConfigNodeEnvLog, { force: true }),
        fsp.rm(nextConfigNodeEnvLog, { force: true }),
      ]);
      childEnv.NODE_ENV = "test";
      expect(build).not.toThrow();
      expect((await fsp.readFile(viteConfigNodeEnvLog, "utf-8")).split("\n")[0]).toBe("test");
      expect((await fsp.readFile(nextConfigNodeEnvLog, "utf-8")).split("\n")[0]).toBe("test");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30000);
});

describe("client `global` define (dev server behavior)", () => {
  let tmpDir: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-global-dev-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");

    // A real node_modules directory (per-package symlinks into the workspace
    // root) so a fixture-local CJS dependency can live next to the real deps
    // and get picked up by the client dep optimizer.
    const nmDir = path.join(tmpDir, "node_modules");
    await fsp.mkdir(nmDir);
    for (const entry of await fsp.readdir(rootNodeModules)) {
      if (entry === ".vite" || entry === ".cache") continue;
      await fsp.symlink(path.join(rootNodeModules, entry), path.join(nmDir, entry), "junction");
    }

    // Dependency that reads `global` — the use-dark-mode failure shape.
    // Browsers have no `global`, so the client pre-bundle must rewrite it to
    // `globalThis` via the dep optimizer define (pre-bundled deps bypass the
    // plugin transform pipeline entirely).
    const depDir = path.join(nmDir, "fake-global-dep");
    await fsp.mkdir(depDir);
    await fsp.writeFile(
      path.join(depDir, "package.json"),
      JSON.stringify({
        name: "fake-global-dep",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }),
    );
    await fsp.writeFile(
      path.join(depDir, "index.js"),
      `export default function readGlobalProbe() {
  if (typeof global === "undefined") return "no-global";
  global.__vinextGlobalProbe = (global.__vinextGlobalProbe || 0) + 1;
  return "global-ok:" + typeof global;
}
`,
    );

    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `import readGlobalProbe from "fake-global-dep";

export default function Home() {
  const pageProbe = typeof global === "undefined" ? "no-global" : typeof global;
  return (
    <div>
      <p id="dep-probe">{readGlobalProbe()}</p>
      <p id="page-probe">{pageProbe}</p>
    </div>
  );
}
`,
    );

    server = await createServer({
      root: tmpDir,
      configFile: false,
      plugins: [vinext() as never],
      server: { port: 0 },
      logLevel: "silent",
    });
    await server.listen();
    const addr = server.httpServer?.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://localhost:${addr.port}`;
    }
  }, 60000);

  afterAll(async () => {
    try {
      (server?.httpServer as { closeAllConnections?: () => void })?.closeAllConnections?.();
      await Promise.race([server?.close(), new Promise((r) => setTimeout(r, 3000))]);
    } catch {}
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("SSR renders the page (server keeps the real Node global)", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("global-ok:object");
  });

  it("injects `global` -> globalThis into the dev client runtime defines", async () => {
    // In dev, Vite applies non-import.meta.env client defines at runtime: the
    // serialized define map is substituted into the client env entry
    // (`__DEFINES__` in /@vite/env) and assigned onto globalThis before user
    // code runs. `"global": globalThis` therefore makes `global` a real
    // browser global — same shape as webpack's `node.global` runtime shim,
    // with `typeof global` === "object" matching Next.js.
    const res = await fetch(`${baseUrl}/@vite/env`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toMatch(/"global":\s*globalThis/);
  });

  it("rewrites `global` in pre-bundled deps for the client", async () => {
    // Trigger dep discovery/pre-bundling, then read the optimizer output.
    await fetch(`${baseUrl}/`);
    const depsDir = path.join(server.config.cacheDir, "deps");
    const readOptimizedDep = async (): Promise<string | null> => {
      let entries: string[];
      try {
        entries = await fsp.readdir(depsDir);
      } catch {
        return null;
      }
      for (const entry of entries) {
        if (!entry.startsWith("fake-global-dep") || !entry.endsWith(".js")) continue;
        const content = await fsp.readFile(path.join(depsDir, entry), "utf8");
        if (content.includes("__vinextGlobalProbe")) return content;
      }
      return null;
    };

    let optimized: string | null = null;
    for (let attempt = 0; attempt < 60 && optimized === null; attempt++) {
      optimized = await readOptimizedDep();
      if (optimized === null) await new Promise((r) => setTimeout(r, 500));
    }
    expect(optimized).not.toBeNull();
    // The free `global` reference must be rewritten so browsers (which have
    // no `global`) don't throw ReferenceError after hydration.
    expect(optimized!).toContain("globalThis.__vinextGlobalProbe");
    expect(optimized!).not.toContain("global.__vinextGlobalProbe");
    expect(optimized!).not.toMatch(/typeof global(?![Tt])/);
  }, 45000);
});
