import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/app-route-client-preloads",
);

// A process serves one production build: the SSR entry's client reference
// loader and the inline CSS manifest are globals.
describe("App Router production SSR streamed client references with inline CSS", () => {
  let baseUrl = "";
  let fixtureDir = "";
  let server: import("node:http").Server | undefined;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(
      FIXTURE_SOURCE_DIR,
      "vinext-route-client-preloads-inline-css-",
    );
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    fs.writeFileSync(
      path.join(fixtureDir, "next.config.mjs"),
      "export default { experimental: { inlineCss: true } };\n",
    );
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

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

  it("inlines a streamed reference's stylesheet the shell links last", async () => {
    // Nothing else on the page renders after the panel, so its stylesheet
    // links after the shell's.
    const response = await fetch(`${baseUrl}/streamed/also`);
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain('data-testid="streamed-panel"');
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(/<style data-vinext-inline-css[^>]*>[^<]*\.streamed-panel/);
    expect(html).not.toMatch(/<link\b[^>]*\brel="stylesheet"[^>]*>/);
  });

  it("inlines the stylesheet of a client component rendering after the shell", async () => {
    const response = await fetch(`${baseUrl}/late-css/loading`);
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain('data-testid="late-loading-panel"');
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(/<style data-vinext-inline-css[^>]*>[^<]*\.late-loading-panel/);
    expect(html).not.toMatch(/<link\b[^>]*\bas="style"[^>]*>/);
  });

  it("inlines a stylesheet it shares with a Server Component once, where the server links it", async () => {
    const html = await (await fetch(`${baseUrl}/late-css/shared`)).text();

    expect(html.match(/<style data-vinext-inline-css[^>]*>[^<]*\.late-shared\{/g)).toHaveLength(1);
    expect(html).toMatch(
      /<style data-vinext-inline-css[^>]*data-precedence="vite-rsc\/importer-resources"[^>]*>[^<]*\.late-shared\{/,
    );
  });
});
