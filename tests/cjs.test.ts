import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, PAGES_FIXTURE_DIR, startFixtureServer, fetchHtml } from "./helpers.js";
import vinext from "../packages/vinext/src/index.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function linkNodeModule(rootNodeModules: string, nmDir: string, pkg: string): Promise<void> {
  const dest = path.join(nmDir, pkg);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.symlink(path.join(rootNodeModules, pkg), dest, "junction").catch((err) => {
    if (err.code !== "EEXIST") throw err;
  });
}

describe("CJS interop (App Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders page that uses CJS require() and module.exports", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/basic");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-basic");
    // React SSR may insert comment nodes between text and expressions
    // (e.g. "Random: <!-- -->4"), so use a regex.
    expect(html).toMatch(/Random:.*4/);
  });

  it("renders page that uses CJS require('server-only')", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/server-only");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-server-only");
    expect(html).toContain("This page uses CJS require");
  });
});

describe("CJS interop (Pages Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(PAGES_FIXTURE_DIR));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders page that uses CJS require() and module.exports", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/basic");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-basic");
    // Pages Router SSR inserts React comment nodes between text and
    // expressions (e.g. "Random: <!-- -->4"), so use a regex.
    expect(html).toMatch(/Random:.*4/);
  });
});

describe("CJS interop (Pages Router node_modules)", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-cjs-node-modules-"));

    const nmDir = path.join(tmpDir, "node_modules");
    await fs.mkdir(nmDir, { recursive: true });

    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    for (const pkg of ["react", "react-dom", "vite", "vite-plus", "vinext"]) {
      await linkNodeModule(rootNodeModules, nmDir, pkg);
    }

    const cjsDir = path.join(nmDir, "cjs-node-package");
    await fs.mkdir(cjsDir, { recursive: true });
    await fs.writeFile(
      path.join(cjsDir, "package.json"),
      JSON.stringify({ name: "cjs-node-package", version: "1.0.0", main: "index.js" }),
    );
    await fs.writeFile(
      path.join(cjsDir, "index.js"),
      `const core = require("./core.js");
module.exports = { value: core.value };`,
    );
    await fs.writeFile(
      path.join(cjsDir, "core.js"),
      `module.exports = { value: "from-cjs-package" };`,
    );

    await fs.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `import dep from "cjs-node-package";

export default function Page() {
  return <div id="cjs-node-modules">{dep.value}</div>;
}`,
    );

    server = await createServer({
      root: tmpDir,
      configFile: false,
      plugins: [vinext({ appDir: tmpDir })],
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { port: 0, cors: false },
      logLevel: "silent",
    });

    await server.listen();
    const addr = server.httpServer?.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://localhost:${addr.port}`;
    }
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("renders a page that imports a CommonJS package from node_modules", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-node-modules");
    expect(html).toContain("from-cjs-package");
  });
});
