/**
 * next/font/google shim
 *
 * Provides a compatible shim for Next.js Google Fonts.
 *
 * Two modes:
 * 1. **Dev / CDN mode** (default): Loads fonts from Google Fonts CDN via <link> tags.
 *    Class names are deterministically hashed from font config to avoid hydration
 *    mismatches between SSR and client.
 * 2. **Self-hosted mode** (production build): The vinext:google-fonts Vite plugin
 *    fetches font CSS + .woff2 files at build time, generates fallback @font-face
 *    with size-adjust metrics, hashes font-family names, and injects all metadata
 *    into the font constructor call. No requests to Google at runtime.
 *
 * Usage:
 *   import { Inter } from 'next/font/google';
 *   const inter = Inter({ subsets: ['latin'], weight: ['400', '700'] });
 *   // inter.className -> deterministic CSS class (e.g. '__className_a3b2c1')
 *   // inter.style -> { fontFamily: "'__Inter_a3b2c1', '__Inter_a3b2c1 Fallback', sans-serif" }
 *   // inter.variable -> CSS variable class name (e.g. '__variable_a3b2c1')
 */

import {
  escapeCSSString,
  sanitizeCSSVarName,
  sanitizeFallback,
  simpleHash,
  createFontSSRState,
  injectFontStylesheet,
  injectSelfHostedCSS,
  injectClassNameRule,
  injectVariableClassRule,
  type BuildInjectedOptions,
  type FontResult,
} from "./font-utils.js";

// ---------------------------------------------------------------------------
// Module-scoped SSR state
// ---------------------------------------------------------------------------

const state = createFontSSRState();

/** SSR-only: track Google Fonts CDN URLs for <link> injection. */
const ssrFontUrls: string[] = [];
const ssrFontUrlSet = new Set<string>();

// ---------------------------------------------------------------------------
// SSR state accessors (consumers import from "next/font/google")
// ---------------------------------------------------------------------------

export function getSSRFontStyles(): string[] {
  return [...state.ssrFontStyles];
}

export function getSSRFontLinks(): string[] {
  return [...ssrFontUrls];
}

export function getSSRFontPreloads(): Array<{ href: string; type: string }> {
  return [...state.ssrFontPreloads];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FontOptions {
  weight?: string | string[];
  style?: string | string[];
  subsets?: string[];
  display?: string;
  preload?: boolean;
  fallback?: string[];
  adjustFontFallback?: boolean | string;
  variable?: string;
  axes?: string[];
}



// ---------------------------------------------------------------------------
// Deterministic class name generation
// ---------------------------------------------------------------------------

/**
 * Generate deterministic class names from font family + options.
 * This replaces the counter-based approach to prevent hydration mismatches
 * when module execution order differs between SSR and client.
 */
function generateClassNames(family: string, options: FontOptions): { className: string; variableClassName: string } {
  const key = `${family}:${JSON.stringify({
    w: options.weight,
    s: options.style,
    sub: options.subsets,
    d: options.display,
    f: options.fallback,
    v: options.variable,
    ax: options.axes,
  })}`;
  const hash = simpleHash(key);
  return {
    className: `__className_${hash}`,
    variableClassName: `__variable_${hash}`,
  };
}

// ---------------------------------------------------------------------------
// Google Fonts URL construction
// ---------------------------------------------------------------------------

/**
 * Convert a font family name to a CSS variable name.
 * e.g., "Inter" -> "--font-inter", "Roboto Mono" -> "--font-roboto-mono"
 */
function toVarName(family: string): string {
  return "--font-" + family.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Build a Google Fonts CSS URL.
 */
function buildGoogleFontsUrl(family: string, options: FontOptions): string {
  const params = new URLSearchParams();
  let spec = family;

  const weights = options.weight
    ? Array.isArray(options.weight) ? options.weight : [options.weight]
    : [];
  const styles = options.style
    ? Array.isArray(options.style) ? options.style : [options.style]
    : [];

  if (weights.length > 0 || styles.length > 0) {
    const hasItalic = styles.includes("italic");
    if (weights.length > 0) {
      if (hasItalic) {
        const pairs: string[] = [];
        for (const w of weights) {
          pairs.push(`0,${w}`);
          pairs.push(`1,${w}`);
        }
        spec += `:ital,wght@${pairs.join(";")}`;
      } else {
        spec += `:wght@${weights.join(";")}`;
      }
    }
  } else {
    // Request full variable weight range when no weight specified
    spec += `:wght@100..900`;
  }

  params.set("family", spec);
  params.set("display", options.display ?? "swap");

  return `https://fonts.googleapis.com/css2?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Font loader
// ---------------------------------------------------------------------------

function createFontLoader(family: string) {
  return function fontLoader(options: FontOptions & BuildInjectedOptions = {}): FontResult {
    const fallback = options.fallback ?? ["sans-serif"];
    const defaultVarName = toVarName(family);
    const cssVarName = options.variable ? (sanitizeCSSVarName(options.variable) ?? defaultVarName) : defaultVarName;

    // --- Build mode: use plugin-injected metadata ---
    if (options._selfHostedCSS && options._hashedFamily) {
      const hashedFamily = options._hashedFamily;
      const fallbackFamily = options._fallbackFamily;
      const className = options._className ?? generateClassNames(family, options).className;
      const variableClassName = options._variableClassName ?? generateClassNames(family, options).variableClassName;

      // Build fontFamily string: hashed primary + fallback + user fallbacks
      const parts: string[] = [`'${escapeCSSString(hashedFamily)}'`];
      if (fallbackFamily) {
        parts.push(`'${escapeCSSString(fallbackFamily)}'`);
      }
      parts.push(...fallback.map(sanitizeFallback));
      const fontFamily = parts.join(", ");

      // Inject self-hosted @font-face CSS (includes hashed font-family names)
      injectSelfHostedCSS(state, options._selfHostedCSS);

      // Inject fallback @font-face CSS (with size-adjust metrics)
      if (options._fallbackCSS) {
        injectSelfHostedCSS(state, options._fallbackCSS);
      }

      injectClassNameRule(state, className, fontFamily);
      injectVariableClassRule(state, variableClassName, cssVarName, fontFamily);

      return {
        className,
        style: { fontFamily },
        variable: variableClassName,
      };
    }

    // --- Dev / CDN mode: no hashing, no fallback metrics ---
    const { className, variableClassName } = generateClassNames(family, options);
    const fontFamily = `'${escapeCSSString(family)}', ${fallback.map(sanitizeFallback).join(", ")}`;

    const url = buildGoogleFontsUrl(family, options);
    injectFontStylesheet(state, url);

    if (typeof document === "undefined") {
      if (!ssrFontUrlSet.has(url)) {
        ssrFontUrlSet.add(url);
        ssrFontUrls.push(url);
      }
    }

    injectClassNameRule(state, className, fontFamily);
    injectVariableClassRule(state, variableClassName, cssVarName, fontFamily);

    return {
      className,
      style: { fontFamily },
      variable: variableClassName,
    };
  };
}

// Re-export for plugin use
export { buildGoogleFontsUrl };

// ---------------------------------------------------------------------------
// Proxy + named exports
// ---------------------------------------------------------------------------

const googleFonts = new Proxy(
  {} as Record<string, (options?: FontOptions) => FontResult>,
  {
    get(_target, prop: string | symbol) {
      if (typeof prop !== "string") return undefined;
      if (prop === "__esModule") return true;
      if (prop === "default") return googleFonts;
      // Convert PascalCase to proper font family name
      // e.g., "Inter" -> "Inter", "RobotoMono" -> "Roboto Mono"
      const family = prop.replace(/([a-z])([A-Z])/g, "$1 $2");
      return createFontLoader(family);
    },
  },
);

export default googleFonts;

// Named exports for common fonts (provides better IDE autocomplete)
export const Inter = createFontLoader("Inter");
export const Roboto = createFontLoader("Roboto");
export const Roboto_Mono = createFontLoader("Roboto Mono");
export const Open_Sans = createFontLoader("Open Sans");
export const Lato = createFontLoader("Lato");
export const Poppins = createFontLoader("Poppins");
export const Montserrat = createFontLoader("Montserrat");
export const Source_Code_Pro = createFontLoader("Source Code Pro");
export const Noto_Sans = createFontLoader("Noto Sans");
export const Raleway = createFontLoader("Raleway");
export const Ubuntu = createFontLoader("Ubuntu");
export const Nunito = createFontLoader("Nunito");
export const Playfair_Display = createFontLoader("Playfair Display");
export const Merriweather = createFontLoader("Merriweather");
export const PT_Sans = createFontLoader("PT Sans");
export const Fira_Code = createFontLoader("Fira Code");
export const JetBrains_Mono = createFontLoader("JetBrains Mono");
export const Geist = createFontLoader("Geist");
export const Geist_Mono = createFontLoader("Geist Mono");
