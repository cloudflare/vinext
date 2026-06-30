/**
 * Tests for vinext's `sassOptions` passthrough from next.config into
 * Vite's `css.preprocessorOptions.scss`.
 *
 * Next.js (sass-loader) destructures `prependData`, `additionalData`, and
 * `implementation` from `sassOptions` and forwards the rest as Sass options.
 * `prependData` (legacy) takes precedence over `additionalData`. Modern
 * Sass renamed `includePaths` → `loadPaths`; vinext accepts either and
 * forwards `loadPaths` to Vite, which uses modern Sass.
 *
 * Covers the upstream fixtures that fail in CI when `sassOptions` is not
 * threaded through:
 *   - test/e2e/app-dir/scss/basic-module-include-paths
 *   - test/e2e/app-dir/scss/basic-module-additional-data
 *   - test/e2e/app-dir/scss/basic-module-prepend-data
 *
 * Reference: packages/next/src/build/webpack/config/blocks/css/index.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack/config/blocks/css/index.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildSassPreprocessorOptions,
  normalizeSassTildeCssImport,
  rewriteSassTildeCssImports,
  wrapSassTildeAdditionalData,
  createSassTildeImporter,
} from "../packages/vinext/src/plugins/sass.js";
import { fileURLToPath } from "node:url";

// The vinext config hook mutates process.env.NODE_ENV as a side effect.
// Save/restore so tests that call config() don't leak between files.
let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
  }
});

describe("buildSassPreprocessorOptions", () => {
  it("returns undefined when sassOptions is null/undefined", () => {
    expect(buildSassPreprocessorOptions(null)).toBeUndefined();
    expect(buildSassPreprocessorOptions(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty sassOptions object", () => {
    expect(buildSassPreprocessorOptions({})).toBeUndefined();
  });

  it("maps additionalData through to Vite's additionalData", () => {
    const result = buildSassPreprocessorOptions({ additionalData: "$var: red;" });
    expect(result).toEqual({ additionalData: "$var: red;" });
  });

  it("maps legacy prependData onto additionalData", () => {
    const result = buildSassPreprocessorOptions({ prependData: "$var: red;" });
    expect(result).toEqual({ additionalData: "$var: red;" });
  });

  it("prefers prependData over additionalData (matches Next.js precedence)", () => {
    // Next.js: `additionalData: sassPrependData || sassAdditionalData`
    const result = buildSassPreprocessorOptions({
      prependData: "$legacy: red;",
      additionalData: "$modern: blue;",
    });
    expect(result?.additionalData).toBe("$legacy: red;");
  });

  it("falls through to additionalData when prependData is empty (matches Next.js truthy-OR)", () => {
    // Next.js: `sassPrependData || sassAdditionalData` — falsy prependData
    // (empty string) yields to additionalData, rather than overriding it.
    const result = buildSassPreprocessorOptions({
      prependData: "",
      additionalData: "$modern: blue;",
    });
    expect(result?.additionalData).toBe("$modern: blue;");
  });

  it("forwards function-form additionalData through", () => {
    // Vite accepts `additionalData` as `(source, filename) => string | Promise<string>`.
    // sass-loader accepts the same shape. The passthrough should keep
    // function values intact (not stringify them or coerce to a string).
    const fn = (source: string) => `$injected: red;\n${source}`;
    const result = buildSassPreprocessorOptions({ additionalData: fn });
    expect(result?.additionalData).toBe(fn);
  });

  it("forwards loadPaths verbatim", () => {
    const result = buildSassPreprocessorOptions({ loadPaths: ["./styles"] });
    expect(result?.loadPaths).toEqual(["./styles"]);
  });

  it("aliases legacy includePaths onto modern loadPaths", () => {
    const result = buildSassPreprocessorOptions({ includePaths: ["./styles"] });
    expect(result?.loadPaths).toEqual(["./styles"]);
  });

  it("merges loadPaths and includePaths when both are present", () => {
    const result = buildSassPreprocessorOptions({
      loadPaths: ["./modern"],
      includePaths: ["./legacy"],
    });
    expect(result?.loadPaths).toEqual(["./modern", "./legacy"]);
  });

  it("forwards implementation through (e.g. sass-embedded)", () => {
    const result = buildSassPreprocessorOptions({ implementation: "sass-embedded" });
    expect(result?.implementation).toBe("sass-embedded");
  });

  it("forwards unknown Sass options through verbatim", () => {
    const result = buildSassPreprocessorOptions({
      silenceDeprecations: ["import"],
      quietDeps: true,
    });
    expect(result?.silenceDeprecations).toEqual(["import"]);
    expect(result?.quietDeps).toBe(true);
  });

  it("ignores non-string entries in includePaths/loadPaths", () => {
    const result = buildSassPreprocessorOptions({
      includePaths: ["./valid", 42, null] as unknown as string[],
    });
    expect(result?.loadPaths).toEqual(["./valid"]);
  });
});

describe("createSassTildeImporter", () => {
  let tmpRoot: string;
  let importer: ReturnType<typeof createSassTildeImporter>;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-tilde-"));
    // Create node_modules/mypkg/index.scss so the fast-path can find it
    await fsp.mkdir(path.join(tmpRoot, "node_modules", "mypkg"), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, "node_modules", "mypkg", "index.scss"), "");
    await fsp.mkdir(path.join(tmpRoot, "node_modules", "@scope", "pkg"), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, "node_modules", "@scope", "pkg", "styles.scss"), "");
    // Create styles/variables.scss for root-relative resolution
    await fsp.mkdir(path.join(tmpRoot, "styles"), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, "styles", "variables.scss"), "$color: red;");
    importer = createSassTildeImporter(tmpRoot);
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("returns null for URLs without a leading tilde", () => {
    expect(importer.findFileUrl("styles/variables")).toBeNull();
    expect(importer.findFileUrl("./local")).toBeNull();
    expect(importer.findFileUrl("mypkg/index")).toBeNull();
  });

  it("returns null for a bare tilde with no path", () => {
    expect(importer.findFileUrl("~")).toBeNull();
  });

  it("resolves ~/path relative to the project root", () => {
    const result = importer.findFileUrl("~/styles/variables");
    expect(result).not.toBeNull();
    const resolved = fileURLToPath(result!.href);
    // Should point to <root>/styles/variables (Sass will add .scss extension)
    expect(resolved).toBe(path.join(tmpRoot, "styles/variables"));
  });

  it("resolves ~pkg/path via node_modules fast-path", () => {
    const result = importer.findFileUrl("~mypkg/index.scss");
    expect(result).not.toBeNull();
    const resolved = fileURLToPath(result!.href);
    expect(resolved).toBe(path.join(tmpRoot, "node_modules", "mypkg", "index.scss"));
  });

  it("resolves scoped packages ~@scope/pkg/styles.scss", () => {
    const result = importer.findFileUrl("~@scope/pkg/styles.scss");
    expect(result).not.toBeNull();
    const resolved = fileURLToPath(result!.href);
    expect(resolved).toBe(path.join(tmpRoot, "node_modules", "@scope", "pkg", "styles.scss"));
  });

  it("returns null for unknown packages not in node_modules", () => {
    // 'nonexistent-pkg' has no directory in tmpRoot/node_modules, and
    // createRequire resolution will also fail.
    const result = importer.findFileUrl("~nonexistent-pkg/styles.scss");
    expect(result).toBeNull();
  });

  it("returns a file: URL object (not a plain string)", () => {
    const result = importer.findFileUrl("~/styles/variables");
    expect(result).toBeInstanceOf(URL);
    expect(result?.protocol).toBe("file:");
  });
});

describe("normalizeSassTildeCssImport", () => {
  const root = path.join(path.sep, "project");

  it("strips package tilde imports emitted as plain CSS imports", () => {
    expect(
      normalizeSassTildeCssImport(
        "~nprogress/nprogress.css",
        path.join(root, "styles", "global.scss"),
        root,
      ),
    ).toBe("nprogress/nprogress.css");
  });

  it("resolves root-relative tilde imports against the project root", () => {
    expect(
      normalizeSassTildeCssImport(
        "~/styles/base.css?inline",
        path.join(root, "styles", "global.scss"),
        root,
      ),
    ).toBe(path.join(root, "styles", "base.css?inline").replaceAll(path.sep, "/"));
  });

  it("ignores tilde imports from JavaScript modules", () => {
    expect(
      normalizeSassTildeCssImport(
        "~nprogress/nprogress.css",
        path.join(root, "app", "page.tsx"),
        root,
      ),
    ).toBeNull();
  });

  it("ignores non-tilde and bare-tilde imports", () => {
    const importer = path.join(root, "styles", "global.scss");
    expect(normalizeSassTildeCssImport("nprogress/nprogress.css", importer, root)).toBeNull();
    expect(normalizeSassTildeCssImport("~", importer, root)).toBeNull();
  });
});

describe("rewriteSassTildeCssImports", () => {
  const root = path.join(path.sep, "project");
  const id = path.join(root, "styles", "global.scss");

  it("rewrites CSS imports that Sass preserves for PostCSS", () => {
    const source = [
      `@use '~/styles/variables' as *;`,
      `@import '~nprogress/nprogress.css';`,
      `@import url("~/styles/base.css");`,
      `@import url(~package/unquoted.css), '~package/second.css';`,
    ].join("\n");

    expect(rewriteSassTildeCssImports(source, id, root)).toBe(
      [
        `@use '~/styles/variables' as *;`,
        `@import 'nprogress/nprogress.css';`,
        `@import url("${path.join(root, "styles", "base.css").replaceAll(path.sep, "/")}");`,
        `@import url(package/unquoted.css), 'package/second.css';`,
      ].join("\n"),
    );
  });

  it("rewrites imports after leading comments", () => {
    for (const source of [
      [`/* banner */`, `@import '~package/theme.css';`].join("\n"),
      [`// banner`, `@import '~package/theme.css';`].join("\n"),
      [`$value: 1; // trailing`, `@import '~package/theme.css';`].join("\n"),
      `/* banner */ @import '~package/theme.css';`,
    ]) {
      expect(rewriteSassTildeCssImports(source, id, root)).toBe(source.replace("'~", "'"));
    }
  });

  it("does not rewrite import-like text in comments or strings", () => {
    const source = [
      `/* @import '~package/comment.css'; */`,
      `// @import '~package/line-comment.css';`,
      `$value: "@import '~package/string.css'";`,
      `.example { content: $value; }`,
    ].join("\n");
    expect(rewriteSassTildeCssImports(source, id, root)).toBeNull();
  });

  it("does not rewrite non-Sass import text", () => {
    for (const source of [
      `@IMPORT '~package/uppercase.css';`,
      `.example { --raw: @import '~package/custom-property.css'; }`,
      [`.example {`, `  --raw:`, `    @import '~package/multiline.css';`, `}`].join("\n"),
    ]) {
      expect(rewriteSassTildeCssImports(source, id, root)).toBeNull();
    }
  });

  it("stops semicolonless indented Sass imports at the newline", () => {
    const source = [
      `@import '~package/base.css'`,
      `.example`,
      `  background: url('~package/not-an-import.css')`,
    ].join("\n");
    expect(rewriteSassTildeCssImports(source, path.join(root, "styles", "global.sass"), root)).toBe(
      [
        `@import 'package/base.css'`,
        `.example`,
        `  background: url('~package/not-an-import.css')`,
      ].join("\n"),
    );
  });

  it("does not rewrite tilde paths inside line comments in an import statement", () => {
    const source = [`@import './base.css', // ~package/comment.css`, `  './next.css';`].join("\n");
    expect(rewriteSassTildeCssImports(source, id, root)).toBeNull();
  });

  it("does not mistake URL protocols for Sass line comments", () => {
    for (const source of [
      `@import url(http://example.com/base.css), '~package/http.css';`,
      `@import url(https://example.com/base.css), '~package/https.css';`,
      `@import url(//cdn.example.com/base.css), '~package/protocol-relative.css';`,
    ]) {
      expect(rewriteSassTildeCssImports(source, id, root)).toBe(source.replace("'~", "'"));
    }
  });

  it("does not mistake URL protocols outside imports for Sass line comments", () => {
    const source = `.example { background: url(http://example.com/base.png); } @import '~package/next.css';`;
    expect(rewriteSassTildeCssImports(source, id, root)).toBe(
      `.example { background: url(http://example.com/base.png); } @import 'package/next.css';`,
    );
  });

  it("does not rewrite strings in import conditions", () => {
    for (const source of [
      `@import 'theme.css' supports(selector(a[href="~package/token.css"]));`,
      `@import url(base.css) screen and (foo: "~package/token.css");`,
    ]) {
      expect(rewriteSassTildeCssImports(source, id, root)).toBeNull();
    }
  });

  it("does not treat media-query commas as import separators", () => {
    const source = `@import "theme.css" screen, (foo: "~package/token.css");`;
    expect(rewriteSassTildeCssImports(source, id, root)).toBeNull();
  });

  it("rewrites later imports after import conditions", () => {
    const source = `@import '~package/a.css' layer(foo), '~package/b.css';`;
    expect(rewriteSassTildeCssImports(source, id, root)).toBe(
      `@import 'package/a.css' layer(foo), 'package/b.css';`,
    );
  });

  it("rewrites later imports after comments", () => {
    for (const source of [
      `@import 'base.css', /* keep */ '~package/next.css';`,
      [`@import 'base.css',`, `  // keep`, `  '~package/next.css';`].join("\n"),
    ]) {
      expect(rewriteSassTildeCssImports(source, id, root)).toBe(source.replace("'~", "'"));
    }
  });

  it("leaves Sass imports and ordinary CSS imports unchanged", () => {
    expect(
      rewriteSassTildeCssImports(
        [`@import '~package/theme.scss';`, `@import './local.css';`].join("\n"),
        id,
        root,
      ),
    ).toBeNull();
  });
});

describe("wrapSassTildeAdditionalData", () => {
  const root = path.join(path.sep, "project");
  const filename = path.join(root, "styles", "global.scss");

  it("rewrites tilde CSS imports injected by string additionalData", () => {
    const wrapped = wrapSassTildeAdditionalData(`@import '~package/injected.css';\n`, root);
    expect(wrapped).toBe(`@import 'package/injected.css';\n`);
  });

  it("uses indented Sass parsing for string additionalData", () => {
    const wrapped = wrapSassTildeAdditionalData(
      [`@import '~package/base.css'`, `$value: foo, '~package/not-an-import.css'`].join("\n"),
      root,
      "sass",
    );
    expect(wrapped).toBe(
      [`@import 'package/base.css'`, `$value: foo, '~package/not-an-import.css'`].join("\n"),
    );
  });

  it("rewrites tilde CSS imports returned by function additionalData", async () => {
    const wrapped = wrapSassTildeAdditionalData(
      (source) => `@import '~/styles/injected.css';\n${source}`,
      root,
    );
    await expect(wrapped(`.page { color: red; }`, filename)).resolves.toBe(
      `@import '${path.join(root, "styles", "injected.css").replaceAll(path.sep, "/")}';\n.page { color: red; }`,
    );
  });

  it("preserves source maps returned by function additionalData", async () => {
    const map = { version: 3, sources: [filename], names: [], mappings: "AAAA" };
    const wrapped = wrapSassTildeAdditionalData(
      (source) => ({ content: `@import '~package/injected.css';\n${source}`, map }),
      root,
    );
    const result = await wrapped(`.page { color: red; }`, filename);
    expect(result).toMatchObject({
      content: `@import 'package/injected.css';\n.page { color: red; }`,
      map: { version: 3, sources: [filename] },
    });
    expect(typeof result).toBe("object");
    if (typeof result === "object") expect(result.map).not.toBe(map);
  });
});

describe("vinext config hook threads sassOptions into css.preprocessorOptions", () => {
  async function runConfigHook(
    nextConfigSrc: string,
  ): Promise<Record<string, unknown> | undefined> {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();

    const mainPlugin = plugins.find(
      // oxlint-disable-next-line typescript/no-explicit-any
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-sass-config-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), nextConfigSrc);

    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });
      // oxlint-disable-next-line typescript/no-explicit-any
      return (result as any)?.css;
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  it("forwards sassOptions.additionalData into css.preprocessorOptions.scss", async () => {
    const css = await runConfigHook(
      `export default { sassOptions: { additionalData: '$var: red;' } };`,
    );
    // oxlint-disable-next-line typescript/no-explicit-any
    const scssAdditionalData = (css as any)?.preprocessorOptions?.scss?.additionalData;
    // oxlint-disable-next-line typescript/no-explicit-any
    const sassAdditionalData = (css as any)?.preprocessorOptions?.sass?.additionalData;
    expect(scssAdditionalData).toBe("$var: red;");
    expect(sassAdditionalData).toBe("$var: red;");
  }, 15000);

  it("aliases includePaths into loadPaths in css.preprocessorOptions.scss", async () => {
    const css = await runConfigHook(
      `export default { sassOptions: { includePaths: ['./styles'] } };`,
    );
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((css as any)?.preprocessorOptions?.scss?.loadPaths).toEqual(["./styles"]);
  }, 15000);

  it("always sets preprocessorOptions (tilde importer is always injected)", async () => {
    const css = await runConfigHook(`export default {};`);
    // preprocessorOptions is ALWAYS set — even without sassOptions — because
    // vinext injects the tilde importer unconditionally so that SCSS files can
    // use webpack-style ~pkg/file and ~/path imports (Next.js / sass-loader
    // behaviour). See: packages/vinext/src/plugins/sass.ts#createSassTildeImporter
    // oxlint-disable-next-line typescript/no-explicit-any
    const opts = (css as any)?.preprocessorOptions;
    expect(opts).toBeDefined();
    // oxlint-disable-next-line typescript/no-explicit-any
    const scssImporters: any[] = opts.scss.importers;
    expect(scssImporters.length).toBeGreaterThanOrEqual(1);
    // oxlint-disable-next-line typescript/no-explicit-any
    const sassImporters: any[] = opts.sass.importers;
    expect(sassImporters.length).toBeGreaterThanOrEqual(1);
  }, 15000);
});
