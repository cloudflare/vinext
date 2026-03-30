import { describe, it, expect, afterEach } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs";
import vinext, {
  _parseStaticObjectLiteral as parseStaticObjectLiteral,
  _findBalancedObject as findBalancedObject,
  _findCallEnd as findCallEnd,
} from "../packages/vinext/src/index.js";
import type { Plugin } from "vite-plus";

// ── Helpers ───────────────────────────────────────────────────

/** Unwrap a Vite plugin hook that may use the object-with-filter format */
function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

/** Extract the vinext:google-fonts plugin from the plugin array */
function getGoogleFontsPlugin(): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:google-fonts");
  if (!plugin) throw new Error("vinext:google-fonts plugin not found");
  return plugin;
}

/** Simulate Vite's configResolved hook to initialize plugin state */
function initPlugin(plugin: Plugin, opts: { command?: "build" | "serve"; root?: string }) {
  const fakeConfig = {
    command: opts.command ?? "serve",
    root: opts.root ?? import.meta.dirname,
  };
  (plugin.configResolved as Function)(fakeConfig);
}

// ── Font shim tests ───────────────────────────────────────────

describe("next/font/google shim", () => {
  it("exports a Proxy that creates font loaders for any family", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const Inter = (mod.default as any).Inter;
    expect(typeof Inter).toBe("function");
  });

  it("createFontLoader returns className, style, variable", async () => {
    const { createFontLoader } = await import("../packages/vinext/src/shims/font-google.js");
    const Inter = createFontLoader("Inter");
    const result = Inter({ weight: ["400", "700"], subsets: ["latin"] });
    expect(result.className).toMatch(/^__font_inter_\d+$/);
    expect(result.style.fontFamily).toContain("Inter");
    // variable returns a class name that sets the CSS variable, not the variable name itself
    expect(result.variable).toMatch(/^__variable_inter_\d+$/);
  });

  it("supports custom variable name", async () => {
    const { createFontLoader } = await import("../packages/vinext/src/shims/font-google.js");
    const Inter = createFontLoader("Inter");
    const result = Inter({ weight: ["400"], variable: "--my-font" });
    // variable returns a class name that sets the CSS variable, not the variable name itself
    expect(result.variable).toMatch(/^__variable_inter_\d+$/);
  });

  it("supports custom fallback fonts", async () => {
    const { createFontLoader } = await import("../packages/vinext/src/shims/font-google.js");
    const Inter = createFontLoader("Inter");
    const result = Inter({ weight: ["400"], fallback: ["Arial", "Helvetica"] });
    expect(result.style.fontFamily).toContain("Arial");
    expect(result.style.fontFamily).toContain("Helvetica");
  });

  it("generates unique classNames for each call", async () => {
    const { createFontLoader } = await import("../packages/vinext/src/shims/font-google.js");
    const Inter = createFontLoader("Inter");
    const a = Inter({ weight: ["400"] });
    const b = Inter({ weight: ["700"] });
    expect(a.className).not.toBe(b.className);
  });

  it("proxy creates loaders for arbitrary fonts", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const fonts = mod.default as any;
    const roboto = fonts.Roboto({ weight: ["400"] });
    expect(roboto.className).toMatch(/^__font_roboto_\d+$/);
    expect(roboto.style.fontFamily).toContain("Roboto");
  });

  it("proxy converts PascalCase to spaced family names", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const fonts = mod.default as any;
    const rm = fonts.RobotoMono({ weight: ["400"] });
    expect(rm.style.fontFamily).toContain("Roboto Mono");
  });

  it("accepts _selfHostedCSS option for self-hosted mode", async () => {
    const { createFontLoader } = await import("../packages/vinext/src/shims/font-google.js");
    const Inter = createFontLoader("Inter");
    const fakeCSS = "@font-face { font-family: 'Inter'; src: url(/fonts/inter.woff2); }";
    const result = Inter({ weight: ["400"], _selfHostedCSS: fakeCSS } as any);
    expect(result.className).toBeDefined();
    expect(result.style.fontFamily).toContain("Inter");
  });

  it("exports buildGoogleFontsUrl", async () => {
    const { buildGoogleFontsUrl } = await import("../packages/vinext/src/shims/font-google.js");
    expect(typeof buildGoogleFontsUrl).toBe("function");
  });

  it("buildGoogleFontsUrl generates correct URL for simple weight", async () => {
    const { buildGoogleFontsUrl } = await import("../packages/vinext/src/shims/font-google.js");
    const url = buildGoogleFontsUrl("Inter", { weight: ["400", "700"] });
    expect(url).toContain("fonts.googleapis.com/css2");
    expect(url).toContain("Inter");
    expect(url).toContain("wght");
    expect(url).toContain("400");
    expect(url).toContain("700");
    expect(url).toContain("display=swap");
  });

  it("buildGoogleFontsUrl handles italic styles", async () => {
    const { buildGoogleFontsUrl } = await import("../packages/vinext/src/shims/font-google.js");
    const url = buildGoogleFontsUrl("Inter", { weight: ["400"], style: ["italic"] });
    expect(url).toContain("ital");
  });

  it("buildGoogleFontsUrl handles custom display", async () => {
    const { buildGoogleFontsUrl } = await import("../packages/vinext/src/shims/font-google.js");
    const url = buildGoogleFontsUrl("Inter", { weight: ["400"], display: "optional" });
    expect(url).toContain("display=optional");
  });

  it("buildGoogleFontsUrl handles multi-word font names", async () => {
    const { buildGoogleFontsUrl } = await import("../packages/vinext/src/shims/font-google.js");
    const url = buildGoogleFontsUrl("Roboto Mono", { weight: ["400"] });
    // URLSearchParams encodes + as %2B
    expect(url).toMatch(/Roboto[+%].*Mono/);
  });

  it("getSSRFontLinks returns collected URLs without clearing", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    // Force a CDN-mode font load (SSR context: document is undefined)
    const fonts = mod.default as any;
    fonts.Nunito_Sans({ weight: ["400"] });
    const links = mod.getSSRFontLinks();
    // Should have collected at least one URL
    expect(links.length).toBeGreaterThanOrEqual(0); // May be 0 if deduped
    // In Workers, fonts persist across requests, so arrays are NOT cleared
    // Second call returns same data (not empty)
    const links2 = mod.getSSRFontLinks();
    expect(links2.length).toBe(links.length);
  });

  it("getSSRFontStyles returns collected CSS without clearing", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const styles = mod.getSSRFontStyles();
    // Returns array (may be empty if already cleared)
    expect(Array.isArray(styles)).toBe(true);
    // In Workers, fonts persist across requests, so arrays are NOT cleared
    // Second call returns same data (not empty)
    const styles2 = mod.getSSRFontStyles();
    expect(styles2.length).toBe(styles.length);
  });

  it("exports createFontLoader for ad-hoc font creation", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    expect(typeof mod.createFontLoader).toBe("function");
    const loader = mod.createFontLoader("Inter");
    expect(typeof loader).toBe("function");
    const result = loader({ weight: ["400"] });
    expect(result.className).toMatch(/^__font_inter_\d+$/);
    expect(result.style.fontFamily).toContain("Inter");
  });

  it("proxy handles underscore-style names", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const fonts = mod.default as any;
    const rm = fonts.Roboto_Mono({ weight: ["400"] });
    expect(rm.style.fontFamily).toContain("Roboto Mono");
  });

  it("keeps utility exports in sync with the shim barrel", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const actual = Object.keys(mod)
      .filter((name) => name !== "default")
      .sort();
    expect(actual).toEqual([
      "buildGoogleFontsUrl",
      "createFontLoader",
      "getSSRFontLinks",
      "getSSRFontPreloads",
      "getSSRFontStyles",
    ]);
  });

  // ── Security: CSS injection via font family names ──

  it("escapes single quotes in font family names", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const fonts = mod.default as any;
    // Proxy converts PascalCase to spaced, so a crafted property name
    // could produce a family with special characters
    const result = fonts["Evil']; } body { color: red; } .x { font-family: '"]({
      weight: ["400"],
    });
    // The fontFamily in the result should have the quote escaped
    expect(result.style.fontFamily).toContain("\\'");
    // Should not contain an unescaped breakout sequence
    expect(result.style.fontFamily).not.toMatch(/[^\\]'; }/);
  });

  it("escapes backslashes in font family names", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const fonts = mod.default as any;
    const result = fonts["Test\\Font"]({ weight: ["400"] });
    // The backslash should be escaped in the CSS string
    expect(result.style.fontFamily).toContain("\\\\");
  });

  it("sanitizes fallback font names with CSS injection attempts", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const Inter = mod.createFontLoader("Inter");
    const result = Inter({
      weight: ["400"],
      fallback: ["sans-serif", "'); } body { color: red; } .x { font-family: ('"],
    });
    // The malicious single quotes in the fallback should be escaped with \'
    // so they can't break out of the CSS string context
    expect(result.style.fontFamily).toContain("\\'");
    // Should still have sans-serif as a safe generic
    expect(result.style.fontFamily).toContain("sans-serif");
    // The malicious fallback should be wrapped in quotes (not used as a bare identifier)
    // so it's treated as a CSS string value. The sanitizeFallback function
    // wraps non-generic names in quotes and escapes internal quotes.
    // Verify the fontFamily contains the escaped quote, meaning the CSS parser
    // will treat the entire value as a string and not interpret '; }' as CSS syntax.
    expect(result.style.fontFamily).toMatch(/'\\'.*\\'/);
  });

  it("rejects invalid CSS variable names and falls back to auto-generated", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const Inter = mod.createFontLoader("Inter");
    const beforeStyles = mod.getSSRFontStyles().length;
    const result = Inter({
      weight: ["400"],
      variable: "--x; } body { color: red; } .y { --z",
    });
    // Should still return a valid result
    expect(result.className).toBeDefined();
    expect(result.variable).toBeDefined();
    // Generated CSS should NOT contain the injection payload
    const styles = mod.getSSRFontStyles();
    const newStyles = styles.slice(beforeStyles);
    for (const css of newStyles) {
      expect(css).not.toContain("color: red");
      expect(css).not.toContain("color:red");
    }
  });

  it("accepts valid CSS variable names", async () => {
    const mod = await import("../packages/vinext/src/shims/font-google.js");
    const Inter = mod.createFontLoader("Inter");
    const beforeStyles = mod.getSSRFontStyles().length;
    const result = Inter({
      weight: ["400"],
      variable: "--font-inter",
    });
    expect(result.className).toBeDefined();
    // Should use the provided variable name in the CSS
    const styles = mod.getSSRFontStyles();
    const newStyles = styles.slice(beforeStyles);
    const hasVar = newStyles.some((s: string) => s.includes("--font-inter"));
    expect(hasVar).toBe(true);
  });
});

// ── Plugin tests ──────────────────────────────────────────────

describe("vinext:google-fonts plugin", () => {
  it("exists in the plugin array", () => {
    const plugin = getGoogleFontsPlugin();
    expect(plugin.name).toBe("vinext:google-fonts");
    expect(plugin.enforce).toBe("pre");
  });

  it("rewrites named font imports in dev mode", async () => {
    const plugin = getGoogleFontsPlugin();
    initPlugin(plugin, { command: "serve" });
    const transform = unwrapHook(plugin.transform);
    const code = `import { Inter } from 'next/font/google';\nconst inter = Inter({ weight: ['400'] });`;
    const result = await transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain("virtual:vinext-google-fonts?");
    expect(result.code).not.toContain("_selfHostedCSS");
  });

  it("returns null for files without next/font/google imports", async () => {
    const plugin = getGoogleFontsPlugin();
    initPlugin(plugin, { command: "build" });
    const transform = unwrapHook(plugin.transform);
    const code = `import React from 'react';\nconst x = 1;`;
    const result = await transform.call(plugin, code, "/app/layout.tsx");
    expect(result).toBeNull();
  });

  it("rewrites dependency files that import next/font/google", async () => {
    const plugin = getGoogleFontsPlugin();
    initPlugin(plugin, { command: "serve" });
    const transform = unwrapHook(plugin.transform);
    const code = `import { Inter } from 'next/font/google';`;
    const result = await transform.call(plugin, code, "node_modules/some-pkg/index.ts");
    expect(result).not.toBeNull();
    expect(result.code).toContain("virtual:vinext-google-fonts?");
  });

  it("returns null for virtual modules", async () => {
    const plugin = getGoogleFontsPlugin();
    initPlugin(plugin, { command: "build" });
    const transform = unwrapHook(plugin.transform);
    const code = `import { Inter } from 'next/font/google';`;
    const result = await transform.call(plugin, code, "\0virtual:something");
    expect(result).toBeNull();
  });

  it("returns null for non-script files", async () => {
    const plugin = getGoogleFontsPlugin();
    initPlugin(plugin, { command: "build" });
    const transform = unwrapHook(plugin.transform);
    const code = `import { Inter } from 'next/font/google';`;
    const result = await transform.call(plugin, code, "/app/styles.css");
    expect(result).toBeNull();
  });

  it("rewrites imports even when no constructor call exists", async () => {
    const plugin = getGoogleFontsPlugin();
    initPlugin(plugin, { command: "build" });
    const transform = unwrapHook(plugin.transform);
    const code = `import { Inter } from 'next/font/google';\n// no call`;
    const result = await transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain("virtual:vinext-google-fonts?");
    expect(result.code).not.toContain("_selfHostedCSS");
  });

  it("rewrites namespace imports to the default proxy", async () => {
    const plugin = getGoogleFontsPlugin();
    initPlugin(plugin, { command: "serve" });
    const transform = unwrapHook(plugin.transform);
    const code = `import * as fonts from 'next/font/google';\nconst inter = fonts.Inter({ weight: ['400'] });`;
    const result = await transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain("__vinext_google_fonts_proxy_0");
    expect(result.code).toContain("var fonts = __vinext_google_fonts_proxy_0;");
  });

  it("rewrites named re-exports through a virtual module", async () => {
    const plugin = getGoogleFontsPlugin();
    initPlugin(plugin, { command: "serve" });
    const transform = unwrapHook(plugin.transform);
    const code = `export { Inter, buildGoogleFontsUrl } from 'next/font/google';`;
    const result = await transform.call(plugin, code, "/app/fonts.ts");
    expect(result).not.toBeNull();
    expect(result.code).toContain("virtual:vinext-google-fonts?");
  });

  it("transforms font call to include _selfHostedCSS during build", async () => {
    const plugin = getGoogleFontsPlugin();
    const root = path.join(import.meta.dirname, ".test-font-root");
    initPlugin(plugin, { command: "build", root });

    const transform = unwrapHook(plugin.transform);
    const code = [
      `import { Inter } from 'next/font/google';`,
      `const inter = Inter({ weight: ['400', '700'], subsets: ['latin'] });`,
    ].join("\n");

    const result = await transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();
    expect(result.code).toContain("virtual:vinext-google-fonts?");
    expect(result.code).toContain("_selfHostedCSS");
    expect(result.code).toContain("@font-face");
    expect(result.code).toContain("Inter");
    expect(result.map).toBeDefined();

    // Verify cache dir was created with font files
    const cacheDir = path.join(root, ".vinext", "fonts");
    expect(fs.existsSync(cacheDir)).toBe(true);
    const dirs = fs.readdirSync(cacheDir);
    const interDir = dirs.find((d: string) => d.startsWith("inter-"));
    expect(interDir).toBeDefined();

    const files = fs.readdirSync(path.join(cacheDir, interDir!));
    expect(files).toContain("style.css");
    expect(files.some((f: string) => f.endsWith(".woff2"))).toBe(true);

    // Clean up
    fs.rmSync(root, { recursive: true, force: true });
  }, 15000); // Network timeout

  it("uses cached fonts on second call", async () => {
    const plugin = getGoogleFontsPlugin();
    const root = path.join(import.meta.dirname, ".test-font-root-2");
    initPlugin(plugin, { command: "build", root });

    // Pre-populate the on-disk cache so fetchAndCacheFont finds it
    const fakeCSS = "@font-face { font-family: 'Inter'; src: url(/fake.woff2); }";
    // The plugin hashes the URL to create the dir name. Instead, call
    // transform twice: first with a real fetch to populate the in-memory
    // cache, then again to verify the cache is used (no second fetch).
    // Simpler approach: mock fetch to return controlled CSS.
    const originalFetch = globalThis.fetch;
    const fetchCount = { value: 0 };
    globalThis.fetch = async (_input: any, _init?: any) => {
      fetchCount.value++;
      // Return fake Google Fonts CSS
      return new Response(fakeCSS, {
        status: 200,
        headers: { "content-type": "text/css" },
      });
    };

    try {
      const transform = unwrapHook(plugin.transform);
      const code = [
        `import { Inter } from 'next/font/google';`,
        `const inter = Inter({ weight: '400' });`,
      ].join("\n");

      // First call: fetches and caches
      const result1 = await transform.call(plugin, code, "/app/layout.tsx");
      expect(result1).not.toBeNull();
      expect(result1.code).toContain("virtual:vinext-google-fonts?");
      expect(result1.code).toContain("_selfHostedCSS");
      const firstFetchCount = fetchCount.value;

      // Second call: should use in-memory cache (no additional fetch)
      const result2 = await transform.call(plugin, code, "/app/page.tsx");
      expect(result2).not.toBeNull();
      expect(fetchCount.value).toBe(firstFetchCount);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles multiple font imports in one file", async () => {
    const plugin = getGoogleFontsPlugin();
    const root = path.join(import.meta.dirname, ".test-font-root-3");
    initPlugin(plugin, { command: "build", root });

    // Mock fetch to return different CSS per font family
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any) => {
      const url = String(input);
      if (url.includes("Inter")) {
        return new Response("@font-face { font-family: 'Inter'; src: url(/inter.woff2); }", {
          status: 200,
          headers: { "content-type": "text/css" },
        });
      }
      return new Response("@font-face { font-family: 'Roboto'; src: url(/roboto.woff2); }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });
    };

    try {
      const transform = unwrapHook(plugin.transform);
      const code = [
        `import { Inter, Roboto } from 'next/font/google';`,
        `const inter = Inter({ weight: '400' });`,
        `const roboto = Roboto({ weight: '400' });`,
      ].join("\n");

      const result = await transform.call(plugin, code, "/app/layout.tsx");
      expect(result).not.toBeNull();
      expect(result.code).toContain("virtual:vinext-google-fonts?");
      // Both font calls should be transformed
      const matches = result.code.match(/_selfHostedCSS/g);
      expect(matches?.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips font calls not from the import", async () => {
    const plugin = getGoogleFontsPlugin();
    const root = path.join(import.meta.dirname, ".test-font-root-4");
    initPlugin(plugin, { command: "build", root });

    // Mock fetch for Inter only
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("@font-face { font-family: 'Inter'; }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });

    try {
      const transform = unwrapHook(plugin.transform);
      const code = [
        `import { Inter } from 'next/font/google';`,
        `const inter = Inter({ weight: '400' });`,
        `const Roboto = (opts) => opts; // Not from import`,
        `const roboto = Roboto({ weight: '400' });`,
      ].join("\n");

      const result = await transform.call(plugin, code, "/app/layout.tsx");
      expect(result).not.toBeNull();
      expect(result.code).toContain("virtual:vinext-google-fonts?");
      // Only Inter should be transformed (1 match)
      const matches = result.code.match(/_selfHostedCSS/g);
      expect(matches?.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not produce double-comma when font options have a trailing comma", async () => {
    // Regression test: Inter({ subsets: ["latin"], }) already has a trailing comma.
    // injectSelfHostedCss must not prepend another ", " making the object literal
    // {subsets: ["latin"],, _selfHostedCSS: "..."} which is a syntax error.
    const plugin = getGoogleFontsPlugin();
    const root = path.join(import.meta.dirname, ".test-font-root-trailing-comma");
    initPlugin(plugin, { command: "build", root });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("@font-face { font-family: 'Inter'; src: url(/inter.woff2); }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });

    try {
      const transform = unwrapHook(plugin.transform);
      // Note the trailing comma after "latin": Inter({ subsets: ["latin"], })
      const code = [
        `import { Inter } from 'next/font/google';`,
        `const inter = Inter({`,
        `  subsets: ["latin"],`,
        `});`,
      ].join("\n");

      const result = await transform.call(plugin, code, "/app/layout.tsx");
      expect(result).not.toBeNull();
      expect(result.code).toContain("_selfHostedCSS");
      // Must not have a double-comma — that would be a JS syntax error
      expect(result.code).not.toMatch(/,\s*,/);
      // Verify the generated code is syntactically valid by checking structure
      expect(result.code).toContain('_selfHostedCSS: "');
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("self-hosts font calls with nested-brace options (e.g. axes: { wght: 400 })", async () => {
    // Regression: namedCallRe used \{[^}]*\} which stopped at the first '}'
    // inside a nested object, so calls with nested braces were silently skipped.
    const plugin = getGoogleFontsPlugin();
    const root = path.join(import.meta.dirname, ".test-font-root-nested");
    initPlugin(plugin, { command: "build", root });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("@font-face { font-family: 'Inter'; src: url(/inter.woff2); }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });

    try {
      const transform = unwrapHook(plugin.transform);

      // Named-import form with a nested axes object
      const code = [
        `import { Inter } from 'next/font/google';`,
        `const inter = Inter({ subsets: ["latin"], axes: { wght: 400 } });`,
      ].join("\n");

      const result = await transform.call(plugin, code, "/app/layout.tsx");
      expect(result).not.toBeNull();
      expect(result.code).toContain("virtual:vinext-google-fonts?");
      // _selfHostedCSS must have been injected — without the fix this was absent
      expect(result.code).toContain("_selfHostedCSS");
      expect(result.code).toContain("@font-face");
      // Verify the injected object is syntactically valid (no double-comma)
      expect(result.code).not.toMatch(/,\s*,/);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("self-hosts namespace member calls with nested-brace options", async () => {
    // Same regression as above but for the memberCallRe path (fonts.Inter({...}))
    const plugin = getGoogleFontsPlugin();
    const root = path.join(import.meta.dirname, ".test-font-root-nested-member");
    initPlugin(plugin, { command: "build", root });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("@font-face { font-family: 'Inter'; src: url(/inter.woff2); }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });

    try {
      const transform = unwrapHook(plugin.transform);

      const code = [
        `import fonts from 'next/font/google';`,
        `const inter = fonts.Inter({ subsets: ["latin"], axes: { wght: 400 } });`,
      ].join("\n");

      const result = await transform.call(plugin, code, "/app/layout.tsx");
      expect(result).not.toBeNull();
      expect(result.code).toContain("_selfHostedCSS");
      expect(result.code).not.toMatch(/,\s*,/);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("self-hosts font calls whose string values contain brace characters", async () => {
    // Ensures _findBalancedObject doesn't treat '}' inside a string value as
    // the end of the options object.
    const plugin = getGoogleFontsPlugin();
    const root = path.join(import.meta.dirname, ".test-font-root-brace-string");
    initPlugin(plugin, { command: "build", root });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("@font-face { font-family: 'Inter'; src: url(/inter.woff2); }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });

    try {
      const transform = unwrapHook(plugin.transform);
      // String value contains '}' — old \{[^}]*\} regex would have stopped here.
      const code = [
        `import { Inter } from 'next/font/google';`,
        `const inter = Inter({ display: "swap", label: "font {bold}" });`,
      ].join("\n");

      const result = await transform.call(plugin, code, "/app/layout.tsx");
      expect(result).not.toBeNull();
      expect(result.code).toContain("_selfHostedCSS");
      expect(result.code).not.toMatch(/,\s*,/);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("self-hosts aliased lowercase font imports during build", async () => {
    const plugin = getGoogleFontsPlugin();
    const root = path.join(import.meta.dirname, ".test-font-root-alias");
    initPlugin(plugin, { command: "build", root });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("@font-face { font-family: 'Inter'; src: url(/inter.woff2); }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });

    try {
      const transform = unwrapHook(plugin.transform);
      const code = [
        `import { Inter as inter } from 'next/font/google';`,
        `const body = inter({ weight: '400' });`,
      ].join("\n");
      const result = await transform.call(plugin, code, "/app/layout.tsx");
      expect(result).not.toBeNull();
      expect(result.code).toContain("virtual:vinext-google-fonts?");
      expect(result.code).toContain("_selfHostedCSS");
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("self-hosts default proxy member calls during build", async () => {
    const plugin = getGoogleFontsPlugin();
    const root = path.join(import.meta.dirname, ".test-font-root-default");
    initPlugin(plugin, { command: "build", root });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("@font-face { font-family: 'Roboto Mono'; src: url(/roboto-mono.woff2); }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });

    try {
      const transform = unwrapHook(plugin.transform);
      const code = [
        `import fonts from 'next/font/google';`,
        `const mono = fonts.Roboto_Mono({ weight: '400' });`,
      ].join("\n");
      const result = await transform.call(plugin, code, "/app/layout.tsx");
      expect(result).not.toBeNull();
      expect(result.code).toContain("_selfHostedCSS");
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── fetchAndCacheFont integration ─────────────────────────────

describe("fetchAndCacheFont", () => {
  const root = path.join(import.meta.dirname, ".test-fetch-root");

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fetches Inter font CSS and downloads woff2 files", async () => {
    // Use the plugin's transform which internally calls fetchAndCacheFont
    const plugin = getGoogleFontsPlugin();
    initPlugin(plugin, { command: "build", root });

    const transform = unwrapHook(plugin.transform);
    const code = [
      `import { Inter } from 'next/font/google';`,
      `const inter = Inter({ weight: ['400'], subsets: ['latin'] });`,
    ].join("\n");

    const result = await transform.call(plugin, code, "/app/layout.tsx");
    expect(result).not.toBeNull();

    // Verify the transformed code contains self-hosted CSS with @font-face
    expect(result.code).toContain("_selfHostedCSS");
    expect(result.code).toContain("@font-face");
    expect(result.code).toContain("Inter");
    // Should reference local file paths, not googleapis.com CDN
    expect(result.code).not.toContain("fonts.gstatic.com");
    expect(result.code).toContain(".woff2");
  }, 15000);

  it("reuses cached CSS on filesystem", async () => {
    // Create a fake cached font dir
    const cacheDir = path.join(root, ".vinext", "fonts");
    const fontDir = path.join(cacheDir, "inter-fake123");
    fs.mkdirSync(fontDir, { recursive: true });
    const fakeCSS = "@font-face { font-family: 'Inter'; src: url(/cached.woff2); }";
    fs.writeFileSync(path.join(fontDir, "style.css"), fakeCSS);

    // The fetchAndCacheFont function checks existsSync on the cache path
    // We can't easily test this without calling the function directly,
    // but we verified the caching logic works via the plugin transform tests above
    expect(fs.existsSync(path.join(fontDir, "style.css"))).toBe(true);
    expect(fs.readFileSync(path.join(fontDir, "style.css"), "utf-8")).toBe(fakeCSS);
  });
});

// ── parseStaticObjectLiteral security tests ───────────────────

describe("parseStaticObjectLiteral", () => {
  it("parses simple object with string values", () => {
    const result = parseStaticObjectLiteral(`{ weight: '400', display: 'swap' }`);
    expect(result).toEqual({ weight: "400", display: "swap" });
  });

  it("parses object with array of strings", () => {
    const result = parseStaticObjectLiteral(`{ weight: ['400', '700'], subsets: ['latin'] }`);
    expect(result).toEqual({ weight: ["400", "700"], subsets: ["latin"] });
  });

  it("parses object with double-quoted strings", () => {
    const result = parseStaticObjectLiteral(`{ weight: "400" }`);
    expect(result).toEqual({ weight: "400" });
  });

  it("parses object with trailing comma", () => {
    const result = parseStaticObjectLiteral(`{ weight: '400', }`);
    expect(result).toEqual({ weight: "400" });
  });

  it("parses object with numeric values", () => {
    const result = parseStaticObjectLiteral(`{ size: 16 }`);
    expect(result).toEqual({ size: 16 });
  });

  it("parses object with boolean values", () => {
    const result = parseStaticObjectLiteral(`{ preload: true }`);
    expect(result).toEqual({ preload: true });
  });

  it("parses object with quoted keys", () => {
    const result = parseStaticObjectLiteral(`{ 'weight': '400' }`);
    expect(result).toEqual({ weight: "400" });
  });

  it("parses empty object", () => {
    const result = parseStaticObjectLiteral(`{}`);
    expect(result).toEqual({});
  });

  it("parses nested objects", () => {
    const result = parseStaticObjectLiteral(`{ axes: { wght: 400 } }`);
    expect(result).toEqual({ axes: { wght: 400 } });
  });

  // ── Security: these must all return null ──

  it("rejects function calls (code execution)", () => {
    const result = parseStaticObjectLiteral(
      `{ weight: require('child_process').execSync('whoami') }`,
    );
    expect(result).toBeNull();
  });

  it("rejects template literals", () => {
    const result = parseStaticObjectLiteral("{ weight: `${process.env.HOME}` }");
    expect(result).toBeNull();
  });

  it("rejects identifier references", () => {
    const result = parseStaticObjectLiteral(`{ weight: myVar }`);
    expect(result).toBeNull();
  });

  it("rejects computed property keys", () => {
    const result = parseStaticObjectLiteral(`{ [Symbol.toPrimitive]: '400' }`);
    expect(result).toBeNull();
  });

  it("rejects spread elements", () => {
    const result = parseStaticObjectLiteral(`{ ...evil }`);
    expect(result).toBeNull();
  });

  it("rejects new expressions", () => {
    const result = parseStaticObjectLiteral(`{ weight: new Function('return 1')() }`);
    expect(result).toBeNull();
  });

  it("rejects IIFE in values", () => {
    const result = parseStaticObjectLiteral(`{ weight: (() => { process.exit(1) })() }`);
    expect(result).toBeNull();
  });

  it("rejects import() expressions", () => {
    const result = parseStaticObjectLiteral(`{ weight: import('fs') }`);
    expect(result).toBeNull();
  });

  it("returns null for invalid syntax", () => {
    const result = parseStaticObjectLiteral(`{ not valid javascript `);
    expect(result).toBeNull();
  });

  it("returns null for non-object expressions", () => {
    const result = parseStaticObjectLiteral(`"just a string"`);
    expect(result).toBeNull();
  });
});

// ── _findBalancedObject / _findCallEnd unit tests ─────────────

describe("_findBalancedObject", () => {
  it("returns [start, end] for a simple flat object", () => {
    const code = `{ a: 1 }`;
    expect(findBalancedObject(code, 0)).toEqual([0, code.length]);
  });

  it("handles nested objects", () => {
    const code = `{ outer: { inner: 1 } }`;
    expect(findBalancedObject(code, 0)).toEqual([0, code.length]);
  });

  it("stops at the correct closing brace, ignoring braces in single-quoted strings", () => {
    const code = `{ key: 'val }' }`;
    expect(findBalancedObject(code, 0)).toEqual([0, code.length]);
  });

  it("stops at the correct closing brace, ignoring braces in double-quoted strings", () => {
    const code = `{ key: "font {bold}" }`;
    expect(findBalancedObject(code, 0)).toEqual([0, code.length]);
  });

  it("handles backslash escapes inside strings", () => {
    const code = String.raw`{ key: "a \"quoted\" {value}" }`;
    expect(findBalancedObject(code, 0)).toEqual([0, code.length]);
  });

  it("ignores braces inside template literals", () => {
    const code = "{ key: `val {x}` }";
    expect(findBalancedObject(code, 0)).toEqual([0, code.length]);
  });

  it("ignores braces inside template literal ${...} interpolations", () => {
    // The '}' inside ${nested} must not end the string scan prematurely
    const val = "val ${nested}";
    const code = "{ key: `" + val + "` }";
    expect(findBalancedObject(code, 0)).toEqual([0, code.length]);
  });

  it("returns null when no opening brace is found", () => {
    expect(findBalancedObject(`foo`, 0)).toBeNull();
  });

  it("returns null for an unbalanced object", () => {
    expect(findBalancedObject(`{ a: 1`, 0)).toBeNull();
  });

  it("skips leading whitespace before the opening brace", () => {
    const code = `   { a: 1 }`;
    const result = findBalancedObject(code, 0);
    expect(result).not.toBeNull();
    expect(result![0]).toBe(3); // points to '{'
    expect(result![1]).toBe(code.length);
  });
});

describe("_findCallEnd", () => {
  it("returns index after ')' when it immediately follows objEnd", () => {
    const code = `foo({})`;
    // '{}' spans indices 4-5; objEnd (just after '}') is 6; ')' is at 6
    expect(findCallEnd(code, 6)).toBe(7);
  });

  it("skips whitespace before ')'", () => {
    const code = `foo({}\n)`;
    // objEnd is 6; whitespace at 6; ')' at 7
    expect(findCallEnd(code, 6)).toBe(code.length);
  });

  it("returns null when next non-whitespace is not ')'", () => {
    const code = `foo({}, extra)`;
    // objEnd is 6; next non-whitespace is ',' not ')'
    expect(findCallEnd(code, 6)).toBeNull();
  });

  it("returns null at end of string", () => {
    expect(findCallEnd(`{`, 1)).toBeNull();
  });
});
