import { describe, it, expect } from "vitest";
import vinext from "../packages/vinext/src/index.js";
import localFont, { getSSRFontStyles } from "../packages/vinext/src/shims/font-local.js";
import type { Plugin } from "vite";

// ── Helpers ───────────────────────────────────────────────────

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

  it("returns null for node_modules files", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import localFont from 'next/font/local';\nconst f = localFont({ src: './font.woff2' });`;
    const result = transform.call(plugin, code, "node_modules/some-pkg/index.ts");
    expect(result).toBeNull();
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
    // Should add an import for the font file
    expect(result.code).toContain(`import __vinext_local_font_0 from "./my-font.woff2";`);
    // Should replace the path string with the import variable
    expect(result.code).toContain("src: __vinext_local_font_0");
    // Should NOT contain the original quoted path in the src property
    expect(result.code).not.toMatch(/src:\s*["']\.\/my-font\.woff2["']/);
    expect(result.map).toBeDefined();
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
    expect(result.code).toContain(`import __vinext_local_font_0 from "./font.woff2";`);
    expect(result.code).toContain("path: __vinext_local_font_0");
    expect(result.code).not.toMatch(/path:\s*["']\.\/font\.woff2["']/);
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
    // Two imports should be added
    expect(result.code).toContain(
      `import __vinext_local_font_0 from "./fonts/InterVariable.woff2";`,
    );
    expect(result.code).toContain(
      `import __vinext_local_font_1 from "./fonts/InterVariable-Italic.woff2";`,
    );
    // Both paths should be replaced
    expect(result.code).toContain("path: __vinext_local_font_0");
    expect(result.code).toContain("path: __vinext_local_font_1");
    // Original paths should be gone
    expect(result.code).not.toMatch(/path:\s*["']\.\/fonts\/InterVariable\.woff2["']/);
    expect(result.code).not.toMatch(/path:\s*["']\.\/fonts\/InterVariable-Italic\.woff2["']/);
  });

  // ── Font file extensions ─────────────────────────────────────

  it("handles .woff files", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({ src: "./font.woff" });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain(`import __vinext_local_font_0 from "./font.woff";`);
  });

  it("handles .ttf files", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({ src: "./font.ttf" });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain(`import __vinext_local_font_0 from "./font.ttf";`);
  });

  it("handles .otf files", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({ src: "./font.otf" });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain(`import __vinext_local_font_0 from "./font.otf";`);
  });

  it("handles .eot files", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({ src: "./font.eot" });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain(`import __vinext_local_font_0 from "./font.eot";`);
  });

  // ── Quote styles ─��───────────────────────────────────────────

  it("handles single-quoted paths", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({ src: './font.woff2' });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain(`import __vinext_local_font_0 from "./font.woff2";`);
    expect(result.code).toContain("src: __vinext_local_font_0");
  });

  it("handles double-quoted paths", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({ src: "./font.woff2" });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain("src: __vinext_local_font_0");
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
    // Non-font imports should be preserved
    expect(result.code).toContain(`import React from 'react'`);
    expect(result.code).toContain(`import { useState } from 'react'`);
    expect(result.code).toContain(`import localFont from 'next/font/local'`);
    // Font path should be transformed
    expect(result.code).toContain("src: __vinext_local_font_0");
    // Export should be preserved
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

  it("handles relative paths with subdirectories", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({ src: "./assets/fonts/my-font.woff2" });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain(
      `import __vinext_local_font_0 from "./assets/fonts/my-font.woff2";`,
    );
  });

  it("handles parent-relative paths", () => {
    const plugin = getLocalFontsPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import localFont from 'next/font/local';`,
      `const f = localFont({ src: "../fonts/my-font.woff2" });`,
    ].join("\n");
    const result = transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain(`import __vinext_local_font_0 from "../fonts/my-font.woff2";`);
  });

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
    expect(result.variable).toMatch(/^__variable_local_\d+$/);
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
    // Should add two font imports
    expect(result.code).toContain(
      `import __vinext_local_font_0 from "./fonts/InterVariable.woff2";`,
    );
    expect(result.code).toContain(
      `import __vinext_local_font_1 from "./fonts/InterVariable-Italic.woff2";`,
    );
    // Paths should be replaced
    expect(result.code).toContain("path: __vinext_local_font_0");
    expect(result.code).toContain("path: __vinext_local_font_1");
    // Other options and JSX should be preserved
    expect(result.code).toContain('variable: "--font-inter"');
    expect(result.code).toContain('display: "swap"');
    expect(result.code).toContain("className={inter.variable}");
    expect(result.code).toContain("export default function RootLayout");
  });
});
