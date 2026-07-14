import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { build, createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-no-actions-process");
const SERVER_HELPER = path.resolve(
  import.meta.dirname,
  "fixtures/app-action-process/start-server.mjs",
);
const PROD_SERVER_SOURCE = path.resolve(
  import.meta.dirname,
  "../packages/vinext/src/server/prod-server.ts",
);

async function waitForServerPort(child: ChildProcess, getOutput: () => string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = getOutput().match(/VINEXT_TEST_PORT=(\d+)/);
    if (match) return Number(match[1]);
    if (child.exitCode !== null) {
      throw new Error(`Production server exited before startup:\n${getOutput()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for production server:\n${getOutput()}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

describe("App Router production build without server actions", () => {
  let child: ChildProcess | undefined;
  let tempDir: string;
  let baseUrl: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(import.meta.dirname, ".tmp-no-actions-process-"));
    const outDir = path.join(FIXTURE_DIR, "dist");
    const builder = await createBuilder({
      root: FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: FIXTURE_DIR })],
    });
    await builder.buildApp();

    const runtimeDir = path.join(tempDir, "runtime");
    await build({
      root: path.resolve(import.meta.dirname, ".."),
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: runtimeDir,
        ssr: PROD_SERVER_SOURCE,
        rolldownOptions: { output: { entryFileNames: "prod-server.mjs" } },
      },
    });

    let output = "";
    child = spawn(
      process.execPath,
      [SERVER_HELPER, path.join(runtimeDir, "prod-server.mjs"), outDir],
      { cwd: path.resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (chunk) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk) => (output += chunk.toString()));
    const port = await waitForServerPort(child, () => output);
    baseUrl = `http://127.0.0.1:${port}`;
  }, 60_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 3_000);
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    await rm(path.join(FIXTURE_DIR, "dist"), { recursive: true, force: true });
    await rm(path.join(FIXTURE_DIR, ".next"), { recursive: true, force: true });
    await rm(path.join(FIXTURE_DIR, "next-env.d.ts"), { force: true });
  });

  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  it("returns action-not-found for an MPA post when the build has no server actions", async () => {
    const body = new FormData();
    body.set("ordinary-field", "value");
    const response = await fetch(baseUrl, { method: "POST", body });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(response.headers.get("cache-control")).toBeNull();
    expect(await response.text()).toBe("Server action not found.");
    expect(child!.exitCode).toBeNull();
  });

  it.each(["next-action", "x-rsc-action"])(
    "passes a raw POST carrying %s through to a Route Handler",
    async (actionHeader) => {
      const response = await fetch(`${baseUrl}/raw-action-request`, {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          [actionHeader]: "not-a-page-action",
        },
        body: "raw-route-body",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        body: "raw-route-body",
        contentType: "text/plain; charset=utf-8",
        nextAction: actionHeader === "next-action" ? "not-a-page-action" : null,
        rscAction: actionHeader === "x-rsc-action" ? "not-a-page-action" : null,
      });
      expect(child!.exitCode).toBeNull();
    },
  );
});
