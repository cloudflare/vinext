import { describe, it, expect } from "vitest";
import {
  escapeCSSString,
  sanitizeCSSVarName,
  sanitizeFallback,
  sanitizeCSSProperty,
  sanitizeCSSValue,
  simpleHash,
  createFontSSRState,
  injectFontFaceCSS,
  injectSelfHostedCSS,
  injectClassNameRule,
  injectVariableClassRule,
  injectFontStylesheet,
  collectFontPreloads,
} from "../packages/vinext/src/shims/font-utils.js";

// ── escapeCSSString ──────────────────────────────────────────

describe("escapeCSSString", () => {
  it("escapes single quotes", () => {
    expect(escapeCSSString("it's")).toBe("it\\'s");
  });

  it("escapes backslashes", () => {
    expect(escapeCSSString("foo\\bar")).toBe("foo\\\\bar");
  });

  it("escapes newlines and carriage returns", () => {
    expect(escapeCSSString("line\none")).toBe("line\\a one");
    expect(escapeCSSString("line\rone")).toBe("line\\d one");
  });

  it("escapes combined injection attempt", () => {
    const attack = "'; } body { color: red; } .x { font-family: '";
    const result = escapeCSSString(attack);
    // All single quotes should be escaped (preceded by backslash)
    expect(result).not.toMatch(/(?<!\\)'/);
    expect(result).toContain("\\'");
  });

  it("passes through safe strings unchanged", () => {
    expect(escapeCSSString("Inter")).toBe("Inter");
    expect(escapeCSSString("Roboto Mono")).toBe("Roboto Mono");
  });
});

// ── sanitizeCSSVarName ───────────────────────────────────────

describe("sanitizeCSSVarName", () => {
  it("accepts valid CSS custom property names", () => {
    expect(sanitizeCSSVarName("--font-inter")).toBe("--font-inter");
    expect(sanitizeCSSVarName("--font-sans")).toBe("--font-sans");
    expect(sanitizeCSSVarName("--x")).toBe("--x");
    expect(sanitizeCSSVarName("--my_var")).toBe("--my_var");
  });

  it("rejects names without -- prefix", () => {
    expect(sanitizeCSSVarName("font-inter")).toBeUndefined();
    expect(sanitizeCSSVarName("-font")).toBeUndefined();
  });

  it("rejects names with special characters", () => {
    expect(sanitizeCSSVarName("--font; color: red")).toBeUndefined();
    expect(sanitizeCSSVarName("--font{")).toBeUndefined();
    expect(sanitizeCSSVarName("--font}")).toBeUndefined();
    expect(sanitizeCSSVarName("--font inter")).toBeUndefined();
  });

  it("rejects empty and bare --", () => {
    expect(sanitizeCSSVarName("")).toBeUndefined();
    expect(sanitizeCSSVarName("--")).toBeUndefined();
  });
});

// ── sanitizeFallback ─────────────────────────────────────────

describe("sanitizeFallback", () => {
  it("returns generic family keywords bare", () => {
    expect(sanitizeFallback("sans-serif")).toBe("sans-serif");
    expect(sanitizeFallback("serif")).toBe("serif");
    expect(sanitizeFallback("monospace")).toBe("monospace");
    expect(sanitizeFallback("system-ui")).toBe("system-ui");
  });

  it("quotes non-generic family names", () => {
    expect(sanitizeFallback("Arial")).toBe("'Arial'");
    expect(sanitizeFallback("Times New Roman")).toBe("'Times New Roman'");
  });

  it("escapes injection attempts inside quotes", () => {
    const malicious = "'); } body { color: red; } .x { font-family: ('";
    const result = sanitizeFallback(malicious);
    expect(result[0]).toBe("'");
    expect(result[result.length - 1]).toBe("'");
    // No unescaped single quotes inside
    const inner = result.slice(1, -1);
    expect(inner).not.toMatch(/(?<!\\)'/);
  });

  it("trims whitespace", () => {
    expect(sanitizeFallback("  sans-serif  ")).toBe("sans-serif");
    expect(sanitizeFallback("  Arial  ")).toBe("'Arial'");
  });
});

// ── sanitizeCSSProperty ──────────────────────────────────────

describe("sanitizeCSSProperty", () => {
  it("accepts standard CSS properties", () => {
    expect(sanitizeCSSProperty("font-family")).toBe("font-family");
    expect(sanitizeCSSProperty("fontWeight")).toBe("fontWeight");
  });

  it("accepts custom properties", () => {
    expect(sanitizeCSSProperty("--my-var")).toBe("--my-var");
  });

  it("rejects properties with injection characters", () => {
    expect(sanitizeCSSProperty("font; color")).toBeUndefined();
    expect(sanitizeCSSProperty("font{")).toBeUndefined();
    expect(sanitizeCSSProperty("font}")).toBeUndefined();
  });

  it("rejects empty and numeric-start strings", () => {
    expect(sanitizeCSSProperty("")).toBeUndefined();
    expect(sanitizeCSSProperty("123abc")).toBeUndefined();
  });
});

// ── sanitizeCSSValue ─────────────────────────────────────────

describe("sanitizeCSSValue", () => {
  it("accepts safe CSS values", () => {
    expect(sanitizeCSSValue("'Inter', sans-serif")).toBe("'Inter', sans-serif");
    expect(sanitizeCSSValue("400")).toBe("400");
    expect(sanitizeCSSValue("normal")).toBe("normal");
  });

  it("rejects values with braces", () => {
    expect(sanitizeCSSValue("foo { bar")).toBeUndefined();
    expect(sanitizeCSSValue("foo } bar")).toBeUndefined();
  });

  it("rejects values with semicolons", () => {
    expect(sanitizeCSSValue("red; background: url(evil)")).toBeUndefined();
  });

  it("rejects HTML closing tags", () => {
    expect(sanitizeCSSValue("</style>")).toBeUndefined();
  });
});

// ── simpleHash ───────────────────────────────────────────────

describe("simpleHash", () => {
  it("returns a 6-character hex string", () => {
    const result = simpleHash("Inter");
    expect(result).toMatch(/^[0-9a-f]{6}$/);
  });

  it("is deterministic", () => {
    expect(simpleHash("Roboto Mono")).toBe(simpleHash("Roboto Mono"));
  });

  it("produces different hashes for different inputs", () => {
    expect(simpleHash("Inter")).not.toBe(simpleHash("Roboto"));
  });

  it("handles empty string", () => {
    const result = simpleHash("");
    expect(result).toMatch(/^[0-9a-f]{6}$/);
  });

  it("handles long strings", () => {
    const long = "a".repeat(10000);
    const result = simpleHash(long);
    expect(result).toMatch(/^[0-9a-f]{6}$/);
  });
});

// ── createFontSSRState ───────────────────────────────────────

describe("createFontSSRState", () => {
  it("returns fresh state with empty collections", () => {
    const state = createFontSSRState();
    expect(state.injectedFonts.size).toBe(0);
    expect(state.injectedClassRules.size).toBe(0);
    expect(state.injectedVariableRules.size).toBe(0);
    expect(state.injectedSelfHosted.size).toBe(0);
    expect(state.ssrFontStyles).toEqual([]);
    expect(state.ssrFontPreloads).toEqual([]);
    expect(state.ssrFontPreloadHrefs.size).toBe(0);
  });

  it("returns independent instances", () => {
    const a = createFontSSRState();
    const b = createFontSSRState();
    a.injectedFonts.add("test");
    expect(b.injectedFonts.size).toBe(0);
  });
});

// ── SSR injection helpers ────────────────────────────────────
// In test/node environment, `document` is undefined so all injection
// functions take the SSR codepath (push to arrays).

describe("injectFontFaceCSS (SSR)", () => {
  it("pushes CSS to ssrFontStyles", () => {
    const state = createFontSSRState();
    injectFontFaceCSS(state, "@font-face { font-family: 'Inter'; }", "inter");
    expect(state.ssrFontStyles).toEqual(["@font-face { font-family: 'Inter'; }"]);
  });

  it("deduplicates by id", () => {
    const state = createFontSSRState();
    injectFontFaceCSS(state, "@font-face { font-family: 'Inter'; }", "inter");
    injectFontFaceCSS(state, "@font-face { font-family: 'Inter'; }", "inter");
    expect(state.ssrFontStyles).toHaveLength(1);
  });

  it("allows different ids", () => {
    const state = createFontSSRState();
    injectFontFaceCSS(state, "css-a", "a");
    injectFontFaceCSS(state, "css-b", "b");
    expect(state.ssrFontStyles).toHaveLength(2);
  });
});

describe("injectSelfHostedCSS (SSR)", () => {
  it("pushes CSS and collects woff2 preloads", () => {
    const state = createFontSSRState();
    const css = "@font-face { src: url('/fonts/inter.woff2'); }";
    injectSelfHostedCSS(state, css);
    expect(state.ssrFontStyles).toEqual([css]);
    expect(state.ssrFontPreloads).toEqual([{ href: "/fonts/inter.woff2", type: "font/woff2" }]);
  });

  it("deduplicates by CSS content", () => {
    const state = createFontSSRState();
    const css = "@font-face { src: url('/fonts/inter.woff2'); }";
    injectSelfHostedCSS(state, css);
    injectSelfHostedCSS(state, css);
    expect(state.ssrFontStyles).toHaveLength(1);
    expect(state.ssrFontPreloads).toHaveLength(1);
  });

  it("ignores non-absolute woff2 URLs", () => {
    const state = createFontSSRState();
    injectSelfHostedCSS(state, "@font-face { src: url('inter.woff2'); }");
    expect(state.ssrFontPreloads).toEqual([]);
  });
});

describe("injectClassNameRule (SSR)", () => {
  it("pushes className rule to ssrFontStyles", () => {
    const state = createFontSSRState();
    injectClassNameRule(state, "__className_abc123", "'Inter', sans-serif");
    expect(state.ssrFontStyles[0]).toContain(".__className_abc123");
    expect(state.ssrFontStyles[0]).toContain("'Inter', sans-serif");
  });

  it("deduplicates by className", () => {
    const state = createFontSSRState();
    injectClassNameRule(state, "cls", "'Inter'");
    injectClassNameRule(state, "cls", "'Inter'");
    expect(state.ssrFontStyles).toHaveLength(1);
  });
});

describe("injectVariableClassRule (SSR)", () => {
  it("injects variable class rule with :root fallback", () => {
    const state = createFontSSRState();
    injectVariableClassRule(state, "__var_abc123", "--font-inter", "'Inter', sans-serif");
    const css = state.ssrFontStyles[0];
    expect(css).toContain(".__var_abc123");
    expect(css).toContain("--font-inter");
    expect(css).toContain(":root");
  });

  it("deduplicates by variableClassName", () => {
    const state = createFontSSRState();
    injectVariableClassRule(state, "v1", "--font-x", "'X'");
    injectVariableClassRule(state, "v1", "--font-x", "'X'");
    expect(state.ssrFontStyles).toHaveLength(1);
  });
});

describe("injectFontStylesheet (SSR)", () => {
  it("tracks URL but does not push to ssrFontStyles (no link creation in SSR)", () => {
    const state = createFontSSRState();
    injectFontStylesheet(state, "https://fonts.googleapis.com/css2?family=Inter");
    // In SSR, this only adds to injectedFonts set, not to styles
    expect(state.injectedFonts.has("https://fonts.googleapis.com/css2?family=Inter")).toBe(true);
  });

  it("deduplicates by URL", () => {
    const state = createFontSSRState();
    injectFontStylesheet(state, "https://fonts.example.com/a.css");
    injectFontStylesheet(state, "https://fonts.example.com/a.css");
    expect(state.injectedFonts.size).toBe(1);
  });
});

describe("collectFontPreloads (SSR)", () => {
  it("collects absolute woff2 paths", () => {
    const state = createFontSSRState();
    collectFontPreloads(state, ["/fonts/inter.woff2", "/fonts/roboto.woff2"]);
    expect(state.ssrFontPreloads).toHaveLength(2);
    expect(state.ssrFontPreloads[0]).toEqual({ href: "/fonts/inter.woff2", type: "font/woff2" });
  });

  it("ignores non-absolute, non-woff2, and empty paths", () => {
    const state = createFontSSRState();
    collectFontPreloads(state, ["inter.woff2", "/fonts/inter.ttf", "", "/fonts/ok.woff2"]);
    expect(state.ssrFontPreloads).toHaveLength(1);
    expect(state.ssrFontPreloads[0]?.href).toBe("/fonts/ok.woff2");
  });

  it("deduplicates by href", () => {
    const state = createFontSSRState();
    collectFontPreloads(state, ["/fonts/inter.woff2"]);
    collectFontPreloads(state, ["/fonts/inter.woff2"]);
    expect(state.ssrFontPreloads).toHaveLength(1);
  });
});
