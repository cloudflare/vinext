/**
 * `images.loaderFile` / `images.loader` support.
 *
 * Covers:
 *  - generateImageLoaderModule() codegen for the `virtual:vinext-image-loader`
 *    module across the unconfigured / loaderFile / bare-"custom" permutations.
 *  - resolveNextConfig() path resolution and the config-time validation that
 *    turns a mistyped loaderFile into an error instead of a silent fallback to
 *    the built-in `/_next/image` loader.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toSlash } from "pathslash";
import { describe, it, expect } from "vite-plus/test";
import {
  generateImageLoaderModule,
  VIRTUAL_IMAGE_LOADER,
} from "../packages/vinext/src/image/image-loader-virtual.js";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";

/**
 * Create a throwaway project root containing `loader.mjs` (a valid loader) and
 * `no-default.mjs` (a module without a default export). `.mjs` because the temp
 * dir has no package.json, so Node would treat `.js` as CommonJS.
 */
function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-image-loader-"));
  fs.writeFileSync(
    path.join(root, "loader.mjs"),
    "export default ({ src, width, quality }) =>\n" +
      "  `https://cdn.test${src}?w=${width}&q=${quality ?? 75}`;\n",
  );
  fs.writeFileSync(path.join(root, "no-default.mjs"), "export const notALoader = 1;\n");
  return root;
}

/** Write generated source into `root` and import it as a real ES module. */
async function importGenerated(root: string, name: string, code: string): Promise<unknown> {
  const modulePath = path.join(root, name);
  fs.writeFileSync(modulePath, code);
  return import(pathToFileURL(modulePath).href);
}

// ─── codegen ───────────────────────────────────────────────────────────────

describe("generateImageLoaderModule", () => {
  it("exposes the public virtual module id", () => {
    expect(VIRTUAL_IMAGE_LOADER).toBe("virtual:vinext-image-loader");
  });

  it("emits an undefined default export when nothing is configured", () => {
    // The shim imports this module unconditionally and falls back to the
    // built-in loader on `undefined`, so the export must exist either way.
    expect(generateImageLoaderModule()).toContain("export default undefined;");
    expect(generateImageLoaderModule({})).toContain("export default undefined;");
  });

  it("re-exports the configured loaderFile's default export", () => {
    const code = generateImageLoaderModule({ loaderFile: "/project/my-loader.js" });
    expect(code).toContain(
      'import * as __vinextUserImageLoaderModule from "/project/my-loader.js";',
    );
    expect(code).toContain("export default __vinextImageLoader;");
  });

  it("fails loudly when the loaderFile has no default export", () => {
    const code = generateImageLoaderModule({ loaderFile: "/project/my-loader.js" });
    expect(code).toContain("if (typeof __vinextImageLoader !== 'function')");
    // A real newline in the emitted source, not a literal backslash-n.
    expect(code).toContain(
      '"images.loaderFile detected but the file is missing default export.\\nRead more:',
    );
  });

  it('reports the missing loader prop for loader:"custom" with no loaderFile', () => {
    // Upstream treats this as a per-image error rather than a config error,
    // because a `loader` prop on each <Image> is legitimate usage.
    const code = generateImageLoaderModule({ loader: "custom" });
    expect(code).toContain("export default function customImageLoader({ src })");
    expect(code).toContain('is missing "loader" prop.');
    expect(code).not.toContain("export default undefined;");
  });

  it('prefers the loaderFile when both it and loader:"custom" are set', () => {
    const code = generateImageLoaderModule({ loader: "custom", loaderFile: "/project/l.js" });
    expect(code).toContain('from "/project/l.js"');
    expect(code).not.toContain("customImageLoader");
  });
});

// ─── generated modules, executed ───────────────────────────────────────────
//
// The generator emits JavaScript source as strings, so quoting and escaping are
// only really verified by running the result.

describe("generated virtual:vinext-image-loader module", () => {
  it("re-exports a working loader from the configured loaderFile", async () => {
    const root = makeProjectRoot();
    const mod = (await importGenerated(
      root,
      "generated-loader.mjs",
      generateImageLoaderModule({ loaderFile: path.join(root, "loader.mjs") }),
    )) as { default: (p: { src: string; width: number; quality?: number }) => string };

    expect(mod.default({ src: "/photo.jpg", width: 640, quality: 80 })).toBe(
      "https://cdn.test/photo.jpg?w=640&q=80",
    );
  });

  it("throws the upstream message when the loaderFile has no default export", async () => {
    const root = makeProjectRoot();
    await expect(
      importGenerated(
        root,
        "generated-nodefault.mjs",
        generateImageLoaderModule({ loaderFile: path.join(root, "no-default.mjs") }),
      ),
    ).rejects.toThrow(
      "images.loaderFile detected but the file is missing default export.\n" +
        "Read more: https://nextjs.org/docs/messages/invalid-images-config",
    );
  });

  it('throws the upstream missing-loader-prop message for bare loader:"custom"', async () => {
    const root = makeProjectRoot();
    const mod = (await importGenerated(
      root,
      "generated-custom.mjs",
      generateImageLoaderModule({ loader: "custom" }),
    )) as { default: (p: { src: string; width: number }) => string };

    expect(() => mod.default({ src: "/photo.jpg", width: 640 })).toThrow(
      'Image with src "/photo.jpg" is missing "loader" prop.\n' +
        "Read more: https://nextjs.org/docs/messages/next-image-missing-loader",
    );
  });

  it('exports requiresLoaderProp from every branch, set only for bare-"custom"', async () => {
    // The shim imports this name unconditionally, so a branch that omitted it
    // would fail to link rather than degrade — importing each variant is what
    // proves all three satisfy the contract. Only the bare-"custom" stub sets
    // it: the shim reports that misconfiguration before it decides whether an
    // image is optimized, since `unoptimized` legitimately bypasses a real
    // loader but must not bypass the error.
    const root = makeProjectRoot();
    const variants = [
      { name: "requires-none.mjs", images: undefined, expected: false },
      {
        name: "requires-file.mjs",
        images: { loaderFile: path.join(root, "loader.mjs") },
        expected: false,
      },
      { name: "requires-custom.mjs", images: { loader: "custom" as const }, expected: true },
    ];

    for (const variant of variants) {
      const mod = (await importGenerated(
        root,
        variant.name,
        generateImageLoaderModule(variant.images),
      )) as { requiresLoaderProp: boolean };
      expect(mod.requiresLoaderProp).toBe(variant.expected);
    }
  });
});

// ─── config resolution ─────────────────────────────────────────────────────

describe("resolveNextConfig images.loaderFile", () => {
  it("resolves a relative loaderFile against the project root", async () => {
    const root = makeProjectRoot();
    const config = await resolveNextConfig({ images: { loaderFile: "./loader.mjs" } }, root);
    // `resolveImageLoaderFile` returns a `toSlash`-normalized path, so the
    // expectation has to be normalized too — `root` comes from `mkdtempSync`
    // and carries native separators, which on Windows would otherwise compare a
    // half-backslash path against a forward-slash one.
    expect(config.images?.loaderFile).toBe(toSlash(path.join(root, "loader.mjs")));
  });

  it("leaves loaderFile undefined when unset", async () => {
    const config = await resolveNextConfig({ images: { unoptimized: true } });
    expect(config.images?.loaderFile).toBeUndefined();
  });

  it("throws when the loaderFile does not exist", async () => {
    const root = makeProjectRoot();
    // The failure this guards: a typo'd path silently falling back to the
    // built-in loader looks identical to loaderFile not being supported.
    await expect(resolveNextConfig({ images: { loaderFile: "./nope.js" } }, root)).rejects.toThrow(
      /images.loaderFile does not exist/,
    );
  });

  it("rejects a loaderFile paired with an unsupported named loader", async () => {
    const root = makeProjectRoot();
    await expect(
      resolveNextConfig(
        // Named CDN loaders exist only in next/legacy/image upstream.
        { images: { loader: "imgix" as "custom", loaderFile: "./loader.mjs" } },
        root,
      ),
    ).rejects.toThrow(/cannot be used with images.loaderFile/);
  });

  it("rejects an unsupported named loader even without a loaderFile", async () => {
    // The dangerous permutation: nothing downstream rejects a named loader on
    // its own, so every image would quietly be served from `/_next/image`
    // instead of the CDN the config names.
    await expect(
      resolveNextConfig({ images: { loader: "cloudinary" as "custom" } }),
    ).rejects.toThrow(/images.loader property \(cloudinary\) is not supported/);
  });

  it('allows loader:"custom" with no loaderFile', async () => {
    const config = await resolveNextConfig({ images: { loader: "custom" } });
    expect(config.images?.loader).toBe("custom");
    expect(config.images?.loaderFile).toBeUndefined();
  });
});
