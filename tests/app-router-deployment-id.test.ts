import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

describe("App Router deployment ID", () => {
  let baseUrl: string;
  let previousNextDeploymentId: string | undefined;
  let previousVinextDeploymentId: string | undefined;
  let server: ViteDevServer | undefined;
  let tmpDir: string | undefined;

  beforeAll(async () => {
    previousNextDeploymentId = process.env.NEXT_DEPLOYMENT_ID;
    previousVinextDeploymentId = process.env.__VINEXT_DEPLOYMENT_ID;
    process.env.NEXT_DEPLOYMENT_ID = "test-deployment-id";
    delete process.env.__VINEXT_DEPLOYMENT_ID;

    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-app-rsc-dpl-"));
    await fsp.cp(APP_FIXTURE_DIR, tmpDir, { recursive: true });
    await fsp.rm(path.join(tmpDir, "node_modules", ".vite"), { recursive: true, force: true });

    ({ server, baseUrl } = await startFixtureServer(tmpDir, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
    if (previousNextDeploymentId === undefined) {
      delete process.env.NEXT_DEPLOYMENT_ID;
    } else {
      process.env.NEXT_DEPLOYMENT_ID = previousNextDeploymentId;
    }
    if (previousVinextDeploymentId === undefined) {
      delete process.env.__VINEXT_DEPLOYMENT_ID;
    } else {
      process.env.__VINEXT_DEPLOYMENT_ID = previousVinextDeploymentId;
    }
  });

  // Ported from Next.js: test/e2e/app-dir/segment-cache/deployment-skew/deployment-skew.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/deployment-skew/deployment-skew.test.ts
  it("sets the deployment ID header on RSC responses", async () => {
    const res = await fetch(`${baseUrl}/about.rsc?_rsc=`, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-component");
    expect(res.headers.get("x-nextjs-deployment-id")).toBe("test-deployment-id");
  });
});
