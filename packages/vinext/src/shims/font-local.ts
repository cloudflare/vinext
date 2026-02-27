/**
 * next/font/local shim
 *
 * Provides a runtime-compatible shim for Next.js local fonts.
 *
 * Two modes:
 * 1. **Dev mode** (default): Generates @font-face CSS at runtime with
 *    deterministic class names (hashed from font config, not counter-based).
 * 2. **Build mode**: The vinext:local-fonts Vite plugin resolves font file
 *    paths, extracts metrics via fontkitten, generates fallback @font-face
 *    with size-adjust, hashes font-family names, and injects all metadata.
 *
 * Usage:
 *   import localFont from 'next/font/local';
 *   const myFont = localFont({ src: './my-font.woff2' });
 *   // myFont.className -> deterministic CSS class
 *   // myFont.style -> { fontFamily: "'__local_font_a3b2c1', sans-serif" }
 *   // myFont.variable -> CSS variable class name
 */

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
  collectFontPreloads,
  type BuildInjectedOptions,
  type FontResult,
} from "./font-utils.js";

// ---------------------------------------------------------------------------
// Module-scoped SSR state
// ---------------------------------------------------------------------------

const state = createFontSSRState();

// ---------------------------------------------------------------------------
// SSR state accessors (consumers import from "next/font/local")
// ---------------------------------------------------------------------------

export function getSSRFontStyles(): string[] {
  return [...state.ssrFontStyles];
}

export function getSSRFontPreloads(): Array<{ href: string; type: string }> {
  return [...state.ssrFontPreloads];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LocalFontSrc {
  path: string;
  weight?: string;
  style?: string;
}

interface LocalFontOptions {
  src: string | LocalFontSrc | LocalFontSrc[];
  display?: string;
  weight?: string;
  style?: string;
  fallback?: string[];
  preload?: boolean;
  variable?: string;
  adjustFontFallback?: boolean | string;
  declarations?: Array<{ prop: string; value: string }>;
}



// ---------------------------------------------------------------------------
// Font source helpers
// ---------------------------------------------------------------------------

function normalizeSources(options: LocalFontOptions): LocalFontSrc[] {
  if (Array.isArray(options.src)) return options.src;
  if (typeof options.src === "string") return [{ path: options.src }];
  return [options.src];
}

// ---------------------------------------------------------------------------
// Dev mode @font-face generation
// ---------------------------------------------------------------------------

function generateFontFaceCSS(family: string, options: LocalFontOptions): string {
  const sources = normalizeSources(options);
  const display = sanitizeCSSValue(options.display ?? "swap") ?? "swap";
  const rules: string[] = [];

  for (const src of sources) {
    const weight = sanitizeCSSValue(src.weight ?? options.weight ?? "400") ?? "400";
    const style = sanitizeCSSValue(src.style ?? options.style ?? "normal") ?? "normal";
    const format = src.path.endsWith(".woff2")
      ? "woff2"
      : src.path.endsWith(".woff")
        ? "woff"
        : src.path.endsWith(".ttf")
          ? "truetype"
          : src.path.endsWith(".otf")
            ? "opentype"
            : "woff2";

    rules.push(`@font-face {
  font-family: '${escapeCSSString(family)}';
  src: url('${escapeCSSString(src.path)}') format('${format}');
  font-weight: ${weight};
  font-style: ${style};
  font-display: ${display};
}`);
  }

  if (options.declarations) {
    for (const decl of options.declarations) {
      const safeProp = sanitizeCSSProperty(decl.prop);
      const safeValue = sanitizeCSSValue(decl.value);
      if (safeProp && safeValue) {
        rules.push(`@font-face { font-family: '${escapeCSSString(family)}'; ${safeProp}: ${safeValue}; }`);
      }
    }
  }

  return rules.join("\n");
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function localFont(options: LocalFontOptions & BuildInjectedOptions): FontResult {
  const fallback = options.fallback ?? ["sans-serif"];
  const cssVarName = options.variable ? sanitizeCSSVarName(options.variable) : undefined;

  // --- Build mode: use plugin-injected metadata ---
  if (options._selfHostedCSS && options._hashedFamily) {
    const hashedFamily = options._hashedFamily;
    const fallbackFamily = options._fallbackFamily;
    const className = options._className ?? `__className_${simpleHash(options._selfHostedCSS)}`;
    const variableClassName = options._variableClassName ?? `__variable_${simpleHash(options._selfHostedCSS)}`;

    const parts: string[] = [`'${escapeCSSString(hashedFamily)}'`];
    if (fallbackFamily) {
      parts.push(`'${escapeCSSString(fallbackFamily)}'`);
    }
    parts.push(...fallback.map(sanitizeFallback));
    const fontFamily = parts.join(", ");

    injectSelfHostedCSS(state, options._selfHostedCSS);
    if (options._fallbackCSS) {
      injectSelfHostedCSS(state, options._fallbackCSS);
    }

    injectClassNameRule(state, className, fontFamily);
    if (cssVarName) {
      injectVariableClassRule(state, variableClassName, cssVarName, fontFamily);
    }

    return {
      className,
      style: { fontFamily },
      ...(cssVarName ? { variable: variableClassName } : {}),
    };
  }

  // --- Dev mode: generate @font-face at runtime ---
  const srcKey = typeof options.src === "string"
    ? options.src
    : JSON.stringify(options.src);
  const configKey = `local:${srcKey}:${options.weight ?? ""}:${options.style ?? ""}:${options.display ?? ""}:${options.variable ?? ""}:${JSON.stringify(options.fallback ?? [])}`;
  const hash = simpleHash(configKey);

  const family = `__local_font_${hash}`;
  const className = `__className_${hash}`;
  const variableClassName = `__variable_${hash}`;
  const fontFamily = `'${family}', ${fallback.map(sanitizeFallback).join(", ")}`;

  collectFontPreloads(state, normalizeSources(options).map(s => s.path));

  const css = generateFontFaceCSS(family, options);
  injectFontFaceCSS(state, css, family);
  injectClassNameRule(state, className, fontFamily);

  if (cssVarName) {
    injectVariableClassRule(state, variableClassName, cssVarName, fontFamily);
  }

  return {
    className,
    style: { fontFamily },
    ...(cssVarName ? { variable: variableClassName } : {}),
  };
}
