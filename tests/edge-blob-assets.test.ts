import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import vinext from "../packages/vinext/src/index.js";

// Ported from Next.js:
// test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
describe("Pages edge API blob assets in production", () => {
  let tmpRoot: string;
  let outDir: string;
  let server: import("node:http").Server;
  let baseUrl: string;
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-edge-blob-assets-"));
    outDir = path.join(tmpRoot, "dist");
    await fsp.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(tmpRoot, "node_modules"),
      "junction",
    );
    await fsp.mkdir(path.join(tmpRoot, "pages", "api"), { recursive: true });
    await fsp.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, "package.json"), JSON.stringify({ type: "module" }));
    await fsp.writeFile(path.join(tmpRoot, "src", "text-file.txt"), "Hello, from text-file.txt!");
    await fsp.writeFile(path.join(tmpRoot, "src", "vercel.png"), image);
    await fsp.writeFile(
      path.join(tmpRoot, "pages", "api", "edge.js"),
      `export const config = { runtime: "edge" };

export default async function handler(request) {
  const name = new URL(request.url).searchParams.get("handler");
  if (name === "text-file") {
    const url = new URL("../../src/text-file.txt", import.meta.url);
    return fetch(url);
  }
  if (name === "image-file") {
    const url = new URL("../../src/vercel.png", import.meta.url);
    return fetch(url);
  }
  return new Response("Invalid handler", { status: 400 });
}
`,
    );

    await build({
      root: tmpRoot,
      configFile: false,
      plugins: [vinext({ disableAppRouter: true })],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "server"),
        ssr: "virtual:vinext-server-entry",
        rolldownOptions: { output: { entryFileNames: "entry.js" } },
      },
    });

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const started = await startProdServer({ port: 0, host: "127.0.0.1", outDir });
    server = "server" in started ? started.server : started;
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("fetches a relative text asset", async () => {
    const response = await fetch(`${baseUrl}/api/edge?handler=text-file`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello, from text-file.txt!");
  });

  it("fetches a relative image asset byte-for-byte", async () => {
    const response = await fetch(`${baseUrl}/api/edge?handler=image-file`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(image)).toBe(true);
  });
});
