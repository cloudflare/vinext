export type FontStyle = {
  fontFamily: string;
  fontWeight?: number;
  fontStyle?: string;
};

export type FontFaceStyleInput = {
  fontFamily: string;
  weight?: string | string[];
  style?: string | string[];
  internalWeight?: number;
  internalStyle?: string;
  google?: boolean;
};

/**
 * Escape a string for safe interpolation inside a CSS single-quoted string.
 *
 * Prevents CSS injection by escaping characters that could break out of
 * a `'...'` CSS string context: backslashes, single quotes, and newlines.
 *
 * Used by font-google-base.ts, font-local.ts, and fallback-metrics.ts.
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
 *
 * Custom properties must start with `--` and only contain alphanumeric
 * characters, hyphens, and underscores. Anything else could be used to
 * break out of the CSS declaration and inject arbitrary rules.
 *
 * Returns the name if valid, undefined otherwise.
 */
export function sanitizeCSSVarName(name: string): string | undefined {
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
export function sanitizeFallback(name: string): string {
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

export function singleFontOptionValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    const values = new Set(value);
    return values.size === 1 ? value[0] : undefined;
  }
  return value;
}

export function sanitizeFontDescriptorValue(value: string): string | undefined {
  if (/[{};]|\/\*|\*\/|<\//i.test(value)) return undefined;
  return value;
}

export function resolveFontWeight(weight: string | string[] | undefined): number | undefined {
  const value = singleFontOptionValue(weight);
  if (!value || value.includes(" ")) return undefined;
  const numericWeight = Number(value);
  return Number.isFinite(numericWeight) ? numericWeight : undefined;
}

export function resolveFontStyle(style: string | string[] | undefined): string | undefined {
  const value = singleFontOptionValue(style);
  if (!value || value.includes(" ")) return undefined;
  return sanitizeFontDescriptorValue(value);
}

export function resolveGoogleFontStyle(style: string | string[] | undefined): string | undefined {
  if (style === undefined) return "normal";
  const value = singleFontOptionValue(style);
  if (!value) return undefined;
  if (value === "normal" || value === "italic") return value;
  return undefined;
}

export function resolveSingleFaceStyle(input: FontFaceStyleInput): FontStyle {
  const fontWeight = input.internalWeight ?? resolveFontWeight(input.weight);
  const internalStyle = input.internalStyle
    ? sanitizeFontDescriptorValue(input.internalStyle)
    : undefined;
  const fontStyle =
    internalStyle ??
    (input.google ? resolveGoogleFontStyle(input.style) : resolveFontStyle(input.style));

  return {
    fontFamily: input.fontFamily,
    ...(fontWeight !== undefined ? { fontWeight } : {}),
    ...(fontStyle ? { fontStyle } : {}),
  };
}

export function formatFontClassRule(className: string, style: FontStyle): string {
  const fontStyle = style.fontStyle ? sanitizeFontDescriptorValue(style.fontStyle) : undefined;
  const declarations = [
    `font-family: ${style.fontFamily}`,
    ...(style.fontWeight !== undefined ? [`font-weight: ${style.fontWeight}`] : []),
    ...(fontStyle ? [`font-style: ${fontStyle}`] : []),
  ];
  return `.${className} { ${declarations.join("; ")}; }\n`;
}

/**
 * Determine the MIME type for a font file based on its extension.
 * Uses endsWith() only to avoid false positives from substring matches
 * (e.g. ".woff" matching ".woff2").
 */
export function getFontMimeType(pathOrUrl: string): string {
  if (pathOrUrl.endsWith(".woff2")) return "font/woff2";
  if (pathOrUrl.endsWith(".woff")) return "font/woff";
  if (pathOrUrl.endsWith(".ttf")) return "font/ttf";
  if (pathOrUrl.endsWith(".otf")) return "font/opentype";
  return "font/woff2";
}
