/**
 * Issue #3238: next/image `fill` must not emit an inline `object-fit`.
 *
 * Next.js builds the fill style from the legacy `objectFit` prop (undefined
 * for modern usage) and spreads the caller's `style` last, so a fill image has
 * no inline object-fit unless the caller sets one. A stylesheet rule such as
 * `.object-contain { object-fit: contain }` can then apply.
 * See next/dist/shared/lib/get-img-props.js (`imgStyle`).
 */
import { describe, it, expect } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Image, { getImageProps } from "../packages/vinext/src/shims/image.js";

describe("next/image fill leaves object-fit to the caller (issue #3238)", () => {
  it("getImageProps fill style has no objectFit", () => {
    const { props } = getImageProps({ alt: "fill", src: "/bg.png", fill: true });
    expect(props.style).not.toHaveProperty("objectFit");
  });

  it("local fill <Image> SSR has no inline object-fit", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "logo",
        src: "/logo.png",
        fill: true,
        className: "object-contain",
      }),
    );
    expect(html).toContain('data-nimg="fill"');
    expect(html).not.toContain("object-fit");
  });

  it("remote fill <Image> SSR has no inline object-fit", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote logo",
        src: "https://images.unsplash.com/photo-fill",
        fill: true,
        className: "object-contain",
      }),
    );
    expect(html).toContain('data-nimg="fill"');
    expect(html).not.toContain("object-fit");
  });

  it("custom loader fill <Image> SSR has no inline object-fit", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "loader logo",
        src: "/logo.png",
        fill: true,
        className: "object-contain",
        loader: ({ src, width }: { src: string; width: number }) => `${src}?w=${width}`,
      }),
    );
    expect(html).toContain("position:absolute");
    expect(html).not.toContain("object-fit");
  });

  it("unoptimized fill <Image> SSR has no inline object-fit", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "unoptimized logo",
        src: "/logo.png",
        fill: true,
        unoptimized: true,
        className: "object-contain",
      }),
    );
    expect(html).toContain('data-nimg="fill"');
    expect(html).not.toContain("object-fit");
  });

  it("caller style objectFit is still honored", () => {
    const { props } = getImageProps({
      alt: "fill",
      src: "/bg.png",
      fill: true,
      style: { objectFit: "contain" },
    });
    expect(props.style?.objectFit).toBe("contain");
  });

  it("deprecated objectFit/objectPosition props style a fill image", () => {
    const { props } = getImageProps({
      alt: "fill",
      src: "/bg.png",
      fill: true,
      objectFit: "cover",
      objectPosition: "top",
    });
    expect(props.style?.objectFit).toBe("cover");
    expect(props.style?.objectPosition).toBe("top");
    expect(props).not.toHaveProperty("objectFit");
    expect(props).not.toHaveProperty("objectPosition");

    for (const src of ["/logo.png", "https://images.unsplash.com/photo-fill"]) {
      const html = ReactDOMServer.renderToString(
        React.createElement(Image, { alt: "fill", src, fill: true, objectFit: "cover" }),
      );
      expect(html).toContain("object-fit:cover");
      expect(html).not.toContain('objectFit="cover"');
    }
  });

  it("caller style wins over the deprecated objectFit prop", () => {
    const { props } = getImageProps({
      alt: "fill",
      src: "/bg.png",
      fill: true,
      objectFit: "cover",
      style: { objectFit: "contain" },
    });
    expect(props.style?.objectFit).toBe("contain");
  });

  it("deprecated objectFit prop is dropped for non-fill images", () => {
    const { props } = getImageProps({
      alt: "sized",
      src: "/bg.png",
      width: 100,
      height: 100,
      objectFit: "cover",
    });
    expect(props.style).not.toHaveProperty("objectFit");
    expect(props).not.toHaveProperty("objectFit");
  });
});
