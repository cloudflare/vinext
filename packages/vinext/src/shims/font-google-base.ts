import { buildGoogleFontsUrl as buildUrlFromAxes } from "../build/google-fonts/build-url.js";
import {
  escapeCSSString,
  formatFontClassRule,
  getFontMimeType,
  resolveSingleFaceStyle,
  sanitizeCSSVarName,
  sanitizeFallback,
  type FontStyle,
} from "./font-utils.js";

/**
 * next/font/google shim
 *
 * Provides a compatible shim for Next.js Google Fonts.
 *
 * Two modes:
 * 1. **Dev / CDN mode** (default): Loads fonts from Google Fonts CDN via <link> tags.
 * 2. **Self-hosted mode** (production build): The vinext:google-fonts Vite plugin
 *    fetches font CSS + .woff2 files at build time, caches them locally, and injects
 *    @font-face CSS pointing at local assets. No requests to Google at runtime.
 *
 * Usage:
 *   import { Inter } from 'next/font/google';
 *   const inter = Inter({ subsets: ['latin'], weight: ['400', '700'] });
 *   // inter.className -> stable CSS class for this font/options pair
 *   // inter.style -> { fontFamily: "'Inter', 'Inter Fallback'", fontStyle: "normal" }
 *   // inter.variable -> CSS class that sets the font CSS variable when requested
 */

// Track which font stylesheets have been injected (SSR + client)
const injectedFonts = new Set<string>();

export type FontOptions = {
  weight?: string | string[];
  style?: string | string[];
  subsets?: string[];
  display?: string;
  preload?: boolean;
  fallback?: string[];
  adjustFontFallback?: boolean | string;
  variable?: string;
  axes?: string[];
};

export type FontResult = {
  className: string;
  style: FontStyle;
  variable?: string;
};

type InternalGoogleFontRuntimeOptions = {
  selfHostedCSS?: string;
  preloadUrls?: string[];
  adjustedFallbackCSS?: string;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
};

type FontLoaderOptions = FontOptions & {
  /**
   * Internal payload injected by the vinext:google-fonts transform after
   * metadata validation. Runtime must prefer these values over user options
   * because they represent the resolved Next-compatible face, including
   * metadata defaults such as italic-only families.
   */
  _vinext?: {
    font?: InternalGoogleFontRuntimeOptions;
  };
};

/**
 * Convert a font family name to a CSS variable name.
 * e.g., "Inter" -> "--font-inter", "Roboto Mono" -> "--font-roboto-mono"
 */
function toVarName(family: string): string {
  return "--font-" + family.toLowerCase().replace(/\s+/g, "-");
}

function fontClassSegment(family: string): string {
  const segment = family
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return segment || "font";
}

function normalizeStringSetOption(value: string | string[] | undefined): string {
  if (!value) return "";
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].sort().join(",");
}

function normalizeWeightOption(value: string | string[] | undefined): string {
  const normalized = normalizeStringSetOption(value);
  return normalized === "variable" ? "" : normalized;
}

function normalizeStyleOption(value: string | string[] | undefined): string {
  const values = new Set(
    (Array.isArray(value) ? value : value ? [value] : [])
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const hasItalic = values.has("italic");
  const hasNormal = values.has("normal");
  if (!hasItalic) return "";
  return hasNormal ? "italic,normal" : "italic";
}

function normalizeFallbackOption(value: string[] | undefined): string {
  if (!value) return "";
  return value.map((item) => item.trim()).join(",");
}

function normalizeBooleanOption(value: boolean | undefined): string {
  if (value === undefined) return "";
  return value ? "1" : "0";
}

function normalizeStringOrBooleanOption(value: boolean | string | undefined): string {
  if (value === undefined) return "";
  return typeof value === "boolean" ? normalizeBooleanOption(value) : value;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

function createFontIdentity(
  family: string,
  options: FontLoaderOptions,
  cssVarName: string,
  fallback: string[],
): string {
  return hashString(
    [
      family,
      cssVarName,
      normalizeWeightOption(options.weight),
      normalizeStyleOption(options.style),
      normalizeStringSetOption(options.subsets),
      options.display ?? "swap",
      normalizeBooleanOption(options.preload),
      normalizeFallbackOption(fallback),
      normalizeStringOrBooleanOption(options.adjustFontFallback),
      normalizeStringSetOption(options.axes),
      options._vinext?.font?.selfHostedCSS ?? "",
      options._vinext?.font?.fontWeight?.toString() ?? "",
      options._vinext?.font?.fontStyle ?? "",
    ].join("\0"),
  );
}

/**
 * Build a Google Fonts CSS URL.
 *
 * In production this code path is dead. The build plugin
 * (`vinext:google-fonts` in `src/plugins/fonts.ts`) statically resolves
 * each font call's axis values against the bundled metadata, fetches the
 * Google Fonts CSS, and injects the resulting CSS as
 * `_vinext.font.selfHostedCSS` so the runtime never queries Google. The shim
 * only reaches this builder when the plugin's static parser bails (dynamic
 * options, eval-only shapes), which is dev-only.
 *
 * The dev fallback intentionally has no metadata: shipping the 388 KB
 * `font-data.json` to the Worker bundle would dwarf the rest of the shim,
 * and the production path already has the metadata-aware variant. The
 * tradeoff is that the dev fallback cannot resolve a variable font's
 * actual `wght` axis range. It emits no axis segment when no `weight` is
 * given, which makes Google return the default static face (200) instead
 * of the broken `:wght@100..900` URL that issue #885 reports.
 */
export function buildGoogleFontsUrl(family: string, options: FontOptions): string {
  const weights = options.weight
    ? Array.isArray(options.weight)
      ? options.weight
      : [options.weight]
    : [];
  const styles = options.style
    ? Array.isArray(options.style)
      ? options.style
      : [options.style]
    : [];

  const hasItalic = styles.includes("italic");
  const hasNormal = styles.includes("normal");
  // Google treats omitted ital as ital=0, so italic-only requests emit
  // ['1']; mixed requests emit ['0','1']; normal-only stays undefined so
  // the URL has no ital axis at all.
  const ital = hasItalic ? [...(hasNormal ? ["0"] : []), "1"] : undefined;

  // The dev fallback has no metadata, so the variable sentinel cannot be
  // resolved to the font's real axis range here. Drop it like empty options
  // instead of emitting the invalid Google Fonts URL `:wght@variable`.
  const normalizedWeights = weights.length === 1 && weights[0] === "variable" ? [] : weights;

  // Italic-only with no explicit weight still needs a wght value or the
  // ital axis has nowhere to attach in Google's URL grammar. Fall back to
  // '400' because every Google Font has it and it is the visible default.
  // The plugin's metadata-aware path covers the variable-font case in
  // production.
  const wght = normalizedWeights.length > 0 ? normalizedWeights : ital ? ["400"] : undefined;

  return buildUrlFromAxes(family, { wght, ital }, options.display ?? "swap");
}

/**
 * Inject a <link> tag for the font (client-side only).
 * On the server, we track font URLs for SSR head injection.
 */
function injectFontStylesheet(url: string): void {
  if (injectedFonts.has(url)) return;
  injectedFonts.add(url);

  if (typeof document !== "undefined") {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
  }
}

/** Track which className CSS rules have been injected. */
const injectedClassRules = new Set<string>();

/**
 * Inject a CSS rule that maps a className to the exported font style.
 *
 * This is what makes `<div className={inter.className}>` apply the font.
 * Next.js generates equivalent rules at build time.
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
  const styleElement = document.createElement("style");
  styleElement.textContent = css;
  styleElement.setAttribute("data-vinext-font-class", className);
  document.head.appendChild(styleElement);
}

/** Track which variable class CSS rules have been injected. */
const injectedVariableRules = new Set<string>();

/**
 * Inject a CSS rule that sets a CSS variable on an element.
 * This is what makes `<html className={inter.variable}>` set the CSS variable
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
  const css = `.${variableClassName} { ${cssVarName}: ${fontFamily}; }\n`;

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

// SSR: collect font class CSS for injection in <head>
const ssrFontStyles: string[] = [];

/**
 * Get collected SSR font class styles (used by the renderer).
 * Note: We don't clear the arrays because fonts are loaded at module import
 * time and need to persist across all requests in the Workers environment.
 */
export function getSSRFontStyles(): string[] {
  return [...ssrFontStyles];
}

// SSR: collect font URLs to inject in <head>
const ssrFontUrls: string[] = [];

/**
 * Get collected SSR font URLs (used by the renderer).
 * Note: We don't clear the arrays because fonts are loaded at module import
 * time and need to persist across all requests in the Workers environment.
 */
export function getSSRFontLinks(): string[] {
  return [...ssrFontUrls];
}

// SSR: collect font file URLs for <link rel="preload"> injection (self-hosted Google fonts)
const ssrFontPreloads: Array<{ href: string; type: string }> = [];
const ssrFontPreloadHrefs = new Set<string>();

/**
 * Get collected SSR font preload data (used by the renderer).
 * Returns an array of { href, type } objects for emitting
 * <link rel="preload" as="font" ...> tags.
 */
export function getSSRFontPreloads(): Array<{ href: string; type: string }> {
  return [...ssrFontPreloads];
}

/**
 * Collect build-selected font file URLs for preload link generation.
 * Only collects on the server (SSR). Deduplicates by href using a Set for O(1) lookups.
 */
function collectFontPreloads(urls: string[]): void {
  if (typeof document !== "undefined") return; // client-side, skip

  for (const href of urls) {
    if (href.startsWith("/") && !ssrFontPreloadHrefs.has(href)) {
      ssrFontPreloadHrefs.add(href);
      ssrFontPreloads.push({ href, type: getFontMimeType(href) });
    }
  }
}

/** Track injected self-hosted @font-face blocks (deduplicate) */
const injectedSelfHosted = new Set<string>();

/**
 * Inject self-hosted @font-face CSS (from the build plugin).
 * This replaces the CDN <link> tag with inline CSS.
 */
function injectSelfHostedCSS(css: string, preloadUrls: string[] = []): void {
  collectFontPreloads(preloadUrls);
  if (injectedSelfHosted.has(css)) return;
  injectedSelfHosted.add(css);

  if (typeof document === "undefined") {
    // SSR: add to collected styles
    ssrFontStyles.push(css);
    return;
  }

  // Client: inject <style> tag
  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font-selfhosted", "true");
  document.head.appendChild(style);
}

export type FontLoader = (options?: FontLoaderOptions) => FontResult;

export function createFontLoader(family: string): FontLoader {
  return function fontLoader(options: FontLoaderOptions = {}): FontResult {
    const internal = options._vinext?.font;
    const fallback = options.fallback ?? [];
    // The adjusted fallback family name must match the font-family emitted by
    // buildFallbackFontFace() in build/google-fonts/fallback-metrics.ts ('{family} Fallback').
    // Keep these two sites in sync to prevent silent fallback mismatches.
    const adjustedFallback =
      options.adjustFontFallback === false || !internal?.adjustedFallbackCSS
        ? []
        : [`'${escapeCSSString(family)} Fallback'`];
    // Sanitize each fallback name to prevent CSS injection via crafted values
    const fontFamily = [
      `'${escapeCSSString(family)}'`,
      ...adjustedFallback,
      ...fallback.map(sanitizeFallback),
    ].join(", ");
    // Validate CSS variable name — reject anything that could inject CSS.
    // Fall back to auto-generated name if invalid.
    const defaultVarName = toVarName(family);
    const cssVarName = options.variable
      ? (sanitizeCSSVarName(options.variable) ?? defaultVarName)
      : defaultVarName;
    const id = createFontIdentity(family, options, cssVarName, fallback);
    const classSegment = fontClassSegment(family);
    const className = `__font_${classSegment}_${id}`;
    // In Next.js, `variable` returns a CLASS NAME that sets the CSS variable.
    // Users apply this class to set the CSS variable on that element.
    const variableClassName = `__variable_${classSegment}_${id}`;
    const style = resolveSingleFaceStyle({
      fontFamily,
      weight: options.weight,
      style: options.style,
      internalWeight: internal?.fontWeight,
      internalStyle: internal?.fontStyle,
      google: true,
    });

    if (internal?.selfHostedCSS) {
      // Self-hosted mode: inject local @font-face CSS instead of CDN link
      injectSelfHostedCSS(internal.selfHostedCSS, internal.preloadUrls);
    } else {
      // CDN mode: inject <link> to Google Fonts
      const url = buildGoogleFontsUrl(family, options);
      injectFontStylesheet(url);

      // On SSR, collect the URL for head injection
      if (typeof document === "undefined") {
        if (!ssrFontUrls.includes(url)) {
          ssrFontUrls.push(url);
        }
      }
    }

    if (options.adjustFontFallback !== false && internal?.adjustedFallbackCSS) {
      injectSelfHostedCSS(internal.adjustedFallbackCSS);
    }

    // Inject a CSS rule that maps className to font-family.
    // This is what makes `<div className={inter.className}>` work.
    injectClassNameRule(className, style);

    if (options.variable) {
      // Inject a CSS rule for the variable class name.
      // This is what makes `<html className={inter.variable}>` set the CSS variable.
      injectVariableClassRule(variableClassName, cssVarName, fontFamily);
    }

    return {
      className,
      style,
      ...(options.variable ? { variable: variableClassName } : {}),
    };
  };
}

// Export a Proxy that creates font loaders for any Google Font family.
// Usage: import { Inter } from 'next/font/google'
// The proxy intercepts property access and returns a loader for that font.
const googleFontLoaders: Record<string, FontLoader> = {};

const googleFonts = new Proxy(googleFontLoaders, {
  get(_target, prop: string | symbol) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "default") return googleFonts;
    // Convert export-style names to proper font family names:
    // - Underscores to spaces: "Roboto_Mono" -> "Roboto Mono"
    // - PascalCase to spaces:  "RobotoMono"  -> "Roboto Mono"
    const family = prop.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
    return createFontLoader(family);
  },
});

export default googleFonts;
