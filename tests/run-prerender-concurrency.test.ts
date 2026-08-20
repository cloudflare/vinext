import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  prerenderAppMock,
  prerenderPagesMock,
  writePrerenderIndexMock,
  startProdServerMock,
  appRouterMock,
  pagesRouterMock,
  apiRouterMock,
} = vi.hoisted(() => ({
  prerenderAppMock: vi.fn(async () => ({ routes: [] })),
  prerenderPagesMock: vi.fn(async () => ({ routes: [] })),
  writePrerenderIndexMock: vi.fn(),
  startProdServerMock: vi.fn(async () => ({
    server: { close: (callback: () => void) => callback() },
    port: 3000,
  })),
  appRouterMock: vi.fn(async () => []),
  pagesRouterMock: vi.fn(async () => []),
  apiRouterMock: vi.fn(async () => []),
}));

vi.mock("../packages/vinext/src/build/prerender.js", () => ({
  prerenderApp: prerenderAppMock,
  prerenderPages: prerenderPagesMock,
  writePrerenderIndex: writePrerenderIndexMock,
  readPrerenderSecret: () => "secret",
}));

vi.mock("../packages/vinext/src/server/prod-server.js", () => ({
  startProdServer: startProdServerMock,
}));

vi.mock("../packages/vinext/src/routing/app-router.js", () => ({
  appRouter: appRouterMock,
}));

vi.mock("../packages/vinext/src/routing/pages-router.js", () => ({
  pagesRouter: pagesRouterMock,
  apiRouter: apiRouterMock,
}));

describe("runPrerender concurrency", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes configured concurrency to both app and pages prerender phases", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-run-prerender-concurrency-"));
    fs.mkdirSync(path.join(root, "app"));
    fs.mkdirSync(path.join(root, "pages"));

    try {
      const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");

      await runPrerender({
        root,
        concurrency: 4,
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
      });

      expect(prerenderAppMock).toHaveBeenCalledWith(expect.objectContaining({ concurrency: 4 }));
      expect(prerenderPagesMock).toHaveBeenCalledWith(expect.objectContaining({ concurrency: 4 }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads functional next config with the production-build phase", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-run-prerender-config-phase-"));
    fs.mkdirSync(path.join(root, "app"));
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      `export default (phase) => ({ env: { OBSERVED_CONFIG_PHASE: phase } });\n`,
    );

    try {
      const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");

      await runPrerender({
        root,
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
      });

      expect(prerenderAppMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            env: expect.objectContaining({
              OBSERVED_CONFIG_PHASE: "phase-production-build",
            }),
          }),
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
