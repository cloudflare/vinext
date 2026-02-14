/**
 * next/font/local shim
 *
 * Provides a runtime-compatible shim for Next.js local fonts.
 * Generates @font-face CSS declarations and returns an object
 * with className, style, and variable properties.
 *
 * Usage:
 *   import localFont from 'next/font/local';
 *   const myFont = localFont({ src: './my-font.woff2' });
 *   // myFont.className -> unique CSS class
 *   // myFont.style -> { fontFamily: "'my-font'" }
 *   // myFont.variable -> CSS variable name
 */

let classCounter = 0;
const injectedFonts = new Set<string>();

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

interface FontResult {
  className: string;
  style: { fontFamily: string };
  variable?: string;
}

function generateFontFaceCSS(
  family: string,
  options: LocalFontOptions,
): string {
  const sources = Array.isArray(options.src)
    ? options.src
    : typeof options.src === "string"
      ? [{ path: options.src }]
      : [options.src];

  const display = options.display ?? "swap";
  const rules: string[] = [];

  for (const src of sources) {
    const weight = src.weight ?? options.weight ?? "400";
    const style = src.style ?? options.style ?? "normal";
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
  font-family: '${family}';
  src: url('${src.path}') format('${format}');
  font-weight: ${weight};
  font-style: ${style};
  font-display: ${display};
}`);
  }

  // Add extra declarations if provided
  if (options.declarations) {
    for (const decl of options.declarations) {
      rules.push(`@font-face { font-family: '${family}'; ${decl.prop}: ${decl.value}; }`);
    }
  }

  return rules.join("\n");
}

function injectFontFaceCSS(css: string, id: string): void {
  if (injectedFonts.has(id)) return;
  injectedFonts.add(id);

  if (typeof document !== "undefined") {
    const style = document.createElement("style");
    style.textContent = css;
    style.setAttribute("data-vinext-font", id);
    document.head.appendChild(style);
  }
}

/** Track which className CSS rules have been injected. */
const injectedClassRules = new Set<string>();

/**
 * Inject a CSS rule that maps a className to a font-family.
 * Also creates a CSS variable rule if a variable name is specified.
 *
 * This is what makes `<div className={font.className}>` apply the font.
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

  if (typeof document !== "undefined") {
    const style = document.createElement("style");
    style.textContent = css;
    style.setAttribute("data-vinext-font-class", className);
    document.head.appendChild(style);
  }
}

export default function localFont(options: LocalFontOptions): FontResult {
  const id = classCounter++;
  const family = `__local_font_${id}`;
  const className = `__font_local_${id}`;
  const fallback = options.fallback ?? ["sans-serif"];
  const fontFamily = `'${family}', ${fallback.join(", ")}`;
  const variable = options.variable;

  // Inject @font-face declarations
  const css = generateFontFaceCSS(family, options);
  injectFontFaceCSS(css, family);

  // Inject the className -> font-family CSS rule (+ optional CSS variable)
  injectClassNameRule(className, fontFamily, variable);

  return {
    className,
    style: { fontFamily },
    ...(variable ? { variable } : {}),
  };
}
