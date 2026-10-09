import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const NITRO_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "../examples/app-router-nitro/node_modules",
);

async function writeFile(file: string, source: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, source, "utf8");
}

async function writeInlineCssFixture(fixtureRoot: string, nodeModules: string): Promise<void> {
  await fsp.symlink(nodeModules, path.join(fixtureRoot, "node_modules"), "junction");
  await writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await writeFile(
    path.join(fixtureRoot, "app", "global.css"),
    ".inline-css-build-marker { color: rgb(1, 2, 3); }\n",
  );
  await writeFile(
    path.join(fixtureRoot, "app", "layout.tsx"),
    `import "./global.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  await writeFile(
    path.join(fixtureRoot, "app", "page.tsx"),
    `export default function Page() {
  return <p className="inline-css-build-marker">home</p>;
}
`,
  );
}

async function findRscEntry(rscOutDir: string): Promise<string> {
  const entries = await fsp.readdir(rscOutDir);
  const entry = entries.find((file) => /^index\.m?js$/.test(file));
  if (!entry) {
    throw new Error(`No RSC entry found in ${rscOutDir}. Contents: ${entries.join(", ")}`);
  }
  return path.join(rscOutDir, entry);
}

async function getAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function fetchFromNitroServer(root: string, pathname: string): Promise<string> {
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(root, ".output/server/index.mjs")], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}${pathname}`);
        return await response.text();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`Timed out waiting for ${baseUrl}`);
  } finally {
    server.kill("SIGTERM");
  }
}

describe("inline CSS production build", () => {
  it("injects the inline CSS manifest into a custom App Router RSC output directory", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-inline-css-build-"));
    const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-inline-css-build-out-"));
    try {
      await writeInlineCssFixture(fixtureRoot, ROOT_NODE_MODULES);

      const rscOutDir = path.join(outRoot, "custom-rsc");
      const ssrOutDir = path.join(outRoot, "custom-ssr");
      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        plugins: [
          vinext({
            appDir: fixtureRoot,
            rscOutDir,
            ssrOutDir,
            nextConfig: {
              experimental: {
                inlineCss: true,
              },
            },
          }),
        ],
        logLevel: "silent",
      });

      await builder.buildApp();

      const rscEntry = await findRscEntry(rscOutDir);
      const code = await fsp.readFile(rscEntry, "utf8");

      expect(code).toContain("globalThis.__VINEXT_INLINE_CSS__");
      expect(code).toContain("_next/static");
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(outRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);

  // Nitro moves the client output to .output/public and the RSC entry under
  // its build directory, so nothing is written to dist/client or dist/server.
  it("inlines App Router stylesheets in a Nitro server build", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-inline-css-nitro-"));
    try {
      await writeInlineCssFixture(fixtureRoot, NITRO_NODE_MODULES);
      await writeFile(
        path.join(fixtureRoot, "next.config.mjs"),
        "export default { experimental: { inlineCss: true } };\n",
      );

      const nitroModule = (await import(
        pathToFileURL(path.join(NITRO_NODE_MODULES, "nitro/dist/vite.mjs")).href
      )) as { nitro(config?: Record<string, unknown>): Plugin[] };
      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        logLevel: "silent",
        plugins: [
          vinext({ appDir: fixtureRoot }),
          nitroModule.nitro({ buildDir: path.join(fixtureRoot, ".nitro") }),
        ],
      });
      await builder.buildApp();

      const html = await fetchFromNitroServer(fixtureRoot, "/");
      expect(html).toContain("inline-css-build-marker");
      expect(html).toMatch(/<style[^>]*>[^<]*\.inline-css-build-marker/);
      expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
});
