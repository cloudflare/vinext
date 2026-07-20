import { describe, it, expect } from "vite-plus/test";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";
import { toSlash } from "pathslash";
import localFont, { getSSRFontStyles } from "../packages/vinext/src/shims/font-local.js";
import type { Plugin } from "vite-plus";

// ── Helpers ───────────────────────────────────────────────────

// Absolute path to vinext's own font-local shim — the plugin guards against
// rewriting any file under its shims directory via a prefix check, so tests
// that exercise the guard must use the real resolved path.
// Vite hands the transform hook POSIX-normalized ids, and the plugin's guard
// prefix-checks against the (forward-slash) shims dir — so normalize here too.
const FONT_LOCAL_SHIM_PATH = toSlash(
  path.resolve(import.meta.dirname, "../packages/vinext/src/shims/font-local.ts"),
);

/** Unwrap a Vite plugin hook that may use the object-with-filter format */
function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

/** Extract the vinext:local-fonts plugin from the plugin array */
function getLocalFontsPlugin(): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:local-fonts");
  if (!plugin) throw new Error("vinext:local-fonts plugin not found");
  return plugin;
}

// ── Plugin existence ─────────────────────────────────────────

describe("vinext:local-fonts plugin", () => {
  it("exists in the plugin array", () => {
    const plugin = getLocalFontsPlugin();
    expect(plugin.name).toBe("vinext:local-fonts");
    expect(plugin.enforce).toBe("pre");
  });

  // ── Guard clauses ────────────────────────────────────────────

  it("returns null for files without next/font/local", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import React from 'react';\nconst x = 1;`;
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).toBeNull();
  });

  it("transforms node_modules packages that wrap next/font/local", () => {
    // Regression: npm packages like `geist` ship their own font files and call
    // localFont() with paths relative to the package's dist/ directory. The
    // transform previously excluded node_modules, so the raw relative path
    // (e.g. "./fonts/geist-mono/GeistMono-Variable.woff2") leaked into the
    // runtime @font-face src and 404'd. Next.js's font loader runs on these
    // package files, so vinext must too.
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `export const GeistMono = localFont({`,
      `  src: './fonts/geist-mono/GeistMono-Variable.woff2',`,
      `  variable: '--font-geist-mono',`,
      `});`,
    ].join("\n");
    const result = transform.call(plugin, code, "/proj/node_modules/geist/dist/mono.js");
    expect(result).not.toBeNull();
    expectImported(result.code, "./fonts/geist-mono/GeistMono-Variable.woff2");
    expect(result.code).toContain(`_vinext: { font: { family: "GeistMono" } }`);
  });

  it("skips vinext's own font-local shim (it has example paths in comments)", () => {
    // The shim must never be rewritten. The guard is a prefix check against the
    // resolved shims directory, so use the real shim path.
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import localFont from 'next/font/local';\nconst f = localFont({ src: './font.woff2' });`;
    const result = transform.call(plugin, code, FONT_LOCAL_SHIM_PATH);
    expect(result).toBeNull();
  });

  it("transforms third-party packages whose path contains 'font-local'", () => {
    // Guard against a loose substring match regressing the fix: a real package
    // named `font-local-loader` (or one shipping fonts under a `font-local/`
    // dir) must still be transformed. Only vinext's own shims directory is
    // skipped, via a precise prefix check.
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `export const Custom = localFont({ src: './font-local/Custom.woff2' });`,
    ].join("\n");
    const result = transform.call(
      plugin,
      code,
      "/proj/node_modules/font-local-loader/dist/index.js",
    );
    expect(result).not.toBeNull();
    expectImported(result.code, "./font-local/Custom.woff2");
  });

  it("returns null for virtual modules", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import localFont from 'next/font/local';\nconst f = localFont({ src: './font.woff2' });`;
    const result = transform.call(plugin, code, "\0virtual:something");
    expect(result).toBeNull();
  });

  it("returns null for non-script files", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import localFont from 'next/font/local';\nconst f = localFont({ src: './font.woff2' });`;
    const result = transform.call(plugin, code, "/app/styles.css");
    expect(result).toBeNull();
  });

  it("returns null when code mentions next/font/local but has no import", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `// This file mentions next/font/local in a comment\nconst x = 1;`;
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).toBeNull();
  });

  it("returns null when import exists but no font file paths", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import localFont from 'next/font/local';\n// no call with font paths`;
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).toBeNull();
  });

  // ── Helper: assert a font file string was promoted to an ESM import ──
  // The transform's contract is that font path strings get rewritten to ESM
  // imports so Vite can fingerprint and serve them. We don't care about the
  // generated identifier names, only that the file is imported and the
  // original quoted path no longer appears as a property value.
  function expectImported(code: string, fontPath: string) {
    expect(code).toMatch(
      new RegExp(`import\\s+\\w+\\s+from\\s+"${fontPath.replace(/[.+]/g, "\\$&")}"`),
    );
    expect(code).not.toMatch(
      new RegExp(`(?:src|path):\\s*["']${fontPath.replace(/[.+]/g, "\\$&")}["']`),
    );
  }

  // ── Simple string src ────────────────────────────────────────

  it("transforms a simple string src path", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const myFont = localFont({ src: "./my-font.woff2" });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expectImported(result.code, "./my-font.woff2");
    expect(result.map).toBeDefined();
  });

  it("passes the local binding name through to the runtime font payload", () => {
    // Ported from Next.js: test/e2e/app-dir/mdx-font-preload/mdx-font-preload.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/mdx-font-preload/mdx-font-preload.test.ts
    //
    // Next's font transform passes the variable name into the local font loader,
    // and the loader uses it as the font-family for generated className styles.
    // The MDX test observes that through getComputedStyle(document.body).fontFamily.
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      ``,
      `const myFont = localFont({`,
      `  src: "../fonts/font1_roboto.woff2",`,
      `  variable: "--font-my-font",`,
      `});`,
    ].join("\n");

    const result = transform.call(plugin, code, "/app/layout.tsx");

    expect(result).not.toBeNull();
    expectImported(result.code, "../fonts/font1_roboto.woff2");
    expect(result.code).toContain(`_vinext: { font: { family: "myFont" } }`);
  });

  it("passes the local binding name through for same-line block declarations", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `export default function Layout(){const myFont = localFont({ src: "./font.woff2" }); return null;}`,
    ].join("\n");

    const result = transform.call(plugin, code, "/app/layout.tsx");

    expect(result).not.toBeNull();
    expectImported(result.code, "./font.woff2");
    expect(result.code).toContain(`_vinext: { font: { family: "myFont" } }`);
  });

  it("does not produce double-comma when a trailing comma is hidden behind a block comment", () => {
    // Regression for #1973: `.trim()` strips whitespace but not comments, so a
    // trailing comma followed by a block comment escaped the trailing-comma
    // check and a second comma was inserted before the `_vinext` payload.
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const myFont = localFont({`,
      `  src: "./my-font.woff2", /* c */`,
      `});`,
    ].join("\n");

    const result = transform.call(plugin, code, "/app/layout.tsx");

    expect(result).not.toBeNull();
    expect(result.code).toContain(`_vinext: { font: { family: "myFont" } }`);
    expect(result.code).not.toMatch(/\*\/\s*,/);
  });

  it("does not produce double-comma when a trailing comma is hidden behind a line comment", () => {
    // Regression for #1973: a trailing comma followed by a `// line comment`.
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const myFont = localFont({`,
      `  src: "./my-font.woff2", // c`,
      `});`,
    ].join("\n");

    const result = transform.call(plugin, code, "/app/layout.tsx");

    expect(result).not.toBeNull();
    expect(result.code).toContain(`_vinext: { font: { family: "myFont" } }`);
    expect(result.code).not.toMatch(/\/\/ c\n\s*,/);
  });

  it("does not produce double-comma when a string value contains `//` before a trailing comma", () => {
    // Hardening for #1973: a whole-slice comment strip also deletes the `//`
    // inside a string literal (e.g. a path with a double slash) and everything
    // after it on that line — swallowing the REAL trailing comma and causing a
    // second comma to be injected. The string-aware, end-only scan is not fooled.
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const myFont = localFont({`,
      `  src: "./fonts//my-font.woff2",`,
      `});`,
    ].join("\n");

    const result = transform.call(plugin, code, "/app/layout.tsx");

    expect(result).not.toBeNull();
    expect(result.code).toContain(`_vinext: { font: { family: "myFont" } }`);
    // The real trailing comma must be detected → no double comma injected.
    expect(result.code).not.toMatch(/,\s*,/);
  });

  // ── Object src with path property ────────────────────────────

  it("transforms a single source object with path property", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const myFont = localFont({ src: { path: "./font.woff2", weight: "400" } });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expectImported(result.code, "./font.woff2");
  });

  // ── Array of source objects ──────────────────────────────────

  it("transforms multiple font sources in an array", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const inter = localFont({`,
      `  src: [`,
      `    { path: "./fonts/InterVariable.woff2", weight: "100 900", style: "normal" },`,
      `    { path: "./fonts/InterVariable-Italic.woff2", weight: "100 900", style: "italic" },`,
      `  ],`,
      `  variable: "--font-inter",`,
      `});`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expectImported(result.code, "./fonts/InterVariable.woff2");
    expectImported(result.code, "./fonts/InterVariable-Italic.woff2");
  });

  // ── Font file extensions ─────────────────────────────────────

  it.each([".woff", ".ttf", ".otf", ".eot"])("transforms %s files", (ext) => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({ src: "./font${ext}" });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expectImported(result.code, `./font${ext}`);
  });

  // ── Quote styles ─────────────────────────────────────────────

  it("handles both single- and double-quoted paths", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    for (const code of [
      `import localFont from 'next/font/local';\nconst f = localFont({ src: './font.woff2' });`,
      `import localFont from 'next/font/local';\nconst f = localFont({ src: "./font.woff2" });`,
    ]) {
      const result = transform.call(plugin, code, "/app/layout.tsx");
      expect(result).not.toBeNull();
      expectImported(result.code, "./font.woff2");
    }
  });

  // ── Preserves other code ─────────────────────────────────────

  it("preserves non-font code alongside transforms", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import React from 'react';`,
      `import localFont from 'next/font/local';`,
      `import { useState } from 'react';`,
      ``,
      `const myFont = localFont({ src: "./font.woff2" });`,
      ``,
      `export default function Layout() { return null; }`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expectImported(result.code, "./font.woff2");
    // Non-font imports and export should be preserved
    expect(result.code).toContain(`import React from 'react'`);
    expect(result.code).toContain(`import { useState } from 'react'`);
    expect(result.code).toContain(`import localFont from 'next/font/local'`);
    expect(result.code).toContain("export default function Layout");
  });

  it("preserves variable and display options", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({`,
      `  src: "./font.woff2",`,
      `  variable: "--font-custom",`,
      `  display: "swap",`,
      `});`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain('variable: "--font-custom"');
    expect(result.code).toContain('display: "swap"');
  });

  // ── Path styles ──────────────────────────────────────────────

  it.each(["./assets/fonts/my-font.woff2", "../fonts/my-font.woff2"])(
    "handles path %s",
    (fontPath) => {
      const plugin = getLocalFontsPlugin();
      const transform = unwrapHook(plugin.transform);
      const code = [
        `import localFont from 'next/font/local';`,
        `const f = localFont({ src: "${fontPath}" });`,
      ].join("\n");
      const result = transform.call(plugin, code, "/app/layout.tsx");
      expect(result).not.toBeNull();
      expectImported(result.code, fontPath);
    },
  );

  // ── Security: CSS injection via font file paths ────────────

  it("escapes single quotes in font file paths to prevent CSS injection", () => {
    const beforeCount = getSSRFontStyles().length;

    // A crafted font path with a single quote could break out of url('...')
    const result = localFont({
      src: "./font'); } body { color: red; } .x { src: url('.woff2",
    });
    // The font should still load (it's escaped, not rejected)
    expect(result.className).toBeDefined();
    expect(result.style.fontFamily).toBeDefined();

    // Check that the generated CSS has the quote escaped
    const styles = getSSRFontStyles();
    const newStyles = styles.slice(beforeCount);
    const fontFaceCSS = newStyles.find((s: string) => s.includes("@font-face"));
    if (fontFaceCSS) {
      // Should contain escaped quote, not raw breakout
      expect(fontFaceCSS).not.toContain("url('./font');");
      expect(fontFaceCSS).toContain("\\'");
    }
  });

  it("escapes backslashes in font file paths", () => {
    const result = localFont({
      src: "./fonts\\evil.woff2",
    });
    expect(result.className).toBeDefined();
    expect(result.style.fontFamily).toBeDefined();
  });

  it("sanitizes fallback font names with CSS injection attempts", () => {
    const result = localFont({
      src: "./font.woff2",
      fallback: ["sans-serif", "'); } body { color: red; } .x { font-family: ('"],
    });
    expect(result.className).toBeDefined();
    // The malicious single quotes in the fallback should be escaped with \'
    // so they can't break out of the CSS string context
    expect(result.style.fontFamily).toContain("\\'");
    // Should still have sans-serif as a safe generic
    expect(result.style.fontFamily).toContain("sans-serif");
    // The malicious fallback should be wrapped in quotes (not used as a bare identifier)
    // so it's treated as a CSS string value. The sanitizeFallback function
    // wraps non-generic names in quotes and escapes internal quotes.
    expect(result.style.fontFamily).toMatch(/'\\'.*\\'/);
  });

  it("rejects invalid CSS variable names", () => {
    const beforeCount = getSSRFontStyles().length;
    const result = localFont({
      src: "./font.woff2",
      variable: "--x; } body { color: red; } .y { --z",
    });
    expect(result.className).toBeDefined();
    // The malicious variable should be rejected — no variable class should be injected
    const styles = getSSRFontStyles();
    const newStyles = styles.slice(beforeCount);
    // Should NOT contain the injection payload in any generated CSS
    for (const css of newStyles) {
      expect(css).not.toContain("color: red");
      expect(css).not.toContain("color:red");
    }
  });

  it("accepts valid CSS variable names", () => {
    const result = localFont({
      src: "./font.woff2",
      variable: "--font-custom",
    });
    expect(result.className).toBeDefined();
    // variable returns a class name, not the variable name
    expect(result.variable).toMatch(/^__variable_local_[0-9a-f]+$/);
  });

  it("uses the transform-provided binding name as the class font-family", () => {
    // Ported from Next.js: test/e2e/app-dir/mdx-font-preload/mdx-font-preload.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/mdx-font-preload/mdx-font-preload.test.ts
    const beforeCount = getSSRFontStyles().length;
    const options = {
      src: "/assets/font1_roboto.woff2",
      variable: "--font-my-font",
      _vinext: { font: { family: "myFont" } },
    } satisfies Parameters<typeof localFont>[0] & {
      _vinext: { font: { family: string } };
    };

    const result = localFont(options);

    expect(result.style.fontFamily).toContain("myFont");
    expect(result.style.fontFamily).not.toContain("__local_font");

    const addedStyles = getSSRFontStyles().slice(beforeCount).join("\n");
    expect(addedStyles).toContain(`.${result.className}`);
    expect(addedStyles).toContain("font-family: 'myFont'");
    expect(addedStyles).not.toContain("__local_font");
  });

  it("does not dedupe distinct font-face rules by repeated transformed binding names", () => {
    const beforeCount = getSSRFontStyles().length;
    const first = localFont({
      src: "/assets/module-a.woff2",
      _vinext: { font: { family: "myFont" } },
    } satisfies Parameters<typeof localFont>[0] & {
      _vinext: { font: { family: string } };
    });
    const second = localFont({
      src: "/assets/module-b.woff2",
      _vinext: { font: { family: "myFont" } },
    } satisfies Parameters<typeof localFont>[0] & {
      _vinext: { font: { family: string } };
    });

    expect(first.style.fontFamily).toContain("myFont");
    expect(second.style.fontFamily).toContain("myFont");

    const addedStyles = getSSRFontStyles().slice(beforeCount).join("\n");
    expect(addedStyles).toContain("/assets/module-a.woff2");
    expect(addedStyles).toContain("/assets/module-b.woff2");
  });

  it("rejects invalid transform-provided binding names and uses the generated family", () => {
    const beforeCount = getSSRFontStyles().length;
    const result = localFont({
      src: "/assets/invalid-family.woff2",
      _vinext: { font: { family: "myFont'} body { color: red; }" } },
    } satisfies Parameters<typeof localFont>[0] & {
      _vinext: { font: { family: string } };
    });

    expect(result.style.fontFamily).toMatch(/__local_font_\d+/);
    expect(result.style.fontFamily).not.toContain("myFont");

    const addedStyles = getSSRFontStyles().slice(beforeCount).join("\n");
    expect(addedStyles).toContain("font-family: '__local_font_");
    expect(addedStyles).not.toContain("myFont");
    expect(addedStyles).not.toContain("color: red");
  });

  it("rejects non-string transform-provided binding names before regex validation", () => {
    let toStringCalls = 0;
    const statefulFamily = {
      toString() {
        toStringCalls++;
        return toStringCalls === 1 ? "myFont" : "myFont'} body { color: red; }";
      },
    };
    const beforeCount = getSSRFontStyles().length;
    const result = localFont({
      src: "/assets/non-string-family.woff2",
      _vinext: { font: { family: statefulFamily } },
    });

    expect(result.style.fontFamily).toMatch(/__local_font_\d+/);
    expect(result.style.fontFamily).not.toContain("myFont");
    expect(toStringCalls).toBe(0);

    const addedStyles = getSSRFontStyles().slice(beforeCount).join("\n");
    expect(addedStyles).toContain("font-family: '__local_font_");
    expect(addedStyles).not.toContain("myFont");
    expect(addedStyles).not.toContain("color: red");
  });

  it("matches Next.js style exports for a single local source", () => {
    // Ported from Next.js: test/e2e/next-font/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/next-font/index.test.ts
    const beforeCount = getSSRFontStyles().length;
    const result = localFont({
      src: "./font.woff2",
      weight: "100",
      style: "italic",
    });

    expect(result.style).toMatchObject({
      fontWeight: 100,
      fontStyle: "italic",
    });

    const addedStyles = getSSRFontStyles().slice(beforeCount).join("\n");
    expect(addedStyles).toContain(`.${result.className}`);
    expect(addedStyles).toContain("font-weight: 100");
    expect(addedStyles).toContain("font-style: italic");
  });

  it("sanitizes declaration props to prevent injection", () => {
    const beforeCount = getSSRFontStyles().length;
    const result = localFont({
      src: "./font.woff2",
      declarations: [
        { prop: "font-weight", value: "400" }, // valid
        { prop: "} body { color: red; } .x { font-weight", value: "400" }, // malicious prop
      ],
    });
    expect(result.className).toBeDefined();
    const styles = getSSRFontStyles();
    const newStyles = styles.slice(beforeCount);
    // Valid declaration should be present
    const hasFontWeight = newStyles.some((s: string) => s.includes("font-weight: 400"));
    expect(hasFontWeight).toBe(true);
    // Malicious declaration should be rejected entirely
    for (const css of newStyles) {
      expect(css).not.toContain("color: red");
      expect(css).not.toContain("color:red");
    }
  });

  it("sanitizes declaration values to prevent injection", () => {
    const beforeCount = getSSRFontStyles().length;
    const result = localFont({
      src: "./font.woff2",
      declarations: [
        { prop: "font-weight", value: "400; } body { color: red; } .x { font-weight: 400" },
      ],
    });
    expect(result.className).toBeDefined();
    const styles = getSSRFontStyles();
    const newStyles = styles.slice(beforeCount);
    // The value with } should be rejected — no rule should contain the injection
    for (const css of newStyles) {
      expect(css).not.toContain("color: red");
      expect(css).not.toContain("color:red");
    }
  });

  it("rejects unsafe local font-style values in generated CSS", () => {
    const beforeCount = getSSRFontStyles().length;
    const result = localFont({
      src: "./font.woff2",
      style: "italic;}body{color:red",
    } as any);

    expect(result.style.fontStyle).toBeUndefined();

    const newStyles = getSSRFontStyles().slice(beforeCount).join("\n");
    expect(newStyles).not.toContain("color:red");
    expect(newStyles).not.toContain("color: red");
    expect(newStyles).not.toContain("italic;}body");
    expect(newStyles).toContain("font-style: normal");
  });

  // ── Sourcemap ────────────────────────────────────────────────

  it("generates a sourcemap", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({ src: "./font.woff2" });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.map).toBeDefined();
    expect(result.map.mappings).toBeDefined();
  });

  // ── Realistic layout example ─────────────────────────────────

  it("transforms a realistic Next.js layout file", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from "next/font/local";`,
      ``,
      `const inter = localFont({`,
      `  src: [`,
      `    { path: "./fonts/InterVariable.woff2", weight: "100 900", style: "normal" },`,
      `    { path: "./fonts/InterVariable-Italic.woff2", weight: "100 900", style: "italic" },`,
      `  ],`,
      `  variable: "--font-inter",`,
      `  display: "swap",`,
      `});`,
      ``,
      `export default function RootLayout({ children }: { children: React.ReactNode }) {`,
      `  return (`,
      `    <html lang="en" className={inter.variable}>`,
      `      <body>{children}</body>`,
      `    </html>`,
      `  );`,
      `}`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expectImported(result.code, "./fonts/InterVariable.woff2");
    expectImported(result.code, "./fonts/InterVariable-Italic.woff2");
    // Other options and JSX should be preserved
    expect(result.code).toContain('variable: "--font-inter"');
    expect(result.code).toContain('display: "swap"');
    expect(result.code).toContain("className={inter.variable}");
    expect(result.code).toContain("export default function RootLayout");
  });
});
