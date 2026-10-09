/**
 * next/image component unit tests.
 *
 * Mirrors test cases from Next.js test/unit/next-image-new.test.ts and
 * test/unit/next-image-get-img-props.test.ts, adapted for vinext's
 * Image shim implementation.
 *
 * Tests SSR output, srcSet generation, getImageProps(), fill mode,
 * priority, custom loader, and static image data handling.
 */
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Image, { getImageProps, type StaticImageData } from "../packages/vinext/src/shims/image.js";

/** Helper: expected optimization URL matching what the image shim produces. */
function optUrl(src: string, w: number, q = 75): string {
  return `/_next/image?url=${encodeURIComponent(src)}&w=${w}&q=${q}`;
}

function deployedOptUrl(src: string, w: number, q: number, deploymentId: string): string {
  return `${optUrl(src, w, q)}&dpl=${deploymentId}`;
}
/** Same as optUrl but with HTML entity encoding (for SSR output assertions). */
function optUrlHtml(src: string, w: number, q = 75): string {
  return optUrl(src, w, q).replace(/&/g, "&amp;");
}

// ─── Issue #1513 reproduction ───────────────────────────────────────────
//
// The default loader must emit URLs starting with `/_next/image` (Next.js
// canonical) — not the previous `/_vinext/image` prefix. This guards
// against regression of https://github.com/cloudflare/vinext/issues/1513.

describe("default loader emits /_next/image URLs (issue #1513)", () => {
  it("imageOptimizationUrl uses /_next/image prefix", async () => {
    const { imageOptimizationUrl } = await import("../packages/vinext/src/shims/image.js");
    const url = imageOptimizationUrl("/photo.png", 828, 85);
    expect(url.startsWith("/_next/image?")).toBe(true);
    expect(url).toContain("url=%2Fphoto.png");
    expect(url).toContain("w=828");
    expect(url).toContain("q=85");
  });

  it("keeps the deployment ID outside the optimized source URL", async () => {
    const { imageOptimizationUrl } = await import("../packages/vinext/src/shims/image.js");
    expect(imageOptimizationUrl("/_next/static/media/test.hash.png?dpl=deploy-1", 828, 85)).toBe(
      deployedOptUrl("/_next/static/media/test.hash.png", 828, 85, "deploy-1"),
    );
  });

  it("Image SSR src starts with /_next/image, not /_vinext/image", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/test.png",
        width: 100,
        height: 100,
      }),
    );
    expect(html).toMatch(/src="\/_next\/image\?/);
    expect(html).not.toContain("/_vinext/image");
  });
});

// ─── trailingSlash: the image optimizer's own path obeys the config ────
//
// Ported from Next.js e2e fixtures:
//   test/e2e/next-image-new/trailing-slash/trailing-slash.test.ts
//   test/e2e/next-image-legacy/trailing-slash/trailing-slash.test.ts
// Both expect /_next/image/?url=... (trailing slash before the query
// string) once next.config.js sets `trailingSlash: true`. imageOptimizationUrl
// is shared by the legacy Image shim (shims/legacy-image.tsx wraps this
// component), so fixing it here fixes both fixtures.

describe("imageOptimizationUrl honors trailingSlash", () => {
  afterEach(() => {
    delete process.env.__VINEXT_TRAILING_SLASH;
    vi.resetModules();
  });

  it("adds a trailing slash before the query string when trailingSlash is set", async () => {
    process.env.__VINEXT_TRAILING_SLASH = "true";
    vi.resetModules();
    const { imageOptimizationUrl: imageOptimizationUrlWithTrailingSlash } =
      await import("../packages/vinext/src/shims/image.js");
    expect(imageOptimizationUrlWithTrailingSlash("/test.jpg", 828, 75)).toBe(
      "/_next/image/?url=%2Ftest.jpg&w=828&q=75",
    );
  });

  it("does not add a trailing slash when trailingSlash is unset", async () => {
    delete process.env.__VINEXT_TRAILING_SLASH;
    vi.resetModules();
    const { imageOptimizationUrl: imageOptimizationUrlDefault } =
      await import("../packages/vinext/src/shims/image.js");
    expect(imageOptimizationUrlDefault("/test.jpg", 828, 75)).toBe(
      "/_next/image?url=%2Ftest.jpg&w=828&q=75",
    );
  });

  it("the Image component's SSR src carries the trailing slash", async () => {
    process.env.__VINEXT_TRAILING_SLASH = "true";
    vi.resetModules();
    const { default: TrailingSlashImage } = await import("../packages/vinext/src/shims/image.js");
    const html = ReactDOMServer.renderToString(
      React.createElement(TrailingSlashImage, {
        id: "test1",
        alt: "test",
        src: "/_next/static/media/test.hash.jpg",
        width: 400,
        height: 300,
      }),
    );
    expect(html).toMatch(/src="\/_next\/image\/\?url=/);
  });
});

// ─── images.loader / images.loaderFile validation ──────────────────────
//
// Ported from the loader checks at the top of Next.js's getImgProps
// (packages/next/src/shared/lib/get-img-props.ts).

describe("images.loader config validation", () => {
  afterEach(() => {
    delete process.env.__VINEXT_IMAGE_CUSTOM_LOADER;
    delete process.env.__VINEXT_IMAGE_LOADER_FILE;
    vi.resetModules();
  });

  it('throws for an image without a loader prop when images.loader is "custom"', async () => {
    process.env.__VINEXT_IMAGE_CUSTOM_LOADER = "true";
    vi.resetModules();
    const shim = await import("../packages/vinext/src/shims/image-external.js");
    const imageProps = { alt: "a", src: "/photo.jpg", width: 100, height: 100 };
    const message = 'Image with src "/photo.jpg" is missing "loader" prop.';

    expect(() =>
      ReactDOMServer.renderToString(React.createElement(shim.default, imageProps)),
    ).toThrow(message);
    expect(() => shim.getImageProps({ ...imageProps, unoptimized: true })).toThrow(message);
    expect(
      shim.getImageProps({ ...imageProps, loader: ({ src, width }) => `${src}?w=${width}` }).props
        .src,
    ).toBe("/photo.jpg?w=256");
  });

  it("throws when images.loaderFile has no default export", async () => {
    process.env.__VINEXT_IMAGE_LOADER_FILE = "true";
    vi.resetModules();
    const shim = await import("../packages/vinext/src/shims/image-external.js");

    expect(() =>
      shim.getImageProps({ alt: "a", src: "/photo.jpg", width: 100, height: 100 }),
    ).toThrow("images.loaderFile detected but the file is missing default export.");
  });

  // Next.js's next/legacy/image never imports the loaderFile module, and its
  // "custom" loader only throws when it has to build a URL (client/legacy/image.tsx).
  it("keeps next/legacy/image off loaderFile and lets unoptimized images through", async () => {
    process.env.__VINEXT_IMAGE_CUSTOM_LOADER = "true";
    process.env.__VINEXT_IMAGE_LOADER_FILE = "true";
    vi.resetModules();
    const loaderFileEvaluated = vi.fn();
    vi.doMock("vinext/shims/image-loader-file", () => {
      loaderFileEvaluated();
      return { default: undefined };
    });
    try {
      const { default: LegacyImage } = await import("../packages/vinext/src/shims/legacy-image.js");
      const imageProps = { alt: "a", src: "/photo.jpg", width: 100, height: 100 };

      expect(
        ReactDOMServer.renderToString(
          React.createElement(LegacyImage, { ...imageProps, unoptimized: true }),
        ),
      ).toContain('src="/photo.jpg"');
      expect(() =>
        ReactDOMServer.renderToString(React.createElement(LegacyImage, imageProps)),
      ).toThrow('Image with src "/photo.jpg" is missing "loader" prop.');
      expect(loaderFileEvaluated).not.toHaveBeenCalled();

      // The next/image entry is the only importer of the loader file.
      await import("../packages/vinext/src/shims/image-external.js");
      expect(loaderFileEvaluated).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("vinext/shims/image-loader-file");
    }
  });

  // Next.js's legacy image marks data: and blob: sources unoptimized before
  // it builds a URL, so its "custom" loader neither throws nor runs for them.
  it("renders inline next/legacy/image sources as-is when images.loader is custom", async () => {
    process.env.__VINEXT_IMAGE_CUSTOM_LOADER = "true";
    vi.resetModules();
    const { default: LegacyImage } = await import("../packages/vinext/src/shims/legacy-image.js");

    for (const src of ["data:image/png;base64,iVBORw0KGgo=", "blob:https://example.com/id"]) {
      const html = ReactDOMServer.renderToString(
        React.createElement(LegacyImage, { alt: "a", src, width: 100, height: 100 }),
      );
      expect(html).toContain(`src="${src}"`);
      expect(html).not.toContain("/_next/image");
    }
  });
});

// ─── SSR rendering ──────────────────────────────────────────────────────

describe("Image SSR rendering", () => {
  it("renders a basic <img> tag with correct attributes", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "a nice image",
        src: "/test.png",
        width: 100,
        height: 100,
      }),
    );
    expect(html).toContain('alt="a nice image"');
    // Local images are routed through the optimization endpoint
    expect(html).toContain(`src="${optUrlHtml("/test.png", 256)}"`);
    expect(html).toContain('width="100"');
    expect(html).toContain('height="100"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('data-nimg="1"');
  });

  it("renders with priority (preload + eager loading + fetchpriority)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "priority image",
        src: "/hero.png",
        width: 800,
        height: 600,
        priority: true,
      }),
    );
    // Ported from Next.js:
    // .nextjs-ref/test/e2e/next-image-new/app-dir/app-dir-static.test.ts
    // .nextjs-ref/packages/next/src/client/image-component.tsx
    expect(html).toContain('<link rel="preload"');
    expect(html).toContain('as="image"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain(`imageSrcSet="${optUrlHtml("/hero.png", 828)} 1x`);
    expect(html).toContain(`${optUrlHtml("/hero.png", 1920)} 2x`);
    expect(html).not.toContain(`href="${optUrlHtml("/hero.png", 800)}"`);
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).not.toContain('loading="lazy"');
  });

  it("renders an image preload for the modern preload prop", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "preloaded image",
        src: "/hero-preload.png",
        width: 800,
        height: 600,
        preload: true,
      }),
    );
    expect(html).toContain('<link rel="preload"');
    expect(html).toContain('as="image"');
    expect(html).toContain(`imageSrcSet="${optUrlHtml("/hero-preload.png", 828)} 1x`);
    expect(html).toContain(`${optUrlHtml("/hero-preload.png", 1920)} 2x`);
    expect(html).not.toContain('loading="lazy"');
    expect(html).not.toContain('fetchPriority="high"');
  });

  it("renders fill mode with absolute positioning", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "fill image",
        src: "/bg.png",
        fill: true,
      }),
    );
    // Fill mode: no width/height attributes
    expect(html).not.toMatch(/width="\d+"/);
    expect(html).not.toMatch(/height="\d+"/);
    // Fill adds position:absolute and 100% dimensions
    expect(html).toContain("position:absolute");
    expect(html).toContain("width:100%");
    expect(html).toContain("height:100%");
    expect(html).toContain('data-nimg="fill"');
    // Fill defaults sizes to 100vw
    expect(html).toContain('sizes="100vw"');
  });

  it("renders remote fill mode with absolute positioning", () => {
    // Ported from Next.js: test/unit/next-image-get-img-props.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/unit/next-image-get-img-props.test.ts
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote fill image",
        src: "https://images.unsplash.com/photo-fill",
        fill: true,
      }),
    );
    // Remote fill must preserve the same layout contract as local fill:
    // the DOM img is absolutely positioned and marked as data-nimg="fill".
    expect(html).not.toMatch(/width="\d+"/);
    expect(html).not.toMatch(/height="\d+"/);
    expect(html).toContain("position:absolute");
    expect(html).toContain("width:100%");
    expect(html).toContain("height:100%");
    expect(html).toContain('data-nimg="fill"');
    expect(html).toContain('sizes="100vw"');
  });

  it("renders with custom sizes prop", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "sized",
        src: "/img.png",
        width: 500,
        height: 300,
        sizes: "(max-width: 768px) 100vw, 50vw",
      }),
    );
    expect(html).toContain('sizes="(max-width: 768px) 100vw, 50vw"');
    expect(html).toContain(`${optUrlHtml("/img.png", 640)} 640w`);
    expect(html).not.toContain(`${optUrlHtml("/img.png", 640)} 1x`);
  });

  it("renders with blur placeholder styles", () => {
    const blurDataURL = "data:image/png;base64,abc123";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "blurry",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        placeholder: "blur",
        blurDataURL,
      }),
    );
    expect(html).toContain(`url(${blurDataURL})`);
    expect(html).toContain("background-size:cover");
  });

  it("renders with custom loader", () => {
    const loader = ({ src, width, quality }: { src: string; width: number; quality?: number }) =>
      `https://cdn.example.com${src}?w=${width}&q=${quality || 75}`;

    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "cdn image",
        src: "/photo.jpg",
        width: 200,
        height: 150,
        loader,
      }),
    );
    // A custom loader gets the same per-width srcSet treatment as the
    // built-in loader: src is the 2x (larger) breakpoint, srcSet carries
    // both the 1x and 2x breakpoints rounded up from [200, 400].
    expect(html).toContain('src="https://cdn.example.com/photo.jpg?w=640&amp;q=75"');
    expect(html).toContain(
      'srcSet="https://cdn.example.com/photo.jpg?w=256&amp;q=75 1x, https://cdn.example.com/photo.jpg?w=640&amp;q=75 2x"',
    );
  });

  // Next.js getWidths(config, undefined, sizes): a width-less (fill) image
  // offers every device size and defaults sizes to 100vw.
  it("gives a fill image's custom loader every device width and sizes=100vw", () => {
    const loader = ({ src, width }: { src: string; width: number }) =>
      `https://cdn.example.com${src}?w=${width}`;
    const deviceSizes = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
    const expectedSrcSet = deviceSizes
      .map((w) => `https://cdn.example.com/photo.jpg?w=${w} ${w}w`)
      .join(", ");

    const html = ReactDOMServer.renderToString(
      React.createElement(Image, { alt: "fill", src: "/photo.jpg", fill: true, loader }),
    );
    expect(html).toContain('src="https://cdn.example.com/photo.jpg?w=3840"');
    expect(html).toContain(`srcSet="${expectedSrcSet}"`);
    expect(html).toContain('sizes="100vw"');

    const { props } = getImageProps({ alt: "fill", src: "/photo.jpg", fill: true, loader });
    expect(props.src).toBe("https://cdn.example.com/photo.jpg?w=3840");
    expect(props.srcSet).toBe(expectedSrcSet);
    expect(props.sizes).toBe("100vw");
  });

  // Next.js: `src: overrideSrc || imgAttributes.src`, keeping the loader srcSet.
  it("applies overrideSrc on top of custom loader attributes", () => {
    const loader = ({ src, width }: { src: string; width: number }) =>
      `https://cdn.example.com${src}?w=${width}`;
    const imageProps = {
      alt: "override",
      src: "/photo.jpg",
      width: 200,
      height: 150,
      loader,
      overrideSrc: "/override.jpg",
    };
    const srcSet =
      "https://cdn.example.com/photo.jpg?w=256 1x, https://cdn.example.com/photo.jpg?w=640 2x";

    const html = ReactDOMServer.renderToString(React.createElement(Image, imageProps));
    expect(html).toContain('src="/override.jpg"');
    expect(html).toContain(`srcSet="${srcSet}"`);

    const { props } = getImageProps(imageProps);
    expect(props.src).toBe("/override.jpg");
    expect(props.srcSet).toBe(srcSet);
  });

  // Next.js marks data:/blob: sources unoptimized before generateImgAttrs.
  it("never passes data:, blob: or empty sources to a custom loader or /_next/image", () => {
    const loader = vi.fn(({ src, width }: { src: string; width: number }) => `${src}?w=${width}`);
    for (const src of ["data:image/png;base64,iVBORw0KGgo=", "blob:https://example.com/uuid", ""]) {
      for (const imageProps of [
        { alt: "inline", src, width: 100, height: 100, loader },
        { alt: "inline", src, width: 100, height: 100 },
      ]) {
        const html = ReactDOMServer.renderToString(React.createElement(Image, imageProps));
        // React omits an empty src attribute entirely.
        if (src) expect(html).toContain(`src="${src}"`);
        expect(html).not.toContain("srcSet");
        expect(html).not.toContain("/_next/image");

        const { props } = getImageProps(imageProps);
        expect(props.src).toBe(src);
        expect(props.srcSet).toBeUndefined();
      }
    }
    expect(loader).not.toHaveBeenCalled();
  });

  // Next.js deletes a caller-provided srcSet before building the attributes.
  it("ignores a caller-provided srcSet", () => {
    const loader = ({ src, width }: { src: string; width: number }) => `${src}?w=${width}`;
    const imageProps = {
      alt: "srcset",
      src: "/photo.jpg",
      width: 100,
      height: 100,
      loader,
      srcSet: "/evil.jpg 1x",
    } as Parameters<typeof getImageProps>[0];
    const srcSet = "/photo.jpg?w=128 1x, /photo.jpg?w=256 2x";

    const html = ReactDOMServer.renderToString(React.createElement(Image, imageProps));
    expect(html).toContain(`srcSet="${srcSet}"`);
    expect(html).not.toContain("/evil.jpg");
    expect(getImageProps(imageProps).props.srcSet).toBe(srcSet);
  });

  // Next.js applies these attributes regardless of which loader built the URL.
  it("keeps priority, data-nimg and blur placeholder styles for custom loaders", () => {
    const loader = ({ src, width }: { src: string; width: number }) => `${src}?w=${width}`;
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "blur",
        src: "/photo.jpg",
        width: 100,
        height: 100,
        loader,
        priority: true,
        placeholder: "blur",
        blurDataURL: "data:image/png;base64,iVBORw0KGgo=",
      }),
    );
    const img = html.match(/<img\b[^>]*>/)?.[0] ?? "";
    expect(img).toContain('fetchPriority="high"');
    expect(img).toContain('data-nimg="1"');
    expect(img).toContain("background-image:url(data:image/png;base64,iVBORw0KGgo=)");
  });

  // Next.js keeps `src` after `sizes`/`srcSet` so Safari doesn't fetch it early.
  it("orders src after srcSet and sizes for custom loaders", () => {
    const loader = ({ src, width }: { src: string; width: number }) => `${src}?w=${width}`;
    const imageProps = { alt: "order", src: "/photo.jpg", width: 100, height: 100, loader };

    const html = ReactDOMServer.renderToString(React.createElement(Image, imageProps));
    expect(html.indexOf(" src=")).toBeGreaterThan(html.indexOf(" srcSet="));

    const keys = Object.keys(getImageProps(imageProps).props);
    expect(keys.indexOf("src")).toBeGreaterThan(keys.indexOf("srcSet"));
    expect(keys.indexOf("src")).toBeGreaterThan(keys.indexOf("sizes"));
  });

  it("renders StaticImageData (import result)", () => {
    const staticImage: StaticImageData = {
      src: "/_next/static/media/test.abc123.png",
      width: 800,
      height: 600,
      blurDataURL: "data:image/png;base64,xyz",
    };
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "static import",
        src: staticImage,
        placeholder: "blur",
      }),
    );
    expect(html).toContain(`src="${optUrlHtml("/_next/static/media/test.abc123.png", 1920)}"`);

    expect(html).toContain('width="800"');
    expect(html).toContain('height="600"');
    expect(html).toContain("data:image/png;base64,xyz");
  });

  it("bypasses optimization for deployment-tagged SVG static imports", () => {
    const src = "/_next/static/media/icon.0123abcd.svg?dpl=deployment-1";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "static svg",
        src: { src, width: 32, height: 32 },
      }),
    );

    expect(html).toContain(`src="${src.replaceAll("&", "&amp;")}"`);
    expect(html).toContain(`srcSet="${src.replaceAll("&", "&amp;")}`);
    expect(html).not.toContain("/_next/image?");
  });

  it("applies className and custom style", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "styled",
        src: "/test.png",
        width: 100,
        height: 100,
        className: "hero-img",
        style: { borderRadius: "8px" },
      }),
    );
    expect(html).toContain('class="hero-img"');
    expect(html).toContain("border-radius:8px");
  });

  it("preserves custom style for remote images with width and height", () => {
    // Next.js computes a single imgAttributes.style object in getImgProps and
    // passes it through to the rendered <img>.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/get-img-props.ts
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/image-component.tsx
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote styled",
        src: "https://images.unsplash.com/photo-style",
        width: 400,
        height: 300,
        style: {
          borderRadius: "12px",
          objectPosition: "left center",
          transform: "scale(0.9)",
        },
      }),
    );

    expect(html).toContain("border-radius:12px");
    expect(html).toContain("object-position:left center");
    expect(html).toContain("transform:scale(0.9)");
  });
});

// ─── srcSet generation ──────────────────────────────────────────────────

describe("Image srcSet generation", () => {
  // Ported from Next.js: test/e2e/app-dir/next-image/next-image.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-image/next-image.test.ts
  it("uses fixed-image x descriptors for a 400px static import", () => {
    const src = "/_next/static/media/test.hash.png?dpl=deploy-1";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "static import",
        src: { src, width: 400, height: 400 },
        quality: 85,
      }),
    );

    expect(html).toContain(
      `src="${deployedOptUrl("/_next/static/media/test.hash.png", 828, 85, "deploy-1").replaceAll("&", "&amp;")}"`,
    );
    expect(html).toContain(
      `${deployedOptUrl("/_next/static/media/test.hash.png", 640, 85, "deploy-1").replaceAll("&", "&amp;")} 1x, ${deployedOptUrl("/_next/static/media/test.hash.png", 828, 85, "deploy-1").replaceAll("&", "&amp;")} 2x`,
    );
  });

  it("generates fixed-size 1x and 2x srcSet entries", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/photo.png",
        width: 500,
        height: 400,
      }),
    );
    expect(html).toContain("srcSet");
    expect(html).toContain(`${optUrlHtml("/photo.png", 640)} 1x`);
    expect(html).toContain(`${optUrlHtml("/photo.png", 1080)} 2x`);
    // Should not include widths > 1000
    expect(html).not.toContain("1080w");
  });

  it("generates srcSet with all widths for large images", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/large.png",
        width: 2000,
        height: 1500,
      }),
    );
    expect(html).toContain(`${optUrlHtml("/large.png", 2048)} 1x`);
    expect(html).toContain(`${optUrlHtml("/large.png", 3840)} 2x`);
  });

  it("uses Next.js default image sizes for small fixed images", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "tiny",
        src: "/icon.png",
        width: 16,
        height: 16,
      }),
    );
    // Next.js 16 removed 16 from the defaults. Both the 1x and 2x targets
    // therefore snap to 32 and collapse into one candidate.
    expect(html).toContain(`${optUrlHtml("/icon.png", 32)} 1x`);
    expect(html).not.toContain(optUrlHtml("/icon.png", 16));
  });

  it("does not generate srcSet for fill mode", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "fill",
        src: "/bg.png",
        fill: true,
      }),
    );
    // Fill mode: no srcSet (srcSet is only for local non-fill images with width)
    expect(html).not.toContain("srcSet");
  });
});

// ─── getImageProps ──────────────────────────────────────────────────────

describe("getImageProps", () => {
  it("returns correct props for basic image", () => {
    const { props } = getImageProps({
      alt: "a nice desc",
      src: "/test.png",
      width: 100,
      height: 200,
    });

    expect(props.alt).toBe("a nice desc");
    expect(props.src).toBe(optUrl("/test.png", 256));
    expect(props.width).toBe(100);
    expect(props.height).toBe(200);
    expect(props.loading).toBe("lazy");
    expect(props.decoding).toBe("async");
    expect((props as any)["data-nimg"]).toBe("1");
  });

  it("returns priority props", () => {
    const { props } = getImageProps({
      alt: "priority",
      src: "/hero.png",
      width: 800,
      height: 600,
      priority: true,
    });

    expect(props.loading).toBe("eager");
    expect(props.fetchPriority).toBe("high");
  });

  it("returns fill mode props", () => {
    const { props } = getImageProps({
      alt: "fill",
      src: "/bg.png",
      fill: true,
    });

    expect(props.width).toBeUndefined();
    expect(props.height).toBeUndefined();
    expect(props.sizes).toBe("100vw");
    expect((props as any)["data-nimg"]).toBe("fill");
    expect((props.style as any)?.position).toBe("absolute");
    expect((props.style as any)?.width).toBe("100%");
    expect((props.style as any)?.height).toBe("100%");
  });

  it("returns custom loader URL", () => {
    const loader = ({ src, width }: { src: string; width: number }) =>
      `https://cdn.example.com${src}?w=${width}`;

    const { props } = getImageProps({
      alt: "cdn",
      src: "/photo.jpg",
      width: 300,
      height: 200,
      loader,
    });

    // Same per-width srcSet treatment as the built-in loader: [300, 600]
    // round up to the nearest configured breakpoints, 384 and 640.
    expect(props.src).toBe("https://cdn.example.com/photo.jpg?w=640");
    expect(props.srcSet).toBe(
      "https://cdn.example.com/photo.jpg?w=384 1x, https://cdn.example.com/photo.jpg?w=640 2x",
    );
  });

  it("returns blur placeholder styles", () => {
    const { props } = getImageProps({
      alt: "blur",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      placeholder: "blur",
      blurDataURL: "data:image/png;base64,test",
    });

    expect((props.style as any)?.backgroundImage).toBe("url(data:image/png;base64,test)");
    expect((props.style as any)?.backgroundSize).toBe("cover");
  });

  it("merges user style with default", () => {
    const { props } = getImageProps({
      alt: "styled",
      src: "/test.png",
      width: 100,
      height: 100,
      style: { maxWidth: "100%", height: "auto" },
    });

    expect((props.style as any)?.maxWidth).toBe("100%");
    expect((props.style as any)?.height).toBe("auto");
  });

  it("passes through arbitrary props", () => {
    const { props } = getImageProps({
      alt: "test",
      src: "/test.png",
      width: 100,
      height: 100,
      id: "my-image",
    } as any);

    expect(props.id).toBe("my-image");
  });

  it("handles StaticImageData", () => {
    const staticImage: StaticImageData = {
      src: "/static/photo.png",
      width: 1920,
      height: 1080,
    };

    const { props } = getImageProps({
      alt: "static",
      src: staticImage,
    });

    expect(props.src).toBe(optUrl("/static/photo.png", 3840));
    expect(props.width).toBe(1920);
    expect(props.height).toBe(1080);
  });

  it("getImageProps bypasses optimization for deployment-tagged SVG imports", () => {
    const src = "/_next/static/media/icon.0123abcd.svg?dpl=deployment-1";
    const { props } = getImageProps({
      alt: "static svg",
      src: { src, width: 32, height: 32 },
    });

    expect(props.src).toBe(src);
    expect(props.srcSet).toBeUndefined();
  });

  it("generates srcSet for local images", () => {
    const { props } = getImageProps({
      alt: "local",
      src: "/photo.png",
      width: 800,
      height: 600,
    });

    expect(props.srcSet).toBeDefined();
    expect(props.srcSet).toContain("/_next/image");
    expect(props.srcSet).toContain("photo.png");
    expect(props.srcSet).toContain("w");
  });

  it("handles loading=eager prop", () => {
    const { props } = getImageProps({
      alt: "eager",
      src: "/test.png",
      width: 100,
      height: 100,
      loading: "eager",
    });

    expect(props.loading).toBe("eager");
  });
});

// ─── Security: blurDataURL CSS injection ────────────────────────────────

describe("blurDataURL CSS injection prevention", () => {
  it("rejects blurDataURL with ) character (CSS url breakout)", () => {
    const { props } = getImageProps({
      alt: "malicious",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      placeholder: "blur",
      blurDataURL: "data:x); color: red; background: url(",
    });

    // Should NOT have any backgroundImage — the malicious URL is rejected
    expect((props.style as any)?.backgroundImage).toBeUndefined();
  });

  it("rejects blurDataURL with ; character (CSS property injection)", () => {
    const { props } = getImageProps({
      alt: "malicious",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      placeholder: "blur",
      blurDataURL: "data:image/png;base64,abc); color: red; x: url(",
    });

    // The ; in data:image/png;base64 is fine, but ) breaks out of url()
    expect((props.style as any)?.backgroundImage).toBeUndefined();
  });

  it("rejects blurDataURL with { character (CSS rule injection)", () => {
    const { props } = getImageProps({
      alt: "malicious",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      placeholder: "blur",
      blurDataURL: "data:image/svg+xml,<svg>{</svg>",
    });

    expect((props.style as any)?.backgroundImage).toBeUndefined();
  });

  it("rejects blurDataURL that does not start with data:image/", () => {
    const { props } = getImageProps({
      alt: "malicious",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      placeholder: "blur",
      blurDataURL: "javascript:alert(1)",
    });

    expect((props.style as any)?.backgroundImage).toBeUndefined();
  });

  it("accepts valid base64 blurDataURL", () => {
    const { props } = getImageProps({
      alt: "valid",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      placeholder: "blur",
      blurDataURL:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    });

    expect((props.style as any)?.backgroundImage).toContain("data:image/png;base64,");
  });

  it("sanitizes blurDataURL in SSR rendering (Image component)", () => {
    const maliciousURL = "data:x); color: red; background: url(";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "malicious",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        placeholder: "blur",
        blurDataURL: maliciousURL,
      }),
    );
    // Should NOT contain the malicious CSS injection
    expect(html).not.toContain("color: red");
    expect(html).not.toContain("color:red");
    // Should NOT contain any background-image at all (blur was rejected)
    expect(html).not.toContain("background-image");
  });

  it("renders valid blurDataURL in SSR", () => {
    const validURL = "data:image/png;base64,abc123";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "valid blur",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        placeholder: "blur",
        blurDataURL: validURL,
      }),
    );
    expect(html).toContain("background-image");
    expect(html).toContain(validURL);
  });
});

// ─── onLoadingComplete (deprecated but supported) ────────────────────────
// Next.js deprecated onLoadingComplete in v14 but still supports it.
// It should be handled internally and NOT leak through to the returned props.

describe("onLoadingComplete prop", () => {
  it("getImageProps does not leak onLoadingComplete into returned props", () => {
    const { props } = getImageProps({
      alt: "test",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      onLoadingComplete: () => {},
    });
    // onLoadingComplete must be consumed internally, not passed through
    expect((props as any).onLoadingComplete).toBeUndefined();
  });

  it("getImageProps does not leak onLoad or onLoadingComplete when both provided", () => {
    const { props } = getImageProps({
      alt: "test",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      onLoad: () => {},
      onLoadingComplete: () => {},
    });
    expect((props as any).onLoadingComplete).toBeUndefined();
    expect((props as any).onLoad).toBeUndefined();
  });

  it("does not leak onLoadingComplete as a DOM attribute in SSR (local image)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        onLoadingComplete: () => {},
      }),
    );
    expect(html).not.toContain("onLoadingComplete");
    expect(html).not.toContain("onloadingcomplete");
    expect(html).toContain('alt="test"');
  });

  it("does not leak onLoadingComplete as a DOM attribute in SSR (custom loader)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "cdn",
        src: "/photo.jpg",
        width: 200,
        height: 150,
        loader: ({ src, width }: { src: string; width: number }) =>
          `https://cdn.example.com${src}?w=${width}`,
        onLoadingComplete: () => {},
      }),
    );
    expect(html).not.toContain("onLoadingComplete");
    expect(html).not.toContain("onloadingcomplete");
    expect(html).toContain('alt="cdn"');
  });

  it("does not leak onLoadingComplete as a DOM attribute in SSR (remote URL)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote",
        src: "https://example.com/photo.jpg",
        width: 400,
        height: 300,
        onLoadingComplete: () => {},
      }),
    );
    expect(html).not.toContain("onLoadingComplete");
    expect(html).not.toContain("onloadingcomplete");
    expect(html).toContain('alt="remote"');
  });
});

// Ported from Next.js: test/e2e/next-image-new/unoptimized/unoptimized.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/unoptimized/unoptimized.test.ts
describe("unoptimized remote images", () => {
  it("preserves a Cloudflare Images variant URL without generating srcSet", () => {
    const src = "https://imagedelivery.net/accountHash/imageId/public";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "cloudflare image",
        src,
        width: 100,
        height: 100,
        unoptimized: true,
        placeholder: "blur",
        blurDataURL: "data:image/png;base64,test",
        style: { borderRadius: 8 },
      }),
    );

    expect(html).toContain(`src="${src}"`);
    expect(html).toContain('width="100"');
    expect(html).toContain('height="100"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('data-nimg="1"');
    expect(html).toContain("background-image:url(data:image/png;base64,test)");
    expect(html).toContain("border-radius:8px");
    expect(html).not.toContain("public=undefined");
    expect(html).not.toContain("srcSet");
    expect(html).not.toContain("sizes=");

    const { props } = getImageProps({
      alt: "cloudflare image",
      src,
      width: 100,
      height: 100,
      unoptimized: true,
      placeholder: "blur",
      blurDataURL: "data:image/png;base64,test",
      style: { borderRadius: 8 },
    });
    expect(props.src).toBe(src);
    expect(props.srcSet).toBeUndefined();
    expect(props.sizes).toBeUndefined();
    expect(props.style).toMatchObject({
      backgroundImage: "url(data:image/png;base64,test)",
      borderRadius: 8,
    });
  });

  it("does not invoke a custom loader", () => {
    const loader = vi.fn(() => "https://cdn.example.com/transformed.jpg");
    const src = "https://imagedelivery.net/accountHash/imageId/public";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "cloudflare image",
        src,
        width: 100,
        height: 100,
        unoptimized: true,
        loader,
      }),
    );

    expect(loader).not.toHaveBeenCalled();
    expect(html).toContain(`src="${src}"`);

    const { props } = getImageProps({
      alt: "cloudflare image",
      src,
      width: 100,
      height: 100,
      unoptimized: true,
      loader,
    });
    expect(loader).not.toHaveBeenCalled();
    expect(props.src).toBe(src);
  });

  // Ported from Next.js: test/unit/next-image-get-img-props.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/unit/next-image-get-img-props.test.ts
  it("honors overrideSrc", () => {
    const src = "https://imagedelivery.net/accountHash/imageId/public";
    const overrideSrc = "https://cdn.example.com/original.jpg";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "cloudflare image",
        src,
        overrideSrc,
        width: 100,
        height: 100,
        unoptimized: true,
        priority: true,
      }),
    );

    expect(html).toContain(`src="${overrideSrc}"`);
    expect(html).not.toContain(`src="${src}"`);

    const { props } = getImageProps({
      alt: "cloudflare image",
      src,
      overrideSrc,
      width: 100,
      height: 100,
      unoptimized: true,
    });
    expect(props.src).toBe(overrideSrc);
    expect(props.srcSet).toBeUndefined();
  });

  it("bypasses remote pattern validation in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([
      { hostname: "allowed.example.com" },
    ]);

    vi.resetModules();
    const { default: UnoptimizedImage, getImageProps: getUnoptimizedImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    const src = "https://imagedelivery.net/accountHash/imageId/public";
    const html = ReactDOMServer.renderToString(
      React.createElement(UnoptimizedImage, {
        alt: "cloudflare image",
        src,
        width: 100,
        height: 100,
        unoptimized: true,
      }),
    );

    expect(html).toContain(`src="${src}"`);
    expect(
      getUnoptimizedImageProps({
        alt: "cloudflare image",
        src,
        width: 100,
        height: 100,
        unoptimized: true,
      }).props.src,
    ).toBe(src);

    vi.unstubAllEnvs();
    delete process.env.__VINEXT_IMAGE_REMOTE_PATTERNS;
    vi.resetModules();
  });
});

// ─── Reproduction: priority prop on remote URL paths ────────────────────
// Regression tests for:
//   "Received `true` for a non-boolean attribute `priority`."
// The bug: UnpicImage was receiving priority={true} and leaking it to the
// DOM <img> element. priority is a Next.js concept; it must be translated to
// loading="eager" and fetchPriority="high" before reaching the DOM.
// Affected paths: remote URL with fill=true, and remote URL with width+height.

describe("priority prop — no DOM leak on remote URL paths", () => {
  it("does not render priority attribute on DOM img (remote URL + width/height)", () => {
    // Reproduction: this used to emit `priority="true"` on the DOM element,
    // triggering the React warning about non-boolean attribute.
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote priority",
        src: "https://images.unsplash.com/photo-1",
        width: 800,
        height: 600,
        priority: true,
      }),
    );
    expect(html).not.toContain("priority=");
    expect(html).not.toContain('"priority"');
  });

  it("does not render priority attribute on DOM img (remote URL + fill)", () => {
    // Reproduction: fill layout path also forwarded priority={true} to UnpicImage.
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote fill priority",
        src: "https://images.unsplash.com/photo-2",
        fill: true,
        priority: true,
      }),
    );
    expect(html).not.toContain("priority=");
    expect(html).not.toContain('"priority"');
  });

  it("renders loading=eager for remote URL + width/height when priority=true", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote priority eager",
        src: "https://images.unsplash.com/photo-3",
        width: 400,
        height: 300,
        priority: true,
      }),
    );
    expect(html).toContain('loading="eager"');
    expect(html).not.toContain('loading="lazy"');
  });

  it("renders loading=eager for remote URL + fill when priority=true", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote fill priority eager",
        src: "https://images.unsplash.com/photo-4",
        fill: true,
        priority: true,
      }),
    );
    expect(html).toContain('loading="eager"');
    expect(html).not.toContain('loading="lazy"');
  });

  it("renders fetchPriority=high for remote URL + width/height when priority=true", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote priority fetchpriority",
        src: "https://images.unsplash.com/photo-5",
        width: 400,
        height: 300,
        priority: true,
      }),
    );
    expect(html).toContain("fetchPriority");
    expect(html).toContain("high");
  });

  it("defaults to loading=lazy for remote URL when priority is unset", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote lazy",
        src: "https://images.unsplash.com/photo-6",
        width: 400,
        height: 300,
      }),
    );
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain("priority=");
  });
});

// ─── onLoad / onError single-fire dedup ──────────────────────────────────
// Ported from Next.js: test/e2e/app-dir/next-image-events/next-image-events.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-image-events/next-image-events.test.ts
//
// onLoad and onError must fire at most once per src per mount to prevent
// double-counting failures or infinite re-render loops when user code
// calls setState inside the event handler. React re-renders that result
// from state updates inside onError/onLoad must not re-trigger the handler.
//
// The dedup is client-side (refs inside useRef). SSR tests verify that
// onLoad/onError handlers are properly attached to the img element on
// all render paths without leaking as DOM attributes. Runtime dedup
// behavior is verified via E2E (Playwright) tests mirroring the Next.js
// e2e suite — those tests assert that console.log fires exactly once
// per src across hydration, client render, and re-render.

describe("onLoad / onError handler attachment (SSR)", () => {
  it("does not leak onLoad as DOM attribute (local image)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        onLoad: () => {},
      }),
    );
    expect(html).not.toContain("onload=");
    expect(html).not.toContain("onLoad=");
    expect(html).toContain('alt="test"');
  });

  it("does not leak onError as DOM attribute (local image)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        onError: () => {},
      }),
    );
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("onError=");
    expect(html).toContain('alt="test"');
  });

  it("does not leak onLoad or onError as DOM attributes (custom loader)", () => {
    const loader = ({ src, width }: { src: string; width: number }) =>
      `https://cdn.example.com${src}?w=${width}`;
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "cdn",
        src: "/photo.jpg",
        width: 200,
        height: 150,
        loader,
        onLoad: () => {},
        onError: () => {},
      }),
    );
    expect(html).not.toContain("onload=");
    expect(html).not.toContain("onerror=");
    expect(html).toContain('alt="cdn"');
  });

  it("does not leak onLoad or onError as DOM attributes (remote URL + width/height)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote",
        src: "https://images.unsplash.com/photo-7",
        width: 400,
        height: 300,
        onLoad: () => {},
        onError: () => {},
      }),
    );
    expect(html).not.toContain("onload=");
    expect(html).not.toContain("onerror=");
    expect(html).toContain('alt="remote"');
  });

  it("does not leak onLoad or onError as DOM attributes (remote URL + fill)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote fill",
        src: "https://images.unsplash.com/photo-8",
        fill: true,
        onLoad: () => {},
        onError: () => {},
      }),
    );
    expect(html).not.toContain("onload=");
    expect(html).not.toContain("onerror=");
    expect(html).toContain('alt="remote fill"');
  });

  it("renders valid SSR output with both onLoad and onError (local image)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "events",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        onLoad: () => {},
        onError: () => {},
      }),
    );
    expect(html).toContain("<img");
    expect(html).toContain('alt="events"');
    expect(html).toContain('data-nimg="1"');
  });

  it("renders valid SSR output with both onLoad and onError (remote URL via UnpicImage)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote events",
        src: "https://images.unsplash.com/photo-9",
        width: 400,
        height: 300,
        onLoad: () => {},
        onError: () => {},
      }),
    );
    expect(html).toContain("<img");
    expect(html).toContain('alt="remote events"');
  });
});

// ─── dangerouslyAllowLocalIP / private-IP guard ─────────────────────────
// Ported from Next.js: test/unit/image-optimizer/fetch-external-image.test.ts
// https://github.com/vercel/next.js/blob/canary/test/unit/image-optimizer/fetch-external-image.test.ts

describe("dangerouslyAllowLocalIP private-IP guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.__VINEXT_IMAGE_REMOTE_PATTERNS;
    delete process.env.__VINEXT_IMAGE_DOMAINS;
    delete process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP;
  });

  it("blocks private-IP remote URLs in production (Image returns null)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([{ hostname: "**" }]);
    process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP = "false";

    // Module-level constants in image.tsx are evaluated at import time from
    // process.env, so we must re-evaluate the module after changing env.
    vi.resetModules();
    const { default: PrivateIpImage } = await import("../packages/vinext/src/shims/image.js");

    const html = ReactDOMServer.renderToString(
      React.createElement(PrivateIpImage, {
        alt: "private ip",
        src: "http://127.0.0.1/photo.jpg",
        width: 400,
        height: 300,
      }),
    );
    // Production: blocked → no img tag rendered
    expect(html).not.toContain("<img");
  });

  it("blocks private-IP remote URLs in production (getImageProps returns empty src)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([{ hostname: "**" }]);
    process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP = "false";

    vi.resetModules();
    const { getImageProps: privateIpGetImageProps } =
      await import("../packages/vinext/src/shims/image.js");

    const { props } = privateIpGetImageProps({
      alt: "private ip",
      src: "http://192.168.1.1/photo.jpg",
      width: 400,
      height: 300,
    });
    expect(props.src).toBe("");
  });

  it("allows private-IP remote URLs when dangerouslyAllowLocalIP = true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([{ hostname: "**" }]);
    process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP = "true";

    // Module-level constants in image.tsx are evaluated at import time from
    // process.env, so we must re-evaluate the module after changing env.
    vi.resetModules();
    const { default: PrivateIpImage } = await import("../packages/vinext/src/shims/image.js");

    const html = ReactDOMServer.renderToString(
      React.createElement(PrivateIpImage, {
        alt: "private ip allowed",
        src: "http://10.0.0.1/photo.jpg",
        width: 400,
        height: 300,
      }),
    );
    expect(html).toContain("<img");
    expect(html).toContain('alt="private ip allowed"');
  });

  it("allows public-IP remote URLs regardless of dangerouslyAllowLocalIP", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([{ hostname: "**" }]);
    process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP = "false";

    // Module-level constants in image.tsx are evaluated at import time from
    // process.env, so we must re-evaluate the module after changing env.
    vi.resetModules();
    const { default: PrivateIpImage } = await import("../packages/vinext/src/shims/image.js");

    const html = ReactDOMServer.renderToString(
      React.createElement(PrivateIpImage, {
        alt: "public ip",
        src: "http://8.8.8.8/photo.jpg",
        width: 400,
        height: 300,
      }),
    );
    expect(html).toContain("<img");
    expect(html).toContain('alt="public ip"');
  });

  it("warns but does not block private-IP remote URLs in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([{ hostname: "**" }]);
    process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP = "false";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Module-level constants in image.tsx are evaluated at import time from
    // process.env, so we must re-evaluate the module after changing env.
    vi.resetModules();
    const { default: PrivateIpImage } = await import("../packages/vinext/src/shims/image.js");

    const html = ReactDOMServer.renderToString(
      React.createElement(PrivateIpImage, {
        alt: "private ip dev",
        src: "http://172.16.0.1/photo.jpg",
        width: 400,
        height: 300,
      }),
    );
    // Dev: warn but still render
    expect(html).toContain("<img");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("resolved to private IP"));

    warnSpy.mockRestore();
  });
});
