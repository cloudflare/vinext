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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { createServer } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import Image, { getImageProps, type StaticImageData } from "../packages/vinext/src/shims/image.js";

/** Helper: expected optimization URL matching what the image shim produces. */
function optUrl(src: string, w: number, q = 75): string {
  return `/_next/image?url=${encodeURIComponent(src)}&w=${w}&q=${q}`;
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
  it("uses the normalized configured optimizer path", async () => {
    process.env.__VINEXT_IMAGE_PATH = "/docs/_next/image/";
    vi.resetModules();

    try {
      const { imageOptimizationUrl } = await import("../packages/vinext/src/shims/image.js");
      expect(imageOptimizationUrl("/photo.png", 828, 75)).toBe(
        "/docs/_next/image/?url=%2Fphoto.png&w=828&q=75",
      );
    } finally {
      delete process.env.__VINEXT_IMAGE_PATH;
      vi.resetModules();
    }
  });

  it("retains default-loader behavior with a configured optimizer path", async () => {
    process.env.__VINEXT_IMAGE_PATH = "/docs/_next/image/";
    process.env.__VINEXT_IMAGE_REJECT_LOCAL_QUERY_WITHOUT_PATTERN = "true";
    vi.resetModules();

    try {
      const { getImageProps } = await import("../packages/vinext/src/shims/image.js");
      expect(getImageProps({ alt: "svg", src: "/icon.svg", width: 32, height: 32 }).props.src).toBe(
        "/icon.svg",
      );
      expect(() =>
        getImageProps({ alt: "query", src: "/photo.png?v=1", width: 32, height: 32 }),
      ).toThrow("is using a query string which is not configured in images.localPatterns");
    } finally {
      delete process.env.__VINEXT_IMAGE_PATH;
      delete process.env.__VINEXT_IMAGE_REJECT_LOCAL_QUERY_WITHOUT_PATTERN;
      vi.resetModules();
    }
  });

  it("imageOptimizationUrl uses /_next/image prefix", async () => {
    const { imageOptimizationUrl } = await import("../packages/vinext/src/shims/image.js");
    const url = imageOptimizationUrl("/photo.png", 828, 85);
    expect(url.startsWith("/_next/image?")).toBe(true);
    expect(url).toContain("url=%2Fphoto.png");
    expect(url).toContain("w=828");
    expect(url).toContain("q=85");
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

describe("global loader configuration", () => {
  it("requires a loader prop when the configured loader is custom", async () => {
    process.env.__VINEXT_IMAGE_LOADER = "custom";
    vi.resetModules();

    try {
      const { getImageProps } = await import("../packages/vinext/src/shims/image.js");
      expect(() =>
        getImageProps({ alt: "custom", src: "/logo.png", width: 32, height: 32 }),
      ).toThrow('is missing "loader" prop');
    } finally {
      delete process.env.__VINEXT_IMAGE_LOADER;
      vi.resetModules();
    }
  });

  it("uses current next/image semantics for configured built-in loader paths", async () => {
    process.env.__VINEXT_IMAGE_LOADER = "imgix";
    process.env.__VINEXT_IMAGE_PATH = "https://example.imgix.net/";
    vi.resetModules();

    try {
      const loader = (await import("../packages/vinext/src/shims/image-loader.js")).default;
      expect(loader({ src: "/logo.png", width: 640, quality: 80 })).toBe(
        "https://example.imgix.net/?url=%2Flogo.png&w=640&q=80",
      );
    } finally {
      delete process.env.__VINEXT_IMAGE_LOADER;
      delete process.env.__VINEXT_IMAGE_PATH;
      vi.resetModules();
    }
  });

  it("uses images.loaderFile for Image and getImageProps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-image-loader-"));
    fs.mkdirSync(path.join(root, "app"), { recursive: true });
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      `export default { images: { loader: "custom", loaderFile: "./image-loader.js" } };`,
    );
    fs.writeFileSync(
      path.join(root, "image-loader.js"),
      `export default function loader({ src, width, quality }) { return \`${"${src}"}#w:${"${width}"},q:${"${quality || 50}"}\`; }`,
    );
    fs.writeFileSync(
      path.join(root, "entry.tsx"),
      `import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Image, { getImageProps } from "next/image";
export function render() {
  return {
    html: renderToStaticMarkup(<Image id="img" src="/logo.png" alt="logo" width={400} height={200} />),
    props: getImageProps({ src: "/logo.png", alt: "logo", width: 400, height: 200 }).props,
  };
}`,
    );

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: root })],
      server: { middlewareMode: true },
    });

    try {
      const module = await server.ssrLoadModule("/entry.tsx");
      const result = module.render();
      expect(result.html).toContain("/logo.png#w:828,q:50");
      expect(result.html).toContain("/logo.png#w:640,q:50 1x");
      expect(result.props.src).toBe("/logo.png#w:828,q:50");
      expect(result.props.srcSet).toContain("/logo.png#w:640,q:50 1x");
    } finally {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── SSR rendering ──────────────────────────────────────────────────────

describe("Image SSR rendering", () => {
  it.each(["", "data:image/png;base64,abc", "blob:https://example.com/image"])(
    "renders special source %s unoptimized without lazy loading",
    (src) => {
      const html = ReactDOMServer.renderToString(
        React.createElement(Image, { alt: "special", src, width: 100, height: 100 }),
      );
      expect(html).not.toContain("/_next/image?");
      expect(html).not.toContain('loading="lazy"');

      const { props } = getImageProps({ alt: "special", src, width: 100, height: 100 });
      expect(props.src).toBe(src);
      expect(props.srcSet).toBeUndefined();
      expect(props.loading).toBeUndefined();
    },
  );

  it("appends deployment IDs to unoptimized local images without replacing existing IDs", async () => {
    process.env.__VINEXT_DEPLOYMENT_ID = "deployment-2";
    vi.resetModules();
    const { default: ConfiguredImage } = await import("../packages/vinext/src/shims/image.js");

    const html = ReactDOMServer.renderToString(
      React.createElement(ConfiguredImage, {
        alt: "direct",
        src: "/photo.jpg?version=1",
        width: 100,
        height: 100,
        unoptimized: true,
      }),
    );
    expect(html).toContain('src="/photo.jpg?version=1&amp;dpl=deployment-2"');

    const existing = ReactDOMServer.renderToString(
      React.createElement(ConfiguredImage, {
        alt: "existing",
        src: "/photo.jpg?dpl=deployment-1",
        width: 100,
        height: 100,
        unoptimized: true,
      }),
    );
    expect(existing).toContain('src="/photo.jpg?dpl=deployment-1"');

    const { getImageProps: getConfiguredImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    expect(
      getConfiguredImageProps({
        alt: "props",
        src: "/photo.jpg",
        width: 100,
        height: 100,
        unoptimized: true,
      }).props.src,
    ).toBe("/photo.jpg?dpl=deployment-2");
    delete process.env.__VINEXT_DEPLOYMENT_ID;
  });

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
    expect(html).toContain(`${optUrlHtml("/img.png", 384)} 384w`);
    expect(html).toContain(`${optUrlHtml("/img.png", 3840)} 3840w`);
    expect(html).not.toContain(" 1x");
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
    expect(html).toContain('src="https://cdn.example.com/photo.jpg?w=640&amp;q=75"');
    expect(html).toContain(
      'srcSet="https://cdn.example.com/photo.jpg?w=256&amp;q=75 1x, https://cdn.example.com/photo.jpg?w=640&amp;q=75 2x"',
    );
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

  it("uses unoptimized attributes for default-loader SVG static imports", () => {
    process.env.__VINEXT_DEPLOYMENT_ID = "deployment-1";
    try {
      const src = "/_next/static/media/icon.0123abcd.svg";
      const html = ReactDOMServer.renderToString(
        React.createElement(Image, {
          alt: "static svg",
          src: { src, width: 32, height: 32 },
          sizes: "100vw",
        }),
      );

      expect(html).toContain('src="/_next/static/media/icon.0123abcd.svg?dpl=deployment-1"');
      expect(html).not.toContain("srcSet=");
      expect(html).not.toContain("sizes=");
      expect(html).not.toContain("/_next/image?");
    } finally {
      delete process.env.__VINEXT_DEPLOYMENT_ID;
    }
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
  it("generates fixed-size 1x and 2x srcSet entries", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/photo.png",
        width: 500,
        height: 400,
      }),
    );
    expect(html).toContain(`${optUrlHtml("/photo.png", 640)} 1x`);
    expect(html).toContain(`${optUrlHtml("/photo.png", 1080)} 2x`);
  });

  it("caps fixed-size srcSet entries at the largest configured width", () => {
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
    expect(html).not.toContain(optUrlHtml("/icon.png", 16));
    expect(html).toContain(`${optUrlHtml("/icon.png", 32)} 1x`);
  });

  it("uses all configured widths for sizes without viewport percentages", () => {
    const { props } = getImageProps({
      alt: "responsive",
      src: "/responsive.png",
      width: 500,
      height: 300,
      sizes: "(max-width: 600px) 320px, 500px",
    });

    expect(props.srcSet).toContain(`${optUrl("/responsive.png", 32)} 32w`);
    expect(props.srcSet).toContain(`${optUrl("/responsive.png", 3840)} 3840w`);
    expect(props.srcSet).not.toContain(" 1x");
  });

  it("routes configured remote images through the optimizer", () => {
    const src = "https://image-optimization-test.vercel.app/test.jpg";
    const { props } = getImageProps({ alt: "remote", src, width: 200, height: 200, quality: 90 });

    expect(props.src).toBe(optUrl(src, 640, 75));
    expect(props.srcSet).toBe(`${optUrl(src, 256, 75)} 1x, ${optUrl(src, 640, 75)} 2x`);
  });

  it("generates a 100vw width srcSet for fill mode", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "fill",
        src: "/bg.png",
        fill: true,
      }),
    );
    expect(html).toContain('sizes="100vw"');
    expect(html).toContain(`${optUrlHtml("/bg.png", 640)} 640w`);
    expect(html).toContain(`${optUrlHtml("/bg.png", 3840)} 3840w`);
  });

  it("sorts configured widths for widthless and fill images", async () => {
    process.env.__VINEXT_IMAGE_DEVICE_SIZES = JSON.stringify([1080, 640, 828]);
    process.env.__VINEXT_IMAGE_SIZES = JSON.stringify([384, 32, 256]);
    vi.resetModules();

    try {
      const { getImageProps: getConfiguredImageProps } =
        await import("../packages/vinext/src/shims/image.js");
      const widthless = getConfiguredImageProps({ alt: "widthless", src: "/widthless.png" });
      const fill = getConfiguredImageProps({ alt: "fill", src: "/fill.png", fill: true });
      const expected = [640, 828, 1080]
        .map((width) => `${optUrl("/widthless.png", width)} ${width}w`)
        .join(", ");
      const expectedFill = [640, 828, 1080]
        .map((width) => `${optUrl("/fill.png", width)} ${width}w`)
        .join(", ");

      expect(widthless.props.srcSet).toBe(expected);
      expect(fill.props.srcSet).toBe(expectedFill);
    } finally {
      delete process.env.__VINEXT_IMAGE_DEVICE_SIZES;
      delete process.env.__VINEXT_IMAGE_SIZES;
      vi.resetModules();
    }
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

  it("uses direct image URLs when images.unoptimized is enabled", async () => {
    process.env.__VINEXT_IMAGE_UNOPTIMIZED = "true";
    vi.resetModules();
    const { getImageProps: getUnoptimizedImageProps } =
      await import("../packages/vinext/src/shims/image.js");

    const { props } = getUnoptimizedImageProps({
      alt: "direct",
      src: "/direct.png",
      width: 100,
      height: 100,
    });
    expect(props.src).toBe("/direct.png");
    expect(props.srcSet).toBeUndefined();

    delete process.env.__VINEXT_IMAGE_UNOPTIMIZED;
    vi.resetModules();
  });

  it("uses the nearest configured quality for default-loader URLs", async () => {
    process.env.__VINEXT_IMAGE_QUALITIES = JSON.stringify([60, 90]);
    vi.resetModules();
    const { getImageProps: getConfiguredImageProps } =
      await import("../packages/vinext/src/shims/image.js");

    expect(
      getConfiguredImageProps({ alt: "default quality", src: "/test.png", width: 100, height: 100 })
        .props.src,
    ).toContain("q=60");
    expect(
      getConfiguredImageProps({
        alt: "nearest quality",
        src: "/test.png",
        width: 100,
        height: 100,
        quality: 80,
      }).props.src,
    ).toContain("q=90");

    delete process.env.__VINEXT_IMAGE_QUALITIES;
    vi.resetModules();
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

  it("returns responsive custom loader attributes", () => {
    const loader = ({ src, width }: { src: string; width: number }) =>
      `https://cdn.example.com${src}?w=${width}`;

    const { props } = getImageProps({
      alt: "cdn",
      src: "/photo.jpg",
      width: 300,
      height: 200,
      loader,
    });

    expect(props.src).toBe("https://cdn.example.com/photo.jpg?w=640");
    expect(props.srcSet).toBe(
      "https://cdn.example.com/photo.jpg?w=384 1x, https://cdn.example.com/photo.jpg?w=640 2x",
    );
  });

  it("uses overrideSrc with custom loader srcSet in component and getImageProps", () => {
    const loader = ({ src, width }: { src: string; width: number }) =>
      `https://cdn.example.com${src}?w=${width}`;
    const overrideSrc = "https://images.example.com/original.jpg";

    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "cdn",
        src: "/photo.jpg",
        width: 300,
        height: 200,
        loader,
        overrideSrc,
      }),
    );
    expect(html).toContain(`src="${overrideSrc}"`);
    expect(html).toContain("https://cdn.example.com/photo.jpg?w=384 1x");
    expect(html).toContain("https://cdn.example.com/photo.jpg?w=640 2x");

    const { props } = getImageProps({
      alt: "cdn",
      src: "/photo.jpg",
      width: 300,
      height: 200,
      loader,
      overrideSrc,
    });
    expect(props.src).toBe(overrideSrc);
    expect(props.srcSet).toBe(
      "https://cdn.example.com/photo.jpg?w=384 1x, https://cdn.example.com/photo.jpg?w=640 2x",
    );
  });

  it("passes raw quality to custom loaders regardless of configured qualities", async () => {
    process.env.__VINEXT_IMAGE_QUALITIES = "[60]";
    vi.resetModules();
    const { getImageProps: getConfiguredImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    const loader = vi.fn(({ quality }: { quality?: number }) => `/photo.jpg?q=${quality}`);

    expect(
      getConfiguredImageProps({
        alt: "custom quality",
        src: "/photo.jpg",
        width: 300,
        height: 200,
        loader,
        quality: 90,
      }).props.src,
    ).toBe("/photo.jpg?q=90");
    expect(
      getConfiguredImageProps({
        alt: "default custom quality",
        src: "/photo.jpg",
        width: 300,
        height: 200,
        loader,
      }).props.src,
    ).toBe("/photo.jpg?q=undefined");
    expect(loader).toHaveBeenCalledWith(expect.objectContaining({ quality: undefined }));

    delete process.env.__VINEXT_IMAGE_QUALITIES;
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

  it("retains common image props with a custom loader", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "custom common props",
        src: "/photo.jpg",
        width: 300,
        height: 200,
        loader: ({ src, width }) => `${src}?w=${width}`,
        priority: true,
        placeholder: "blur",
        blurDataURL: "data:image/png;base64,test",
      }),
    );
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain('data-nimg="1"');
    expect(html).toContain("background-image:url(data:image/png;base64,test)");
  });

  it("uses custom loaders for SVG sources", () => {
    const loader = ({ src, width }: { src: string; width: number }) =>
      `https://cdn.example.com${src}?w=${width}`;
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "custom svg",
        src: "/icon.svg",
        width: 32,
        height: 32,
        loader,
      }),
    );
    expect(html).toContain('src="https://cdn.example.com/icon.svg?w=64"');
    expect(html).toContain("https://cdn.example.com/icon.svg?w=32 1x");

    const { props } = getImageProps({
      alt: "custom svg",
      src: "/icon.svg",
      width: 32,
      height: 32,
      loader,
    });
    expect(props.src).toBe("https://cdn.example.com/icon.svg?w=64");
    expect(props.srcSet).toBe(
      "https://cdn.example.com/icon.svg?w=32 1x, https://cdn.example.com/icon.svg?w=64 2x",
    );
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

  it("getImageProps uses unoptimized attributes for default-loader SVG imports", () => {
    process.env.__VINEXT_DEPLOYMENT_ID = "deployment-1";
    try {
      const src = "/_next/static/media/icon.0123abcd.svg";
      const { props } = getImageProps({
        alt: "static svg",
        src: { src, width: 32, height: 32 },
        sizes: "100vw",
      });

      expect(props.src).toBe(`${src}?dpl=deployment-1`);
      expect(props.srcSet).toBeUndefined();
      expect(props.sizes).toBeUndefined();
    } finally {
      delete process.env.__VINEXT_DEPLOYMENT_ID;
    }
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
    expect(props.srcSet).toContain("1x");
    expect(props.srcSet).toContain("2x");
  });

  it("moves a static asset deployment id onto optimizer URLs", () => {
    const { props } = getImageProps({
      alt: "static",
      src: {
        src: "/_next/static/media/test.abc123.png?dpl=deployment-1",
        width: 400,
        height: 400,
      },
      quality: 85,
    });

    expect(props.src).toBe(
      "/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Ftest.abc123.png&w=828&q=75&dpl=deployment-1",
    );
    expect(props.srcSet).toBe(
      "/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Ftest.abc123.png&w=640&q=75&dpl=deployment-1 1x, " +
        "/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Ftest.abc123.png&w=828&q=75&dpl=deployment-1 2x",
    );
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

  it("uses overrideSrc as optimized src while preserving generated srcSet", () => {
    const overrideSrc = "https://cdn.example.com/original.jpg";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "overridden optimized image",
        src: "/photo.jpg",
        overrideSrc,
        width: 100,
        height: 100,
      }),
    );

    expect(html).toContain(`src="${overrideSrc}"`);
    expect(html).toContain("srcSet=");
    expect(html).toContain("/_next/image?url=%2Fphoto.jpg");

    const { props } = getImageProps({
      alt: "overridden optimized image",
      src: "/photo.jpg",
      overrideSrc,
      width: 100,
      height: 100,
    });
    expect(props.src).toBe(overrideSrc);
    expect(props.srcSet).toContain("/_next/image?url=%2Fphoto.jpg");
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

  it("renders valid SSR output with both onLoad and onError for a remote URL", () => {
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

  it("defers private-IP rejection to the optimizer in production", async () => {
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
    expect(html).toContain("<img");
    expect(html).toContain("/_next/image?url=http%3A%2F%2F127.0.0.1%2Fphoto.jpg");
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

  it("defers configured private-IP rejection to the optimizer in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([{ hostname: "**" }]);
    process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP = "false";

    // Module-level constants in image.tsx are evaluated at import time from
    // process.env, so we must re-evaluate the module after changing env.
    vi.resetModules();
    const { default: PrivateIpImage, getImageProps: getPrivateIpImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    const props = {
      alt: "private ip dev",
      src: "http://172.16.0.1/photo.jpg",
      width: 400,
      height: 300,
    };

    const html = ReactDOMServer.renderToString(React.createElement(PrivateIpImage, props));
    expect(html).toContain("/_next/image?url=http%3A%2F%2F172.16.0.1%2Fphoto.jpg");
    expect(getPrivateIpImageProps(props).props.src).toContain(
      "/_next/image?url=http%3A%2F%2F172.16.0.1%2Fphoto.jpg",
    );
  });
});

describe("remote URL protocol normalization", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.__VINEXT_IMAGE_REMOTE_PATTERNS;
    delete process.env.__VINEXT_IMAGE_DOMAINS;
    vi.restoreAllMocks();
  });

  it("validates mixed-case HTTPS component sources against remotePatterns", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([
      { protocol: "https", hostname: "images.example.com", pathname: "/allowed/**" },
    ]);

    vi.resetModules();
    const { default: ConfiguredImage } = await import("../packages/vinext/src/shims/image.js");
    const html = ReactDOMServer.renderToString(
      React.createElement(ConfiguredImage, {
        alt: "configured remote image",
        src: "HTTPS://images.example.com/allowed/photo.png",
        width: 400,
        height: 300,
      }),
    );

    expect(html).toContain("<img");
    expect(html).toContain("/_next/image?");
  });

  it("defers mixed-case HTTP component validation in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([
      { protocol: "https", hostname: "images.example.com", pathname: "/allowed/**" },
    ]);
    vi.resetModules();
    const { default: ConfiguredImage } = await import("../packages/vinext/src/shims/image.js");
    const html = ReactDOMServer.renderToString(
      React.createElement(ConfiguredImage, {
        alt: "unconfigured remote image",
        src: "HTTP://unconfigured.example.com/photo.png",
        width: 400,
        height: 300,
      }),
    );

    expect(html).toContain("<img");
    expect(html).toContain("/_next/image?url=HTTP%3A%2F%2Funconfigured.example.com%2Fphoto.png");
  });

  it("validates mixed-case HTTPS getImageProps sources against remotePatterns", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([
      { protocol: "https", hostname: "images.example.com", pathname: "/allowed/**" },
    ]);

    vi.resetModules();
    const { getImageProps: getConfiguredImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    const { props } = getConfiguredImageProps({
      alt: "configured remote image",
      src: "HTTPS://images.example.com/allowed/photo.png",
      width: 400,
      height: 300,
    });

    expect(props.src).toContain("/_next/image?");
  });

  it("defers mixed-case HTTP getImageProps validation in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.__VINEXT_IMAGE_REMOTE_PATTERNS = JSON.stringify([
      { protocol: "https", hostname: "images.example.com", pathname: "/allowed/**" },
    ]);
    vi.resetModules();
    const { getImageProps: getConfiguredImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    const { props } = getConfiguredImageProps({
      alt: "unconfigured remote image",
      src: "HTTP://unconfigured.example.com/photo.png",
      width: 400,
      height: 300,
    });

    expect(props.src).toContain(
      "/_next/image?url=HTTP%3A%2F%2Funconfigured.example.com%2Fphoto.png",
    );
  });
});

describe("unconfigured remote image hosts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.__VINEXT_IMAGE_REMOTE_PATTERNS;
    delete process.env.__VINEXT_IMAGE_DOMAINS;
    vi.resetModules();
  });

  it("emits optimizer URLs for unconfigured remote images in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.__VINEXT_IMAGE_REMOTE_PATTERNS;
    delete process.env.__VINEXT_IMAGE_DOMAINS;
    vi.resetModules();
    const { default: UnconfiguredImage, getImageProps: getUnconfiguredImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    const src = "https://images.example.com/photo.png";
    const html = ReactDOMServer.renderToString(
      React.createElement(UnconfiguredImage, {
        alt: "unconfigured remote image",
        src,
        width: 400,
        height: 300,
      }),
    );

    expect(html).toContain("<img");
    expect(html).toContain("/_next/image?url=https%3A%2F%2Fimages.example.com%2Fphoto.png");
    expect(
      getUnconfiguredImageProps({
        alt: "unconfigured remote image",
        src,
        width: 400,
        height: 300,
      }).props.src,
    ).toContain("/_next/image?url=https%3A%2F%2Fimages.example.com%2Fphoto.png");
  });

  it.each([
    ["https://images.example.com/photo.png", 'hostname "images.example.com" is not configured'],
    [
      "//images.example.com/photo.png",
      "protocol-relative URL (//) must be changed to an absolute URL",
    ],
    ["images.example.com/photo.png", "if using relative image it must start with a leading slash"],
  ])("throws for invalid remote src %s in development", async (src, message) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { default: InvalidImage, getImageProps: getInvalidImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    const props = { alt: "invalid remote image", src, width: 400, height: 300 };

    expect(() => ReactDOMServer.renderToString(React.createElement(InvalidImage, props))).toThrow(
      message,
    );
    expect(() => getInvalidImageProps(props)).toThrow(message);
  });
});

describe("local image patterns", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.__VINEXT_IMAGE_LOCAL_PATTERNS;
    delete process.env.__VINEXT_IMAGE_REJECT_LOCAL_QUERY_WITHOUT_PATTERN;
    delete process.env.__VINEXT_IMAGE_QUALITIES;
    vi.resetModules();
  });

  it.each(["development", "production"])(
    "throws for default query-bearing local URLs in %s",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      process.env.__VINEXT_IMAGE_REJECT_LOCAL_QUERY_WITHOUT_PATTERN = "true";
      vi.resetModules();
      const { default: ConfiguredImage, getImageProps: getConfiguredImageProps } =
        await import("../packages/vinext/src/shims/image.js");
      const props = {
        alt: "query image",
        src: "/photo.jpg?v=1",
        width: 300,
        height: 200,
      };

      expect(() =>
        ReactDOMServer.renderToString(React.createElement(ConfiguredImage, props)),
      ).toThrow(
        'Image with src "/photo.jpg?v=1" is using a query string which is not configured in images.localPatterns.',
      );
      expect(() => getConfiguredImageProps(props)).toThrow(
        'Image with src "/photo.jpg?v=1" is using a query string which is not configured in images.localPatterns.',
      );
    },
  );

  it("throws for configured localPatterns mismatches in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    process.env.__VINEXT_IMAGE_LOCAL_PATTERNS = JSON.stringify([
      { pathname: "/assets/**", search: "" },
    ]);
    vi.resetModules();
    const { default: ConfiguredImage, getImageProps: getConfiguredImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    const props = { alt: "unmatched image", src: "/photo.jpg", width: 300, height: 200 };

    expect(() =>
      ReactDOMServer.renderToString(React.createElement(ConfiguredImage, props)),
    ).toThrow("does not match `images.localPatterns`");
    expect(() => getConfiguredImageProps(props)).toThrow("does not match `images.localPatterns`");
  });

  it("defers configured localPatterns mismatches to the optimizer in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.__VINEXT_IMAGE_LOCAL_PATTERNS = JSON.stringify([
      { pathname: "/assets/**", search: "" },
    ]);
    vi.resetModules();
    const { default: ConfiguredImage, getImageProps: getConfiguredImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    const props = { alt: "unmatched image", src: "/photo.jpg", width: 300, height: 200 };

    expect(ReactDOMServer.renderToString(React.createElement(ConfiguredImage, props))).toContain(
      "/_next/image?url=%2Fphoto.jpg",
    );
    expect(getConfiguredImageProps(props).props.src).toContain("/_next/image?url=%2Fphoto.jpg");
  });

  it("allows configured query-bearing local URLs in production without embedding patterns", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.__VINEXT_IMAGE_LOCAL_PATTERNS;
    process.env.__VINEXT_IMAGE_REJECT_LOCAL_QUERY_WITHOUT_PATTERN = "false";
    vi.resetModules();
    const { default: ConfiguredImage, getImageProps: getConfiguredImageProps } =
      await import("../packages/vinext/src/shims/image.js");
    const props = { alt: "query image", src: "/photo.jpg?v=1", width: 300, height: 200 };

    expect(ReactDOMServer.renderToString(React.createElement(ConfiguredImage, props))).toContain(
      "%2Fphoto.jpg%3Fv%3D1",
    );
    expect(getConfiguredImageProps(props).props.src).toContain("%2Fphoto.jpg%3Fv%3D1");
  });
});
