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
 * Determine the preload `type` for a font file based on its extension.
 * Uses endsWith() only to avoid false positives from substring matches
 * (e.g. ".woff" matching ".woff2"). Matches Next.js, which emits
 * `font/${ext}` for every font preload (including `font/eot`).
 */
export function getFontMimeType(pathOrUrl: string): string {
  if (pathOrUrl.endsWith(".woff2")) return "font/woff2";
  if (pathOrUrl.endsWith(".woff")) return "font/woff";
  if (pathOrUrl.endsWith(".ttf")) return "font/ttf";
  if (pathOrUrl.endsWith(".otf")) return "font/otf";
  if (pathOrUrl.endsWith(".eot")) return "font/eot";
  return "font/woff2";
}

/**
 * The global slot holding the owner key of the font loader call that is
 * running. The `vinext:font-owner` transform (see `plugins/fonts.ts`) passes
 * each server module's key to its loader calls as `_vinextOwner`, and the
 * loaders set this slot only for their own synchronous run (see
 * {@link runWithFontOwner}), so no other module's evaluation can interleave.
 */
export const FONT_OWNER_KEY = Symbol.for("vinext.font.owner");

/**
 * The owner keys of the modules a render may show, or `null`/`undefined` for
 * every collected font. Built from the route font manifest (see
 * `plugins/font-owner-manifest.ts`).
 */
export type FontOwners = readonly string[] | null | undefined;

type OwnedFontEntry<T> = {
  value: T;
  /** The modules that registered it, or `null` when one had no owner key. */
  owners: Set<string> | null;
  /** Entries with the same key are emitted once per render, first one wins. */
  onceKey?: string;
};

/** An insertion-ordered SSR font collection, deduplicated by entry key. */
export type OwnedFontCollection<T> = Map<string, OwnedFontEntry<T>>;

/** Run a font loader call with `owner` as the owner of what it registers. */
export function runWithFontOwner<T>(owner: unknown, fn: () => T): T {
  const g = globalThis as typeof globalThis & { [FONT_OWNER_KEY]?: unknown };
  const previous = g[FONT_OWNER_KEY];
  g[FONT_OWNER_KEY] = typeof owner === "string" ? owner : undefined;
  try {
    return fn();
  } finally {
    g[FONT_OWNER_KEY] = previous;
  }
}

function currentFontOwner(): string | null {
  const owner = (globalThis as typeof globalThis & { [FONT_OWNER_KEY]?: unknown })[FONT_OWNER_KEY];
  return typeof owner === "string" ? owner : null;
}

/**
 * Record `value` under `key`, owned by the module now evaluating. A font
 * registered outside any owned module (a loader call the transform could not
 * attribute) belongs to every render, as all fonts did before fonts were scoped.
 */
export function addOwnedFontEntry<T>(
  collection: OwnedFontCollection<T>,
  key: string,
  value: T,
  onceKey?: string,
): void {
  const owner = currentFontOwner();
  const entry = collection.get(key);
  if (!entry) {
    collection.set(key, { value, owners: owner === null ? null : new Set([owner]), onceKey });
    return;
  }
  if (entry.owners === null) return;
  if (owner === null) entry.owners = null;
  else entry.owners.add(owner);
}

/** The values a render owned by `owners` carries, in registration order. */
export function listOwnedFontEntries<T>(
  collection: OwnedFontCollection<T>,
  owners?: FontOwners,
): T[] {
  const wanted = owners ? new Set(owners) : null;
  const emittedOnceKeys = new Set<string>();
  const values: T[] = [];
  for (const entry of collection.values()) {
    if (wanted && entry.owners && !hasAny(entry.owners, wanted)) continue;
    if (entry.onceKey !== undefined) {
      if (emittedOnceKeys.has(entry.onceKey)) continue;
      emittedOnceKeys.add(entry.onceKey);
    }
    values.push(entry.value);
  }
  return values;
}

function hasAny(owners: ReadonlySet<string>, wanted: ReadonlySet<string>): boolean {
  for (const owner of owners) if (wanted.has(owner)) return true;
  return false;
}
