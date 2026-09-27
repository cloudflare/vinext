import path from "node:path";
import { runInNewContext } from "node:vm";
import { createBuilder } from "vite";
import { expect, it } from "vite-plus/test";

// Upstream regression: test/e2e/app-dir/cache-components/cache-components.server-action.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/cache-components/cache-components.server-action.test.ts
it("loads next/constants in browsers without a Node process global", async () => {
  let code = "";
  const builder = await createBuilder({
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "capture-constants-bundle",
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type === "chunk" && output.isEntry) code = output.code;
          }
        },
      },
    ],
    build: {
      write: false,
      lib: {
        entry: path.resolve(import.meta.dirname, "../packages/vinext/src/shims/constants.ts"),
        name: "NextConstants",
        formats: ["iife"],
      },
    },
  });
  await builder.buildApp();
  expect(code).not.toBe("");
  const context: { NextConstants?: { CONFIG_FILES: string[] } } = {};
  runInNewContext(code, context);
  expect(context.NextConstants?.CONFIG_FILES).toEqual([
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
  ]);
});
