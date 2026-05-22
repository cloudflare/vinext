/**
 * vinext-specific extensions to Next.js's `NEXT_DATA`.
 *
 * The `next` package declares `Window.__NEXT_DATA__: NEXT_DATA` in its types.
 * We can't augment the `NEXT_DATA` type alias, so we extend the vinext shim's
 * interface (shims/internal/utils.ts) and cast at the usage sites.
 */
import type { NEXT_DATA } from "vinext/shims/internal/utils";
import { isUnknownRecord } from "../utils/record.js";

export type VinextLinkPrefetchRoute = {
  canPrefetchLoadingShell: boolean;
  isDynamic: boolean;
  patternParts: string[];
};

export type VinextNextData = {
  /** vinext-specific additions (not part of Next.js upstream). */
  __vinext?: {
    /** Absolute URL of the page module for dynamic import. */
    pageModuleUrl?: string;
    /** Absolute URL of the `_app` module for dynamic import. */
    appModuleUrl?: string;
  };
} & NEXT_DATA;

type BrowserVinextNextData = NonNullable<Window["__NEXT_DATA__"]> & VinextNextData;

type VinextLocaleGlobalTarget = {
  __VINEXT_LOCALE__: string | undefined;
  __VINEXT_LOCALES__: string[] | undefined;
  __VINEXT_DEFAULT_LOCALE__: string | undefined;
};

export function extractVinextNextDataJson(html: string): string | null {
  const assignment = /<script(?:\s[^>]*)?>\s*window\.__NEXT_DATA__\s*=\s*/.exec(html);
  if (!assignment || assignment.index === undefined) return null;

  let start = assignment.index + assignment[0].length;
  while (
    html[start] === " " ||
    html[start] === "\n" ||
    html[start] === "\t" ||
    html[start] === "\r"
  ) {
    start++;
  }
  if (html[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < html.length; index++) {
    const char = html[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }

  return null;
}

export function parseVinextNextDataJson(json: string): BrowserVinextNextData {
  const parsed: unknown = JSON.parse(json);
  if (!isBrowserVinextNextData(parsed)) {
    throw new Error("Navigation failed: invalid __NEXT_DATA__ in response");
  }
  return parsed;
}

function isBrowserVinextNextData(value: unknown): value is BrowserVinextNextData {
  if (!isUnknownRecord(value)) return false;

  const props = value.props;
  const page = value.page;
  const query = value.query;
  const vinext = value.__vinext;

  return (
    isUnknownRecord(props) &&
    typeof page === "string" &&
    isUnknownRecord(query) &&
    (vinext === undefined || isUnknownRecord(vinext))
  );
}

export function applyVinextLocaleGlobals(
  target: VinextLocaleGlobalTarget,
  nextData: VinextNextData,
): void {
  if (nextData.locale !== undefined) {
    target.__VINEXT_LOCALE__ = nextData.locale;
  }
  if (nextData.locales !== undefined) {
    target.__VINEXT_LOCALES__ = [...nextData.locales];
  }
  if (nextData.defaultLocale !== undefined) {
    target.__VINEXT_DEFAULT_LOCALE__ = nextData.defaultLocale;
  }
}
