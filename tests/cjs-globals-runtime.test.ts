import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules",
);
const NITRO_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "../examples/app-router-nitro/node_modules",
);

async function createHybridFixture(
  prefix: string,
  nodeModules: string,
): Promise<{
  root: string;
  canonicalRoot: string;
  cjsPackageDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const cjsPackageDir = path.join(root, "vendor/node_modules/cjs-path-identity");
  await Promise.all([
    fs.mkdir(path.join(root, "app"), { recursive: true }),
    fs.mkdir(path.join(root, "pages"), { recursive: true }),
    fs.mkdir(cjsPackageDir, { recursive: true }),
    fs.symlink(nodeModules, path.join(root, "node_modules"), "junction"),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" })),
    fs.writeFile(
      path.join(root, "app/layout.tsx"),
      `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
    ),
    fs.writeFile(
      path.join(root, "app/page.tsx"),
      `export default function Page() { return "app"; }\n`,
    ),
    fs.writeFile(
      path.join(root, "pages/cjs-dependency-globals.tsx"),
      `import path from "node:path";
import identity from "../vendor/node_modules/cjs-path-identity/index.js";
const projectRuntimePath = path.join(__dirname, "project-runtime.js");
export function getServerSideProps() {
  return { props: { runtimePath: identity.path, projectRuntimePath } };
}
export default function Page(props: { runtimePath: string; projectRuntimePath: string }) {
  return <><p id="runtime-path">{props.runtimePath}</p><p id="project-runtime-path">{props.projectRuntimePath}</p></>;
}
`,
    ),
    fs.writeFile(
      path.join(cjsPackageDir, "package.json"),
      JSON.stringify({ name: "cjs-path-identity", type: "commonjs", main: "index.js" }),
    ),
    fs.writeFile(
      path.join(cjsPackageDir, "index.js"),
      `exports.path = require("node:path").join(__dirname, "runtime.js");\n`,
    ),
  ]);
  const canonicalRoot = await fs.realpath(root);
  return {
    root,
    canonicalRoot,
    cjsPackageDir: path.join(canonicalRoot, "vendor/node_modules/cjs-path-identity"),
  };
}

async function readJavaScriptTree(root: string): Promise<string> {
  const files = await fs.readdir(root, { recursive: true });
  return (
    await Promise.all(
      files
        .filter((file) => /\.[cm]?js$/.test(file))
        .map((file) => fs.readFile(path.join(root, file), "utf8")),
    )
  ).join("\n");
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

async function waitForHttp(url: string): Promise<Response> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function stopChildProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const stoppedGracefully = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!stoppedGracefully) {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
  }
}

describe("bundled CJS globals on the Cloudflare Workers runtime", () => {
  let root = "";
  let canonicalRoot = "";
  let cjsPackageDir = "";
  let worker: { url: Promise<URL>; dispose(): Promise<void> } | undefined;
  let baseUrl = "";
  let workerBundle = "";

  beforeAll(async () => {
    ({ root, canonicalRoot, cjsPackageDir } = await createHybridFixture(
      "vinext-cjs-globals-worker-",
      CLOUDFLARE_NODE_MODULES,
    ));
    await fs.writeFile(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        name: "vinext-cjs-globals-worker",
        compatibility_date: "2026-04-01",
        compatibility_flags: ["nodejs_compat"],
        main: "vinext/server/fetch-handler",
        assets: { not_found_handling: "none", binding: "ASSETS" },
      }),
    );
    const cloudflareModule = (await import(
      pathToFileURL(path.join(root, "node_modules/@cloudflare/vite-plugin/dist/index.mjs")).href
    )) as {
      cloudflare(options: {
        viteEnvironment: { name: string; childEnvironments: string[] };
      }): Plugin;
    };
    const cloudflare = (...args: Parameters<typeof cloudflareModule.cloudflare>) =>
      cloudflareModule.cloudflare(...args);
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();
    workerBundle = await readJavaScriptTree(path.join(root, "dist/server"));

    const wrangler = (await import(
      pathToFileURL(path.join(root, "node_modules/wrangler/wrangler-dist/cli.js")).href
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
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("uses Next Edge-compatible logical identity without leaking host paths", async () => {
    const res = await fetch(`${baseUrl}/cjs-dependency-globals`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<p id="runtime-path">/runtime.js</p>');
    expect(html).toContain('<p id="project-runtime-path">/project-runtime.js</p>');
    expect(workerBundle).not.toContain(cjsPackageDir);
    expect(html).not.toContain(canonicalRoot);
  });
});

describe("bundled CJS globals on the Nitro Node runtime", () => {
  let root = "";
  let canonicalRoot = "";
  let cjsPackageDir = "";
  let serverProcess: ChildProcess | undefined;
  let baseUrl = "";
  let nitroBundle = "";

  beforeAll(async () => {
    ({ root, canonicalRoot, cjsPackageDir } = await createHybridFixture(
      "vinext-cjs-globals-nitro-",
      NITRO_NODE_MODULES,
    ));
    const nitroModule = (await import(
      pathToFileURL(path.join(root, "node_modules/nitro/dist/vite.mjs")).href
    )) as { nitro(): Plugin[] };
    const nitro = () => nitroModule.nitro();
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root }), nitro()],
      logLevel: "silent",
    });
    await builder.buildApp();

    const serverDir = path.join(root, ".output/server");
    nitroBundle = await readJavaScriptTree(serverDir);
    const port = await getAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProcess = spawn(process.execPath, [path.join(serverDir, "index.mjs")], {
      cwd: root,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: "ignore",
    });
    await waitForHttp(`${baseUrl}/`);
  }, 180_000);

  afterAll(async () => {
    await stopChildProcess(serverProcess);
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps chunk-relative identity through Nitro's final bundle", async () => {
    const res = await fetch(`${baseUrl}/cjs-dependency-globals`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<p id="runtime-path">.*\.output\/server\/(?:_ssr\/)?runtime\.js<\/p>/);
    expect(html).toContain(
      `<p id="project-runtime-path">${path.join(canonicalRoot, "pages/project-runtime.js")}</p>`,
    );
    expect(nitroBundle).not.toContain(cjsPackageDir);
  });
});
