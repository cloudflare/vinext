import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";

// Ported in spirit from Next.js: test/e2e/twoslash
// https://github.com/vercel/next.js/tree/canary/test/e2e/twoslash
//
// A server-external package that reads its own non-JS files at runtime is only
// complete in traced output when the app lists those files in
// `outputFileTracingIncludes`. Nitro traces externals file by file, so the
// option has to reach Nitro's trace.

const NITRO_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "../examples/app-router-nitro/node_modules",
);

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

describe("Nitro outputFileTracingIncludes", () => {
  it("adds included node_modules files to the traced output and drops excluded ones", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const nitroModule = (await import(
      pathToFileURL(path.join(NITRO_NODE_MODULES, "nitro/dist/vite.mjs")).href
    )) as { nitro(options: Record<string, unknown>): import("vite").Plugin[] };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-includes-"));

    try {
      const nodeModules = path.join(root, "node_modules");
      await fs.mkdir(nodeModules);
      for (const entry of await fs.readdir(NITRO_NODE_MODULES)) {
        if (entry.startsWith(".")) continue;
        await fs.symlink(
          path.join(NITRO_NODE_MODULES, entry),
          path.join(nodeModules, entry),
          "junction",
        );
      }
      await writeFiles(root, {
        "package.json": JSON.stringify({ name: "trace-includes", private: true, type: "module" }),
        "next.config.mjs": `export default {
  serverExternalPackages: ["data-pkg"],
  outputFileTracingIncludes: {
    "/": ["./node_modules/data-pkg/data/*.txt", "./node_modules/@scope/extra/**"],
  },
  outputFileTracingExcludes: {
    "/": ["./node_modules/data-pkg/data/skip.txt"],
  },
};`,
        "app/layout.tsx": `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
        "app/route.ts": `import readData from "data-pkg";
export function GET() { return new Response(readData()); }`,
        // The data directory name is built at runtime so the file tracer
        // cannot discover it statically, like TypeScript's lib.*.d.ts files.
        "node_modules/data-pkg/package.json": JSON.stringify({
          name: "data-pkg",
          version: "1.0.0",
          main: "index.js",
        }),
        "node_modules/data-pkg/index.js": `const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, String.fromCharCode(100, 97, 116, 97));
module.exports = () => fs.readdirSync(dir).join(",");`,
        "node_modules/data-pkg/data/a.txt": "a",
        "node_modules/data-pkg/data/b.txt": "b",
        "node_modules/data-pkg/data/skip.txt": "skip",
        "node_modules/@scope/extra/package.json": JSON.stringify({
          name: "@scope/extra",
          version: "2.0.0",
        }),
        "node_modules/@scope/extra/types/index.d.ts": "export {};",
      });

      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [vinext({ appDir: root }), nitroModule.nitro({ preset: "node-server" })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const traced = path.join(root, ".output", "server", "node_modules");
      expect(await exists(path.join(traced, "data-pkg", "index.js"))).toBe(true);
      expect(await exists(path.join(traced, "data-pkg", "data", "a.txt"))).toBe(true);
      expect(await exists(path.join(traced, "data-pkg", "data", "b.txt"))).toBe(true);
      expect(await exists(path.join(traced, "data-pkg", "data", "skip.txt"))).toBe(false);
      expect(await exists(path.join(traced, "@scope", "extra", "types", "index.d.ts"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
