/**
 * Ported from Next.js: test/e2e/instrumentation-hook/instrumentation-hook.test.ts
 * https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/instrumentation-hook/instrumentation-hook.test.ts
 *
 * Every fixture in that suite ends `register()` with
 * `else { await require('this should fail') }`, a branch the compile-time
 * `process.env.NEXT_RUNTIME` constant makes unreachable. webpack's DefinePlugin
 * never resolves it; vinext must not either, in dev or in a production build.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { buildAppFixture, buildPagesFixture, startFixtureServer } from "./helpers.js";

const PAGES_FIXTURE = path.resolve(
  import.meta.dirname,
  "fixtures/instrumentation-next-runtime-pages",
);
const APP_FIXTURE = path.resolve(import.meta.dirname, "fixtures/instrumentation-next-runtime-app");

async function readBundleDir(entry: string): Promise<string> {
  const dir = path.dirname(entry);
  const files = await fs.readdir(dir, { recursive: true });
  const sources = await Promise.all(
    files
      .filter((file) => /\.[cm]?js$/.test(file))
      .map((file) => fs.readFile(path.join(dir, file), "utf8")),
  );
  return sources.join("\n");
}

describe("instrumentation register() with unreachable NEXT_RUNTIME branches", () => {
  it("runs the nodejs branch in Pages Router dev", async () => {
    const { server, baseUrl } = await startFixtureServer(PAGES_FIXTURE, { appDir: null });
    try {
      const html = await (await fetch(`${baseUrl}/`)).text();
      expect(html).toContain("Page Node instrumentationFinished=nodejs");
    } finally {
      await server.close();
    }
  });

  it("runs the nodejs branch before an App Router route handler in dev", async () => {
    const { server, baseUrl } = await startFixtureServer(APP_FIXTURE);
    try {
      const body = await (await fetch(`${baseUrl}/api/check`)).text();
      expect(body).toBe("API Node instrumentationFinished=nodejs");
    } finally {
      await server.close();
    }
  });

  it("builds the Pages Router server bundle without the unreachable require", async () => {
    const entry = await buildPagesFixture(PAGES_FIXTURE);
    try {
      const bundle = await readBundleDir(entry);
      expect(bundle).toContain("instrumentationFinished");
      expect(bundle).not.toContain("this should fail");
    } finally {
      await fs.rm(path.dirname(path.dirname(entry)), { recursive: true, force: true });
    }
  });

  it("builds the App Router bundles without the unreachable require", async () => {
    const entry = await buildAppFixture(APP_FIXTURE);
    try {
      const bundle = await readBundleDir(entry);
      expect(bundle).toContain("instrumentationFinished");
      expect(bundle).not.toContain("this should fail");
    } finally {
      await fs.rm(path.dirname(path.dirname(entry)), { recursive: true, force: true });
    }
  });
});
