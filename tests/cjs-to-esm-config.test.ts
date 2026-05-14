import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Tests for scripts/cjs-to-esm-config.mjs — the standalone converter used by
// the deploy harness to rewrite test apps' next.config.{js,ts} from CJS to
// ESM after vinext init adds "type": "module" to package.json.
//
// Each fixture below is modeled on a real Next.js test fixture under
// .nextjs-ref/test/e2e/... that previously failed in the deploy suite. After
// the converter runs, the result must parse as ESM (verified by running
// `node --check --input-type=module`) so the build doesn't throw at load
// time.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONVERTER = path.resolve(__dirname, "../scripts/cjs-to-esm-config.mjs");

function runConverter(file: string): { exitCode: number; output: string } {
  const res = spawnSync(process.execPath, [CONVERTER, file], {
    encoding: "utf8",
  });
  return {
    exitCode: res.status ?? -1,
    output: `${res.stdout}\n${res.stderr}`,
  };
}

function checkParsesAsEsm(file: string): { ok: boolean; output: string } {
  // Node's --check needs a real .mjs file (or a package.json with "type":
  // "module" in scope) to treat the file as ESM. Write a sibling .mjs copy
  // and run --check on it so we don't have to touch the fixture's
  // package.json setup.
  const tmpFile = file.replace(/\.(js|ts|mjs|cjs)$/, "") + ".__check__.mjs";
  fs.writeFileSync(tmpFile, fs.readFileSync(file, "utf8"));
  try {
    const res = spawnSync(process.execPath, ["--check", tmpFile], {
      encoding: "utf8",
    });
    return {
      ok: res.status === 0,
      output: `${res.stdout}\n${res.stderr}`,
    };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

function loadAsEsm(file: string): { ok: boolean; output: string } {
  // Actually evaluate the file as an ESM module. This catches runtime
  // ReferenceErrors for __dirname / require that --check doesn't catch
  // (the syntax is valid; the references resolve only at runtime).
  const dir = path.dirname(file);
  const pkg = path.join(dir, "package.json");
  const hadPkg = fs.existsSync(pkg);
  if (!hadPkg) {
    fs.writeFileSync(pkg, JSON.stringify({ type: "module" }) + "\n");
  }
  try {
    const res = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(file)});`],
      { encoding: "utf8", cwd: dir },
    );
    return {
      ok: res.status === 0,
      output: `${res.stdout}\n${res.stderr}`,
    };
  } finally {
    if (!hadPkg) {
      fs.rmSync(pkg, { force: true });
    }
  }
}

let tmpDir: string;

function writeFixture(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cjs-converter-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cjs-to-esm-config.mjs", () => {
  it("converts plain module.exports = X", () => {
    // Smoke check for the pre-existing baseline behavior.
    const file = writeFixture(
      "next.config.js",
      `const nextConfig = { reactStrictMode: true }
module.exports = nextConfig
`,
    );

    expect(runConverter(file).exitCode).toBe(0);

    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain("export default nextConfig");
    expect(result).not.toContain("module.exports");

    const parsed = checkParsesAsEsm(file);
    expect(parsed.ok, parsed.output).toBe(true);
  });

  it("rewrites const X = require('mod') into import X from 'mod'", () => {
    const file = writeFixture(
      "next.config.js",
      `const path = require('node:path')
const nextConfig = { distDir: path.join('build') }
module.exports = nextConfig
`,
    );

    expect(runConverter(file).exitCode).toBe(0);

    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain("import path from");
    expect(result).toContain("export default nextConfig");

    const parsed = checkParsesAsEsm(file);
    expect(parsed.ok, parsed.output).toBe(true);
  });

  it("handles require.resolve(...) via createRequire shim (cache-components, edge-pages-support)", () => {
    // Modeled on test/e2e/app-dir/cache-components/next.config.js
    // and test/e2e/edge-pages-support/app/next.config.js.
    // Both use `require.resolve(...)` which the original regex pipeline
    // didn't recognize, leaving a bare `require` reference that triggered
    // ReferenceError in ESM scope.
    const file = writeFixture(
      "next.config.js",
      `const nextConfig = {
  cacheComponents: true,
  adapterPath:
    process.env.NEXT_ADAPTER_PATH ?? require.resolve('./my-adapter.mjs'),
}
module.exports = nextConfig
`,
    );

    expect(runConverter(file).exitCode).toBe(0);

    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain("createRequire");
    expect(result).toContain("const require = ");
    // require.resolve call is intentionally left as-is — the shim makes it
    // resolve to the createRequire-bound version.
    expect(result).toContain("require.resolve('./my-adapter.mjs')");

    const parsed = checkParsesAsEsm(file);
    expect(parsed.ok, parsed.output).toBe(true);
  });

  it("handles __dirname in config body (webpack-loader-set-environment-variable)", () => {
    // Modeled on test/e2e/app-dir/webpack-loader-set-environment-variable/next.config.js
    // which references __dirname when building turbopack/webpack loader paths.
    const file = writeFixture(
      "next.config.js",
      `const { join } = require('path')

const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    rules: {
      '*.svg': {
        as: '*.js',
        loaders: [join(__dirname, './custom-loader.js')],
      },
    },
  },
}

module.exports = nextConfig
`,
    );

    expect(runConverter(file).exitCode).toBe(0);

    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain("import { fileURLToPath");
    expect(result).toContain("const __dirname = ");

    const parsed = checkParsesAsEsm(file);
    expect(parsed.ok, parsed.output).toBe(true);

    // And it should actually run without throwing — this catches the
    // runtime ReferenceError that --check misses.
    const ran = loadAsEsm(file);
    expect(ran.ok, ran.output).toBe(true);
  });

  it("handles __dirname in next.config.ts (next-config-ts/node-api-cjs)", () => {
    // Modeled on test/e2e/app-dir/next-config-ts/node-api-cjs/next.config.ts.
    const file = writeFixture(
      "next.config.ts",
      `import fs from 'node:fs'
import { join } from 'node:path'

const foo = fs.readFileSync(join(__dirname, 'foo.txt'), 'utf8')

const nextConfig = {
  env: {
    foo,
  },
}

export default nextConfig
`,
    );
    // Also write the data file the config reads at module-eval time so
    // loadAsEsm doesn't throw a separate ENOENT.
    fs.writeFileSync(path.join(tmpDir, "foo.txt"), "bar\n", "utf8");

    expect(runConverter(file).exitCode).toBe(0);

    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain("const __dirname = ");

    // .ts files: --check would balk on `import` typed syntax in this fixture
    // (none used, but be defensive). Just exercise the runtime loader.
    const ran = loadAsEsm(file);
    expect(ran.ok, ran.output).toBe(true);
  });

  it("handles __filename references in config body", () => {
    const file = writeFixture(
      "next.config.js",
      `const nextConfig = { env: { CONFIG_FILE: __filename } }
module.exports = nextConfig
`,
    );

    expect(runConverter(file).exitCode).toBe(0);

    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain("const __filename = ");
    expect(result).toContain("fileURLToPath");

    const ran = loadAsEsm(file);
    expect(ran.ok, ran.output).toBe(true);
  });

  it("defines __filename and __dirname only when referenced", () => {
    const file = writeFixture(
      "next.config.js",
      `const nextConfig = { reactStrictMode: true }
module.exports = nextConfig
`,
    );

    expect(runConverter(file).exitCode).toBe(0);

    const result = fs.readFileSync(file, "utf8");
    expect(result).not.toContain("fileURLToPath");
    expect(result).not.toContain("createRequire");
  });

  it("handles a config with no module.exports and no require (no-op)", () => {
    const original = `import type { NextConfig } from 'next'
const config: NextConfig = { reactStrictMode: true }
export default config
`;
    const file = writeFixture("next.config.ts", original);

    expect(runConverter(file).exitCode).toBe(0);

    // Nothing to convert — content should be unchanged.
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("converts destructured const { a, b } = require('mod')", () => {
    const file = writeFixture(
      "next.config.js",
      `const { join, resolve } = require('node:path')
const nextConfig = { distDir: join('build') }
module.exports = nextConfig
`,
    );

    expect(runConverter(file).exitCode).toBe(0);

    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain("import { join, resolve } from");

    const parsed = checkParsesAsEsm(file);
    expect(parsed.ok, parsed.output).toBe(true);
  });

  it("rewrites const X = require('mod')(args) into an inline dynamic import", () => {
    // Inline (await import('mod')).default(args) — not a hoisted static import —
    // is what #1213 settled on so that conditionally-gated requires keep their
    // CJS lazy semantics. See the comment in scripts/cjs-to-esm-config.mjs.
    const file = writeFixture(
      "next.config.js",
      `const withBundleAnalyzer = require('@next/bundle-analyzer')({ enabled: false })
const nextConfig = { reactStrictMode: true }
module.exports = withBundleAnalyzer(nextConfig)
`,
    );

    expect(runConverter(file).exitCode).toBe(0);

    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain(
      "const withBundleAnalyzer = (await import('@next/bundle-analyzer')).default({ enabled: false })",
    );
    // Should NOT have been hoisted into a static top-level import.
    expect(result).not.toMatch(/^import .* from ['"]@next\/bundle-analyzer['"]/m);

    const parsed = checkParsesAsEsm(file);
    expect(parsed.ok, parsed.output).toBe(true);
  });

  it("combines __dirname + require.resolve in a single config (adapter-dynamic-metadata-style)", () => {
    // Cross-check that the prelude collects all needed shims together.
    const file = writeFixture(
      "next.config.js",
      `const nextConfig = {}

if (!process.env.NEXT_ADAPTER_PATH) {
  nextConfig.adapterPath = require.resolve('./my-adapter.mjs')
}
nextConfig.env = { CONFIG_DIR: __dirname }

module.exports = nextConfig
`,
    );

    expect(runConverter(file).exitCode).toBe(0);

    const result = fs.readFileSync(file, "utf8");
    expect(result).toContain("createRequire");
    expect(result).toContain("const require = ");
    expect(result).toContain("const __dirname = ");

    const parsed = checkParsesAsEsm(file);
    expect(parsed.ok, parsed.output).toBe(true);
  });
});
