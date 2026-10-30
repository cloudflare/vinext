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

  /**
   * Checks that every script tag and modulepreload link names the hash of the
   * bytes the server sends for that URL, except client component chunks,
   * which Next.js does not hash either. Returns the hashed URLs.
   */
  async function expectHashedTags(html: string): Promise<Set<string>> {
    const { appClientReferenceChunks } = readClientEntryManifest();
    const clientReferenceUrls = new Set<string>(
      appClientReferenceChunks.modules.map((module: { file: string }) => `/${module.file}`),
    );
    const scripts = html.match(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g) ?? [];
    const modulepreloads = html.match(/<link\b[^>]*\brel="modulepreload"[^>]*>/g) ?? [];
    const hashed = new Set<string>();
    for (const tag of [...scripts, ...modulepreloads]) {
      const url = tag.match(/\b(?:src|href)="([^"]+)"/)![1]!;
      const integrity = tag.match(/\bintegrity="([^"]+)"/)?.[1];
      if (clientReferenceUrls.has(url)) {
        expect(integrity, tag).toBeUndefined();
        continue;
      }
      const asset = await fetch(new URL(url, baseUrl));
      expect(asset.status).toBe(200);
      const digest = createHash("sha256")
        .update(Buffer.from(await asset.arrayBuffer()))
        .digest("base64");
      expect(integrity, tag).toBe(`sha256-${digest}`);
      hashed.add(url);
    }
    return hashed;
  }

  function readClientEntryManifest() {
    return JSON.parse(
      fs.readFileSync(
        path.join(fixtureDir, "dist", "client", "vinext-client-entry-manifest.json"),
        "utf8",
      ),
    );
  }

  it("hashes the bootstrap module and the chunks it preloads, like Next.js", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    const html = await response.text();

    const scripts = html.match(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(1);
    expect(scripts.some((tag) => tag.includes('id="_R_"'))).toBe(true);
    // The Counter's chunk is preloaded, unhashed.
    expect(html).toMatch(/<link\b[^>]*\brel="modulepreload"[^>]*>/);

    const hashed = await expectHashedTags(html);
    expect(hashed).toContain(`/${readClientEntryManifest().appRouteManifest}`);
    expect(hashed.size).toBe(scripts.length + 1);
  });

  it("hashes the same chunks in the error document that replaces a failed shell", async () => {
    const page = await (await fetch(`${baseUrl}/`)).text();
    const response = await fetch(`${baseUrl}/shell-error`);
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain("__next_error__");

    expect(await expectHashedTags(html)).toEqual(await expectHashedTags(page));
  });
});
