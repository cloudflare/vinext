import http from "node:http";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

// Issue #4789: cancelling an App Router document clears the request context
// while the RSC render keeps going, so cookies() throws in a Suspense part that
// resumes after the cancel and reaches onRequestError.
describe("App Router document cancelled by the client", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR));
    // Warm the route so the measured request doesn't race compilation.
    const warm = await fetch(`${baseUrl}/cancelled-document-cookies`);
    await warm.text();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("reports no error when the document is read to the end", async () => {
    await fetch(`${baseUrl}/api/instrumentation-test`, { method: "DELETE" });
    const res = await fetch(`${baseUrl}/cancelled-document-cookies`);
    expect(await res.text()).toContain('id="cookie-count"');
    const state = (await (await fetch(`${baseUrl}/api/instrumentation-test`)).json()) as {
      errors: Array<{ message: string; path: string }>;
    };
    expect(state.errors.filter((e) => e.path.startsWith("/cancelled-document-cookies"))).toEqual(
      [],
    );
  }, 30_000);

  it("keeps cookies() working for Server Components resuming after the cancel", async () => {
    await fetch(`${baseUrl}/api/instrumentation-test`, { method: "DELETE" });

    // Read the shell, then drop the connection (as a browser navigating away).
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${baseUrl}/cancelled-document-cookies`, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
        res.once("error", () => {});
      });
      req.on("error", () => {});
      req.setTimeout(10_000, () => reject(new Error("no shell received")));
    });

    // Let the suspended component resume and finish.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const state = (await (await fetch(`${baseUrl}/api/instrumentation-test`)).json()) as {
      errors: Array<{ message: string; path: string }>;
    };
    const errors = state.errors.filter((e) => e.path.startsWith("/cancelled-document-cookies"));
    expect(errors.map((e) => e.message)).toEqual([]);
  }, 60_000);
});
