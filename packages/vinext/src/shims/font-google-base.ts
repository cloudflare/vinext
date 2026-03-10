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
 *   // inter.className -> unique CSS class
 *   // inter.style -> { fontFamily: "'Inter', sans-serif" }
 *   // inter.variable -> CSS variable name like '--font-inter'
 */

/**
 * Escape a string for safe interpolation inside a CSS single-quoted string.
 *
 * Prevents CSS injection by escaping characters that could break out of
 * a `'...'` CSS string context: backslashes, single quotes, and newlines.
 */
function escapeCSSString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\a ")
    .replace(/\r/g, "\\d ");
}

/**
 * Validate a CSS custom property name (e.g. `--font-inter`).
 *
 * Custom properties must start with `--` and only contain alphanumeric
 * characters, hyphens, and underscores. Anything else could be used to
 * break out of the CSS declaration and inject arbitrary rules.
 *
 * Returns the name if valid, undefined otherwise.
 */
function sanitizeCSSVarName(name: string): string | undefined {
  if (/^--[a-zA-Z0-9_-]+$/.test(name)) return name;
  return undefined;
}

/**
 * Sanitize a CSS font-family fallback name.
 *
 * Generic family names (sans-serif, serif, monospace, etc.) are used as-is.
 * Named families are wrapped in escaped quotes. This prevents injection via
 * crafted fallback values like `); } body { color: red; } .x {`.
 */
function sanitizeFallback(name: string): string {
  // CSS generic font families — safe to use unquoted
  const generics = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong",
  ]);
  const trimmed = name.trim();
  if (generics.has(trimmed)) return trimmed;
  // Wrap in single quotes with escaping to prevent CSS injection
  return `'${escapeCSSString(trimmed)}'`;
}

// Counter for generating unique class names
let classCounter = 0;

// Track which font stylesheets have been injected (SSR + client)
const injectedFonts = new Set<string>();

export interface FontOptions {
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

export interface FontResult {
  className: string;
  style: { fontFamily: string };
  variable?: string;
}

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
export function buildGoogleFontsUrl(family: string, options: FontOptions): string {
  const params = new URLSearchParams();
  // Don't pre-replace spaces with "+". URLSearchParams handles encoding:
  // spaces become "+" in application/x-www-form-urlencoded format.
  // Pre-replacing would cause double-encoding: "+" -> "%2B" (400 error).
  let spec = family;

  // Build weight/style specs
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

  if (weights.length > 0 || styles.length > 0) {
    const hasItalic = styles.includes("italic");
    if (weights.length > 0) {
      if (hasItalic) {
        // Use ital axis: ital,wght@0,400;0,700;1,400;1,700
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
    // When no weight is specified, request the full variable weight range.
    // Without this, Google Fonts returns only weight 400 (the default).
    // Next.js loads the full variable font by default, so we match that
    // behavior to ensure all font weights render correctly.
    spec += `:wght@100..900`;
  }

  params.set("family", spec);
  params.set("display", options.display ?? "swap");

  return `https://fonts.googleapis.com/css2?${params.toString()}`;
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
 * Inject a CSS rule that maps a className to a font-family.
 *
 * This is what makes `<div className={inter.className}>` apply the font.
 * Next.js generates equivalent rules at build time.
 *
 * In Next.js, the .className class ONLY sets font-family — it does NOT
 * set CSS variables. CSS variables are handled separately by the .variable class.
 */
function injectClassNameRule(className: string, fontFamily: string): void {
  if (injectedClassRules.has(className)) return;
  injectedClassRules.add(className);

  const css = `.${className} { font-family: ${fontFamily}; }\n`;

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
 * Determine the MIME type for a font file based on its extension.
 */
function getFontMimeType(pathOrUrl: string): string {
  if (pathOrUrl.endsWith(".woff2")) return "font/woff2";
  if (pathOrUrl.endsWith(".woff")) return "font/woff";
  if (pathOrUrl.endsWith(".ttf")) return "font/ttf";
  if (pathOrUrl.endsWith(".otf")) return "font/opentype";
  return "font/woff2";
}

/**
 * Extract font file URLs from @font-face CSS rules.
 * Parses url('...') references from the CSS text.
 */
function extractFontUrlsFromCSS(css: string): string[] {
  const urls: string[] = [];
  const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(css)) !== null) {
    const url = match[1];
    // Only collect absolute paths (starting with /) — these are self-hosted font files
    if (url && url.startsWith("/")) {
      urls.push(url);
    }
  }
  return urls;
}

/**
 * Collect font file URLs from self-hosted CSS for preload link generation.
 * Only collects on the server (SSR). Deduplicates by href using a Set for O(1) lookups.
 */
function collectFontPreloadsFromCSS(css: string): void {
  if (typeof document !== "undefined") return; // client-side, skip

  const urls = extractFontUrlsFromCSS(css);
  for (const href of urls) {
    if (!ssrFontPreloadHrefs.has(href)) {
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
function injectSelfHostedCSS(css: string): void {
  if (injectedSelfHosted.has(css)) return;
  injectedSelfHosted.add(css);

  // Extract font file URLs for preload hints (SSR only)
  collectFontPreloadsFromCSS(css);

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

export type FontLoader = (options?: FontOptions & { _selfHostedCSS?: string }) => FontResult;

export function createFontLoader(family: string): FontLoader {
  return function fontLoader(options: FontOptions & { _selfHostedCSS?: string } = {}): FontResult {
    const id = classCounter++;
    const className = `__font_${family.toLowerCase().replace(/\s+/g, "_")}_${id}`;
    const fallback = options.fallback ?? ["sans-serif"];
    // Sanitize each fallback name to prevent CSS injection via crafted values
    const fontFamily = `'${escapeCSSString(family)}', ${fallback.map(sanitizeFallback).join(", ")}`;
    // Validate CSS variable name — reject anything that could inject CSS.
    // Fall back to auto-generated name if invalid.
    const defaultVarName = toVarName(family);
    const cssVarName = options.variable
      ? (sanitizeCSSVarName(options.variable) ?? defaultVarName)
      : defaultVarName;
    // In Next.js, `variable` returns a CLASS NAME that sets the CSS variable.
    // Users apply this class to set the CSS variable on that element.
    const variableClassName = `__variable_${family.toLowerCase().replace(/\s+/g, "_")}_${id}`;

    if (options._selfHostedCSS) {
      // Self-hosted mode: inject local @font-face CSS instead of CDN link
      injectSelfHostedCSS(options._selfHostedCSS);
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

    // Inject a CSS rule that maps className to font-family.
    // This is what makes `<div className={inter.className}>` work.
    injectClassNameRule(className, fontFamily);

    // Inject a CSS rule for the variable class name.
    // This is what makes `<html className={inter.variable}>` set the CSS variable.
    injectVariableClassRule(variableClassName, cssVarName, fontFamily);

    return {
      className,
      style: { fontFamily },
      variable: variableClassName,
    };
  };
}

// Export a Proxy that creates font loaders for any Google Font family.
// Usage: import { Inter } from 'next/font/google'
// The proxy intercepts property access and returns a loader for that font.
const googleFonts = new Proxy({} as Record<string, (options?: FontOptions) => FontResult>, {
  get(_target, prop: string) {
    if (prop === "__esModule") return true;
    if (prop === "default") return googleFonts;
    // Convert camelCase/PascalCase to proper font family name
    // e.g., "Inter" -> "Inter", "RobotoMono" -> "Roboto Mono"
    const family = prop.replace(/([a-z])([A-Z])/g, "$1 $2");
    return createFontLoader(family);
  },
});

export default googleFonts;
