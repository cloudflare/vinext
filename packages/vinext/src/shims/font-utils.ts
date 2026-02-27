/**
 * Shared stateless utilities for next/font/google and next/font/local shims.
 *
 * Contains:
 * - CSS sanitization helpers (escapeCSSString, sanitizeCSSVarName, etc.)
 * - Deterministic hashing (simpleHash)
 *
 * Stateful SSR collection and CSS injection remain in each font module
 * because consumers import SSR accessors separately from "next/font/google"
 * and "next/font/local", then merge them at the call site.
 */

// ---------------------------------------------------------------------------
// CSS sanitization helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe interpolation inside a CSS single-quoted string.
 */
export function escapeCSSString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\a ")
    .replace(/\r/g, "\\d ");
}

/**
 * Validate a CSS custom property name (e.g. `--font-inter`).
 * Returns the name if valid, undefined otherwise.
 */
export function sanitizeCSSVarName(name: string): string | undefined {
  if (/^--[a-zA-Z0-9_-]+$/.test(name)) return name;
  return undefined;
}

/**
 * Sanitize a CSS font-family fallback name.
 * Generic family keywords are returned bare; everything else is quoted.
 */
export function sanitizeFallback(name: string): string {
  const generics = new Set([
    "serif", "sans-serif", "monospace", "cursive", "fantasy",
    "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
    "emoji", "math", "fangsong",
  ]);
  const trimmed = name.trim();
  if (generics.has(trimmed)) return trimmed;
  return `'${escapeCSSString(trimmed)}'`;
}

/**
 * Validate a CSS property name. Returns the name if valid, undefined otherwise.
 */
export function sanitizeCSSProperty(prop: string): string | undefined {
  if (/^(--)?[a-zA-Z][a-zA-Z0-9-]*$/.test(prop)) return prop;
  return undefined;
}

/**
 * Validate a CSS value. Blocks injection attempts (braces, semicolons, closing tags).
 * Returns the value if safe, undefined otherwise.
 */
export function sanitizeCSSValue(value: string): string | undefined {
  if (/[{};]|<\//.test(value)) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// Deterministic hashing
// ---------------------------------------------------------------------------

/**
 * Simple djb2-based hash for deterministic class name generation.
 * Produces a 6-char hex string from the input.
 *
 * Used in dev mode where we don't have the full CSS content for sha1 hashing.
 * The same hash must produce identical results on SSR and client to prevent
 * hydration mismatches.
 */
export function simpleHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(16).padStart(6, "0").slice(-6);
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Build-time injected options from the vinext font plugins. */
export interface BuildInjectedOptions {
  /** Self-hosted @font-face CSS with resolved asset URLs and hashed font-family */
  _selfHostedCSS?: string;
  /** Hashed font-family name (e.g. '__Inter_a3b2c1') */
  _hashedFamily?: string;
  /** Fallback font-family name (e.g. '__Inter_a3b2c1 Fallback') */
  _fallbackFamily?: string;
  /** Fallback @font-face CSS with size-adjust metrics */
  _fallbackCSS?: string;
  /** Pre-computed className (e.g. '__className_a3b2c1') */
  _className?: string;
  /** Pre-computed variable class name (e.g. '__variable_a3b2c1') */
  _variableClassName?: string;
}

export interface FontResult {
  className: string;
  style: { fontFamily: string };
  variable?: string;
}

// ---------------------------------------------------------------------------
// CSS injection helpers (shared implementations, parameterized by state)
// ---------------------------------------------------------------------------

/**
 * Shared set for :root CSS variable dedup across all font modules.
 * Prevents duplicate `:root { --font-sans: ... }` rules when the same
 * CSS variable is used by both a Google font and a local font.
 */
const sharedRootVariables = new Set<string>();

/**
 * SSR state container for font modules. Each font module (google/local)
 * maintains its own instance to allow consumers to collect styles separately.
 */
export interface FontSSRState {
  injectedFonts: Set<string>;
  injectedClassRules: Set<string>;
  injectedVariableRules: Set<string>;
  injectedSelfHosted: Set<string>;
  ssrFontStyles: string[];
  ssrFontPreloads: Array<{ href: string; type: string }>;
  ssrFontPreloadHrefs: Set<string>;
}

/**
 * Create a new SSR state container.
 */
export function createFontSSRState(): FontSSRState {
  return {
    injectedFonts: new Set(),
    injectedClassRules: new Set(),
    injectedVariableRules: new Set(),
    injectedSelfHosted: new Set(),
    ssrFontStyles: [],
    ssrFontPreloads: [],
    ssrFontPreloadHrefs: new Set(),
  };
}

/**
 * Extract .woff2 font file URLs from @font-face CSS rules.
 * Only collects .woff2 files — browsers that support preloading also support woff2.
 */
function extractWoff2UrlsFromCSS(css: string): string[] {
  const urls: string[] = [];
  const urlRegex = /url\(['"]?([^'")]+\.woff2)['"]?\)/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(css)) !== null) {
    const url = match[1];
    if (url && url.startsWith("/")) {
      urls.push(url);
    }
  }
  return urls;
}

/**
 * Collect .woff2 preload URLs from CSS into the given state.
 * Server-only (no-op on client).
 */
function collectWoff2PreloadsFromCSS(state: FontSSRState, css: string): void {
  if (typeof document !== "undefined") return;

  for (const href of extractWoff2UrlsFromCSS(css)) {
    if (!state.ssrFontPreloadHrefs.has(href)) {
      state.ssrFontPreloadHrefs.add(href);
      state.ssrFontPreloads.push({ href, type: "font/woff2" });
    }
  }
}

/**
 * Inject a @font-face CSS block with deduplication.
 */
export function injectFontFaceCSS(state: FontSSRState, css: string, id: string): void {
  if (state.injectedFonts.has(id)) return;
  state.injectedFonts.add(id);

  if (typeof document === "undefined") {
    state.ssrFontStyles.push(css);
    return;
  }

  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font", id);
  document.head.appendChild(style);
}

/**
 * Inject self-hosted @font-face CSS. Also collects .woff2 preload URLs.
 */
export function injectSelfHostedCSS(state: FontSSRState, css: string): void {
  if (state.injectedSelfHosted.has(css)) return;
  state.injectedSelfHosted.add(css);

  collectWoff2PreloadsFromCSS(state, css);

  if (typeof document === "undefined") {
    state.ssrFontStyles.push(css);
    return;
  }

  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font-selfhosted", "true");
  document.head.appendChild(style);
}

/**
 * Inject a CSS rule mapping className to font-family.
 */
export function injectClassNameRule(state: FontSSRState, className: string, fontFamily: string): void {
  if (state.injectedClassRules.has(className)) return;
  state.injectedClassRules.add(className);

  const css = `.${className} { font-family: ${fontFamily}; }\n`;

  if (typeof document === "undefined") {
    state.ssrFontStyles.push(css);
    return;
  }

  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font-class", className);
  document.head.appendChild(style);
}

/**
 * Inject a CSS rule setting a CSS variable on an element.
 * Also injects a :root rule for the variable (once per variable name).
 */
export function injectVariableClassRule(
  state: FontSSRState,
  variableClassName: string,
  cssVarName: string,
  fontFamily: string,
): void {
  if (state.injectedVariableRules.has(variableClassName)) return;
  state.injectedVariableRules.add(variableClassName);

  let css = `.${variableClassName} { ${cssVarName}: ${fontFamily}; }\n`;

  if (!sharedRootVariables.has(cssVarName)) {
    sharedRootVariables.add(cssVarName);
    css += `:root { ${cssVarName}: ${fontFamily}; }\n`;
  }

  if (typeof document === "undefined") {
    state.ssrFontStyles.push(css);
    return;
  }

  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font-variable", variableClassName);
  document.head.appendChild(style);
}

/**
 * Inject a <link> stylesheet tag (client) or track URL for SSR (server).
 */
export function injectFontStylesheet(state: FontSSRState, url: string): void {
  if (state.injectedFonts.has(url)) return;
  state.injectedFonts.add(url);

  if (typeof document !== "undefined") {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
  }
}

/**
 * Collect font source paths for preload link generation (dev mode).
 * Only collects .woff2 files with absolute paths. Server-only.
 */
export function collectFontPreloads(state: FontSSRState, paths: string[]): void {
  if (typeof document !== "undefined") return;

  for (const href of paths) {
    if (href && href.startsWith("/") && href.endsWith(".woff2") && !state.ssrFontPreloadHrefs.has(href)) {
      state.ssrFontPreloadHrefs.add(href);
      state.ssrFontPreloads.push({ href, type: "font/woff2" });
    }
  }
}
