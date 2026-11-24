/**
 * Issue #4841: next/image must render an inline `color: transparent` until
 * the image fails to load, so its alt text is not painted before then.
 *
 * Next.js builds the image style with `color: 'transparent'` unless the
 * `showAltText` state (set by the error handler) is on, and spreads the
 * caller's `style` last. See next/dist/shared/lib/get-img-props.js (`imgStyle`).
 */
import { describe, it, expect } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Image, { getImageProps } from "../packages/vinext/src/shims/image.js";

const cases: Array<[string, Record<string, unknown>]> = [
  ["width/height", { src: "/photo.png", alt: "photo", width: 76, height: 20 }],
  ["fill", { src: "/photo.png", alt: "photo", fill: true, sizes: "100vw" }],
  ["unoptimized", { src: "/photo.png", alt: "photo", width: 76, height: 20, unoptimized: true }],
  [
    "custom loader",
    {
      src: "/photo.png",
      alt: "photo",
      width: 76,
      height: 20,
      loader: ({ src, width }: { src: string; width: number }) => `${src}?w=${width}`,
    },
  ],
  ["remote", { src: "https://images.unsplash.com/photo-1", alt: "photo", width: 76, height: 20 }],
];

describe("next/image inline color: transparent (issue #4841)", () => {
  for (const [name, props] of cases) {
    it(`${name} <Image> SSR has inline color:transparent`, () => {
      const html = ReactDOMServer.renderToStaticMarkup(React.createElement(Image, props as never));
      expect(html).toMatch(/style="[^"]*color:transparent/);
    });
  }

  it("getImageProps style has color: transparent", () => {
    const { props } = getImageProps({ src: "/photo.png", alt: "photo", width: 76, height: 20 });
    expect(props.style).toMatchObject({ color: "transparent" });
  });

  it("caller's own color still wins", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Image, {
        src: "/photo.png",
        alt: "photo",
        width: 76,
        height: 20,
        style: { color: "red" },
      }),
    );
    expect(html).toContain("color:red");
    expect(html).not.toContain("color:transparent");
  });
});
