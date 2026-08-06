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
  createSassCssUrlAssetImporter,
  createSassTildeImporter,
} from "../packages/vinext/src/plugins/sass.js";
import { fileURLToPath, pathToFileURL } from "node:url";

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

describe("createSassCssUrlAssetImporter", () => {
  it("marks asset URLs relative to an imported partial before Sass flattens it", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-sass-partial-url-"));
    const stylesDir = path.join(tmpDir, "styles");
    const partialDir = path.join(stylesDir, "subdirectory");
    await fsp.mkdir(partialDir, { recursive: true });
    const entryPath = path.join(stylesDir, "global.scss");
    const partialPath = path.join(partialDir, "_partial.scss");
    await fsp.writeFile(entryPath, `@import './subdirectory/partial';`);
    await fsp.writeFile(
      partialPath,
      `.red { background-image: url('./darka.svg'), url(darkb.svg); }`,
    );

    try {
      const importer = createSassCssUrlAssetImporter();
      const rewritten = importer.rewriteImports(`@import "./subdirectory/partial";`, entryPath);
      const importUrl = rewritten.match(/@import "([^"]+)"/)?.[1];
      expect(importUrl).toContain("vinext-css-url-asset:");
      const canonicalUrl = importer.canonicalize(importUrl!);
      expect(canonicalUrl?.href).toBe(pathToFileURL(partialPath).href);
      const loaded = importer.load(canonicalUrl!);
      expect(loaded?.syntax).toBe("scss");
      expect(loaded?.contents).toContain("vinext_css_url_asset=darka.svg");
      expect(loaded?.contents).toContain("vinext_css_url_asset=darkb.svg");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves the default namespace for @use and supports explicit @use/@forward", async () => {
    const sass = await import("sass");
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-sass-use-url-"));
    const entryPath = path.join(tmpDir, "entry.scss");
    const partialPath = path.join(tmpDir, "_card.scss");
    await fsp.writeFile(partialPath, `$fg: red;\n.card { background-image: url('./card.svg'); }`);

    try {
      const importer = createSassCssUrlAssetImporter();
      const defaultUse = importer.rewriteImports(
        `@use "./card";\n.test { color: card.$fg; }`,
        entryPath,
      );
      expect(defaultUse).toContain(" as card;");
      expect(
        sass.compileString(defaultUse, {
          importers: [importer],
          syntax: "scss",
        }).css,
      ).toContain("vinext_css_url_asset=card.svg");

      const explicitUse = importer.rewriteImports(
        `@use "./card" as c;\n.test { color: c.$fg; }`,
        entryPath,
      );
      expect(explicitUse).not.toContain(" as card as c");
      expect(() =>
        sass.compileString(explicitUse, { importers: [importer], syntax: "scss" }),
      ).not.toThrow();

      const forwarded = importer.rewriteImports(`@forward "./card";`, entryPath);
      expect(() =>
        sass.compileString(forwarded, { importers: [importer], syntax: "scss" }),
      ).not.toThrow();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves underscores in Sass default namespaces", async () => {
    const sass = await import("sass");
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-sass-namespace-url-"));
    const entryPath = path.join(tmpDir, "entry.scss");
    await fsp.writeFile(
      path.join(tmpDir, "_my_colors.scss"),
      `$fg: red;\n.colors { background-image: url('./colors.svg'); }`,
    );
    try {
      const importer = createSassCssUrlAssetImporter();
      const underscored = importer.rewriteImports(
        `@use "./my_colors";\n.test { color: my_colors.$fg; }`,
        entryPath,
      );
      expect(underscored).toContain(" as my_colors;");
      expect(() =>
        sass.compileString(underscored, { importers: [importer], syntax: "scss" }),
      ).not.toThrow();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads partials when Sass normalizes URLs with '~'", async () => {
    const sass = await import("sass");
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-sass-short-path-url-"));
    const shortPathDir = path.join(tmpDir, "RUNNER~1");
    const entryPath = path.join(shortPathDir, "entry.scss");
    await fsp.mkdir(shortPathDir);
    await fsp.writeFile(
      path.join(shortPathDir, "_card.scss"),
      `$fg: red;\n.card { background-image: url('./card.svg'); }`,
    );

    try {
      const importer = createSassCssUrlAssetImporter();
      const rewritten = importer.rewriteImports(
        `@use "./card";\n.test { color: card.$fg; }`,
        entryPath,
      );
      expect(rewritten).toContain("RUNNER~1");
      expect(() =>
        sass.compileString(rewritten, { importers: [importer], syntax: "scss" }),
      ).not.toThrow();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
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
    expect(
      await (css as any)?.preprocessorOptions?.scss?.additionalData(".test {}", "/tmp/test.scss"),
    ).toBe("$var: red;.test {}");
    // oxlint-disable-next-line typescript/no-explicit-any
    expect(
      await (css as any)?.preprocessorOptions?.sass?.additionalData(".test {}", "/tmp/test.sass"),
    ).toBe("$var: red;.test {}");
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
