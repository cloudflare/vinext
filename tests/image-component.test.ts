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
import Image, { getImageProps, type StaticImageData } from "../packages/vinext/src/shims/image.js";

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
    // x-descriptor mode: src = largest snapped width (100→128, 200→256) → 256
    expect(html).toContain(`src="${optUrlHtml("/test.png", 256)}"`);
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
    // x-descriptor: 800→828, 1600→1920 → src = 1920 (largest)
    expect(html).toContain(`src="${optUrlHtml("/_next/static/media/test.abc123.png", 1920)}"`);

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
  it("generates x-descriptor srcSet for local images without sizes prop", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/photo.png",
        width: 500,
        height: 400,
      }),
    );
    // No sizes prop + width=500 → x-descriptor mode (Next.js parity)
    // 500 → snaps to 640, 1000 → snaps to 1080
    expect(html).toContain("srcSet");
    expect(html).toContain(`${optUrlHtml("/photo.png", 640)} 1x`);
    expect(html).toContain(`${optUrlHtml("/photo.png", 1080)} 2x`);
  });

  it("generates w-descriptor srcSet when sizes prop is provided", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "test",
        src: "/large.png",
        width: 2000,
        height: 1500,
        sizes: "100vw",
      }),
    );
    // sizes="100vw" → w-descriptor mode with allSizes
    expect(html).toContain(`${optUrlHtml("/large.png", 640)} 640w`);
    expect(html).toContain(`${optUrlHtml("/large.png", 3840)} 3840w`);
  });

  it("generates x-descriptor srcSet for very small images", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "tiny",
        src: "/icon.png",
        width: 16,
        height: 16,
      }),
    );
    // width=16 → snap to 16, width*2=32 → snap to 32
    // x-descriptors: "opt(16) 1x, opt(32) 2x"
    expect(html).toContain(`${optUrlHtml("/icon.png", 16)} 1x`);
    expect(html).toContain(`${optUrlHtml("/icon.png", 32)} 2x`);
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
    // x-descriptor mode: src = 2x snapped width (100→128, 200→256) → largest = 256
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

    // x-descriptor: 1920→1920, 3840→3840 → src = 3840 (largest)
    expect(props.src).toBe(optUrl("/static/photo.png", 3840));
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
    // No sizes prop → x-descriptors
    expect(props.srcSet).toContain("1x");
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

// ─── StaticImageData always uses /_vinext/image ──────────────────────

describe("StaticImageData always uses /_vinext/image URLs", () => {
  it("renders /_vinext/image URLs in srcSet for static imports", () => {
    const staticImage: StaticImageData = {
      src: "/assets/hero.abc123.png",
      width: 1200,
      height: 800,
    };
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "hero",
        src: staticImage,
      }),
    );
    // srcSet should use /_vinext/image URLs, not direct asset URLs
    expect(html).toContain("/_vinext/image");
    expect(html).not.toContain(".webp");
  });

  it("getImageProps returns /_vinext/image URLs for static imports", () => {
    const staticImage: StaticImageData = {
      src: "/assets/photo.abc123.png",
      width: 800,
      height: 600,
    };
    const { props } = getImageProps({
      alt: "photo",
      src: staticImage,
    });
    expect(props.src).toContain("/_vinext/image");
    expect(props.srcSet).toContain("/_vinext/image");
    expect(props.srcSet).not.toContain(".webp");
  });
});

// ─── Fill mode objectFit customization ────────────────────────────
// Ported from Next.js: test/unit/next-image-get-img-props.test.ts
describe("fill mode objectFit customization", () => {
  it("uses style.objectFit when provided in fill mode", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "fill custom",
        src: "/photo.jpg",
        fill: true,
        style: { objectFit: "contain" },
      }),
    );
    expect(html).toContain("object-fit:contain");
    expect(html).not.toContain("object-fit:cover");
  });

  it("defaults fill mode objectFit to undefined when no style given (not hardcoded cover)", () => {
    const { props } = getImageProps({
      alt: "fill default",
      src: "/photo.jpg",
      fill: true,
    });
    // Next.js doesn't hardcode objectFit:'cover' — it only sets it when the user provides it
    // or via the deprecated objectFit prop. The default fill style should not include objectFit.
    expect((props.style as any)?.objectFit).toBeUndefined();
  });

  it("respects style.objectPosition in fill mode", () => {
    const { props } = getImageProps({
      alt: "fill positioned",
      src: "/photo.jpg",
      fill: true,
      style: { objectPosition: "top left" },
    });
    expect((props.style as any)?.objectPosition).toBe("top left");
  });

  it("allows style.objectFit='none' in fill mode", () => {
    const { props } = getImageProps({
      alt: "fill none",
      src: "/photo.jpg",
      fill: true,
      style: { objectFit: "none" },
    });
    expect((props.style as any)?.objectFit).toBe("none");
  });
});

// ─── imageSizes config support in srcSet ──────────────────────────
describe("imageSizes config support in srcSet", () => {
  it("snaps to imageSizes for small images in x-descriptor mode", () => {
    // width=100 → snaps to allSizes >= 100 → 128 (from imageSizes)
    // width*2=200 → snaps to allSizes >= 200 → 256 (from imageSizes)
    // x-descriptor: "opt(128) 1x, opt(256) 2x"
    const { props } = getImageProps({
      alt: "small image",
      src: "/icon.png",
      width: 100,
      height: 100,
    });
    expect(props.srcSet).toBeDefined();
    if (props.srcSet) {
      // imageSizes 128 is used as the 1x snap point
      expect(props.srcSet).toContain(optUrl("/icon.png", 128));
      expect(props.srcSet).toContain("1x");
      expect(props.srcSet).toContain("2x");
    }
  });
});

// ─── overrideSrc prop ──────────────────────────────────────────────
// Ported from Next.js: test/unit/next-image-get-img-props.test.ts
describe("overrideSrc prop", () => {
  it("overrideSrc replaces the final src in getImageProps", () => {
    const { props } = getImageProps({
      alt: "override test",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      overrideSrc: "/cdn/photo-optimized.jpg",
    });
    expect(props.src).toBe("/cdn/photo-optimized.jpg");
  });

  it("overrideSrc replaces src in SSR rendering", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "override ssr",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        overrideSrc: "/cdn/photo.webp",
      }),
    );
    expect(html).toContain('src="/cdn/photo.webp"');
  });

  it("overrideSrc does not affect srcSet generation", () => {
    const { props } = getImageProps({
      alt: "override srcset",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      overrideSrc: "/cdn/photo.webp",
    });
    // srcSet should still use original src through optimization endpoint
    expect(props.srcSet).toBeDefined();
    expect(props.srcSet).toContain("/_vinext/image");
  });
});

// ─── data:image/* placeholder type ────────────────────────────────
// Ported from Next.js: test/unit/next-image-get-img-props.test.ts
describe("data:image/* placeholder type", () => {
  it("accepts data:image/* string as placeholder value", () => {
    const dataUrl =
      "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
    const { props } = getImageProps({
      alt: "custom placeholder",
      src: "/photo.jpg",
      width: 400,
      height: 300,
      placeholder: dataUrl as any,
    });
    expect((props.style as any)?.backgroundImage).toContain("R0lGODlh");
  });

  it("renders data:image/* placeholder in SSR", () => {
    const dataUrl =
      "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "data placeholder",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        placeholder: dataUrl as any,
      }),
    );
    expect(html).toContain("background-image");
    expect(html).toContain("R0lGODlh");
  });
});

// ─── deprecated props compatibility ───────────────────────────────
// Ported from Next.js: test/unit/next-image-get-img-props.test.ts
describe("deprecated props compatibility", () => {
  it("accepts layout prop without error", () => {
    // Should not throw when receiving deprecated layout prop
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "deprecated layout",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        layout: "responsive",
      } as any),
    );
    expect(html).toContain('alt="deprecated layout"');
  });

  it("accepts objectFit prop without error", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "deprecated objectFit",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        objectFit: "contain",
      } as any),
    );
    expect(html).toContain('alt="deprecated objectFit"');
  });

  it("accepts objectPosition prop without error", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "deprecated objectPosition",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        objectPosition: "top center",
      } as any),
    );
    expect(html).toContain('alt="deprecated objectPosition"');
  });

  it("accepts lazyBoundary and lazyRoot props without error", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "deprecated lazy props",
        src: "/photo.jpg",
        width: 400,
        height: 300,
        lazyBoundary: "200px",
        lazyRoot: null,
      } as any),
    );
    expect(html).toContain('alt="deprecated lazy props"');
  });
});

// ─── srcSet descriptor parity with Next.js ────────────────────────
// Ported from Next.js: packages/next/src/shared/lib/get-img-props.ts getWidths()
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/get-img-props.ts
describe("srcSet x-descriptor parity with Next.js", () => {
  it("uses x-descriptors (1x, 2x) when no sizes prop and width is given", () => {
    // Next.js: getWidths with width=200, no sizes → kind='x'
    // width(200) snaps to allSizes >= 200 → 256
    // width*2(400) snaps to allSizes >= 400 → 640
    // srcSet = "opt(256) 1x, opt(640) 2x"
    const { props } = getImageProps({
      alt: "x-desc test",
      src: "/photo.png",
      width: 200,
      height: 150,
    });
    expect(props.srcSet).toBeDefined();
    expect(props.srcSet).toContain("1x");
    expect(props.srcSet).toContain("2x");
    // Should NOT use w-descriptors
    expect(props.srcSet).not.toMatch(/\d+w/);
  });

  it("snaps widths to nearest allSizes value >= target", () => {
    // width=300 → snap to 384, width*2=600 → snap to 640
    const { props } = getImageProps({
      alt: "snap test",
      src: "/photo.png",
      width: 300,
      height: 200,
    });
    expect(props.srcSet).toContain(optUrl("/photo.png", 384));
    expect(props.srcSet).toContain(optUrl("/photo.png", 640));
  });

  it("deduplicates when 1x and 2x snap to the same size", () => {
    // width=3000 → snap to 3840, width*2=6000 → snap to 3840 (max)
    // Dedup → only one entry: "opt(3840) 1x"
    const { props } = getImageProps({
      alt: "dedup test",
      src: "/photo.png",
      width: 3000,
      height: 2000,
    });
    expect(props.srcSet).toBeDefined();
    // Only 1 entry (deduplicated)
    const entries = props.srcSet!.split(", ");
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain("1x");
  });

  it("sets src to the largest width in srcSet (2x variant)", () => {
    // Next.js: src = loader({ width: widths[last] })
    // width=200 → widths=[256, 640] → src=opt(640)
    const { props } = getImageProps({
      alt: "src test",
      src: "/photo.png",
      width: 200,
      height: 150,
    });
    expect(props.src).toBe(optUrl("/photo.png", 640));
  });

  it("uses w-descriptors when sizes prop is provided", () => {
    // Next.js: getWidths with sizes="50vw" → kind='w'
    const { props } = getImageProps({
      alt: "w-desc test",
      src: "/photo.png",
      width: 500,
      height: 400,
      sizes: "(max-width: 768px) 100vw, 50vw",
    });
    expect(props.srcSet).toBeDefined();
    expect(props.srcSet).toMatch(/\d+w/);
    // Should NOT use x-descriptors
    expect(props.srcSet).not.toContain("1x");
    expect(props.srcSet).not.toContain("2x");
  });

  it("renders x-descriptors in SSR output", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "x-desc ssr",
        src: "/photo.png",
        width: 400,
        height: 300,
      }),
    );
    // Should use x-descriptors in srcSet
    expect(html).toContain("1x");
    expect(html).toContain("2x");
    // Should NOT use w-descriptors
    expect(html).not.toMatch(/\d+w/);
  });

  it("renders w-descriptors in SSR when sizes is provided", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "w-desc ssr",
        src: "/photo.png",
        width: 500,
        height: 400,
        sizes: "50vw",
      }),
    );
    // Should use w-descriptors
    expect(html).toMatch(/\d+w/);
    // Should NOT use x-descriptors
    expect(html).not.toContain(" 1x");
    expect(html).not.toContain(" 2x");
  });
});

// ─── StaticImageData blurWidth/blurHeight ─────────────────────────
describe("StaticImageData blurWidth/blurHeight", () => {
  it("accepts StaticImageData with blurWidth and blurHeight fields", () => {
    const staticImage: StaticImageData & { blurWidth?: number; blurHeight?: number } = {
      src: "/assets/hero.abc123.png",
      width: 1200,
      height: 800,
      blurDataURL: "data:image/png;base64,abc123",
      blurWidth: 8,
      blurHeight: 5,
    };
    // Should not throw
    const { props } = getImageProps({
      alt: "hero with blur dims",
      src: staticImage,
      placeholder: "blur",
    });
    expect(props.src).toBeDefined();
    expect((props.style as any)?.backgroundImage).toContain("data:image/png;base64,abc123");
  });
});
