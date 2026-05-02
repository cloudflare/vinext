import { describe, it, expect } from "vite-plus/test";
import { buildGoogleFontsUrl } from "../../packages/vinext/src/build/google-fonts/build-url.js";

// Ported from Next.js: packages/font/src/google/get-google-fonts-url.ts.
// These tests pin the URL shape that Google Fonts CDN actually accepts. The
// pre-port vinext implementation hardcoded `:wght@100..900`, which is invalid
// for fonts whose `wght` axis is narrower (e.g. Sen 400..800) and produced
// HTTP 400. See issue #885.

describe("buildGoogleFontsUrl", () => {
  it("emits no axis segment when no weight, ital, or variableAxes are given", () => {
    // Google Fonts returns the default static face when no `:` axis is set.
    // Critically, no hardcoded `:wght@100..900`; that is what broke Sen.
    const url = buildGoogleFontsUrl("Sen", {}, "swap");
    expect(url).toBe("https://fonts.googleapis.com/css2?family=Sen&display=swap");
  });

  it("encodes a single weight as :wght@<value>", () => {
    const url = buildGoogleFontsUrl("Inter", { wght: ["400"] }, "swap");
    expect(url).toBe("https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap");
  });

  it("emits a variable-font axis range as :wght@min..max", () => {
    const url = buildGoogleFontsUrl("Sen", { wght: ["400..800"] }, "swap");
    expect(url).toBe("https://fonts.googleapis.com/css2?family=Sen:wght@400..800&display=swap");
  });

  it("joins multiple weights with semicolons in numeric order", () => {
    // Caller provides ["700","100","400"] in any order; URL must sort
    // numerically to match Google's required ordering.
    const url = buildGoogleFontsUrl("Inter", { wght: ["700", "100", "400"] }, "swap");
    expect(url).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:wght@100;400;700&display=swap",
    );
  });

  it("emits ital,wght@<pairs> when both axes are present, sorted by ital then wght", () => {
    const url = buildGoogleFontsUrl("Inter", { wght: ["400", "700"], ital: ["0", "1"] }, "swap");
    expect(url).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,700;1,400;1,700&display=swap",
    );
  });

  it("escapes spaces in family names with '+'", () => {
    const url = buildGoogleFontsUrl("Roboto Mono", { wght: ["400"] }, "swap");
    expect(url).toBe("https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400&display=swap");
  });

  it("threads variableAxes alongside the wght axis with lowercase tags first", () => {
    // Inter's opsz axis (14..32) must appear before WGHT-cased axes if any,
    // and lowercase axis tags sort before uppercase per Google's API.
    const url = buildGoogleFontsUrl(
      "Inter",
      { wght: ["100..900"], variableAxes: [["opsz", "14..32"]] },
      "swap",
    );
    expect(url).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,100..900&display=swap",
    );
  });

  it("emits only variableAxes when neither wght nor ital is given", () => {
    // Edge case from Next.js source: a variable font where the caller
    // selected a non-wght axis but left the weight at its default range.
    const url = buildGoogleFontsUrl("Roboto Flex", { variableAxes: [["wdth", "75..125"]] }, "swap");
    expect(url).toBe(
      "https://fonts.googleapis.com/css2?family=Roboto+Flex:wdth@75..125&display=swap",
    );
  });

  it("uses the requested display value", () => {
    const url = buildGoogleFontsUrl("Inter", { wght: ["400"] }, "optional");
    expect(url).toContain("display=optional");
  });
});
