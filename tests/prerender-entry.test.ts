import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const startProdServer = vi.hoisted(() =>
  vi.fn(async () => ({
    port: 43210,
    server: { close: (callback: () => void) => callback() },
  })),
);

vi.mock("../packages/vinext/src/server/prod-server.js", () => ({ startProdServer }));

describe("App prerender entry", () => {
  let root: string | undefined;

  afterEach(() => {
    startProdServer.mockClear();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts its owned server with the resolved application entry", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prerender-entry-"));
    const serverDir = path.join(root, "dist", "server");
    const rscBundlePath = path.join(serverDir, "application-entry.js");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "test-prerender-secret" }),
    );
    fs.writeFileSync(rscBundlePath, "export default {};");

    const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    await prerenderApp({
      config: await resolveNextConfig(null, root),
      metadataRoutes: [],
      mode: "default",
      outDir: path.join(serverDir, "prerendered-routes"),
      routes: [],
      rscBundlePath,
    });

    expect(startProdServer).toHaveBeenCalledWith(
      expect.objectContaining({ rscEntryPath: rscBundlePath }),
    );
  });
});
