import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

describe("production listener startup", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  function createBuild(router: "app" | "pages") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-listener-startup-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "client"));
    fs.mkdirSync(path.join(root, "server"));
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(
      path.join(root, "server", router === "app" ? "index.js" : "entry.js"),
      router === "app"
        ? 'export default async () => new Response("ok");'
        : 'export async function renderPage() { return new Response("ok"); }',
    );
    return root;
  }
  for (const router of ["app", "pages"] as const) {
    it(`${router} rejects an occupied port with the original listen error`, async () => {
      const blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = blocker.address();
        if (!address || typeof address === "string") throw new Error("Missing TCP address");
        await expect(
          startProdServer({
            outDir: createBuild(router),
            port: address.port,
            host: "127.0.0.1",
            silent: true,
          }),
        ).rejects.toMatchObject({ code: "EADDRINUSE", port: address.port });
      } finally {
        await new Promise<void>((resolve, reject) =>
          blocker.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
    it(`${router} removes the temporary error listener after successful startup`, async () => {
      const { server, port } = await startProdServer({
        outDir: createBuild(router),
        port: 0,
        host: "127.0.0.1",
        silent: true,
      });
      try {
        expect(port).toBeGreaterThan(0);
        expect(server.listening).toBe(true);
        expect(server.listenerCount("error")).toBe(0);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }
});
