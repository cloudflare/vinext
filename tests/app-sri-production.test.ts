import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_SOURCE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-sri");

describe("App Router production experimental.sri", () => {
  let baseUrl = "";
  let fixtureDir = "";
  let server: import("node:http").Server | undefined;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-app-sri-");
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
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

  it("hashes the bootstrap module and the chunks it preloads, like Next.js", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    const html = await response.text();

    const scripts = html.match(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(1);
    expect(scripts.some((tag) => tag.includes('id="_R_"'))).toBe(true);

    // Every script tag, and every link that carries a hash, names the hash of
    // the bytes the server sends for that URL.
    const links = (html.match(/<link\b[^>]*>/g) ?? []).filter((tag) => tag.includes("integrity="));
    for (const tag of [...scripts, ...links]) {
      const url = tag.match(/\b(?:src|href)="([^"]+)"/)![1]!;
      const integrity = tag.match(/\bintegrity="([^"]+)"/)?.[1];
      const asset = await fetch(new URL(url, baseUrl));
      expect(asset.status).toBe(200);
      const digest = createHash("sha256")
        .update(Buffer.from(await asset.arrayBuffer()))
        .digest("base64");
      expect(integrity, tag).toBe(`sha256-${digest}`);
    }
  });
});
