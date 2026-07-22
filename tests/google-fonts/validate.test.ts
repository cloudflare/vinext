import { describe, it, expect } from "vite-plus/test";
import { googleFontsMetadata } from "../../packages/vinext/src/build/google-fonts/font-metadata.js";
import { validateGoogleFontOptions } from "../../packages/vinext/src/build/google-fonts/validate.js";

// Ported from Next.js: packages/font/src/google/validate-google-font-function-call.ts.
// vinext drops the SWC-style `(functionName, fontFunctionArgument)` calling
// convention since the plugin already knows the family name; everything else
// matches Next's contract one-for-one.

describe("validateGoogleFontOptions", () => {
  it("throws on unknown font families", () => {
    expect(() => validateGoogleFontOptions("NotARealFont", {})).toThrow(
      /Unknown font `NotARealFont`/,
    );
  });

  it("defaults a missing weight to ['variable'] for fonts that support it", () => {
    // This is the path that should run for Inter without any explicit weight.
    const opts = validateGoogleFontOptions("Inter", { subsets: ["latin"] });
    expect(opts.weights).toEqual(["variable"]);
  });

  it("throws on missing weight for fonts with no variable face (Anton)", () => {
    // Anton has only a single static `400` weight, no variable face. Today
    // vinext silently builds a `:wght@100..900` URL and Google returns 400;
    // post-port, validate must reject the call before the URL is built.
    expect(() => validateGoogleFontOptions("Anton", { subsets: ["latin"] })).toThrow(
      /Missing weight for font `Anton`/,
    );
  });

  it("rejects a weight value that is not in the font's metadata", () => {
    expect(() => validateGoogleFontOptions("Anton", { weight: "999", subsets: ["latin"] })).toThrow(
      /Unknown weight `999` for font `Anton`/,
    );
  });

  it("rejects mixing 'variable' with explicit weights", () => {
    expect(() =>
      validateGoogleFontOptions("Inter", {
        weight: ["400", "variable"],
        subsets: ["latin"],
      }),
    ).toThrow(/Unexpected `variable` in weight array/);
  });

  it("normalises weight: '400' (string) to weights: ['400']", () => {
    const opts = validateGoogleFontOptions("Inter", { weight: "400", subsets: ["latin"] });
    expect(opts.weights).toEqual(["400"]);
  });

  it("dedupes a duplicate weight array", () => {
    const opts = validateGoogleFontOptions("Inter", {
      weight: ["400", "400", "700"],
      subsets: ["latin"],
    });
    expect(opts.weights).toEqual(["400", "700"]);
  });

  it("defaults styles to ['normal']", () => {
    const opts = validateGoogleFontOptions("Inter", { weight: "400", subsets: ["latin"] });
    expect(opts.styles).toEqual(["normal"]);
  });

  it("preserves italic-only style requests", () => {
    const opts = validateGoogleFontOptions("Inter", {
      weight: "400",
      style: "italic",
      subsets: ["latin"],
    });
    expect(opts.styles).toEqual(["italic"]);
  });

  it("rejects axes on a non-variable font", () => {
    // Anton has no variable face at all, so any `axes` request is invalid.
    expect(() =>
      validateGoogleFontOptions("Anton", { weight: "400", axes: ["wdth"], subsets: ["latin"] }),
    ).toThrow(/Axes can only be defined for variable fonts/);
  });

  it("rejects non-array axes before font capability checks", () => {
    expect(() =>
      validateGoogleFontOptions("Anton", {
        weight: "400",
        axes: { wght: 400 } as any,
        subsets: ["latin"],
      }),
    ).toThrow(/Invalid axes value for font `Anton`, expected an array of axis names/);
  });

  it("rejects axes when an explicit (non-variable) weight is set on a variable font", () => {
    expect(() =>
      validateGoogleFontOptions("Inter", { weight: "400", axes: ["opsz"], subsets: ["latin"] }),
    ).toThrow(/weight property is nonexistent or set to `variable`/);
  });

  it("rejects an invalid display value", () => {
    expect(() =>
      validateGoogleFontOptions("Inter", { weight: "400", display: "bogus", subsets: ["latin"] }),
    ).toThrow(/Invalid display value `bogus`/);
  });

  it("defaults display to 'swap'", () => {
    const opts = validateGoogleFontOptions("Inter", { weight: "400", subsets: ["latin"] });
    expect(opts.display).toBe("swap");
  });

  it("requires subsets when preload is true and the font has preloadable subsets", () => {
    expect(() => validateGoogleFontOptions("Inter", { weight: "400" })).toThrow(
      /Preload is enabled but no subsets were specified/,
    );
  });

  it("rejects an unknown subset", () => {
    expect(() =>
      validateGoogleFontOptions("Inter", { weight: "400", subsets: ["klingon"] }),
    ).toThrow(/Unknown subset `klingon` for font `Inter`/);
  });

  it("disables preload automatically for fonts with no preloadable subsets", () => {
    // `Playwrite AR Guides` has weights: ['400'], styles: ['normal'], and an
    // empty subsets array in upstream metadata. The contract is to silently
    // flip preload to false instead of throwing, matching Next.js behavior.
    // If upstream metadata ever adds a subset to this family this test will
    // need a different fixture; the sanity check below guards the branch
    // independently of the specific family name.
    const opts = validateGoogleFontOptions("Playwrite AR Guides", { weight: "400" });
    expect(opts.preload).toBe(false);
  });

  it("metadata contains at least one family with no preloadable subsets", () => {
    const familiesWithNoSubsets = Object.values(googleFontsMetadata).filter(
      (meta) => meta.subsets.length === 0,
    );
    expect(familiesWithNoSubsets.length).toBeGreaterThan(0);
  });
});
