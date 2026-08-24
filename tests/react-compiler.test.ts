/**
 * React Compiler tests — verifies that `react: { compiler: true }` reaches
 * @vitejs/plugin-react and that the client bundle is auto memoized.
 *
 * The compiler transform is provided by `oxc-transform-react` and wired up by
 * @vitejs/plugin-react 6.1+. vinext auto-registers that plugin, so enabling the
 * compiler must work through vinext's own `react` option, including for apps
 * that put JSX in plain `.js` files (which Next.js allows).
 */
import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  hasReactCompilerPlugin,
  isReactCompilerRequested,
  REACT_COMPILER_PLUGIN_NAME,
} from "../packages/vinext/src/utils/react-compiler-support.js";
import { APP_FIXTURE_DIR } from "./helpers.js";

/**
 * The compiler rewrites components to call the memo cache hook `c(n)` from
 * `react/compiler-runtime`. After bundling and minification the import is
 * renamed, so the call shape is the stable signature to assert on.
 */
const MEMO_CACHE_CALL = /\bc\)\(\d+\)/;

function countMemoizedModules(dir: string): { memoized: number; total: number } {
  let memoized = 0;
  let total = 0;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      total++;
      if (MEMO_CACHE_CALL.test(fs.readFileSync(full, "utf-8"))) memoized++;
    }
  };
  walk(dir);
  return { memoized, total };
}

describe("React Compiler", () => {
  const outDir = path.resolve(APP_FIXTURE_DIR, "dist");

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  async function buildFixture(options: { compiler: boolean }) {
    fs.rmSync(outDir, { recursive: true, force: true });
    const builder = await createBuilder({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [
        vinext(
          options.compiler
            ? { appDir: APP_FIXTURE_DIR, react: { compiler: true } }
            : { appDir: APP_FIXTURE_DIR },
        ),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();
    return countMemoizedModules(path.join(outDir, "client"));
  }

  it("leaves the client bundle untouched when the compiler is off", async () => {
    const result = await buildFixture({ compiler: false });
    expect(result.total).toBeGreaterThan(0);
    expect(result.memoized).toBe(0);
  }, 240_000);

  it("auto memoizes client components when the compiler is on", async () => {
    const result = await buildFixture({ compiler: true });
    expect(result.total).toBeGreaterThan(0);
    expect(result.memoized).toBeGreaterThan(0);
  }, 240_000);

  it("compiles JSX in plain .js files with the compiler enabled", async () => {
    // Regression: `vite:react-compiler` runs at `enforce: "pre"`, same as
    // `vinext:jsx-in-js`. When it ran first it parsed `.js` as plain JS and
    // failed with `Unexpected JSX expression`, so the whole build broke for any
    // app with JSX in a `.js` file.
    const fixturePage = path.join(APP_FIXTURE_DIR, "app", "nextjs-compat", "jsx-in-js", "page.js");
    expect(fs.existsSync(fixturePage)).toBe(true);

    await expect(buildFixture({ compiler: true })).resolves.toBeDefined();
  }, 240_000);
});

describe("React Compiler support detection", () => {
  it("only treats a truthy compiler option as a request", () => {
    expect(isReactCompilerRequested({ compiler: true })).toBe(true);
    expect(isReactCompilerRequested({ compiler: { target: "19" } })).toBe(true);
    expect(isReactCompilerRequested({ compiler: false })).toBe(false);
    expect(isReactCompilerRequested({})).toBe(false);
    expect(isReactCompilerRequested(undefined)).toBe(false);
  });

  it("detects whether the resolved plugin registered the compiler", () => {
    // @vitejs/plugin-react 6.1+ adds this plugin; 6.0 drops the unknown option.
    expect(hasReactCompilerPlugin([{ name: "vite:react-babel" }])).toBe(false);
    expect(
      hasReactCompilerPlugin([{ name: "vite:react-babel" }, { name: REACT_COMPILER_PLUGIN_NAME }]),
    ).toBe(true);
    expect(hasReactCompilerPlugin([null, undefined, false])).toBe(false);
  });
});
