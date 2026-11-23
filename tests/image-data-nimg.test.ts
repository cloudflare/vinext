/**
 * Issue #4842: next/image must set `data-nimg` on every rendered <img>.
 *
 * Next.js always emits `data-nimg="fill"` for fill images and `data-nimg="1"`
 * otherwise (next/dist/shared/lib/get-img-props.js), including with a custom
 * `loader` and for remote `src` with width/height.
 */
import { describe, it, expect } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Image from "../packages/vinext/src/shims/image.js";

const loader = ({ src, width }: { src: string; width: number }) =>
  `https://img.example.com${src}?w=${width}`;

function render(props: Record<string, unknown>): string {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(Image, props as never));
}

describe("next/image sets data-nimg on every branch (issue #4842)", () => {
  it("fill with a custom loader", () => {
    const html = render({ src: "/photo.png", alt: "photo", fill: true, sizes: "100vw", loader });
    expect(html).toContain('data-nimg="fill"');
  });

  it("width/height with a custom loader", () => {
    const html = render({ src: "/photo.png", alt: "photo", width: 76, height: 20, loader });
    expect(html).toContain('data-nimg="1"');
  });

  it("width/height with a remote src", () => {
    const html = render({
      src: "https://images.example.com/photo.png",
      alt: "photo",
      width: 76,
      height: 20,
    });
    expect(html).toContain('data-nimg="1"');
  });

  it("control: width/height with a local src", () => {
    const html = render({ src: "/photo.png", alt: "photo", width: 76, height: 20 });
    expect(html).toContain('data-nimg="1"');
  });
});
