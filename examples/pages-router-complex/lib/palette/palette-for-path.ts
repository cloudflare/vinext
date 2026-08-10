import type { PaletteName } from "./palette";

/**
 * Derives the visual palette from the raw request URL. Runs inside
 * Document.getInitialProps, so it must tolerate rewritten internal paths
 * (`/us/en-us/journal/x`) as well as public ones (`/journal/x`).
 */
export const paletteForPath = (pathname: string): PaletteName | null => {
  const bare = pathname.split("?")[0];
  const segments = bare.split("/").filter(Boolean);
  // Skip the zone prefix when present (`/ca/journal` and `/journal` are the
  // same page).
  const publicSegments = /^[a-z]{2}$/.test(segments[0] ?? "")
    ? segments.slice(1)
    : segments;

  const [head] = publicSegments;
  if (!head) return "base";
  if (head === "journal") return "story";
  if (head === "diagnostics" || head === "detail-tools") return "service";
  return "base";
};
