import { describe, expect, it } from "vitest";

// Ported from Next.js: packages/next/src/shared/lib/image-blur-svg.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/image-blur-svg.ts

const IMAGE_BLUR_SVG_MODULE_PATH = "../packages/vinext/src/shims/image-blur-svg.js";

async function loadModule() {
  return import(IMAGE_BLUR_SVG_MODULE_PATH);
}

describe("getImageBlurSvg", () => {
  it("generates SVG with blurWidth and blurHeight scaled by 40x", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      blurWidth: 8,
      blurHeight: 6,
      blurDataURL: "data:image/png;base64,abc",
    });

    // blurWidth * 40 = 320, blurHeight * 40 = 240
    expect(svg).toContain("viewBox='0 0 320 240'");
    expect(svg).toContain("href='data:image/png;base64,abc'");
  });

  it("uses widthInt and heightInt when blurWidth/blurHeight are absent", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      widthInt: 800,
      heightInt: 600,
      blurDataURL: "data:image/png;base64,abc",
    });

    expect(svg).toContain("viewBox='0 0 800 600'");
  });

  it("omits viewBox when no dimensions are available", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      blurDataURL: "data:image/png;base64,abc",
    });

    expect(svg).not.toContain("viewBox");
  });

  it("includes Gaussian blur filter with stdDeviation=20", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      widthInt: 100,
      heightInt: 100,
      blurDataURL: "data:image/png;base64,abc",
    });

    expect(svg).toContain("stdDeviation='20'");
  });

  it("includes feColorMatrix for color adjustment", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      widthInt: 100,
      heightInt: 100,
      blurDataURL: "data:image/png;base64,abc",
    });

    expect(svg).toContain("feColorMatrix");
    expect(svg).toContain("1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1");
  });

  it("sets preserveAspectRatio='none' when viewBox is present", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      widthInt: 100,
      heightInt: 100,
      blurDataURL: "data:image/png;base64,abc",
    });

    expect(svg).toContain("preserveAspectRatio='none'");
  });

  it("sets preserveAspectRatio='xMidYMid' when objectFit=contain and no viewBox", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      blurDataURL: "data:image/png;base64,abc",
      objectFit: "contain",
    });

    expect(svg).toContain("preserveAspectRatio='xMidYMid'");
  });

  it("sets preserveAspectRatio='xMidYMid slice' when objectFit=cover and no viewBox", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      blurDataURL: "data:image/png;base64,abc",
      objectFit: "cover",
    });

    expect(svg).toContain("preserveAspectRatio='xMidYMid slice'");
  });

  it("sets preserveAspectRatio='none' for other objectFit values when no viewBox", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      blurDataURL: "data:image/png;base64,abc",
      objectFit: "fill",
    });

    expect(svg).toContain("preserveAspectRatio='none'");
  });

  it("prefers blurWidth/blurHeight over widthInt/heightInt", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      widthInt: 800,
      heightInt: 600,
      blurWidth: 8,
      blurHeight: 6,
      blurDataURL: "data:image/png;base64,abc",
    });

    // Should use blurWidth * 40 = 320, not widthInt = 800
    expect(svg).toContain("viewBox='0 0 320 240'");
  });

  it("returns a URL-encoded SVG string", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      widthInt: 100,
      heightInt: 100,
      blurDataURL: "data:image/png;base64,abc",
    });

    // Should be URL-encoded (uses %3C instead of <)
    expect(svg).toContain("%3Csvg");
    expect(svg).toContain("%3C/svg%3E");
    expect(svg).not.toContain("<svg");
  });

  it("includes image element with width/height 100%", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      widthInt: 100,
      heightInt: 100,
      blurDataURL: "data:image/png;base64,abc",
    });

    expect(svg).toContain("width='100%25'");
    expect(svg).toContain("height='100%25'");
  });

  it("matches Next.js output exactly", async () => {
    const { getImageBlurSvg } = await loadModule();
    const svg = getImageBlurSvg({
      widthInt: 100,
      heightInt: 100,
      blurWidth: 8,
      blurHeight: 6,
      blurDataURL: "data:image/png;base64,test",
      objectFit: undefined,
    });

    // This is the exact output Next.js produces
    const expected = `%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 240'%3E%3Cfilter id='b' color-interpolation-filters='sRGB'%3E%3CfeGaussianBlur stdDeviation='20'/%3E%3CfeColorMatrix values='1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1' result='s'/%3E%3CfeFlood x='0' y='0' width='100%25' height='100%25'/%3E%3CfeComposite operator='out' in='s'/%3E%3CfeComposite in2='SourceGraphic'/%3E%3CfeGaussianBlur stdDeviation='20'/%3E%3C/filter%3E%3Cimage width='100%25' height='100%25' x='0' y='0' preserveAspectRatio='none' style='filter: url(%23b);' href='data:image/png;base64,test'/%3E%3C/svg%3E`;

    expect(svg).toBe(expected);
  });
});
