import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LegacyImage from "../packages/vinext/src/shims/legacy-image.js";
import type { ImageProps } from "../packages/vinext/src/shims/legacy-image.js";

// next/legacy/image is a port of Next.js's client/legacy/image.tsx. These
// tests pin its server-rendered markup to Next.js's, ported from
// test/e2e/next-image-legacy/default/default.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-legacy/default/default.test.ts

const EMPTY_DATA_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const IMG_LAYOUT_STYLE =
  "position:absolute;top:0;left:0;bottom:0;right:0;box-sizing:border-box;padding:0;border:none;margin:auto;display:block;width:0;height:0;min-width:100%;max-width:100%;min-height:100%;max-height:100%";
const WRAPPER_STYLE =
  "box-sizing:border-box;display:block;overflow:hidden;width:initial;height:initial;background:none;opacity:1;border:0;margin:0;padding:0";
const SIZER_STYLE =
  "box-sizing:border-box;display:block;width:initial;height:initial;background:none;opacity:1;border:0;margin:0;padding:0";

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

/** The attributes of each rendered img: the sizer, the image, its noscript copy. */
function imgs(html: string): Record<string, string>[] {
  return Array.from(html.matchAll(/<img ([^>]*?)\/?>/g), ([, attrs]) =>
    Object.fromEntries(
      Array.from(attrs.matchAll(/([\w-]+)="([^"]*)"/g), ([, name, value]) => [
        name,
        value
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&amp;/g, "&"),
      ]),
    ),
  );
}

function image(html: string): Record<string, string> {
  const found = imgs(html).find((attrs) => attrs["data-nimg"] !== undefined);
  if (!found) throw new Error(`no image in ${html}`);
  return found;
}

describe("legacy image layout markup", () => {
  it("wraps an intrinsic image in a sizer sized by an SVG of its dimensions", () => {
    for (const layout of [undefined, "intrinsic"] as const) {
      const html = render({ layout, priority: true });
      expect(html).toContain(
        `<span style="${WRAPPER_STYLE.replace("display:block", "display:inline-block")};position:relative;max-width:100%">`,
      );
      expect(html).toContain(`<span style="${SIZER_STYLE};max-width:100%">`);
      expect(imgs(html)[0]).toEqual({
        style:
          "display:block;max-width:100%;width:initial;height:initial;background:none;opacity:1;border:0;margin:0;padding:0",
        alt: "",
        "aria-hidden": "true",
        src: "data:image/svg+xml,%3csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20version=%271.1%27%20width=%27640%27%20height=%27320%27/%3e",
      });
      expect(image(html)["data-nimg"]).toBe("intrinsic");
      expect(image(html).style).toBe(IMG_LAYOUT_STYLE);
      // No width or height attributes: the wrapper sizes the image.
      expect(image(html).width).toBeUndefined();
    }
  });

  it("pads a responsive image's sizer to its aspect ratio", () => {
    const html = render({ layout: "responsive", priority: true });
    expect(html).toContain(`<span style="${WRAPPER_STYLE};position:relative">`);
    expect(html).toContain(`<span style="${SIZER_STYLE};padding-top:50%"></span>`);
    expect(image(html)["data-nimg"]).toBe("responsive");
  });

  // Next.js: `let layout = sizes ? 'responsive' : 'intrinsic'`
  it("defaults to responsive when sizes is set", () => {
    expect(image(render({ sizes: "50vw", priority: true }))["data-nimg"]).toBe("responsive");
    expect(image(render({ sizes: "50vw", layout: "intrinsic", priority: true }))["data-nimg"]).toBe(
      "intrinsic",
    );
  });

  it("gives a fixed image's wrapper its dimensions and no sizer", () => {
    const html = render({ layout: "fixed", priority: true });
    expect(html).toContain(
      `<span style="${WRAPPER_STYLE.replace("display:block", "display:inline-block").replace("width:initial;height:initial", "width:640px;height:320px")};position:relative">`,
    );
    expect(imgs(html)).toHaveLength(1);
  });

  it("positions a fill image's wrapper over its parent", () => {
    const html = render({
      layout: "fill",
      width: undefined,
      height: undefined,
      objectFit: "cover",
      objectPosition: "center",
      priority: true,
    });
    expect(html).toContain(
      `<span style="${WRAPPER_STYLE};position:absolute;top:0;left:0;bottom:0;right:0">`,
    );
    expect(image(html).style).toBe(`${IMG_LAYOUT_STYLE};object-fit:cover;object-position:center`);
  });

  // "should handle the styles prop appropriately"
  it("lets the layout styles override the style prop", () => {
    expect(
      image(
        render({
          layout: "fixed",
          width: 400,
          height: 400,
          style: { borderRadius: "10px", padding: 10 },
          loading: "eager",
        }),
      ).style,
    ).toBe(
      "border-radius:10px;padding:0;position:absolute;top:0;left:0;bottom:0;right:0;box-sizing:border-box;border:none;margin:auto;display:block;width:0;height:0;min-width:100%;max-width:100%;min-height:100%;max-height:100%",
    );
    expect(
      image(
        render({
          layout: "intrinsic",
          width: 400,
          height: 400,
          style: { width: "10px", borderRadius: "10px", margin: "15px" },
          loading: "eager",
        }),
      ).style,
    ).toBe(
      "width:0;border-radius:10px;margin:auto;position:absolute;top:0;left:0;bottom:0;right:0;box-sizing:border-box;padding:0;border:none;display:block;height:0;min-width:100%;max-width:100%;min-height:100%;max-height:100%",
    );
  });
});

describe("legacy image lazy loading", () => {
  it("server-renders a lazy image as a placeholder with a noscript fallback", () => {
    const html = render({ layout: "fixed" });
    const [img, fallback] = imgs(html);
    expect(img.src).toBe(EMPTY_DATA_URL);
    expect(img.srcSet).toBeUndefined();
    expect(img.loading).toBeUndefined();
    expect(html).toContain("<noscript>");
    expect(fallback.loading).toBe("lazy");
    expect(fallback.srcSet).toBe(
      "/_next/image?url=%2Fphoto.jpg&w=640&q=75 1x, /_next/image?url=%2Fphoto.jpg&w=1920&q=75 2x",
    );
    expect(fallback.src).toBe("/_next/image?url=%2Fphoto.jpg&w=1920&q=75");
  });

  it("renders priority and eager images without a placeholder or fallback", () => {
    for (const props of [{ priority: true }, { loading: "eager" as const }]) {
      const html = render({ layout: "fixed", ...props });
      expect(html).not.toContain("<noscript>");
      expect(image(html).src).toBe("/_next/image?url=%2Fphoto.jpg&w=1920&q=75");
      // React's server renderer preloads non-lazy images, as in Next.js.
      expect(image(html).loading).toBeUndefined();
    }
  });

  // "should not pass through user-provided srcset (causing a flash)"
  it("drops a user-provided srcSet", () => {
    const props = {
      width: 300,
      height: 100,
      sizes: "(max-width: 375px) 375px, 100%",
      srcSet: "/photo-mobile.jpg 375w, /photo.jpg",
    } as Partial<ImageProps>;
    const [img, fallback] = imgs(render(props));
    expect(img.src).toBeDefined();
    expect(img.srcSet).toBeUndefined();
    expect(fallback.srcSet).not.toContain("photo-mobile");
    expect(image(render({ ...props, priority: true })).srcSet).not.toContain("photo-mobile");
  });
});

describe("legacy image blur placeholder", () => {
  const blurDataURL =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cimage filter='url(%23blur)'/%3E%3C/svg%3E";

  // "should have blurry placeholder when enabled" and "should not use blurry
  // placeholder for <noscript> image"
  it("blurs the image's background until it loads, but not the noscript copy", () => {
    const html = render({ placeholder: "blur", blurDataURL, priority: true });
    const [, img, fallback] = imgs(html);
    expect(img.style).toBe(
      `${IMG_LAYOUT_STYLE};background-size:cover;background-position:0% 0%;filter:blur(20px);background-image:url("${blurDataURL}")`,
    );
    expect(fallback.style).toBe(IMG_LAYOUT_STYLE);
  });

  // vinext generates no blurDataURL for static imports (Next.js does).
  it("renders a static import without a blurDataURL with no placeholder", () => {
    const html = render({
      src: { src: "/_next/static/media/photo.jpg", width: 640, height: 320 },
      width: undefined,
      height: undefined,
      placeholder: "blur",
      priority: true,
    });
    expect(image(html).style).toBe(IMG_LAYOUT_STYLE);
    expect(() => render({ placeholder: "blur", priority: true })).toThrow(
      'Image with src "/photo.jpg" has "placeholder=\'blur\'" property but is missing the "blurDataURL" property.',
    );
  });

  it("positions the placeholder like the image", () => {
    const html = render({
      placeholder: "blur",
      blurDataURL,
      objectFit: "contain",
      objectPosition: "center",
    });
    expect(imgs(html)[1].style).toContain("background-size:contain;background-position:center");
  });

  // React escapes the style attribute but not CSS, so a `"` in blurDataURL
  // would close the quoted url() and inject declarations.
  it("skips a placeholder whose blurDataURL could break out of url()", () => {
    const html = render({
      placeholder: "blur",
      blurDataURL: 'data:image/png;base64,x");color:red;background-image:url("',
      priority: true,
    });
    expect(image(html).style).toBe(IMG_LAYOUT_STYLE);
  });
});

// Ported from Next.js client/legacy/image.tsx getWidths(): `sizes` picks the
// widths only for fill and responsive layouts, and a responsive image offers
// every device width. See also test/e2e/next-image-legacy/default
// ("should work with layout-responsive so resizing window maintains image
// aspect ratio").
describe("legacy image srcSet widths", () => {
  const DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
  const optimized = (w: number) => `/_next/image?url=%2Fphoto.jpg&w=${w}&q=75`;
  const loader = ({ src, width }: { src: string; width: number }) => `${src}?w=${width}`;

  it("offers every device width to a responsive image", () => {
    const img = image(render({ layout: "responsive", width: 1200, height: 800, priority: true }));
    expect(img.srcSet).toBe(DEVICE_SIZES.map((w) => `${optimized(w)} ${w}w`).join(", "));
    expect(img.sizes).toBe("100vw");
    expect(img.src).toBe(optimized(3840));
  });

  it("builds a responsive custom-loader srcSet from the device widths", () => {
    const img = image(
      render({ layout: "responsive", width: 1200, height: 800, loader, priority: true }),
    );
    expect(img.srcSet).toBe(DEVICE_SIZES.map((w) => `/photo.jpg?w=${w} ${w}w`).join(", "));
    expect(img.sizes).toBe("100vw");
  });

  it("ignores sizes when picking fixed and intrinsic widths", () => {
    for (const layout of ["fixed", "intrinsic"] as const) {
      const img = image(
        render({ layout, width: 400, height: 200, sizes: "50vw", loader, priority: true }),
      );
      expect(img.srcSet).toBe("/photo.jpg?w=640 1x, /photo.jpg?w=828 2x");
      expect(img.sizes).toBe("50vw");
    }
  });

  it("serves SVGs as-is", () => {
    const img = image(render({ src: "/icon.svg", layout: "fixed", priority: true }));
    expect(img.srcSet).toBe("/icon.svg 1x, /icon.svg 2x");
    expect(img.src).toBe("/icon.svg");
  });

  // Next.js generateImgAttrs keeps `src` last so Safari does not fetch it
  // before `srcSet` is set.
  it("renders src after sizes and srcSet", () => {
    const html = render({ layout: "responsive", width: 1200, height: 800, priority: true });
    const tag = html.match(/<img [^>]*data-nimg[^>]*>/)?.[0] ?? "";
    expect(tag.indexOf(" src=")).toBeGreaterThan(tag.indexOf(" srcSet="));
    expect(tag.indexOf(" srcSet=")).toBeGreaterThan(tag.indexOf(" sizes="));
  });
});

describe("legacy image remote sources", () => {
  async function importWithRemotePatterns(nodeEnv: string) {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv(
      "__VINEXT_IMAGE_REMOTE_PATTERNS",
      JSON.stringify([{ protocol: "https", hostname: "images.example.com" }]),
    );
    vi.resetModules();
    return (await import("../packages/vinext/src/shims/legacy-image.js")).default;
  }

  function renderWith(Image: typeof LegacyImage, src: string): string {
    return renderToStaticMarkup(
      React.createElement(Image, { src, alt: "", width: 64, height: 64, priority: true }),
    );
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // vinext's /_next/image serves only local images, so an allowed remote image
  // loads directly instead of through Next.js's optimizer URL.
  it("loads an allowed remote image directly", async () => {
    const Image = await importWithRemotePatterns("production");
    const img = image(renderWith(Image, "https://images.example.com/a.jpg"));
    expect(img.src).toBe("https://images.example.com/a.jpg");
  });

  it("keeps the optimizer URL for an unconfigured host in production", async () => {
    const Image = await importWithRemotePatterns("production");
    expect(image(renderWith(Image, "https://other.example.com/a.jpg")).src).toBe(
      "/_next/image?url=https%3A%2F%2Fother.example.com%2Fa.jpg&w=128&q=75",
    );
  });

  // With no images.remotePatterns or images.domains, vinext allows every
  // remote host, in development as well.
  it("loads any remote image in development when no remote hosts are configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const Image = (await import("../packages/vinext/src/shims/legacy-image.js")).default;
    expect(image(renderWith(Image, "https://other.example.com/a.jpg")).src).toBe(
      "https://other.example.com/a.jpg",
    );
  });

  // Next.js skips the configured-host check under NODE_ENV=test.
  it("does not check remote hosts under NODE_ENV=test", async () => {
    const Image = await importWithRemotePatterns("test");
    expect(() => renderWith(Image, "https://other.example.com/a.jpg")).not.toThrow();
  });

  // Ported from Next.js's legacy defaultLoader development checks.
  it("throws for an unconfigured host in development", async () => {
    const Image = await importWithRemotePatterns("development");
    expect(() => renderWith(Image, "https://other.example.com/a.jpg")).toThrow(
      'Invalid src prop (https://other.example.com/a.jpg) on `next/image`, hostname "other.example.com" is not configured under images in your `next.config.js`',
    );
  });
});
