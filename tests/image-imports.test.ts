import { describe, it, expect } from "vite-plus/test";
import path from "node:path";
import vm from "node:vm";
import vinext from "../packages/vinext/src/index.js";
import { toSlash } from "pathslash";
import type { Plugin } from "vite-plus";

// ── Helpers ───────────────────────────────────────────────────
const IMAGES_DIR = path.resolve(import.meta.dirname, "./fixtures/images");
const PNG_PATH = path.join(IMAGES_DIR, "test-4x3.png");
const JPG_PATH = path.join(IMAGES_DIR, "test-8x6.jpg");

/** Unwrap a Vite plugin hook that may use the object-with-filter format */
function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

/** Extract the vinext:image-imports plugin from the plugin array */
function getImagePlugin(): Plugin & { _dimCache: Map<string, { width: number; height: number }> } {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:image-imports");
  if (!plugin) throw new Error("vinext:image-imports plugin not found");
  return plugin as any;
}

// ── resolveId ─────────────────────────────────────────────────
describe("vinext:image-imports — resolveId", () => {
  it("resolves ?vinext-meta suffix to virtual module ID", () => {
    const plugin = getImagePlugin();
    const resolve = unwrapHook(plugin.resolveId);
    const result = resolve.call(plugin, "/abs/path/hero.jpg?vinext-meta", "/some/file.tsx");
    expect(result).toBe("\0vinext-image-meta:/abs/path/hero.jpg");
  });

  it("returns null for non-meta imports", () => {
    const plugin = getImagePlugin();
    const resolve = unwrapHook(plugin.resolveId);
    expect(resolve.call(plugin, "./hero.jpg", "/some/file.tsx")).toBeNull();
    expect(resolve.call(plugin, "react", "/some/file.tsx")).toBeNull();
    expect(resolve.call(plugin, "next/image", "/some/file.tsx")).toBeNull();
  });
});

// ── load ──────────────────────────────────────────────────────
describe("vinext:image-imports — load", () => {
  function createLoadContext(plugin: Plugin) {
    const watched: string[] = [];
    return {
      context: Object.assign(Object.create(plugin), {
        addWatchFile(filePath: string) {
          watched.push(filePath);
        },
        environment: { config: { command: "build" } },
      }),
      watched,
    };
  }

  it("returns dimensions for a PNG file", async () => {
    const plugin = getImagePlugin();
    const load = plugin.load as Function;
    const { context, watched } = createLoadContext(plugin);
    const result = await load.call(context, `\0vinext-image-meta:${PNG_PATH}`);
    expect(watched).toEqual([PNG_PATH]);
    expect(result).toContain("export default");
    const json = result.replace("export default ", "").replace(";", "");
    const dims = JSON.parse(json);
    expect(dims.width).toBe(4);
    expect(dims.height).toBe(3);
  });

  it("returns dimensions for a JPEG file", async () => {
    const plugin = getImagePlugin();
    const load = plugin.load as Function;
    const { context, watched } = createLoadContext(plugin);
    const result = await load.call(context, `\0vinext-image-meta:${JPG_PATH}`);
    expect(watched).toEqual([JPG_PATH]);
    const json = result.replace("export default ", "").replace(";", "");
    const dims = JSON.parse(json);
    expect(dims.width).toBe(8);
    expect(dims.height).toBe(6);
  });

  it("returns 0x0 for non-existent file", async () => {
    const plugin = getImagePlugin();
    const load = plugin.load as Function;
    const { context, watched } = createLoadContext(plugin);
    const result = await load.call(context, "\0vinext-image-meta:/no/such/file.png");
    expect(watched).toEqual(["/no/such/file.png"]);
    const json = result.replace("export default ", "").replace(";", "");
    const dims = JSON.parse(json);
    expect(dims.width).toBe(0);
    expect(dims.height).toBe(0);
  });

  it("returns null for non-image-meta IDs", async () => {
    const plugin = getImagePlugin();
    const load = plugin.load as Function;
    expect(await load.call(plugin, "./hero.jpg")).toBeNull();
    expect(await load.call(plugin, "react")).toBeNull();
  });

  it("caches dimensions on second call", async () => {
    const plugin = getImagePlugin();
    plugin._dimCache.clear();
    const load = plugin.load as Function;
    const { context } = createLoadContext(plugin);
    await load.call(context, `\0vinext-image-meta:${PNG_PATH}`);
    expect(plugin._dimCache.has(PNG_PATH)).toBe(true);
    // Second call uses cache (no way to verify directly, but should not throw)
    const result = await load.call(context, `\0vinext-image-meta:${PNG_PATH}`);
    expect(result).toContain('"width":4');
  });
});

// ── transform ─────────────────────────────────────────────────
describe("vinext:image-imports — transform", () => {
  // Fake file ID in the images directory so path.resolve works
  const fakeId = path.join(IMAGES_DIR, "page.tsx");

  /**
   * The transform's contract is that an `import X from './pic.png'` becomes a
   * hoisted `var X = { src, width, height, ... }` StaticImageData object, with
   * dimensions resolved through a sibling `?vinext-meta` import. The binding is
   * `var` (not `const`) to preserve the hoisting semantics of the import it
   * replaces — see the "#1975" test below. We verify the shape, not the
   * synthesized intermediate variable names.
   */
  function expectImageBinding(code: string, name: string, fileBasename: string) {
    expect(code).not.toMatch(new RegExp(`import\\s+${name}\\s+from`));
    expect(code).toMatch(new RegExp(`var\\s+${name}\\s*=\\s*\\{[^}]*src\\s*:`));
    const urlSpecifier = toSlash(path.join(IMAGES_DIR, fileBasename));
    expect(code).toContain(urlSpecifier + "?vinext-image-url");
    // The meta import specifier uses forward slashes — the transform normalizes
    // the resolved path so generated output is consistent across platforms.
    const metaSpecifier = toSlash(path.join(IMAGES_DIR, fileBasename));
    expect(code).toContain(metaSpecifier + "?vinext-meta");
  }

  it("transforms a PNG import into StaticImageData", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import hero from './test-4x3.png';\nconsole.log(hero);`;
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
    expect(result.map).toBeDefined();
  });

  it("transforms a JPEG import", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import photo from './test-8x6.jpg';`;
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "photo", "test-8x6.jpg");
  });

  it("transforms multiple image imports in one file", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import hero from './test-4x3.png';`,
      `import photo from './test-8x6.jpg';`,
      `export default function Page() { return null; }`,
    ].join("\n");
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
    expectImageBinding(result.code, "photo", "test-8x6.jpg");
  });

  it("returns null for files with no image imports", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import React from 'react';\nconst x = 1;`;
    const result = await transform.call(plugin, code, fakeId);
    expect(result).toBeNull();
  });

  it("returns null for node_modules files", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import hero from './hero.png';`;
    const result = await transform.call(plugin, code, path.join("node_modules", "pkg", "index.ts"));
    expect(result).toBeNull();
  });

  it("returns null for virtual modules (\\0 prefix)", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import hero from './hero.png';`;
    const result = await transform.call(plugin, code, "\0virtual:something");
    expect(result).toBeNull();
  });

  it("returns null for non-script files", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import hero from './hero.png';`;
    const result = await transform.call(plugin, code, "/app/styles.css");
    expect(result).toBeNull();
  });

  it("skips imports where the image file does not exist", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import ghost from './nonexistent.png';`;
    const result = await transform.call(plugin, code, fakeId);
    // Regex matches but fs.existsSync fails — no changes made
    expect(result).toBeNull();
  });

  it("preserves non-image imports alongside image imports", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import React from 'react';`,
      `import hero from './test-4x3.png';`,
      `import { useState } from 'react';`,
    ].join("\n");
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    // React imports should still be there
    expect(result.code).toContain(`import React from 'react'`);
    expect(result.code).toContain(`import { useState } from 'react'`);
    // Image import should be rewritten as a StaticImageData binding
    expectImageBinding(result.code, "hero", "test-4x3.png");
  });

  it.each([`'./test-4x3.png'`, `"./test-4x3.png"`])("handles import quoted as %s", async (q) => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const result = await transform.call(plugin, `import hero from ${q};`, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
  });

  // Regression: a regex-based scanner matched `import X from '...img'` text
  // anywhere it appeared, including inside comments — even when a real image
  // existed at that path. This generated `const X = { src: __vinext_img_url_X }`
  // referencing an undefined `__vinext_img_url_X`, crashing SSR (dev + prod 500).
  // The scan must be AST-based and only rewrite real ImportDeclaration nodes.
  it("ignores a commented-out image import (line comment)", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import hero from './test-4x3.png';`,
      `// import ghost from './test-8x6.jpg';`,
      `console.log(hero);`,
    ].join("\n");
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    // The real import is rewritten.
    expectImageBinding(result.code, "hero", "test-4x3.png");
    // The commented-out import must not produce any synthesized variables.
    expect(result.code).not.toContain("__vinext_img_url_ghost");
    expect(result.code).not.toContain("__vinext_img_meta_ghost");
    expect(result.code).not.toMatch(/var\s+ghost\s*=/);
    // The comment is preserved verbatim.
    expect(result.code).toContain(`// import ghost from './test-8x6.jpg';`);
  });

  it("ignores a commented-out image import (block comment)", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import hero from './test-4x3.png';`,
      `/* import ghost from './test-8x6.jpg'; */`,
      `console.log(hero);`,
    ].join("\n");
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
    expect(result.code).not.toContain("__vinext_img_url_ghost");
    expect(result.code).not.toMatch(/var\s+ghost\s*=/);
  });

  it("ignores image-import text inside a string literal", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import hero from './test-4x3.png';`,
      `const example = "import ghost from './test-8x6.jpg';";`,
      `console.log(hero, example);`,
    ].join("\n");
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
    expect(result.code).not.toContain("__vinext_img_url_ghost");
    expect(result.code).not.toMatch(/var\s+ghost\s*=/);
  });

  it("does not transform named or namespace image imports", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    // These are not the `import X from '...'` default form, so they're left as-is.
    const code = [
      `import * as ns from './test-4x3.png';`,
      `import { foo } from './test-8x6.jpg';`,
    ].join("\n");
    const result = await transform.call(plugin, code, fakeId);
    expect(result).toBeNull();
  });

  // Regression: the plugin runs with `enforce: "pre"`, so the handler sees RAW
  // source containing JSX and TS type annotations. `parseAst` defaults to plain
  // JS and throws on that syntax; if the handler swallows the error and returns
  // null, image imports in every real component silently skip transformation
  // (hero.src/width/height become undefined). These cases use real TSX/TS
  // syntax that plain-JS parsing would reject.
  it("transforms an image import in a TSX component (JSX in body)", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import Image from 'next/image';`,
      `import hero from './test-4x3.png';`,
      `export default function Home() {`,
      `  return <Image src={hero} alt="hero" width={100} height={100} />;`,
      `}`,
    ].join("\n");
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
    // JSX is left intact for the downstream JSX transform.
    expect(result.code).toContain(`<Image src={hero}`);
  });

  it("transforms an image import in a typed .ts file (type annotations)", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import hero from './test-4x3.png';`,
      `const count: number = 1;`,
      `function load(arg: string): void { console.log(arg, count); }`,
      `console.log(hero);`,
    ].join("\n");
    const result = await transform.call(plugin, code, path.join(IMAGES_DIR, "page.ts"));
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
    // Type annotations are preserved for the downstream TS transform.
    expect(result.code).toContain(`const count: number = 1;`);
  });

  // Regression: parsing a plain `.ts` file as `tsx` throws on TS-only syntax
  // because `<T>` is read as the start of a JSX element. The handler swallows
  // parse errors and returns null, which would silently skip the image
  // transform (hero.src/width/height become undefined). `.ts` must parse as
  // `ts`, not `tsx`.
  it("transforms an image import in a .ts file using an angle-bracket cast", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import hero from './test-4x3.png';`,
      `const value: unknown = hero;`,
      `const widened = <{ src: string }>value;`,
      `console.log(widened.src);`,
    ].join("\n");
    const result = await transform.call(plugin, code, path.join(IMAGES_DIR, "cast.ts"));
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
  });

  it("transforms an image import in a .ts file using a non-comma generic arrow", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import hero from './test-4x3.png';`,
      `const identity = <T>(x: T): T => x;`,
      `console.log(identity(hero));`,
    ].join("\n");
    const result = await transform.call(plugin, code, path.join(IMAGES_DIR, "arrow.ts"));
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
  });

  // Regression (#1975): the synthesized binding must be a hoisted `var`, not a
  // block-scoped `const`. `import X from './a.png'` is a module-scoped binding
  // initialized before module-body execution; replacing it with `const X` puts X
  // in a temporal dead zone until its textual line, so any reference that runs
  // earlier — a hoisted function called above the import, or circular-import
  // re-entry — throws `Cannot access 'X' before initialization`. `var` hoists and
  // has no TDZ, so the forward reference reads `undefined` instead of throwing,
  // matching the hoisting semantics of the import it replaces.
  it("emits a hoisted `var` binding so forward references don't hit the TDZ (#1975)", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `getHero();`, // top-level call BEFORE the import's textual position
      `function getHero() {`,
      `  return hero;`, // hoisted fn closing over the image binding
      `}`,
      `import hero from './test-4x3.png';`,
    ].join("\n");
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();

    // Output level: the binding is hoisted (`var`), never `const`/`let`.
    expect(result.code).toMatch(/var\s+hero\s*=/);
    expect(result.code).not.toMatch(/(?:const|let)\s+hero\s*=/);

    // Behavioral level: execute the rewritten module with the synthesized image
    // imports stubbed (matched by their ?vinext-* source suffix, not by internal
    // variable names) and confirm the forward reference no longer throws. Under
    // the old `const` output this throws "Cannot access 'hero' before
    // initialization"; under `var`, getHero() returns undefined and nothing throws.
    const exec = result.code.replace(
      /import\s+(\w+)\s+from\s+['"][^'"]*\?vinext-(image-url|meta)['"]\s*;/g,
      (_m: string, name: string, kind: string) =>
        kind === "meta"
          ? `const ${name} = { width: 4, height: 3 };`
          : `const ${name} = "stub-url";`,
    );
    expect(() => vm.runInNewContext(exec)).not.toThrow();
  });
});
