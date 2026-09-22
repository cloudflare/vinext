import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  stripBrowserConditionFromServerEnv,
  withoutBrowserCondition,
} from "../packages/vinext/src/plugins/rsc-client-shim-excludes.js";

// ── Unit tests for the resolve-condition helper ────────────────────────────

describe("withoutBrowserCondition", () => {
  it("removes the browser condition while preserving order of the rest", () => {
    expect(
      withoutBrowserCondition(["workerd", "worker", "module", "browser", "development|production"]),
    ).toEqual(["workerd", "worker", "module", "development|production"]);
  });

  it("is a no-op when browser is absent", () => {
    expect(withoutBrowserCondition(["react-server", "node", "import"])).toEqual([
      "react-server",
      "node",
      "import",
    ]);
  });

  it("passes through undefined", () => {
    expect(withoutBrowserCondition(undefined)).toBeUndefined();
  });
});

describe("stripBrowserConditionFromServerEnv", () => {
  it("strips browser from resolve.conditions and dep-optimizer conditions in place", () => {
    const env = {
      resolve: { conditions: ["workerd", "worker", "module", "browser", "development|production"] },
      optimizeDeps: {
        rolldownOptions: {
          resolve: { conditionNames: ["workerd", "worker", "module", "browser", "development"] },
        },
        esbuildOptions: { conditions: ["browser", "module"] },
      },
    };
    stripBrowserConditionFromServerEnv(env);
    expect(env.resolve.conditions).toEqual([
      "workerd",
      "worker",
      "module",
      "development|production",
    ]);
    expect(env.optimizeDeps.rolldownOptions.resolve.conditionNames).toEqual([
      "workerd",
      "worker",
      "module",
      "development",
    ]);
    expect(env.optimizeDeps.esbuildOptions.conditions).toEqual(["module"]);
  });

  it("is a no-op for undefined env", () => {
    expect(() => stripBrowserConditionFromServerEnv(undefined)).not.toThrow();
  });
});

// ── Integration build test (Cloudflare Workers) ────────────────────────────
//
// Reproduces the crash described in the bug report: a `"use client"` component
// that imports a library which registers a custom web component (extends
// HTMLElement) at module-init time. `@cloudflare/vite-plugin` injects the
// `browser` export condition into the worker (rsc/ssr) environments, so an
// `esm-env`-style `BROWSER` flag resolves to `true`, and the bundle would run
// `class extends HTMLElement` at import time — crashing with
// `ReferenceError: HTMLElement is not defined` in workerd.
//
// We model `@number-flow/react` + `number-flow` + `esm-env` with three tiny
// local packages that share the exact resolution shape (conditional `browser`
// export + `BROWSER ? HTMLElement : class {}`). We assert that the value the
// build resolves for `BROWSER` is `false` (server-safe), which is the root-cause
// signal — before the fix it resolved to `true`.

const tmpDirs: string[] = [];
const workerEntryPath = path
  .resolve(import.meta.dirname, "../packages/vinext/src/server/app-router-entry.ts")
  .replace(/\\/g, "/");
const cfPluginPath = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin/dist/index.mjs",
);

type CloudflarePluginFactory = (opts?: {
  viteEnvironment?: { name: string; childEnvironments?: string[] };
}) => import("vite").Plugin;

function writeFile(root: string, filePath: string, content: string) {
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function writePackage(nodeModules: string, name: string, files: Record<string, string>) {
  const dir = path.join(nodeModules, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFile(dir, file, content);
  }
}

/**
 * Build a real `node_modules` for the temp project: per-entry symlinks to the
 * workspace root node_modules (so react / @vitejs/plugin-rsc / etc. resolve),
 * plus the local fake packages written as real directories alongside them. A
 * single symlink of the whole root node_modules would not let us add packages.
 */
function setupNodeModulesWithFakes(root: string) {
  const repoNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  const nodeModules = path.join(root, "node_modules");
  fs.mkdirSync(nodeModules, { recursive: true });
  for (const entry of fs.readdirSync(repoNodeModules)) {
    fs.symlinkSync(path.join(repoNodeModules, entry), path.join(nodeModules, entry), "junction");
  }
  // vinext is the workspace package (not present at the root node_modules top
  // level); link it so any bare `vinext/...` specifier resolves during the build.
  const vinextLink = path.join(nodeModules, "vinext");
  fs.rmSync(vinextLink, { recursive: true, force: true });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../packages/vinext"), vinextLink, "junction");

  // fake-esm-env: mirrors esm-env — `BROWSER` is `true` only under the `browser`
  // export condition, `false` otherwise.
  writePackage(nodeModules, "fake-esm-env", {
    "package.json": JSON.stringify({
      name: "fake-esm-env",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": { default: "./index.js" },
        "./browser": {
          browser: "./true.js",
          development: "./false.js",
          production: "./false.js",
          default: "./false.js",
        },
      },
    }),
    "index.js": `export { default as BROWSER } from "fake-esm-env/browser";\n`,
    "true.js": `export default true;\n`,
    "false.js": `export default false;\n`,
  });

  // fake-number-flow: mirrors `number-flow` — extends HTMLElement at module init
  // when BROWSER is true (the exact crash pattern).
  writePackage(nodeModules, "fake-number-flow", {
    "package.json": JSON.stringify({
      name: "fake-number-flow",
      version: "1.0.0",
      type: "module",
      main: "./index.js",
      module: "./index.js",
      exports: { ".": { default: "./index.js" } },
      dependencies: { "fake-esm-env": "1.0.0" },
    }),
    "index.js": `import { BROWSER } from "fake-esm-env";
const Base = BROWSER ? HTMLElement : class {};
export class NumberFlowElement extends Base {}
function define(name, cls) {
  if (BROWSER && typeof customElements !== "undefined" && !customElements.get(name)) {
    customElements.define(name, cls);
  }
}
define("fake-number-flow", NumberFlowElement);
// Distinct, minification-stable sentinel reflecting the resolved BROWSER value.
export const RESOLVED_BROWSER = BROWSER ? "VINEXT_NF_BROWSER_TRUE" : "VINEXT_NF_BROWSER_FALSE";
export function formatValue(value) { return String(value); }
`,
  });

  // fake-number-flow-react: the "use client" React wrapper (mirrors @number-flow/react).
  writePackage(nodeModules, "fake-number-flow-react", {
    "package.json": JSON.stringify({
      name: "fake-number-flow-react",
      version: "1.0.0",
      type: "module",
      main: "./index.js",
      module: "./index.js",
      exports: { ".": { default: "./index.js" } },
      dependencies: { "fake-number-flow": "1.0.0" },
    }),
    "index.js": `"use client";
import { createElement } from "react";
import { formatValue, NumberFlowElement, RESOLVED_BROWSER } from "fake-number-flow";
const _retain = NumberFlowElement;
export default function NumberFlow({ value }) {
  return createElement(
    "span",
    { "data-testid": "number-flow", "data-resolved-browser": RESOLVED_BROWSER },
    formatValue(value),
  );
}
`,
  });
}

function writeCloudflareApp(root: string, name: string) {
  writeFile(root, "package.json", JSON.stringify({ name, private: true, type: "module" }, null, 2));
  writeFile(
    root,
    "wrangler.jsonc",
    `{
  "name": ${JSON.stringify(name)},
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "main": "./worker/index.ts",
  "assets": { "not_found_handling": "none", "binding": "ASSETS" }
}
`,
  );
  writeFile(
    root,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          types: ["vite/client", "@vitejs/plugin-rsc/types"],
        },
        include: ["app", "*.ts", "*.tsx"],
      },
      null,
      2,
    ),
  );
  writeFile(
    root,
    "worker/index.ts",
    `import handler from ${JSON.stringify(workerEntryPath)};\n\nexport default handler;\n`,
  );
  writeFile(
    root,
    "app/layout.tsx",
    `import type { ReactNode } from "react";
export default function RootLayout({ children }: { children: ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
`,
  );
  writeFile(
    root,
    "app/page.tsx",
    `"use client";
import NumberFlow from "fake-number-flow-react";
import { useState } from "react";
export default function Home() {
  const [value, setValue] = useState(123);
  return (
    <div>
      <NumberFlow value={value} />
      <button onClick={() => setValue((v) => v + 1)}>Increment</button>
    </div>
  );
}
`,
  );
}

function readJsFilesRecursive(root: string): string {
  let output = "";
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output += readJsFilesRecursive(entryPath);
      continue;
    }
    if (entry.name.endsWith(".js")) output += fs.readFileSync(entryPath, "utf-8");
  }
  return output;
}

async function buildCloudflareApp(root: string) {
  const { cloudflare } = (await import(pathToFileURL(cfPluginPath).href)) as {
    cloudflare: CloudflarePluginFactory;
  };
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [
      vinext({ appDir: root }),
      cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
    ],
    logLevel: "silent",
  });
  await builder.buildApp();
}

describe("App Router 'use client' web-component library on Cloudflare Workers", () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A library that does `class extends (BROWSER ? HTMLElement : class {})` at
  // module-init time must resolve BROWSER to `false` in the worker (rsc/ssr)
  // build — otherwise it runs `class extends HTMLElement` during SSR and crashes
  // with `ReferenceError: HTMLElement is not defined` in workerd. The CF plugin
  // injects the `browser` condition; vinext must strip it from the server
  // environments so the server-safe entry is resolved (matching `next start`).
  it("resolves the `browser` export condition to the server-safe entry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-html-element-build-"));
    tmpDirs.push(root);
    setupNodeModulesWithFakes(root);
    writeCloudflareApp(root, "vinext-html-element-build");

    await buildCloudflareApp(root);

    const serverOutput = readJsFilesRecursive(path.join(root, "dist", "server"));
    // BROWSER must have resolved to the server entry (false). Before the fix the
    // CF plugin's `browser` condition resolved it to `true`.
    expect(serverOutput).toContain("VINEXT_NF_BROWSER_FALSE");
    expect(serverOutput).not.toContain("VINEXT_NF_BROWSER_TRUE");

    // The client bundle must keep `browser` semantics (real browser has the DOM),
    // so the browser branch (HTMLElement / true) is expected there.
    const clientOutput = readJsFilesRecursive(path.join(root, "dist", "client"));
    expect(clientOutput).toContain("VINEXT_NF_BROWSER_TRUE");
  }, 90_000);
});
