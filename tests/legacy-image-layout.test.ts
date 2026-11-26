import { describe, expect, it } from "vite-plus/test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LegacyImage from "../packages/vinext/src/shims/legacy-image.js";
import type { ImageProps } from "../packages/vinext/src/shims/legacy-image.js";

function render(props: Partial<ImageProps>): string {
  return renderToStaticMarkup(
    React.createElement(LegacyImage, {
      src: "/photo.jpg",
      alt: "Photo",
      width: 640,
      height: 320,
      ...props,
    }),
  );
}

describe("legacy intrinsic image sizing", () => {
  it.each([undefined, "intrinsic"] as const)("constrains layout=%s to its container", (layout) => {
    const html = render({ layout, style: { borderRadius: 8 } });
    expect(html).toContain('width="640"');
    expect(html).toContain('height="320"');
    expect(html).toContain("max-width:100%");
    expect(html).toContain("height:auto");
    expect(html).toContain("border-radius:8px");
  });

  it("does not constrain layout=fixed", () => {
    const html = render({ layout: "fixed" });
    expect(html).not.toContain("max-width");
    expect(html).not.toContain("height:auto");
  });

  // Next.js: `let layout = sizes ? 'responsive' : 'intrinsic'`
  it("defaults to responsive when sizes is set", () => {
    const html = render({ sizes: "50vw" });
    expect(html).toMatch(/[";]width:100%/);
    expect(html).not.toContain("max-width");
  });

  it("keeps an explicit intrinsic layout when sizes is set", () => {
    const html = render({ sizes: "50vw", layout: "intrinsic" });
    expect(html).toContain("max-width:100%");
    expect(html).not.toMatch(/[";]width:100%/);
  });
});

// Ported from Next.js client/legacy/image.tsx getWidths(): `sizes` picks the
// widths only for fill and responsive layouts, and a responsive image offers
// every device width. See also test/e2e/next-image-legacy/default
// ("should work with layout-responsive so resizing window maintains image
// aspect ratio").
describe("legacy image srcSet widths", () => {
  const DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
  const optimized = (w: number) => `/_next/image?url=%2Fphoto.jpg&amp;w=${w}&amp;q=75`;
  const loader = ({ src, width }: { src: string; width: number }) => `${src}?w=${width}`;

  it("offers every device width to a responsive image", () => {
    const html = render({ layout: "responsive", width: 1200, height: 800 });
    expect(html).toContain(
      `srcSet="${DEVICE_SIZES.map((w) => `${optimized(w)} ${w}w`).join(", ")}"`,
    );
    expect(html).toContain('sizes="100vw"');
    expect(html).toContain(`src="${optimized(3840)}"`);
  });

  it("builds a responsive custom-loader srcSet from the device widths", () => {
    const html = render({ layout: "responsive", width: 1200, height: 800, loader });
    expect(html).toContain(
      `srcSet="${DEVICE_SIZES.map((w) => `/photo.jpg?w=${w} ${w}w`).join(", ")}"`,
    );
    expect(html).toContain('sizes="100vw"');
  });

  it("ignores sizes when picking fixed and intrinsic widths", () => {
    for (const layout of ["fixed", "intrinsic"] as const) {
      const html = render({ layout, width: 400, height: 200, sizes: "50vw", loader });
      expect(html).toContain('srcSet="/photo.jpg?w=640 1x, /photo.jpg?w=828 2x"');
      expect(html).toContain('sizes="50vw"');
    }
  });

  // Next.js generateImgAttrs keeps `src` last so Safari does not fetch it
  // before `srcSet` is set.
  it("renders src after sizes and srcSet", () => {
    const html = render({ layout: "responsive", width: 1200, height: 800 });
    expect(html.indexOf(" src=")).toBeGreaterThan(html.indexOf(" srcSet="));
    expect(html.indexOf(" srcSet=")).toBeGreaterThan(html.indexOf(" sizes="));
  });
});
