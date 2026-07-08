import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";
import {
  APP_FIXTURE_DIR,
  buildAppFixture,
  buildPagesFixture,
  fetchHtml,
  PAGES_FIXTURE_DIR,
} from "./helpers.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

function unwrapStartedProdServer(result: Server | { server: Server }): Server {
  return "server" in result ? result.server : result;
}

async function withProdServer(outDir: string, test: (baseUrl: string) => Promise<void>) {
  const prodServer = unwrapStartedProdServer(
    await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
      noCompression: true,
    }),
  );

  try {
    const addr = prodServer.address();
    if (!addr || typeof addr === "string") throw new Error("Production server did not bind");
    await test(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => prodServer.close(() => resolve()));
  }
}

describe("Node render runtime", () => {
  it("renders a generated production App route through the Node runtime", async () => {
    const rscEntryPath = await buildAppFixture(APP_FIXTURE_DIR);
    const outDir = path.dirname(path.dirname(rscEntryPath));

    try {
      await expect(fs.access(path.join(outDir, "server", "index.js"))).resolves.toBeUndefined();

      const ssrEntry = await fs.readFile(path.join(outDir, "server", "ssr", "index.js"), "utf-8");
      expect(ssrEntry).toContain("react-dom/server.node");
      expect(ssrEntry).not.toContain("react-dom/server.edge");
      expect(ssrEntry).not.toContain("app-ssr-entry.web");

      await withProdServer(outDir, async (baseUrl) => {
        const { res, html } = await fetchHtml(baseUrl, "/?message=node-fizz");
        expect(res.status, html).toBe(200);
        expect(html).toContain("Welcome to App Router");
      });
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("renders a generated production Pages route through the Node runtime", async () => {
    const serverEntryPath = await buildPagesFixture(PAGES_FIXTURE_DIR);
    const outDir = path.dirname(path.dirname(serverEntryPath));

    try {
      await fs.symlink(ROOT_NODE_MODULES, path.join(outDir, "node_modules"), "junction");

      const serverEntry = await fs.readFile(serverEntryPath, "utf-8");
      expect(serverEntry).toContain("react-dom/server.node");
      expect(serverEntry).not.toContain("pages-render-runtime.web");

      await withProdServer(outDir, async (baseUrl) => {
        const { res, html } = await fetchHtml(baseUrl, "/?message=node-fizz");
        expect(res.status, html).toBe(200);
        expect(html).toContain("Hello, vinext!");
      });
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
