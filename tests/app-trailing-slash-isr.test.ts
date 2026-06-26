// Ported from Next.js: test/e2e/app-dir/trailingslash/trailingslash.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/trailingslash/trailingslash.test.ts

import fs from "node:fs";
import path from "node:path";
import { createBuilder, preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-trailing-slash-isr");

describe("App Router trailing-slash ISR with generated static params", () => {
  let previewServer: Awaited<ReturnType<typeof preview>>;
  let baseUrl: string;

  beforeAll(async () => {
    const builder = await createBuilder({
      root: FIXTURE_DIR,
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      logLevel: "silent",
    });
    await builder.buildApp();

    previewServer = await preview({
      root: FIXTURE_DIR,
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      preview: { port: 0 },
      logLevel: "silent",
    });
    const address = previewServer.httpServer.address();
    baseUrl = address && typeof address === "object" ? `http://localhost:${address.port}` : "";
  }, 120_000);

  afterAll(() => {
    previewServer?.httpServer.close();
    fs.rmSync(path.join(FIXTURE_DIR, "dist"), { recursive: true, force: true });
  });

  it("serves the rewritten generated path from its canonical source URL", async () => {
    const destinationResponse = await fetch(`${baseUrl}/en/legacy/`);
    const destinationHtml = await destinationResponse.text();
    const response = await fetch(`${baseUrl}/en`);
    const html = await response.text();

    expect(destinationResponse.status).toBe(200);
    expect(destinationHtml).toContain('id="generated-at"');
    expect(response.status).toBe(200);
    expect(response.url).toBe(`${baseUrl}/en/`);
    expect(html).toContain('id="generated-at"');
    expect(html).toContain("generated-<!-- -->en");
  });
});
