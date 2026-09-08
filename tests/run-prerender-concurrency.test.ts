import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrerenderResult } from "../packages/vinext/src/build/prerender.js";

const {
  prerenderAppMock,
  prerenderPagesMock,
  writePrerenderIndexMock,
  startProdServerMock,
  appRouterMock,
  pagesRouterMock,
  apiRouterMock,
} = vi.hoisted(() => ({
  prerenderAppMock: vi.fn<() => Promise<PrerenderResult>>(async () => ({ routes: [] })),
  prerenderPagesMock: vi.fn<() => Promise<PrerenderResult>>(async () => ({ routes: [] })),
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
  rememberCurrentServerEntryImportMtime: vi.fn(),
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

  it("starts the prerender server with the generated App entry from the build manifest", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-run-prerender-entry-"));
    fs.mkdirSync(path.join(root, "app"));
    fs.mkdirSync(path.join(root, "dist", "server", ".vite"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "server", "BUILD_ID"), "canonical-build\n");
    fs.writeFileSync(path.join(root, "dist", "server", "index.js"), 'import "host:runtime";\n');
    fs.mkdirSync(path.join(root, "dist", "server", "entries"));
    fs.writeFileSync(
      path.join(root, "dist", "server", "entries", "application-entry.js"),
      "export {};\n",
    );
    fs.writeFileSync(
      path.join(root, "dist", "server", "entries", "BUILD_ID"),
      "wrong-nested-build\n",
    );
    fs.writeFileSync(
      path.join(root, "dist", "server", ".vite", "manifest.json"),
      JSON.stringify({
        "virtual:vinext-rsc-entry": {
          file: "entries/application-entry.js",
          isDynamicEntry: true,
        },
      }),
    );

    try {
      const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");

      await runPrerender({ root });

      expect(prerenderAppMock).toHaveBeenCalledWith(
        expect.objectContaining({
          rscBundlePath: path.join(root, "dist", "server", "entries", "application-entry.js"),
          serverDir: path.join(root, "dist", "server"),
          config: expect.objectContaining({ buildId: "canonical-build" }),
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves App artifacts from the configured RSC output root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-run-prerender-custom-rsc-"));
    const serverDir = path.join(root, "build", "application");
    const applicationEntry = path.join(serverDir, "entries", "application-entry.js");
    fs.mkdirSync(path.join(root, "app"));
    fs.mkdirSync(path.join(serverDir, ".vite"), { recursive: true });
    fs.mkdirSync(path.dirname(applicationEntry), { recursive: true });
    fs.writeFileSync(path.join(serverDir, "BUILD_ID"), "custom-build\n");
    fs.writeFileSync(applicationEntry, "export {};\n");
    fs.writeFileSync(
      path.join(serverDir, ".vite", "manifest.json"),
      JSON.stringify({
        "virtual:vinext-rsc-entry": {
          file: "entries/application-entry.js",
          isDynamicEntry: true,
        },
      }),
    );

    try {
      const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");

      await runPrerender({
        root,
        routeRootConfig: { rscOutDir: "build/application" },
      });

      expect(prerenderAppMock).toHaveBeenCalledWith(
        expect.objectContaining({
          rscBundlePath: applicationEntry,
          serverDir,
          buildOutDir: path.join(root, "dist"),
          outDir: path.join(root, "dist", "server", "prerendered-routes"),
          config: expect.objectContaining({ buildId: "custom-build" }),
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps custom RSC builds on the canonical export and manifest roots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-run-prerender-roots-"));
    const serverDir = path.join(root, "build", "application");
    const applicationEntry = path.join(serverDir, "entries", "application-entry.js");
    fs.mkdirSync(path.join(root, "app"));
    fs.mkdirSync(path.join(serverDir, ".vite"), { recursive: true });
    fs.mkdirSync(path.dirname(applicationEntry), { recursive: true });
    fs.writeFileSync(path.join(serverDir, "BUILD_ID"), "custom-build\n");
    fs.writeFileSync(applicationEntry, "export {};\n");
    fs.writeFileSync(
      path.join(serverDir, ".vite", "manifest.json"),
      JSON.stringify({
        "virtual:vinext-rsc-entry": {
          file: "entries/application-entry.js",
          isDynamicEntry: true,
        },
      }),
    );
    fs.writeFileSync(path.join(root, "next.config.mjs"), 'export default { output: "export" };\n');
    prerenderAppMock.mockResolvedValueOnce({
      routes: [
        {
          route: "/",
          status: "rendered",
          outputFiles: [path.join(root, "dist", "client", "index.html")],
          revalidate: false,
          router: "app",
        },
      ],
    });

    try {
      const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");

      await runPrerender({
        root,
        routeRootConfig: { rscOutDir: "build/application" },
      });

      expect(prerenderAppMock).toHaveBeenCalledWith(
        expect.objectContaining({
          rscBundlePath: applicationEntry,
          serverDir,
          buildOutDir: path.join(root, "dist"),
          outDir: path.join(root, "dist", "client"),
        }),
      );
      expect(writePrerenderIndexMock).toHaveBeenCalledWith(
        expect.any(Array),
        path.join(root, "dist", "server"),
        expect.objectContaining({ buildId: "custom-build" }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
