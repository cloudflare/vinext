import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { buildCloudflareAppFixture, createIsolatedFixture, testCacheDir } from "./helpers.js";

const CF_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");
const NODE_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/app-layout-error");
const SIDECAR = "vinext-client-assets.js";

function findFiles(dir: string, match: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(entryPath, match));
    else if (match(entry.name)) found.push(entryPath);
  }
  return found;
}

/**
 * The ssr output nested inside the rsc output ships with it, so the client
 * assets module both environments read is emitted once, at the rsc root, and
 * the ssr bundle imports that copy.
 */
function expectOneSharedSidecar(serverDir: string): void {
  const copies = findFiles(serverDir, (name) => name === SIDECAR).map((file) =>
    path.relative(serverDir, file),
  );
  expect(copies).toEqual([SIDECAR]);
  expect(fs.readFileSync(path.join(serverDir, SIDECAR), "utf8")).toContain(
    '"appBootstrapPreinitModules"',
  );

  const ssrDir = path.join(serverDir, "ssr");
  const specifiers = findFiles(ssrDir, (name) => name.endsWith(".js")).flatMap((file) =>
    [...fs.readFileSync(file, "utf8").matchAll(/["']([^"']*vinext-client-assets\.js)["']/g)].map(
      (match) => path.resolve(path.dirname(file), match[1]),
    ),
  );
  expect(specifiers.length).toBeGreaterThan(0);
  expect(new Set(specifiers)).toEqual(new Set([path.join(serverDir, SIDECAR)]));
}

describe("client assets module with ssr nested in the rsc output (#4761)", () => {
  describe("Cloudflare build with ssr as a child environment of rsc", () => {
    let root: string;

    beforeAll(async () => {
      ({ root } = await buildCloudflareAppFixture(CF_FIXTURE));
    }, 180_000);

    afterAll(() => {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it("ships the module once in the Worker output", () => {
      expectOneSharedSidecar(path.join(root, "dist", "server"));
    });
  });

  describe("Node build with the default dist/server/ssr layout", () => {
    let root: string;

    beforeAll(async () => {
      root = await createIsolatedFixture(NODE_FIXTURE, "vinext-nested-ssr-sidecar-");
      const builder = await createBuilder({
        root,
        cacheDir: testCacheDir(root),
        configFile: false,
        logLevel: "silent",
        plugins: [vinext({ appDir: root })],
      });
      await builder.buildApp();
    }, 180_000);

    afterAll(() => {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it("ships the module once in the server output", () => {
      expectOneSharedSidecar(path.join(root, "dist", "server"));
    });
  });
});
