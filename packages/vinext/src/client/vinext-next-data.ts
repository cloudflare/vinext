/**
 * vinext-specific extensions to Next.js's `NEXT_DATA`.
 *
 * The `next` package declares `Window.__NEXT_DATA__: NEXT_DATA` in its types.
 * We can't augment the `NEXT_DATA` type alias, so we extend the vinext shim's
 * interface (shims/internal/utils.ts) and cast at the usage sites.
 */
import type { NEXT_DATA } from "../shims/internal/utils.js";

export type VinextNextData = {
  /** vinext-specific additions (not part of Next.js upstream). */
  __vinext?: {
    /** Absolute URL of the page module for dynamic import. */
    pageModuleUrl?: string;
    /** Absolute URL of the `_app` module for dynamic import. */
    appModuleUrl?: string;
  };
} & NEXT_DATA;
