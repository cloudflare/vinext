// Typed wrapper around the vendored Google Fonts metadata.
//
// `font-data.json` originates upstream in Next.js (see NOTICE.md). It is a
// large object keyed by family name; the JSON itself stays as a sibling file
// rather than an inline `as const` literal so that we can refresh it from
// upstream with a single copy and keep the source diff legible.

import rawFontData from "./font-data.json" with { type: "json" };

export type VariableAxisDescriptor = {
  tag: string;
  min: number;
  max: number;
  defaultValue: number;
};

export type FontFamilyMetadata = {
  /** Available weight values, plus the literal "variable" if a variable face exists. */
  weights: string[];
  /** Available styles, e.g. ["normal"], ["italic"], or both. */
  styles: string[];
  /** Variable axes for this family. Absent when the family has no variable face. */
  axes?: VariableAxisDescriptor[];
  /** Preloadable subsets (e.g. "latin", "latin-ext", "vietnamese"). */
  subsets: string[];
};

// Strongly typed view of the JSON. The repo bans `as` casts, so the type is
// imposed via an explicit annotation on the export. TypeScript still
// structurally verifies that the JSON's shape is assignable to
// `Record<string, FontFamilyMetadata>`.
export const googleFontsMetadata: Record<string, FontFamilyMetadata> = rawFontData;
