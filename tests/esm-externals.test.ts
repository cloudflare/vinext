import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { emitStandaloneOutput } from "../packages/vinext/src/build/standalone.js";
import {
  closeServer,
  createEsmExternalsFixture,
  ESM_EXTERNALS_APP_TRANSITIVE_PACKAGE,
  ESM_EXTERNALS_BUNDLED_PAGE_PACKAGES,
  ESM_EXTERNALS_EXPLICIT_APP_PACKAGES,
  ESM_EXTERNALS_IMPLICIT_PAGE_PACKAGES,
  ESM_EXTERNALS_ROUTE_EXPECTATIONS,
  firstParagraphText,
} from "./helpers/esm-externals-fixture.js";

type StartedStandaloneServer = {
  baseUrl: string;
  stop: () => Promise<void>;
};

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const forceKill = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function startStandaloneServer(serverPath: string): Promise<StartedStandaloneServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const fail = (message: string): void => {
      finish(() => {
        void stopChild(child);
        reject(new Error(`${message}\n${output}`));
      });
    };
    const timeout = setTimeout(() => {
      fail("Timed out waiting for standalone server to start");
    }, 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /Production server running at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (!match) return;

      finish(() => {
        resolve({
          baseUrl: match[1]!,
          stop: () => stopChild(child),
        });
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      fail(`Standalone server failed to start: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        fail(
          `Standalone server exited before startup: code=${code ?? "null"} signal=${signal ?? "null"}`,
        );
      }
    });
  });
}

// Ported from Next.js: test/e2e/esm-externals/esm-externals.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/esm-externals/esm-externals.test.ts
describe("esm externals production parity", () => {
  it("builds and renders the same SSR output as the upstream Turbopack deploy fixture", async () => {
    const fixture = await createEsmExternalsFixture();

    try {
      const builder = await createBuilder({
        root: fixture.root,
        configFile: false,
        plugins: [vinext({ appDir: fixture.root })],
        logLevel: "silent",
      });
      await builder.buildApp();
      emitStandaloneOutput({
        root: fixture.root,
        outDir: path.join(fixture.root, "dist"),
        vinextPackageRoot: path.resolve(process.cwd(), "packages/vinext"),
      });
      const serverExternals = JSON.parse(
        fs.readFileSync(path.join(fixture.root, "dist/server/vinext-externals.json"), "utf8"),
      ) as string[];
      for (const pagePackage of ESM_EXTERNALS_IMPLICIT_PAGE_PACKAGES) {
        expect(serverExternals).toContain(pagePackage);
      }
      for (const appPackage of ESM_EXTERNALS_EXPLICIT_APP_PACKAGES) {
        expect(serverExternals).toContain(appPackage);
      }
      for (const bundledPackage of ESM_EXTERNALS_BUNDLED_PAGE_PACKAGES) {
        expect(serverExternals).not.toContain(bundledPackage);
      }
      expect(serverExternals).not.toContain(ESM_EXTERNALS_APP_TRANSITIVE_PACKAGE);

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      const started = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir: path.join(fixture.root, "dist"),
        noCompression: true,
      });

      try {
        const baseUrl = `http://127.0.0.1:${started.port}`;

        for (const { route, text } of ESM_EXTERNALS_ROUTE_EXPECTATIONS) {
          const res = await fetch(`${baseUrl}${route}`);
          expect(res.status).toBe(200);
          expect(firstParagraphText(await res.text())).toBe(text);
        }
      } finally {
        await closeServer(started.server);
      }

      const standalone = await startStandaloneServer(
        path.join(fixture.root, "dist/standalone/server.js"),
      );
      try {
        const res = await fetch(`${standalone.baseUrl}/static`);
        expect(res.status).toBe(200);
        expect(firstParagraphText(await res.text())).toBe(ESM_EXTERNALS_ROUTE_EXPECTATIONS[0].text);
      } finally {
        await standalone.stop();
      }
    } finally {
      fixture.cleanup();
    }
  }, 180_000);
});
