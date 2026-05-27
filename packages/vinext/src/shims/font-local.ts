/**
 * next/font/local shim
 *
 * Provides a runtime-compatible shim for Next.js local fonts.
 * Generates @font-face CSS declarations and returns an object
 * with className, style, and variable properties.
 *
 * Supports both client-side injection and SSR collection,
 * matching the patterns used by the Google font shim.
 *
 * Usage:
 *   import localFont from 'next/font/local';
 *   const myFont = localFont({ src: './my-font.woff2' });
 *   // myFont.className -> unique CSS class
 *   // myFont.style -> { fontFamily: "'__local_font_0', sans-serif" }
 *   // myFont.variable -> generated class name when requested
 */
import {
  escapeCSSString,
  formatFontClassRule,
  resolveSingleFaceStyle,
  sanitizeCSSVarName,
  sanitizeFallback,
  sanitizeFontDescriptorValue,
  type FontStyle,
} from "./font-utils.js";

/**
 * Validate a CSS property name for use in declarations.
 *
 * Only allows standard CSS property names (lowercase letters and hyphens)
 * and custom properties (--prefixed). Rejects anything that could inject
 * CSS rules via crafted property names.
 */
function sanitizeCSSProperty(prop: string): string | undefined {
  if (/^(--)?[a-zA-Z][a-zA-Z0-9-]*$/.test(prop)) return prop;
  return undefined;
}

function sanitizeInternalFontFamily(name: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (/^[$_a-zA-Z][$_a-zA-Z0-9]*$/.test(name)) return name;
  return undefined;
}

let classCounter = 0;
const injectedFonts = new Set<string>();

type LocalFontSrc = {
  path: string;
  weight?: string;
  style?: string;
};

type LocalFontOptions = {
  src: string | LocalFontSrc | LocalFontSrc[];
  display?: string;
  weight?: string;
  style?: string;
  fallback?: string[];
  preload?: boolean;
  variable?: string;
  adjustFontFallback?: boolean | string;
  declarations?: Array<{ prop: string; value: string }>;
  _vinext?: {
    font?: {
      family?: unknown;
    };
  };
};

type FontResult = {
  className: string;
  style: FontStyle;
  variable?: string;
};

function generateFontFaceCSS(
  family: string,
  options: LocalFontOptions,
  sources: LocalFontSrc[],
): string {
  const display = options.display ?? "swap";
  const rules: string[] = [];

  for (const src of sources) {
    const weight = sanitizeFontDescriptorValue(src.weight ?? options.weight ?? "400") ?? "400";
    const style = sanitizeFontDescriptorValue(src.style ?? options.style ?? "normal") ?? "normal";
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

  // Add extra declarations if provided — sanitize prop/value to prevent injection
  if (options.declarations) {
    for (const decl of options.declarations) {
      const safeProp = sanitizeCSSProperty(decl.prop);
      const safeValue = sanitizeFontDescriptorValue(decl.value);
      if (safeProp && safeValue) {
        rules.push(
          `@font-face { font-family: '${escapeCSSString(family)}'; ${safeProp}: ${safeValue}; }`,
        );
      }
    }
  }

  return rules.join("\n");
}

// SSR: collect font styles for injection in <head>
const ssrFontStyles: string[] = [];

// SSR: collect font file URLs for <link rel="preload"> injection
const ssrFontPreloads: Array<{ href: string; type: string }> = [];
const ssrFontPreloadHrefs = new Set<string>();

/**
 * Get collected SSR font styles (used by the renderer).
 * Note: We don't clear the arrays because fonts are loaded at module import
 * time and need to persist across all requests in the Workers environment.
 */
export function getSSRFontStyles(): string[] {
  return [...ssrFontStyles];
}

/**
 * Get collected SSR font preload data (used by the renderer).
 * Returns an array of { href, type } objects for emitting
 * <link rel="preload" as="font" ...> tags.
 */
export function getSSRFontPreloads(): Array<{ href: string; type: string }> {
  return [...ssrFontPreloads];
}

function injectFontFaceCSS(css: string, id: string): void {
  if (injectedFonts.has(id)) return;
  injectedFonts.add(id);

  // On server, store the CSS for SSR injection
  if (typeof document === "undefined") {
    ssrFontStyles.push(css);
    return;
  }

  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font", id);
  document.head.appendChild(style);
}

/** Track which className CSS rules have been injected. */
const injectedClassRules = new Set<string>();

/**
 * Inject a CSS rule that maps a className to the exported font style.
 *
 * This is what makes `<div className={font.className}>` apply the font.
 *
 * In Next.js, the .className class sets font-family and any single
 * font-weight/font-style. CSS variables are handled separately by .variable.
 */
function injectClassNameRule(className: string, fontStyle: FontStyle): void {
  if (injectedClassRules.has(className)) return;
  injectedClassRules.add(className);

  const css = formatFontClassRule(className, fontStyle);

  // On server, store the CSS for SSR injection
  if (typeof document === "undefined") {
    ssrFontStyles.push(css);
    return;
  }

  // On client, inject a <style> tag
  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font-class", className);
  document.head.appendChild(style);
}

/** Track which variable class CSS rules have been injected. */
const injectedVariableRules = new Set<string>();

/** Track which :root CSS variable rules have been injected. */
const injectedRootVariables = new Set<string>();

/**
 * Inject a CSS rule that sets a CSS variable on an element.
 * This is what makes `<html className={font.variable}>` set the CSS variable
 * that can be referenced by other styles (e.g., Tailwind's font-sans).
 *
 * In Next.js, the .variable class ONLY sets the CSS variable — it does NOT
 * set font-family. This is critical because apps commonly apply multiple
 * .variable classes to <body> (e.g., geistSans.variable + geistMono.variable).
 * If we also set font-family here, the last class wins due to CSS cascade,
 * causing all text to use that font (e.g., everything becomes monospace).
 */
function injectVariableClassRule(
  variableClassName: string,
  cssVarName: string,
  fontFamily: string,
): void {
  if (injectedVariableRules.has(variableClassName)) return;
  injectedVariableRules.add(variableClassName);

  // Only set the CSS variable — do NOT set font-family.
  // This matches Next.js behavior where .variable classes only define CSS variables.
  let css = `.${variableClassName} { ${cssVarName}: ${fontFamily}; }\n`;

  // Also inject at :root so CSS variable inheritance works throughout the page.
  // This ensures Tailwind utilities like `font-sans` that reference these
  // variables via var(--font-geist-sans) work correctly.
  if (!injectedRootVariables.has(cssVarName)) {
    injectedRootVariables.add(cssVarName);
    css += `:root { ${cssVarName}: ${fontFamily}; }\n`;
  }

  // On server, store the CSS for SSR injection
  if (typeof document === "undefined") {
    ssrFontStyles.push(css);
    return;
  }

  // On client, inject a <style> tag
  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font-variable", variableClassName);
  document.head.appendChild(style);
}

/**
 * Normalize the `src` option into a flat array of `{ path, weight?, style? }`.
 * Handles string, single object, and array forms.
 */
function normalizeSources(options: LocalFontOptions): LocalFontSrc[] {
  if (Array.isArray(options.src)) return options.src;
  if (typeof options.src === "string") return [{ path: options.src }];
  return [options.src];
}

/**
 * Determine the MIME type for a font file based on its extension.
 * Uses endsWith() only — matching the approach in generateFontFaceCSS —
 * to avoid false positives from substring matches (e.g. ".woff" matching ".woff2").
 */
function getFontMimeType(pathOrUrl: string): string {
  if (pathOrUrl.endsWith(".woff2")) return "font/woff2";
  if (pathOrUrl.endsWith(".woff")) return "font/woff";
  if (pathOrUrl.endsWith(".ttf")) return "font/ttf";
  if (pathOrUrl.endsWith(".otf")) return "font/opentype";
  return "font/woff2";
}

/**
 * Collect font source URLs for preload link generation.
 * Only collects on the server (SSR). Deduplicates by href using a Set for O(1) lookups.
 */
function collectFontPreloads(sources: LocalFontSrc[]): void {
  if (typeof document !== "undefined") return; // client-side, skip

  for (const src of sources) {
    const href = src.path;
    // Only collect URLs that are absolute (start with /) — relative paths
    // would resolve incorrectly from different page URLs. The vinext:local-fonts
    // Vite transform should have already resolved them to absolute URLs.
    if (href && href.startsWith("/") && !ssrFontPreloadHrefs.has(href)) {
      ssrFontPreloadHrefs.add(href);
      ssrFontPreloads.push({ href, type: getFontMimeType(href) });
    }
  }
}

export default function localFont(options: LocalFontOptions): FontResult {
  const id = classCounter++;
  const sources = normalizeSources(options);
  const singleSource = sources.length === 1 ? sources[0] : undefined;
  const family = sanitizeInternalFontFamily(options._vinext?.font?.family) ?? `__local_font_${id}`;
  const className = `__font_local_${id}`;
  const fallback = options.fallback ?? ["sans-serif"];
  // Sanitize each fallback name to prevent CSS injection via crafted values
  const fontFamily = `'${family}', ${fallback.map(sanitizeFallback).join(", ")}`;
  // Validate CSS variable name — reject anything that could inject CSS
  const cssVarName = options.variable ? sanitizeCSSVarName(options.variable) : undefined;
  // In Next.js, `variable` returns a CLASS NAME that sets the CSS variable.
  // Users apply this class to set the CSS variable on that element.
  const variableClassName = `__variable_local_${id}`;
  const style = singleSource
    ? resolveSingleFaceStyle({
        fontFamily,
        weight: singleSource.weight ?? options.weight,
        style: singleSource.style ?? options.style,
      })
    : { fontFamily };

  // Collect font URLs for preload <link> tags (SSR only)
  collectFontPreloads(sources);

  // Inject @font-face declarations
  const css = generateFontFaceCSS(family, options, sources);
  // The exposed family can repeat across modules; the generated class stays
  // unique for each localFont call and is the correct injection identity.
  injectFontFaceCSS(css, className);

  // Inject the className -> font-family CSS rule
  injectClassNameRule(className, style);

  // Inject a CSS rule for the variable class name if variable is specified.
  // This is what makes `<html className={font.variable}>` set the CSS variable.
  if (cssVarName) {
    injectVariableClassRule(variableClassName, cssVarName, fontFamily);
  }

  return {
    className,
    style,
    ...(cssVarName ? { variable: variableClassName } : {}),
  };
}
