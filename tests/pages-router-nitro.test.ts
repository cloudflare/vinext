import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http, { type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
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

describe("Pages Router on Nitro", () => {
  let root = "";
  let workerdRoot = "";
  let workerdServiceEntry = "";
  let server: ChildProcess | undefined;
  let upstream: Server | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    const upstreamBody = gzipSync("decoded by the Nitro host");
    upstream = http.createServer((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(upstreamBody.byteLength),
        "content-type": "text/plain",
      });
      response.end(upstreamBody);
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.once("error", reject);
      upstream!.listen(0, "127.0.0.1", resolve);
    });
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Nitro test upstream did not bind a TCP port");
    }

    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-nitro-"));
    await Promise.all([
      fs.mkdir(path.join(root, "pages/post"), { recursive: true }),
      fs.mkdir(path.join(root, "pages/api/echo"), { recursive: true }),
      fs.mkdir(path.join(root, "pages/api/proxy"), { recursive: true }),
      fs.mkdir(path.join(root, "public"), { recursive: true }),
      fs.symlink(NITRO_NODE_MODULES, path.join(root, "node_modules"), "junction"),
    ]);
    await Promise.all([
      fs.writeFile(path.join(root, "package.json"), "{}"),
      fs.writeFile(
        path.join(root, "pages/post/[slug].tsx"),
        `export function getServerSideProps({ params }) {
  return { props: { slug: params.slug } };
}
export default function Post({ slug }) { return <main>post:{slug}</main>; }
`,
      ),
      fs.writeFile(
        path.join(root, "pages/api/echo/[slug].ts"),
        `export default function handler(req, res) {
  res.status(200).json({ method: req.method, slug: req.query.slug });
}
`,
      ),
      fs.writeFile(
        path.join(root, "pages/api/proxy/index.ts"),
        `export const config = { runtime: "edge" };
export default function handler() {
  return fetch("http://127.0.0.1:${upstreamAddress.port}");
}
`,
      ),
      fs.writeFile(
        path.join(root, "pages/500.tsx"),
        `export default function Error500() { return <main>custom 500</main>; }\n`,
      ),
      fs.writeFile(
        path.join(root, "pages/error.tsx"),
        `export function getServerSideProps() { throw new Error("boom"); }
export default function ErrorPage() { return null; }
`,
      ),
      fs.writeFile(
        path.join(root, "proxy.ts"),
        `import { NextResponse } from "next/server";
export function proxy(request) {
  const response = NextResponse.next();
  response.headers.set("x-nitro-middleware", new URL(request.url).pathname);
  return response;
}
`,
      ),
      fs.writeFile(path.join(root, "public/asset.txt"), "nitro public asset"),
    ]);

    const nitroModule = (await import(
      pathToFileURL(path.join(root, "node_modules/nitro/dist/vite.mjs")).href
    )) as { nitro(config?: Record<string, unknown>): Plugin[] };
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext(), nitroModule.nitro({ buildDir: path.join(root, ".nitro") })],
    });
    await builder.buildApp();

    workerdRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-nitro-workerd-"));
    await Promise.all([
      fs.mkdir(path.join(workerdRoot, "pages/api"), { recursive: true }),
      fs.symlink(NITRO_NODE_MODULES, path.join(workerdRoot, "node_modules"), "junction"),
    ]);
    const encodedBody = gzipSync("encoded by workerd");
    await Promise.all([
      fs.writeFile(path.join(workerdRoot, "package.json"), "{}"),
      fs.writeFile(
        path.join(workerdRoot, "pages/api/encoded.ts"),
        `export const config = { runtime: "edge" };
export default function handler() {
  const body = Uint8Array.from(${JSON.stringify([...encodedBody])});
  return new Response(body, { headers: {
    "content-encoding": "gzip",
    "content-length": String(body.byteLength),
  } });
}
`,
      ),
    ]);
    const workerdBuildDir = path.join(workerdRoot, ".nitro");
    const workerdBuilder = await createBuilder({
      root: workerdRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext(),
        nitroModule.nitro({
          buildDir: workerdBuildDir,
          output: { dir: path.join(workerdRoot, ".output") },
          preset: "cloudflare_module",
        }),
      ],
    });
    await workerdBuilder.buildApp();
    workerdServiceEntry = await fs.readFile(
      path.join(workerdBuildDir, "vite/services/ssr/entry.js"),
      "utf8",
    );

    const port = await getAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [path.join(root, ".output/server/index.mjs")], {
      cwd: root,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: "ignore",
    });
    await waitForServer(`${baseUrl}/post/ready`);
  }, 180_000);

  afterAll(async () => {
    await stopServer(server);
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        upstream!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (root) await fs.rm(root, { recursive: true, force: true });
    if (workerdRoot) await fs.rm(workerdRoot, { recursive: true, force: true });
  });

  // Ported from Next.js: test/e2e/getserversideprops/test/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/getserversideprops/test/index.test.ts
  it("serves dynamic SSR pages through Nitro's WinterCG service", async () => {
    const response = await fetch(`${baseUrl}/post/hello`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-nitro-middleware")).toBe("/post/hello");
    const html = await response.text();
    expect(html).toContain("hello</main>");
    const clientChunk = html.match(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/)?.[1];
    expect(clientChunk).toBeDefined();
    expect((await fetch(`${baseUrl}${clientChunk}`)).status).toBe(200);
  });

  // Ported from Next.js: test/e2e/api-support/api-support.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/api-support/api-support.test.ts
  it("serves dynamic API routes", async () => {
    const response = await fetch(`${baseUrl}/api/echo/hello`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: "POST", slug: "hello" });
  });

  it("uses Node response semantics for edge API fetch output", async () => {
    const response = await fetch(`${baseUrl}/api/proxy`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toBe("decoded by the Nitro host");
  });

  it("uses Worker response semantics for Nitro's Cloudflare preset", () => {
    expect(workerdServiceEntry).toContain('hostRuntime: "worker"');
  });

  // Ported from Next.js: test/e2e/500-page/500-page.test.ts and test/e2e/file-serving.
  // https://github.com/vercel/next.js/blob/canary/test/e2e/500-page/500-page.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/file-serving/file-serving.test.ts
  it("preserves Pages errors and Nitro-owned public assets", async () => {
    const [errorResponse, assetResponse] = await Promise.all([
      fetch(`${baseUrl}/error`),
      fetch(`${baseUrl}/asset.txt`),
    ]);
    expect(errorResponse.status).toBe(500);
    expect(await errorResponse.text()).toContain("custom 500");
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toBe("nitro public asset");
  });
});
