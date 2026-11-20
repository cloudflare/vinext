/**
 * Unit tests for next/image aspect-ratio distortion detection.
 *
 * Ported from Next.js: test/development/app-dir/image-sizing-warning/
 * https://github.com/vercel/next.js/blob/canary/test/development/app-dir/image-sizing-warning/image-sizing-warning.test.ts
 * Implementation: packages/next/src/client/image-component.tsx (vercel/next.js#101349)
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getImageAspectRatioWarning } from "../packages/vinext/src/shims/image-aspect-ratio.js";

const ASPECT_RATIO_WARNING =
  "is rendered with a different aspect ratio than its intrinsic dimensions. Adjust the width and height props, or use CSS 'width: \"auto\"' or 'height: \"auto\"' to preserve the aspect ratio. Read more: https://nextjs.org/docs/app/api-reference/components/image#style";

type ImageStub = {
  src: string;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  dataNimg?: string | null;
};

function stubImage(input: ImageStub): HTMLImageElement {
  return {
    src: input.src,
    width: input.width,
    height: input.height,
    naturalWidth: input.naturalWidth,
    naturalHeight: input.naturalHeight,
    getAttribute(name: string) {
      if (name === "data-nimg") return input.dataNimg ?? "1";
      return null;
    },
  } as HTMLImageElement;
}

function withObjectFit<T>(objectFit: string, run: () => T): T {
  const getComputedStyle = vi.fn(() => ({ objectFit }) as CSSStyleDeclaration);
  vi.stubGlobal("window", { getComputedStyle });
  try {
    return run();
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getImageAspectRatioWarning", () => {
  const sample = {
    src: "http://localhost/_next/image?url=%2Fsample.png%3Fcase%3Dfill&w=828&q=75",
    naturalWidth: 820,
    naturalHeight: 720,
  };

  it("warns when object-fit fill distorts a non-fill image", () => {
    const message = withObjectFit("fill", () =>
      getImageAspectRatioWarning(
        stubImage({
          ...sample,
          width: 680,
          height: 720,
          src: sample.src.replace("fill", "default"),
        }),
      ),
    );
    expect(message).toContain('Image with src "/sample.png?case=default"');
    expect(message).toContain(ASPECT_RATIO_WARNING);
  });

  it("warns when both rendered dimensions differ from the source ratio", () => {
    const message = withObjectFit("fill", () =>
      getImageAspectRatioWarning(stubImage({ ...sample, width: 681, height: 721 })),
    );
    expect(message).toContain('Image with src "/sample.png?case=fill"');
    expect(message).toContain(ASPECT_RATIO_WARNING);
  });

  it.each(["cover", "contain", "none", "scale-down"] as const)(
    "does not warn for object-fit %s",
    (objectFit) => {
      expect(
        withObjectFit(objectFit, () =>
          getImageAspectRatioWarning(stubImage({ ...sample, width: 680, height: 720 })),
        ),
      ).toBeUndefined();
    },
  );

  it("does not warn for the fill prop", () => {
    expect(
      withObjectFit("fill", () =>
        getImageAspectRatioWarning(
          stubImage({
            ...sample,
            width: 680,
            height: 720,
            dataNimg: "fill",
            src: sample.src.replace("fill", "fill-prop"),
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it("does not warn when width or height is zero", () => {
    expect(
      withObjectFit("fill", () =>
        getImageAspectRatioWarning(stubImage({ ...sample, width: 0, height: 720 })),
      ),
    ).toBeUndefined();
    expect(
      withObjectFit("fill", () =>
        getImageAspectRatioWarning(stubImage({ ...sample, width: 820, height: 0 })),
      ),
    ).toBeUndefined();
    expect(
      withObjectFit("fill", () =>
        getImageAspectRatioWarning(
          stubImage({ ...sample, width: 820, height: 720, naturalWidth: 0, naturalHeight: 0 }),
        ),
      ),
    ).toBeUndefined();
  });

  it("does not warn for proportional sizing", () => {
    expect(
      withObjectFit("fill", () =>
        getImageAspectRatioWarning(
          stubImage({
            ...sample,
            width: 410,
            height: 360,
            src: sample.src.replace("fill", "proportional"),
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it("does not warn for a cropped cover image whose height matches the prop", () => {
    expect(
      withObjectFit("cover", () =>
        getImageAspectRatioWarning(stubImage({ ...sample, width: 680, height: 720 })),
      ),
    ).toBeUndefined();
  });

  it("allows rounding and density-corrected natural dimensions", () => {
    // Rendered 1640×1440 matches the 820×720 source. Natural dimensions are
    // truncated after density correction (66×57 from 66px sizes and an 820w
    // descriptor), which would false-warn without the 1/naturalWidth terms.
    expect(
      withObjectFit("fill", () =>
        getImageAspectRatioWarning(
          stubImage({
            src: "http://localhost/sample.png?case=density-rounded",
            width: 1640,
            height: 1440,
            naturalWidth: 66,
            naturalHeight: 57,
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it("allows a half-pixel of rendered-size rounding on a fractional SVG", () => {
    expect(
      withObjectFit("fill", () =>
        getImageAspectRatioWarning(
          stubImage({
            src: "http://localhost/fractional.svg?case=fractional",
            width: 75,
            height: 38,
            naturalWidth: 150,
            naturalHeight: 75,
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it("reads the original src from an optimizer url query param", () => {
    const message = withObjectFit("fill", () =>
      getImageAspectRatioWarning(
        stubImage({
          src: "http://n/_next/image?url=%2Fphoto.png%3Fcase%3Dheight-only&w=640&q=75",
          width: 820,
          height: 600,
          naturalWidth: 820,
          naturalHeight: 720,
        }),
      ),
    );
    expect(message).toContain('Image with src "/photo.png?case=height-only"');
  });
});
