import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const NITRO_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "../examples/app-router-nitro/node_modules",
);

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

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
}

// Ported from Next.js:
//   - test/e2e/custom-routes-catchall/custom-routes-catchall.test.ts
//   - test/e2e/i18n-ignore-rewrite-source-locale/rewrites.test.ts
// https://github.com/vercel/next.js/tree/canary/test/e2e/custom-routes-catchall
describe("App Router on Nitro: public files reached through a rewrite", () => {
  let root = "";
  let server: ChildProcess | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-app-nitro-public-rewrite-"));
    await Promise.all([
      fs.mkdir(path.join(root, "app"), { recursive: true }),
      fs.mkdir(path.join(root, "public/nested"), { recursive: true }),
      fs.symlink(NITRO_NODE_MODULES, path.join(root, "node_modules"), "junction"),
    ]);
    await Promise.all([
      fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" })),
      fs.writeFile(
        path.join(root, "next.config.mjs"),
        `export default {
  async rewrites() {
    return {
      beforeFiles: [{ source: "/before/:path*", destination: "/:path*" }],
    };
  },
};
`,
      ),
      fs.writeFile(
        path.join(root, "app/layout.tsx"),
        `export default function Root({ children }) {
  return <html><body>{children}</body></html>;
}
`,
      ),
      fs.writeFile(
        path.join(root, "app/page.tsx"),
        `export default function Page() { return <p>hello world</p>; }\n`,
      ),
      fs.writeFile(
        path.join(root, "middleware.ts"),
        `import { NextResponse } from "next/server";
export function middleware(request) {
  if (request.nextUrl.pathname === "/middleware-rewrite") {
    return NextResponse.rewrite(new URL("/nested/file.txt", request.url));
  }
  const response = NextResponse.next();
  response.headers.set("x-nitro-middleware", request.nextUrl.pathname);
  return response;
}
`,
      ),
      fs.writeFile(path.join(root, "public/file.txt"), "public file"),
      fs.writeFile(path.join(root, "public/nested/file.txt"), "nested public file"),
    ]);

    const nitroModule = (await import(
      pathToFileURL(path.join(NITRO_NODE_MODULES, "nitro/dist/vite.mjs")).href
    )) as { nitro(config?: Record<string, unknown>): Plugin[] };
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext({ appDir: root }),
        nitroModule.nitro({ buildDir: path.join(root, ".nitro") }),
      ],
    });
    await builder.buildApp();

    const port = await getAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [path.join(root, ".output/server/index.mjs")], {
      cwd: root,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: "ignore",
    });
    await waitForServer(baseUrl);
  }, 180_000);

  afterAll(async () => {
    await stopServer(server);
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("serves a public file reached through a beforeFiles rewrite", async () => {
    const response = await fetch(`${baseUrl}/before/file.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-nitro-middleware")).toBe("/before/file.txt");
    expect(await response.text()).toBe("public file");
  });

  it("serves a public file reached through a middleware rewrite", async () => {
    const response = await fetch(`${baseUrl}/middleware-rewrite`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("nested public file");
  });

  it("keeps the 404 for a rewrite to a missing public file", async () => {
    const response = await fetch(`${baseUrl}/before/missing.txt`);
    expect(response.status).toBe(404);
  });

  it("still renders pages", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hello world");
  });
});
