/**
 * next/image must serve data: and blob: sources unoptimized and eager, like
 * Next.js 16.2.7 (next/dist/shared/lib/get-img-props.js:
 * `if (!src || src.startsWith('data:') || src.startsWith('blob:')) { unoptimized = true; isLazy = false; }`,
 * and the same check in next/dist/client/legacy/image.js).
 */
import { describe, it, expect } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Image, { getImageProps } from "../packages/vinext/src/shims/image.js";
import LegacyImage from "../packages/vinext/src/shims/legacy-image.js";

const DATA_SRC =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3C/svg%3E";
const BLOB_SRC = "blob:http://localhost:3000/0b6a1f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

function renderedSrc(html: string): string | undefined {
  const raw = /\ssrc="([^"]*)"/.exec(html)?.[1];
  return raw?.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

describe.each([
  ["data:", DATA_SRC],
  ["blob:", BLOB_SRC],
])("next/image with a %s source", (_label, src) => {
  it("<Image> renders the source as-is and eager", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, { src, alt: "", width: 64, height: 64 }),
    );
    expect(renderedSrc(html)).toBe(src);
    expect(html).not.toContain("/_next/image");
    expect(html).not.toContain("srcSet");
    expect(html).not.toContain("loading=");
  });

  it("<Image> keeps an explicit loading prop", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, { src, alt: "", width: 64, height: 64, loading: "lazy" }),
    );
    expect(html).toContain('loading="lazy"');
  });

  it("<Image> does not pass the source through a custom loader", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        src,
        alt: "",
        width: 64,
        height: 64,
        loader: ({ src: s, width }) => `https://cdn.example.com/${s}?w=${width}`,
      }),
    );
    expect(renderedSrc(html)).toBe(src);
  });

  it("next/legacy/image renders the source as-is and eager", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(LegacyImage, { src, alt: "", width: 64, height: 64 }),
    );
    expect(renderedSrc(html)).toBe(src);
    expect(html).not.toContain("/_next/image");
    expect(html).not.toContain("loading=");
  });

  it("getImageProps() returns the source as-is and eager", () => {
    const { props } = getImageProps({ src, alt: "", width: 64, height: 64 });
    expect(props.src).toBe(src);
    expect(props.srcSet).toBeUndefined();
    expect(props.loading).toBeUndefined();
  });

  it("getImageProps() keeps an explicit loading prop", () => {
    const { props } = getImageProps({ src, alt: "", width: 64, height: 64, loading: "lazy" });
    expect(props.loading).toBe("lazy");
  });
});
