/**
 * Vinext intentionally makes tsconfig `paths` available to application Sass.
 * Vite and current Next.js webpack builds do not provide this behavior, but it
 * is useful when migrating Vite-oriented applications whose source and Sass
 * already share aliases. Keep the extension scoped to application styles so
 * dependencies retain normal package resolution.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, fetchHtml, startFixtureServer } from "./helpers.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/sass-tsconfig-paths");
const tempDirs: string[] = [];

async function makeFixture(): Promise<string> {
  const root = await createIsolatedFixture(FIXTURE, "vinext-sass-tsconfig-paths-");
  await fs.cp(path.join(root, "dependency-fixture"), path.join(root, "vendor", "node_modules"), {
    recursive: true,
  });
  tempDirs.push(root);
  return root;
}

async function readCssOutput(root: string): Promise<string> {
  const clientDir = path.join(root, "dist", "client");
  const entries = await fs.readdir(clientDir, { recursive: true, withFileTypes: true });
  const css = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => {
        const parent =
          (entry as { parentPath?: string; path?: string }).parentPath ??
          (entry as { path?: string }).path ??
          clientDir;
        return fs.readFile(path.join(parent, entry.name), "utf8");
      }),
  );
  return css.join("\n");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Sass tsconfig path aliases", () => {
  it("resolves exact fallbacks, wildcard suffixes, and dependency Sass in dev", async () => {
    const root = await makeFixture();
    const { server, baseUrl } = await startFixtureServer(root);
    try {
      const { res, html } = await fetchHtml(baseUrl, "/");
      expect(res.status).toBe(200);
      expect(html).toContain("Sass tsconfig aliases");
    } finally {
      await server.close();
    }
  }, 60_000);

  it("builds aliased Sass and leaves external CSS URLs untouched", async () => {
    const root = await makeFixture();
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const css = await readCssOutput(root);
    expect(css).toContain("https://example.com/external.css");
    expect(css).toMatch(/(?:#123(?:\b|;)|rgb\(17,\s*34,\s*51\))/i);
    expect(css).toMatch(/(?:#456(?:\b|;)|rgb\(68,\s*85,\s*102\))/i);
    expect(css).toMatch(/(?:#789(?:\b|;)|rgb\(119,\s*136,\s*153\))/i);
    expect(css).toMatch(/(?:#9ab(?:\b|;)|rgb\(153,\s*170,\s*187\))/i);
    expect(css).toMatch(/(?:#c12(?:\b|;)|rgb\(204,\s*17,\s*34\))/i);
  }, 120_000);
});
