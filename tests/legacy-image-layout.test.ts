import { describe, expect, it } from "vite-plus/test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LegacyImage from "../packages/vinext/src/shims/legacy-image.js";

describe("legacy intrinsic image sizing", () => {
  it.each([undefined, "intrinsic"] as const)("constrains layout=%s to its container", (layout) => {
    const html = renderToStaticMarkup(
      React.createElement(LegacyImage, {
        src: "/photo.jpg",
        alt: "Photo",
        width: 640,
        height: 320,
        layout,
        style: { borderRadius: 8 },
      }),
    );
    expect(html).toContain('width="640"');
    expect(html).toContain('height="320"');
    expect(html).toContain("max-width:100%");
    expect(html).toContain("height:auto");
    expect(html).toContain("border-radius:8px");
  });
});
