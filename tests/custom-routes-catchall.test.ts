/**
 * Ported from Next.js: test/e2e/custom-routes-catchall/custom-routes-catchall.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/custom-routes-catchall/custom-routes-catchall.test.ts
 *
 * A `/docs/:path*` -> `/:path*` rewrite reaches pages, public files and the
 * client build manifest. The manifest lists the app's Pages routes in
 * `sortedPages`, as Next.js does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

const FILES: Record<string, string> = {
  "next.config.mjs": `export default {
  async rewrites() {
    return [{ source: "/docs/:path*", destination: "/:path*" }];
  },
};
`,
  "pages/hello.js": "export default function Hello() {\n  return <p>hello world</p>;\n}\n",
  "pages/posts/[id].js": "export default function Post() {\n  return <p>post</p>;\n}\n",
  "pages/api/ping.js": "export default function handler(req, res) {\n  res.end('pong');\n}\n",
  "public/another.txt": "some text\n",
  "public/static/data.json": '{ "hello": "some data..." }\n',
};

describe("custom-routes-catchall", () => {
  let tmpDir: string;
  let baseUrl: string;
  let buildId: string;
  let close: () => void;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-custom-routes-catchall-"));
    const root = path.join(tmpDir, "fixture");
    for (const [file, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    fs.symlinkSync(ROOT_NODE_MODULES, path.join(root, "node_modules"), "junction");

    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const outDir = path.join(root, "dist");
    buildId = fs.readFileSync(path.join(outDir, "server", "BUILD_ID"), "utf-8").trim();
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({ port: 0, outDir, noCompression: true });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;
    close = () => server.close();
  }, 180_000);

  afterAll(() => {
    close?.();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should rewrite and render page correctly", async () => {
    const res = await fetch(`${baseUrl}/docs/hello`);
    expect(await res.text()).toMatch(/hello world/);
  });

  it("should rewrite to /_next/static correctly", async () => {
    const res = await fetch(`${baseUrl}/docs/_next/static/${buildId}/_buildManifest.js`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("/hello");

    const manifest = JSON.parse(
      body.slice("self.__BUILD_MANIFEST = ".length, body.indexOf(";self.__BUILD_MANIFEST_CB")),
    ) as { sortedPages: string[] };
    expect(manifest.sortedPages).toEqual([
      "/_app",
      "/_error",
      "/api/ping",
      "/hello",
      "/posts/[id]",
    ]);
  });

  it("should rewrite to public/static correctly", async () => {
    const res = await fetch(`${baseUrl}/docs/static/data.json`);
    expect(await res.text()).toContain("some data...");
  });

  it("should rewrite to public file correctly", async () => {
    const res = await fetch(`${baseUrl}/docs/another.txt`);
    expect(await res.text()).toContain("some text");
  });
});
