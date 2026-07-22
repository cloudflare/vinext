import { describe, it, expect } from "vite-plus/test";
import { getFontAxes } from "../../packages/vinext/src/build/google-fonts/get-axes.js";

// Ported from Next.js: packages/font/src/google/get-font-axes.ts.
// Resolves the `wght` / `ital` / variable-axis values that the URL builder
// then encodes. The metadata-driven path is the whole reason vinext bundles
// `font-data.json`: without it Sen would emit `:wght@100..900` and 400, and
// variable fonts would lose their real axis range.

describe("getFontAxes", () => {
  it("returns explicit weights as wght and no ital when style is normal-only", () => {
    expect(getFontAxes("Inter", ["400", "700"], ["normal"])).toEqual({
      wght: ["400", "700"],
      ital: undefined,
      variableAxes: undefined,
    });
  });

  it("emits ital ['1'] when only italic style is requested", () => {
    // ital=0 (normal) is implied by Google when omitted, so italic-only
    // becomes ['1'] not ['0','1']. This is the bug vinext currently has where
    // italic-only is silently dropped.
    expect(getFontAxes("Inter", ["400"], ["italic"])).toEqual({
      wght: ["400"],
      ital: ["1"],
      variableAxes: undefined,
    });
  });

  it("emits ital ['0','1'] when both normal and italic styles are requested", () => {
    expect(getFontAxes("Inter", ["400"], ["normal", "italic"])).toEqual({
      wght: ["400"],
      ital: ["0", "1"],
      variableAxes: undefined,
    });
  });

  it("resolves variable Inter to its real wght axis range from metadata", () => {
    expect(getFontAxes("Inter", ["variable"], ["normal"])).toEqual({
      wght: ["100..900"],
      ital: undefined,
      variableAxes: undefined,
    });
  });

  it("resolves variable Sen to 400..800 (regression from issue #885)", () => {
    // Sen's wght axis is 400..800. The pre-port shim emitted 100..900 and
    // Google returned HTTP 400. With metadata, the URL becomes valid.
    expect(getFontAxes("Sen", ["variable"], ["normal"])).toEqual({
      wght: ["400..800"],
      ital: undefined,
      variableAxes: undefined,
    });
  });

  it("threads selected variable axes alongside wght for variable fonts", () => {
    // Inter's opsz axis is 14..32; including it in the URL lets the browser
    // pick the optical-size-tuned outline at the right pixel size.
    expect(getFontAxes("Inter", ["variable"], ["normal"], ["opsz"])).toEqual({
      wght: ["100..900"],
      ital: undefined,
      variableAxes: [["opsz", "14..32"]],
    });
  });

  it("throws when selectedVariableAxes references an axis the font does not have", () => {
    // Inter has `opsz` and `wght`. After filtering out `wght`, the only
    // definable axis is `opsz`, so requesting `slnt` should be rejected with
    // a per-axis error (not the "no definable axes" branch).
    expect(() => getFontAxes("Inter", ["variable"], ["normal"], ["slnt"])).toThrow(
      /Invalid axes value `slnt` for font `Inter`/,
    );
  });

  it("throws when selectedVariableAxes is given for a font with no definable axes", () => {
    // Sen has only `wght`; selecting any non-wght axis should throw with the
    // "no definable axes" message because filtering wght out leaves nothing.
    expect(() => getFontAxes("Sen", ["variable"], ["normal"], [])).toThrow(
      /Font `Sen` has no definable `axes`/,
    );
  });
});
