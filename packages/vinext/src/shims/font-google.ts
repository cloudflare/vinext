/**
 * next/font/google shim
 *
 * Provides a runtime-compatible shim for Next.js Google Fonts.
 * Instead of downloading fonts at build time (like Next.js does),
 * this generates CSS that loads fonts from the Google Fonts CDN.
 *
 * Usage:
 *   import { Inter } from 'next/font/google';
 *   const inter = Inter({ subsets: ['latin'], weight: ['400', '700'] });
 *   // inter.className -> unique CSS class
 *   // inter.style -> { fontFamily: "'Inter', sans-serif" }
 *   // inter.variable -> CSS variable name like '--font-inter'
 */

// Counter for generating unique class names
let classCounter = 0;

// Track which font stylesheets have been injected (SSR + client)
const injectedFonts = new Set<string>();

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

interface FontResult {
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
function buildGoogleFontsUrl(family: string, options: FontOptions): string {
  const params = new URLSearchParams();
  const familyParam = family.replace(/\s+/g, "+");

  let spec = familyParam;

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
 * Also creates a CSS variable rule if a variable name is specified.
 *
 * This is what makes `<div className={inter.className}>` apply the font.
 * Next.js generates equivalent rules at build time.
 */
function injectClassNameRule(
  className: string,
  fontFamily: string,
  variable?: string,
): void {
  if (injectedClassRules.has(className)) return;
  injectedClassRules.add(className);

  let css = `.${className} { font-family: ${fontFamily}; }\n`;
  if (variable) {
    css += `.${className} { ${variable}: ${fontFamily}; }\n`;
  }

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

// SSR: collect font class CSS for injection in <head>
const ssrFontStyles: string[] = [];

/**
 * Get and clear collected SSR font class styles (used by the renderer).
 */
export function getSSRFontStyles(): string[] {
  const styles = [...ssrFontStyles];
  ssrFontStyles.length = 0;
  return styles;
}

// SSR: collect font URLs to inject in <head>
const ssrFontUrls: string[] = [];

/**
 * Get and clear collected SSR font URLs (used by the renderer).
 */
export function getSSRFontLinks(): string[] {
  const urls = [...ssrFontUrls];
  ssrFontUrls.length = 0;
  return urls;
}

function createFontLoader(family: string) {
  return function fontLoader(options: FontOptions = {}): FontResult {
    const id = classCounter++;
    const className = `__font_${family.toLowerCase().replace(/\s+/g, "_")}_${id}`;
    const fallback = options.fallback ?? ["sans-serif"];
    const fontFamily = `'${family}', ${fallback.join(", ")}`;
    const variable = options.variable ?? toVarName(family);

    // Build and inject the Google Fonts stylesheet
    const url = buildGoogleFontsUrl(family, options);
    injectFontStylesheet(url);

    // Inject a CSS rule that maps className to font-family.
    // This is what makes `<div className={inter.className}>` work.
    injectClassNameRule(className, fontFamily, variable);

    // On SSR, collect the URL for head injection
    if (typeof document === "undefined") {
      if (!ssrFontUrls.includes(url)) {
        ssrFontUrls.push(url);
      }
    }

    return {
      className,
      style: { fontFamily },
      variable,
    };
  };
}

// Export a Proxy that creates font loaders for any Google Font family.
// Usage: import { Inter } from 'next/font/google'
// The proxy intercepts property access and returns a loader for that font.
const googleFonts = new Proxy(
  {} as Record<string, (options?: FontOptions) => FontResult>,
  {
    get(_target, prop: string) {
      if (prop === "__esModule") return true;
      if (prop === "default") return googleFonts;
      // Convert camelCase/PascalCase to proper font family name
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
