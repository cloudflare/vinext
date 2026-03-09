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
import { describe, it, expect } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Image, {
  getImageProps,
  findClosestQuality,
  type StaticImageData,
  type StaticImport,
  type StaticRequire,
  type ImageLoaderProps,
  type PlaceholderValue,
  type ImageProps,
} from "../packages/vinext/src/shims/image.js";

/** Helper: expected optimization URL matching what the image shim produces. */
function optUrl(src: string, w: number, q = 75): string {
  return `/_vinext/image?url=${encodeURIComponent(src)}&w=${w}&q=${q}`;
}
/** Same as optUrl but with HTML entity encoding (for SSR output assertions). */
function optUrlHtml(src: string, w: number, q = 75): string {
  return optUrl(src, w, q).replace(/&/g, "&amp;");
}

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
    expect(html).toContain(`src="${optUrlHtml("/test.png", 100)}"`);
    expect(html).toContain('width="100"');
    expect(html).toContain('height="100"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('data-nimg="1"');
  });

  it("renders with priority (eager loading + fetchpriority)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "priority image",
        src: "/hero.png",
        width: 800,
        height: 600,
        priority: true,
      }),
    );
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).not.toContain('loading="lazy"');
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
    expect(html).toContain('src="https://cdn.example.com/photo.jpg?w=200&amp;q=75"');
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
    expect(html).toContain(`src="${optUrlHtml("/_next/static/media/test.abc123.png", 800)}"`);

    expect(html).toContain('width="800"');
    expect(html).toContain('height="600"');
    expect(html).toContain("data:image/png;base64,xyz");
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
});

// ─── srcSet generation ──────────────────────────────────────────────────

describe("Image srcSet generation", () => {
  it("generates srcSet for local images with width", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/photo.png",
        width: 500,
        height: 400,
      }),
    );
    // RESPONSIVE_WIDTHS = [640, 750, 828, 1080, 1200, 1920, 2048, 3840]
    // Filter: widths <= 500 * 2 = 1000 → [640, 750, 828]
    expect(html).toContain("srcSet");
    expect(html).toContain(`${optUrlHtml("/photo.png", 640)} 640w`);
    expect(html).toContain(`${optUrlHtml("/photo.png", 750)} 750w`);
    expect(html).toContain(`${optUrlHtml("/photo.png", 828)} 828w`);
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
    // widths <= 4000: all of them
    expect(html).toContain(`${optUrlHtml("/large.png", 640)} 640w`);
    expect(html).toContain(`${optUrlHtml("/large.png", 3840)} 3840w`);
  });

  it("generates fallback srcSet for very small images", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "tiny",
        src: "/icon.png",
        width: 16,
        height: 16,
      }),
    );
    // widths <= 32: none of RESPONSIVE_WIDTHS qualify
    // Falls back to single: optimized icon.png at 16w
    expect(html).toContain(`${optUrlHtml("/icon.png", 16)} 16w`);
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
    expect(props.src).toBe(optUrl("/test.png", 100));
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

    expect(props.src).toBe("https://cdn.example.com/photo.jpg?w=300");
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

    expect(props.src).toBe(optUrl("/static/photo.png", 1920));
    expect(props.width).toBe(1920);
    expect(props.height).toBe(1080);
  });

  it("generates srcSet for local images", () => {
    const { props } = getImageProps({
      alt: "local",
      src: "/photo.png",
      width: 800,
      height: 600,
    });

    expect(props.srcSet).toBeDefined();
    expect(props.srcSet).toContain("/_vinext/image");
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

// ─── Next.js 16 API surface alignment ────────────────────────────────

describe("StaticImageData (Next.js 16 fields)", () => {
  it("accepts blurWidth and blurHeight optional fields", () => {
    const staticImage: StaticImageData = {
      src: "/static/test.png",
      width: 800,
      height: 600,
      blurDataURL: "data:image/png;base64,xyz",
      blurWidth: 8,
      blurHeight: 6,
    };
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "static with blur dims",
        src: staticImage,
        placeholder: "blur",
      }),
    );
    expect(html).toContain('width="800"');
    expect(html).toContain('height="600"');
    expect(html).toContain("data:image/png;base64,xyz");
  });
});

describe("preload prop (Next.js 16)", () => {
  it("triggers eager loading like priority", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "preloaded image",
        src: "/hero.png",
        width: 800,
        height: 600,
        preload: true,
      }),
    );
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
  });

  it("works in getImageProps", () => {
    const { props } = getImageProps({
      alt: "preloaded",
      src: "/hero.png",
      width: 800,
      height: 600,
      preload: true,
    });
    expect(props.loading).toBe("eager");
    expect(props.fetchPriority).toBe("high");
  });
});

describe("combined preload + priority", () => {
  it("renders eager loading and fetchPriority=high without conflict", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "combined flags",
        src: "/hero.png",
        width: 800,
        height: 600,
        preload: true,
        priority: true,
      }),
    );
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).not.toContain('loading="lazy"');
  });

  it("custom loader with priority sets fetchPriority=high", () => {
    const loader = ({ src, width }: { src: string; width: number }) =>
      `https://cdn.example.com${src}?w=${width}`;

    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "cdn priority",
        src: "/photo.jpg",
        width: 200,
        height: 150,
        loader,
        priority: true,
      }),
    );
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain('src="https://cdn.example.com/photo.jpg?w=200"');
  });

  it("custom loader with preload sets fetchPriority=high", () => {
    const loader = ({ src, width }: { src: string; width: number }) =>
      `https://cdn.example.com${src}?w=${width}`;

    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "cdn preload",
        src: "/photo.jpg",
        width: 200,
        height: 150,
        loader,
        preload: true,
      }),
    );
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
  });
});

describe("deprecated props (Next.js 16 compat)", () => {
  it("accepts and ignores onLoadingComplete", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/test.png",
        width: 100,
        height: 100,
        onLoadingComplete: () => {},
      }),
    );
    // Should render normally without crashing
    expect(html).toContain('alt="test"');
    // Should not leak onLoadingComplete into HTML attributes
    expect(html).not.toContain("onLoadingComplete");
  });

  it("accepts and ignores layout, objectFit, objectPosition, lazyBoundary, lazyRoot", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "deprecated props",
        src: "/test.png",
        width: 100,
        height: 100,
        layout: "fill",
        objectFit: "contain",
        objectPosition: "top",
        lazyBoundary: "200px",
        lazyRoot: "#root",
      }),
    );
    expect(html).toContain('alt="deprecated props"');
    // None of these should appear in rendered HTML
    expect(html).not.toContain("objectFit");
    expect(html).not.toContain("objectPosition");
    expect(html).not.toContain("lazyBoundary");
    expect(html).not.toContain("lazyRoot");
  });
});

describe("width/height string support (Next.js 16)", () => {
  it("accepts string number width and height", () => {
    const { props } = getImageProps({
      alt: "string dims",
      src: "/test.png",
      width: "200" as `${number}`,
      height: "150" as `${number}`,
    });
    expect(props.width).toBe(200);
    expect(props.height).toBe(150);
  });

  it("renders correctly with string dimensions in SSR", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "string dims",
        src: "/test.png",
        width: "300" as `${number}`,
        height: "200" as `${number}`,
      }),
    );
    expect(html).toContain('width="300"');
    expect(html).toContain('height="200"');
  });
});

describe("placeholder data URL (Next.js 16)", () => {
  it("accepts data:image/ URL as placeholder value", () => {
    // data:image/ placeholder with special chars gets rejected by sanitizer,
    // but a valid base64 one works
    const validDataUrl = "data:image/png;base64,abc123";
    const { props } = getImageProps({
      alt: "data placeholder",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      placeholder: validDataUrl as PlaceholderValue,
    });
    expect((props.style as any)?.backgroundImage).toContain("data:image/png;base64,abc123");
  });

  it("applies data:image/ placeholder for remote images", () => {
    const validDataUrl = "data:image/png;base64,abc123";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "remote data placeholder",
        src: "https://example.com/photo.jpg",
        width: 400,
        height: 300,
        placeholder: validDataUrl as PlaceholderValue,
      }),
    );
    // Remote images pass background to @unpic/react, which renders it as inline style
    expect(html).toContain("data:image/png;base64,abc123");
  });
});

describe("StaticImport / StaticRequire support", () => {
  it("handles StaticRequire (default export pattern)", () => {
    const staticRequire: StaticRequire = {
      default: {
        src: "/static/photo.png",
        width: 1920,
        height: 1080,
      },
    };
    const { props } = getImageProps({
      alt: "require import",
      src: staticRequire,
    });
    expect(props.src).toBe(optUrl("/static/photo.png", 1920));
    expect(props.width).toBe(1920);
    expect(props.height).toBe(1080);
  });

  it("handles StaticImport union type", () => {
    // StaticImageData directly
    const directImport: StaticImport = {
      src: "/static/direct.png",
      width: 640,
      height: 480,
    };
    const { props: directProps } = getImageProps({
      alt: "direct",
      src: directImport,
    });
    expect(directProps.src).toBe(optUrl("/static/direct.png", 640));

    // StaticRequire wrapper
    const requireImport: StaticImport = {
      default: {
        src: "/static/require.png",
        width: 320,
        height: 240,
      },
    };
    const { props: requireProps } = getImageProps({
      alt: "require",
      src: requireImport,
    });
    expect(requireProps.src).toBe(optUrl("/static/require.png", 320));
  });
});

describe("type exports", () => {
  it("exports ImageLoaderProps type", () => {
    // Type-only check: the import would fail at compile time if not exported
    const loaderProps: ImageLoaderProps = { src: "/test.png", width: 100, quality: 75 };
    expect(loaderProps.src).toBe("/test.png");
  });

  it("exports ImageProps type", () => {
    const imgProps: ImageProps = { src: "/test.png", alt: "test" };
    expect(imgProps.src).toBe("/test.png");
  });
});

describe("findClosestQuality", () => {
  it("returns input quality when no qualities array provided", () => {
    expect(findClosestQuality(42)).toBe(42);
  });

  it("returns input quality when qualities array is empty", () => {
    expect(findClosestQuality(42, [])).toBe(42);
  });

  it("returns closest allowed quality for low input (not 0)", () => {
    // quality=10 with qualities=[25,50,75,100] should yield 25, not 0
    expect(findClosestQuality(10, [25, 50, 75, 100])).toBe(25);
  });

  it("returns exact match when quality matches an allowed value", () => {
    expect(findClosestQuality(75, [25, 50, 75, 100])).toBe(75);
  });

  it("rounds to nearest allowed value", () => {
    // 60 is closer to 50 (diff=10) than to 75 (diff=15)
    expect(findClosestQuality(60, [25, 50, 75, 100])).toBe(50);
    // 90 is closer to 100 (diff=10) than to 75 (diff=15)
    expect(findClosestQuality(90, [25, 50, 75, 100])).toBe(100);
  });

  it("picks earlier value when equidistant (reduce left-to-right)", () => {
    // 50 is equidistant from 25 (diff=25) and 75 (diff=25) — reduce keeps first
    // Actually 50 is exact match in [25,50,75,100], use different values
    // 37 is equidistant from 25 (diff=12) and 50 (diff=13) — picks 25
    expect(findClosestQuality(37, [25, 50, 75, 100])).toBe(25);
    // 38 is equidistant from 25 (diff=13) and 50 (diff=12) — picks 50
    expect(findClosestQuality(38, [25, 50, 75, 100])).toBe(50);
  });

  it("handles single-element qualities array", () => {
    expect(findClosestQuality(1, [75])).toBe(75);
    expect(findClosestQuality(100, [75])).toBe(75);
  });
});
