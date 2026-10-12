import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder, createServer } from "vite";
import { generateViteConfig } from "../packages/vinext/src/init.js";
import { createIsolatedFixture } from "./helpers.js";

const fixture = path.resolve(import.meta.dirname, "fixtures/init-css-modules");
let root: string;

function expectInheritedDeclarations(css: string, className: string): void {
  const rule = new RegExp(`\\.${className}[^{}]*\\{([^}]*)\\}`, "g");
  const wrapRules = [...css.matchAll(rule)].map((match) => match[1]);
  expect(wrapRules.some((rule) => /position:\s*absolute/.test(rule))).toBe(true);
  expect(wrapRules.some((rule) => /color:\s*red/.test(rule))).toBe(true);
  expect(css).not.toContain("@extend");
}

beforeAll(async () => {
  root = await createIsolatedFixture(
    fixture,
    "vinext-init-css-modules-",
    undefined,
    path.join(fixture, "node_modules"),
  );
  await fs.writeFile(path.join(root, "vite.config.ts"), generateViteConfig(true, false, true));
});

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

// Adapted from Next.js: test/e2e/app-dir/scss/loader-order/loader-order.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/scss/loader-order/loader-order.test.ts
it("preserves @extend declarations and default CSS Module exports in dev", async () => {
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    const server = await createServer({
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No dev server address");
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      const html = await response.text();
      expect(response.status).toBe(200);
      const className = html.match(/class="(_wrap_[a-f0-9]{7})"/)?.[1];
      expect(className).toBeDefined();
      const css = await server.transformRequest("/app/styles.module.css");
      const injectedCss = css?.code.match(/const __vite__css = ("(?:\\.|[^"\\])*")/)?.[1];
      expect(injectedCss).toBeDefined();
      expectInheritedDeclarations(JSON.parse(injectedCss!) as string, className!);
    } finally {
      await server.close();
    }
  } finally {
    process.chdir(previousCwd);
  }
}, 90_000);

it("preserves @extend declarations and default CSS Module exports in build", async () => {
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    const builder = await createBuilder({ root, logLevel: "silent" });
    await builder.buildApp();
    const entries = await fs.readdir(path.join(root, "dist"), {
      recursive: true,
      withFileTypes: true,
    });
    const cssFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".css"));
    const css = (
      await Promise.all(
        cssFiles.map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), "utf8")),
      )
    ).join("\n");
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
      noCompression: true,
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No production server address");
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(response.status).toBe(200);
      const className = (await response.text()).match(/class="(_wrap_[a-f0-9]{7})"/)?.[1];
      expect(className).toBeDefined();
      expectInheritedDeclarations(css, className!);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    process.chdir(previousCwd);
  }
}, 180_000);
