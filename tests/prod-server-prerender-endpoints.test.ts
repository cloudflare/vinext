import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { VINEXT_PRERENDER_SECRET_HEADER } from "../packages/vinext/src/server/headers.js";

describe("Pages production prerender endpoints", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects incompatible page exports before a missing getStaticPaths returns null", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-prerender-endpoint-"));
    roots.push(root);
    const serverDir = path.join(root, "dist", "server");
    fs.mkdirSync(path.join(root, "dist", "client"), { recursive: true });
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, "entry.js"),
      [
        "export const vinextConfig = {};",
        "export const pageRoutes = [{",
        "  pattern: '/posts/:id',",
        "  module: {",
        "    default: Object.assign(function Page() {}, { getInitialProps: async () => ({}) }),",
        "    getStaticProps: async () => ({ props: {} }),",
        "  },",
        "}];",
        "export async function renderPage() { return new Response('ok'); }",
        "export async function handleApiRoute() { return new Response('api'); }",
        "export async function runMiddleware() { return null; }",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(serverDir, "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "test-prerender-secret" }),
    );

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server, port } = await startProdServer({
      host: "127.0.0.1",
      noCompression: true,
      outDir: path.join(root, "dist"),
      port: 0,
      silent: true,
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/__vinext/prerender/pages-static-paths?pattern=/posts/:id`,
        { headers: { [VINEXT_PRERENDER_SECRET_HEADER]: "test-prerender-secret" } },
      );

      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toContain(
        "You can not use getInitialProps with getStaticProps",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
