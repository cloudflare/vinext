import { describe, it, expect } from "vite-plus/test";
import { sortFontsVariantValues } from "../../packages/vinext/src/build/google-fonts/sort-variants.js";

// Ported from Next.js: packages/font/src/google/sort-fonts-variant-values.test.ts
// Comparator must produce a stable, Google-Fonts-acceptable ordering for both
// plain weight values ("100", "400") and "ital,wght" pairs ("0,400", "1,700").

describe("sortFontsVariantValues", () => {
  it("orders plain weight strings by numeric weight", () => {
    expect(sortFontsVariantValues("100", "200")).toBe(-100);
    expect(sortFontsVariantValues("200", "100")).toBe(100);
  });

  it("sorts an unsorted weight array numerically, not lexically", () => {
    const unsorted = ["100", "1000", "300", "200", "500"];
    expect(unsorted.slice().sort(sortFontsVariantValues)).toEqual([
      "100",
      "200",
      "300",
      "500",
      "1000",
    ]);
  });

  it("orders ital,wght pairs by ital first, then wght", () => {
    // Same ital, different wght: numeric wght order
    expect(sortFontsVariantValues("1,100", "1,200")).toBe(-100);
    // Different ital: ital order wins regardless of wght
    expect(sortFontsVariantValues("1,100", "0,200")).toBe(1);
    expect(sortFontsVariantValues("0,200", "1,100")).toBe(-1);
  });

  it("sorts a full ital,wght variant array into Google's required order", () => {
    const unsorted = ["1,100", "1,200", "0,100", "0,200"];
    expect(unsorted.slice().sort(sortFontsVariantValues)).toEqual([
      "0,100",
      "0,200",
      "1,100",
      "1,200",
    ]);
  });
});
