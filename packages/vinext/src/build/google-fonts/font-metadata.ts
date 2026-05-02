// Typed wrapper around the vendored Google Fonts metadata.
//
// `font-data.json` is vendored from vercel/next.js
// (`packages/font/src/google/font-data.json`, MIT License,
// Copyright (c) Vercel, Inc.). Refresh by re-copying that file. Both Next.js
// and vinext are MIT licensed, so the file is redistributed under the same
// terms.

import rawFontData from "./font-data.json" with { type: "json" };

type VariableAxisDescriptor = {
  tag: string;
  min: number;
  max: number;
  defaultValue: number;
};

type FontFamilyMetadata = {
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
