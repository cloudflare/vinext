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
