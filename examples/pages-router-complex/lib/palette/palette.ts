export const PALETTES = ["base", "story", "service"] as const;

export type PaletteName = (typeof PALETTES)[number];
