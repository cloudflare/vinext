import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/app-cold-client-references",
);

type ClientEvaluationMarker = { __vinextUnrelatedClientEvaluated?: boolean };

// Regression coverage for #256, without the global client-reference preload:
// the first requests after `vinext start` must render every client component
// they use, and must not load the client code of pages they don't render.
describe("App Router production SSR with cold client references", () => {
  let baseUrl = "";
  let fixtureDir = "";
  let server: import("node:http").Server | undefined;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-cold-client-refs-");
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    delete (globalThis as ClientEvaluationMarker).__vinextUnrelatedClientEvaluated;
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      outDir: path.join(fixtureDir, "dist"),
      noCompression: true,
    }));
    const address = server.address();
    expect(address && typeof address === "object").toBeTruthy();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }, 120_000);

  afterAll(() => {
    server?.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("renders concurrent first requests in full, holding the shell for a client module still loading", async () => {
    const responses = await Promise.all([fetch(`${baseUrl}/`), fetch(`${baseUrl}/`)]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-testid="providers"');
      expect(html).toContain('data-testid="slow-counter"');
      expect(html).toContain("count <!-- -->0");
    }
  });

  it("does not load the client code of a page the request does not render", () => {
    expect((globalThis as ClientEvaluationMarker).__vinextUnrelatedClientEvaluated).toBeUndefined();
  });

  it("renders a second route's client component on its own first request", async () => {
    const response = await fetch(`${baseUrl}/other`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-testid="unrelated"');
    expect((globalThis as ClientEvaluationMarker).__vinextUnrelatedClientEvaluated).toBe(true);
  });
});
