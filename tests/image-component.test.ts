import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";

const IMAGE_MODULE_PATH = "../packages/vinext/src/shims/image.js";
const HEAD_MODULE_PATH = "../packages/vinext/src/shims/head.js";

async function loadImageModule(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return import(IMAGE_MODULE_PATH);
}

function optUrl(src: string, width: number, quality = 75): string {
  return `/_vinext/image?url=${encodeURIComponent(src)}&w=${width}&q=${quality}`;
}

/** Extract numeric widths from a srcSet string with "w" descriptors. */
function parseSrcSetWidths(srcSet: string): number[] {
  return srcSet.split(",").map((entry) => {
    const match = entry.trim().match(/(\d+)w$/);
    return match ? parseInt(match[1], 10) : NaN;
  });
}

const originalEnv = {
  NEXT_DEPLOYMENT_ID: process.env.NEXT_DEPLOYMENT_ID,
  __VINEXT_IMAGE_UNOPTIMIZED: process.env.__VINEXT_IMAGE_UNOPTIMIZED,
  __VINEXT_IMAGE_LOCAL_PATTERNS: process.env.__VINEXT_IMAGE_LOCAL_PATTERNS,
  __VINEXT_IMAGE_LOADER: process.env.__VINEXT_IMAGE_LOADER,
};

beforeEach(() => {
  delete process.env.NEXT_DEPLOYMENT_ID;
  delete process.env.__VINEXT_IMAGE_UNOPTIMIZED;
  delete process.env.__VINEXT_IMAGE_LOCAL_PATTERNS;
  delete process.env.__VINEXT_IMAGE_LOADER;
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(process.env, originalEnv);
});

describe("next/image shim", () => {
  // Ported from Next.js:
  // test/unit/next-image-get-img-props.test.ts
  // https://github.com/vercel/next.js/blob/v16.1.6/test/unit/next-image-get-img-props.test.ts
  it("uses allSizes with 1x/2x descriptors for fixed-width images", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      alt: "fixed",
      src: "/test.png",
      width: 100,
      height: 200,
    });

    expect(props.srcSet).toBe(`${optUrl("/test.png", 128)} 1x, ${optUrl("/test.png", 256)} 2x`);
    expect(props.src).toBe(optUrl("/test.png", 256));
  });

  // Ported from Next.js:
  // test/unit/next-image-get-img-props.test.ts
  // https://github.com/vercel/next.js/blob/v16.1.6/test/unit/next-image-get-img-props.test.ts
  it("uses the closest configured sizes for small and large fixed widths", async () => {
    const { getImageProps } = await loadImageModule();

    expect(
      getImageProps({
        alt: "small",
        src: "/test.png",
        width: 32,
        height: 32,
      }).props.srcSet,
    ).toBe(`${optUrl("/test.png", 32)} 1x, ${optUrl("/test.png", 64)} 2x`);

    expect(
      getImageProps({
        alt: "large",
        src: "/test.png",
        width: 512,
        height: 512,
      }).props.srcSet,
    ).toBe(`${optUrl("/test.png", 640)} 1x, ${optUrl("/test.png", 1080)} 2x`);
  });

  // Ported from Next.js:
  // test/unit/next-image-get-img-props.test.ts
  // https://github.com/vercel/next.js/blob/v16.1.6/test/unit/next-image-get-img-props.test.ts
  it("applies overrideSrc to the rendered img props", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      alt: "override",
      src: "/test.png",
      width: 100,
      height: 200,
      overrideSrc: "/override.png",
    });

    expect(props.src).toBe("/override.png");
    expect(props.srcSet).toBe(`${optUrl("/test.png", 128)} 1x, ${optUrl("/test.png", 256)} 2x`);
  });

  // Ported from Next.js:
  // test/unit/next-image-get-img-props.test.ts
  // https://github.com/vercel/next.js/blob/v16.1.6/test/unit/next-image-get-img-props.test.ts
  it("treats data and blob URLs as unoptimized", async () => {
    const { getImageProps } = await loadImageModule();

    const dataResult = getImageProps({
      alt: "data",
      src: "data:image/png;base64,abc123",
      width: 100,
      height: 100,
    });
    expect(dataResult.props.src).toBe("data:image/png;base64,abc123");
    expect(dataResult.props.srcSet).toBeUndefined();
    expect(dataResult.props.loading).toBeUndefined();

    const blobResult = getImageProps({
      alt: "blob",
      src: "blob:https://example.com/1234",
      width: 100,
      height: 100,
    });
    expect(blobResult.props.src).toBe("blob:https://example.com/1234");
    expect(blobResult.props.srcSet).toBeUndefined();
    expect(blobResult.props.loading).toBeUndefined();
  });

  it("honors images.unoptimized from config", async () => {
    const { getImageProps } = await loadImageModule({
      __VINEXT_IMAGE_UNOPTIMIZED: "true",
    });
    const { props } = getImageProps({
      alt: "global unoptimized",
      src: "/photo.jpg",
      width: 800,
      height: 600,
    });

    expect(props.src).toBe("/photo.jpg");
    expect(props.srcSet).toBeUndefined();
  });

  // Ported from Next.js:
  // test/unit/next-image-get-img-props.test.ts
  // https://github.com/vercel/next.js/blob/v16.1.6/test/unit/next-image-get-img-props.test.ts
  it("infers the missing dimension for static imports", async () => {
    const { getImageProps } = await loadImageModule();
    const staticImage = {
      src: "/static/photo.png",
      width: 1200,
      height: 800,
    };

    const { props } = getImageProps({
      alt: "static",
      src: staticImage,
      width: 600,
    });

    expect(props.width).toBe(600);
    expect(props.height).toBe(400);
  });

  // Ported from Next.js:
  // test/unit/next-image-get-img-props.test.ts
  // https://github.com/vercel/next.js/blob/v16.1.6/test/unit/next-image-get-img-props.test.ts
  it("does not auto-set loading or fetchPriority for preload and priority", async () => {
    const { getImageProps } = await loadImageModule();

    const preloadProps = getImageProps({
      alt: "preload",
      src: "/hero.png",
      width: 800,
      height: 600,
      preload: true,
    }).props;
    expect(preloadProps.loading).toBeUndefined();
    expect(preloadProps.fetchPriority).toBeUndefined();

    const priorityProps = getImageProps({
      alt: "priority",
      src: "/hero.png",
      width: 800,
      height: 600,
      priority: true,
    }).props;
    expect(priorityProps.loading).toBeUndefined();
    expect(priorityProps.fetchPriority).toBeUndefined();
  });

  it("emits preload links for preload and priority during SSR", async () => {
    const imageModule = await loadImageModule();
    const { resetSSRHead, getSSRHeadHTML } = await import(HEAD_MODULE_PATH);
    const Image = imageModule.default;

    resetSSRHead();
    ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "preload",
        src: "/hero.png",
        width: 800,
        height: 600,
        preload: true,
      }),
    );
    expect(getSSRHeadHTML()).toContain('rel="preload"');
    expect(getSSRHeadHTML()).toContain('as="image"');

    resetSSRHead();
    ReactDOMServer.renderToString(
      React.createElement(Image, {
        alt: "priority",
        src: "/hero.png",
        width: 800,
        height: 600,
        priority: true,
      }),
    );
    expect(getSSRHeadHTML()).toContain('rel="preload"');
  });

  it("throws on invalid preload and priority combinations", async () => {
    const { getImageProps } = await loadImageModule();

    expect(() =>
      getImageProps({
        alt: "bad",
        src: "/hero.png",
        width: 800,
        height: 600,
        preload: true,
        priority: true,
      }),
    ).toThrow(/both "preload" and "priority"/);

    expect(() =>
      getImageProps({
        alt: "bad",
        src: "/hero.png",
        width: 800,
        height: 600,
        preload: true,
        loading: "lazy",
      }),
    ).toThrow(/both "preload" and "loading='lazy'"/);
  });

  it("supports string quality and width/height values", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      alt: "string values",
      src: "/test.png",
      width: "100",
      height: "200",
      quality: "90",
    });

    expect(props.width).toBe(100);
    expect(props.height).toBe(200);
    expect(props.src).toBe(optUrl("/test.png", 256, 75));
  });

  // Ported from Next.js:
  // test/unit/next-image-get-img-props.test.ts
  // https://github.com/vercel/next.js/blob/v16.1.6/test/unit/next-image-get-img-props.test.ts
  it("adds dpl to optimized and unoptimized local images", async () => {
    process.env.NEXT_DEPLOYMENT_ID = "dpl_123";
    const { getImageProps } = await loadImageModule();

    const optimized = getImageProps({
      alt: "optimized",
      src: "/test.png",
      width: 100,
      height: 200,
    }).props;
    expect(optimized.srcSet).toBe(
      `/_vinext/image?url=%2Ftest.png&w=128&q=75&dpl=dpl_123 1x, /_vinext/image?url=%2Ftest.png&w=256&q=75&dpl=dpl_123 2x`,
    );
    expect(optimized.src).toBe(`/_vinext/image?url=%2Ftest.png&w=256&q=75&dpl=dpl_123`);

    const unoptimized = getImageProps({
      alt: "svg",
      src: "/test.svg",
      width: 100,
      height: 200,
    }).props;
    expect(unoptimized.src).toBe("/test.svg?dpl=dpl_123");
  });

  it("preserves existing dpl on local images", async () => {
    process.env.NEXT_DEPLOYMENT_ID = "dpl_123";
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      alt: "existing dpl",
      src: "/_next/static/media/test.abc123.png?dpl=dpl_existing",
      width: 100,
      height: 200,
      unoptimized: true,
    });

    expect(props.src).toBe("/_next/static/media/test.abc123.png?dpl=dpl_existing");
  });

  it("validates localPatterns in development", async () => {
    const { getImageProps } = await loadImageModule({
      __VINEXT_IMAGE_LOCAL_PATTERNS: JSON.stringify([{ pathname: "/allowed/**" }]),
    });

    expect(() =>
      getImageProps({
        alt: "blocked",
        src: "/blocked/test.png",
        width: 100,
        height: 100,
      }),
    ).toThrow(/images\.localPatterns/);
  });
});

describe("findClosestQuality", () => {
  // Ported from Next.js: test/unit/image-optimizer/find-closest-quality.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/unit/image-optimizer/find-closest-quality.test.ts
  it("returns input quality when no qualities array", async () => {
    const { findClosestQuality } = await loadImageModule();
    expect(findClosestQuality(75)).toBe(75);
  });

  it("returns input quality when empty qualities array", async () => {
    const { findClosestQuality } = await loadImageModule();
    expect(findClosestQuality(75, [])).toBe(75);
  });

  it("returns single quality regardless of input", async () => {
    const { findClosestQuality } = await loadImageModule();
    expect(findClosestQuality(50, [80])).toBe(80);
  });

  it("returns exact match", async () => {
    const { findClosestQuality } = await loadImageModule();
    expect(findClosestQuality(75, [25, 50, 75, 100])).toBe(75);
  });

  it("returns closest lower quality", async () => {
    const { findClosestQuality } = await loadImageModule();
    expect(findClosestQuality(60, [25, 50, 75, 100])).toBe(50);
  });

  it("returns closest upper quality", async () => {
    const { findClosestQuality } = await loadImageModule();
    expect(findClosestQuality(70, [25, 50, 75, 100])).toBe(75);
  });

  it("returns first encountered when equidistant", async () => {
    const { findClosestQuality } = await loadImageModule();
    // 62 is equidistant from 50 and 75 — reduce keeps the earlier winner
    expect(findClosestQuality(62, [25, 50, 75, 100])).toBe(50);
  });

  it("snaps default quality 75 to configured qualities", async () => {
    const { findClosestQuality } = await loadImageModule();
    expect(findClosestQuality(75, [25, 50, 80])).toBe(80);
  });
});

describe("sanitizeBlurDataURL prevents CSS injection", () => {
  it("blocks blurDataURL containing parentheses", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      placeholder: "blur",
      blurDataURL: "data:image/png;base64,abc(def)",
    });

    expect(props.style.backgroundImage).toBeUndefined();
  });

  it("blocks blurDataURL containing quotes", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      placeholder: "blur",
      blurDataURL: 'data:image/png;base64,abc"def',
    });

    expect(props.style.backgroundImage).toBeUndefined();
  });

  it("blocks blurDataURL containing newlines", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      placeholder: "blur",
      blurDataURL: "data:image/png;base64,abc\ndef",
    });

    expect(props.style.backgroundImage).toBeUndefined();
  });

  it("blocks placeholder with parentheses via data:image/ path", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      placeholder: "data:image/png;base64,abc(def)" as `data:image/${string}`,
    });

    expect(props.style.backgroundImage).toBeUndefined();
  });

  it("blocks placeholder with quotes via data:image/ path", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      placeholder: 'data:image/png;base64,abc"def' as `data:image/${string}`,
    });

    expect(props.style.backgroundImage).toBeUndefined();
  });

  it("throws for placeholder values that are not data:image/", async () => {
    const { getImageProps } = await loadImageModule();

    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        width: 100,
        height: 100,
        placeholder: "javascript:alert(1)" as `data:image/${string}`,
      }),
    ).toThrow(/invalid "placeholder" property/);

    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        width: 100,
        height: 100,
        placeholder: "data:text/html;base64,abc" as `data:image/${string}`,
      }),
    ).toThrow(/invalid "placeholder" property/);
  });

  it("allows valid blurDataURL and sets backgroundImage", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      placeholder: "blur",
      blurDataURL: "data:image/png;base64,iVBORw0KGgo=",
    });

    expect(props.style.backgroundImage).toBe("url(data:image/png;base64,iVBORw0KGgo=)");
  });
});

describe("getWidths vw-based filtering", () => {
  // Default deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840]
  // Default imageSizes:  [32, 48, 64, 96, 128, 256, 384]
  // allSizes (sorted):   [32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840]
  // With sizes="33vw": smallestRatio = 0.33, threshold = 640 * 0.33 = 211.2
  // Only widths >= 212 survive => 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840
  it("excludes small widths below the vw threshold", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      fill: true,
      sizes: "33vw",
      alt: "test",
      src: "/img.jpg",
    });

    const srcSet = props.srcSet as string;
    const widths = parseSrcSetWidths(srcSet);

    // These small sizes should be filtered out (all < 211.2)
    expect(widths).not.toContain(32);
    expect(widths).not.toContain(48);
    expect(widths).not.toContain(64);
    expect(widths).not.toContain(96);
    expect(widths).not.toContain(128);

    // Sizes >= 256 should be present
    expect(widths).toContain(256);
    expect(widths).toContain(384);
    expect(widths).toContain(640);
    expect(widths).toContain(3840);
  });
});

describe("loader: custom error path", () => {
  it("throws when loader is 'custom' and no loader prop is provided", async () => {
    const { getImageProps } = await loadImageModule({
      __VINEXT_IMAGE_LOADER: "custom",
    });

    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        width: 100,
        height: 100,
      }),
    ).toThrow(/missing "loader" prop/);
  });
});

describe("normalizeProps dev-mode validation", () => {
  it("throws on missing src", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "",
        alt: "test",
        width: 100,
        height: 100,
      }),
    ).toThrow(/missing required "src"/);
  });

  it("throws on src with leading whitespace", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: " /test.png",
        alt: "test",
        width: 100,
        height: 100,
      }),
    ).toThrow(/cannot start with a space/);
  });

  it("throws on src with trailing control character", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png\t",
        alt: "test",
        width: 100,
        height: 100,
      }),
    ).toThrow(/cannot end with a space or control/);
  });

  it("throws on invalid loading value", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        width: 100,
        height: 100,
        loading: "fast" as any,
      }),
    ).toThrow(/invalid "loading" property/);
  });

  it("throws on priority + loading='lazy'", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        width: 100,
        height: 100,
        priority: true,
        loading: "lazy",
      }),
    ).toThrow(/both "priority" and "loading='lazy'"/);
  });

  it("throws on blur placeholder without blurDataURL", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        width: 100,
        height: 100,
        placeholder: "blur",
      }),
    ).toThrow(/missing the "blurDataURL"/);
  });

  it("throws on fill + width", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        fill: true,
        width: 100,
      } as any),
    ).toThrow(/both "width" and "fill"/);
  });

  it("throws on fill + height", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        fill: true,
        height: 100,
      } as any),
    ).toThrow(/both "height" and "fill"/);
  });

  it("throws on fill + style.position (not absolute)", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        fill: true,
        style: { position: "relative" },
      } as any),
    ).toThrow(/fill.*position/);
  });

  it("throws on fill + style.width (not 100%)", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        fill: true,
        style: { width: "50%" },
      } as any),
    ).toThrow(/fill.*width/);
  });

  it("throws on fill + style.height (not 100%)", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        fill: true,
        style: { height: "50%" },
      } as any),
    ).toThrow(/fill.*height/);
  });

  it("throws on non-fill without width", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        height: 100,
      } as any),
    ).toThrow(/missing required "width"/);
  });

  it("throws on non-fill without height", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        width: 100,
      } as any),
    ).toThrow(/missing required "height"/);
  });

  it("throws on invalid width (NaN)", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        width: "abc" as any,
        height: 100,
      }),
    ).toThrow(/invalid "width"/);
  });

  it("throws on invalid height (NaN)", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "/test.png",
        alt: "test",
        width: 100,
        height: "abc" as any,
      }),
    ).toThrow(/invalid "height"/);
  });

  it("throws on static import missing src", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: { src: "", width: 100, height: 100 },
        alt: "test",
      } as any),
    ).toThrow(/must include src/);
  });

  it("throws on static import missing dimensions", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: { src: "/test.png", width: 0, height: 0 },
        alt: "test",
      } as any),
    ).toThrow(/must include height and width/);
  });

  it("throws on protocol-relative src (//example.com)", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "//example.com/img.png",
        alt: "test",
        width: 100,
        height: 100,
      }),
    ).toThrow(/protocol-relative URL/);
  });

  it("throws on unconfigured remote hostname", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "https://evil.com/img.png",
        alt: "test",
        width: 100,
        height: 100,
      }),
    ).toThrow(/not configured/);
  });

  it("throws on relative src not starting with /", async () => {
    const { getImageProps } = await loadImageModule();
    expect(() =>
      getImageProps({
        src: "relative/img.png",
        alt: "test",
        width: 100,
        height: 100,
      }),
    ).toThrow(/must start with a leading slash/);
  });
});

describe("fill mode rendering", () => {
  it("sets data-nimg='fill'", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/test.png",
      alt: "test",
      fill: true,
      sizes: "100vw",
    } as any);

    expect(props["data-nimg"]).toBe("fill");
  });

  it("sets position: absolute, width: 100%, height: 100% in style", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/test.png",
      alt: "test",
      fill: true,
      sizes: "100vw",
    } as any);

    expect(props.style.position).toBe("absolute");
    expect(props.style.width).toBe("100%");
    expect(props.style.height).toBe("100%");
  });

  it("width and height props are undefined", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/test.png",
      alt: "test",
      fill: true,
      sizes: "100vw",
    } as any);

    expect(props.width).toBeUndefined();
    expect(props.height).toBeUndefined();
  });

  it("defaults sizes to '100vw' when no sizes provided", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/test.png",
      alt: "test",
      fill: true,
    } as any);

    expect(props.sizes).toBe("100vw");
  });
});

describe("legacy prop warnings", () => {
  it("warns for lazyBoundary", async () => {
    const { getImageProps } = await loadImageModule();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      lazyBoundary: "200px",
    } as any);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/legacy prop "lazyBoundary"/));
    warnSpy.mockRestore();
  });

  it("warns for lazyRoot", async () => {
    const { getImageProps } = await loadImageModule();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      lazyRoot: "some-id",
    } as any);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/legacy prop "lazyRoot"/));
    warnSpy.mockRestore();
  });

  it("warns for layout", async () => {
    const { getImageProps } = await loadImageModule();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      layout: "responsive",
    } as any);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/legacy prop "layout"/));
    warnSpy.mockRestore();
  });

  it("warns for objectFit", async () => {
    const { getImageProps } = await loadImageModule();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      objectFit: "cover",
    } as any);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/legacy prop "objectFit"/));
    warnSpy.mockRestore();
  });

  it("warns for objectPosition", async () => {
    const { getImageProps } = await loadImageModule();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      objectPosition: "center",
    } as any);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/legacy prop "objectPosition"/));
    warnSpy.mockRestore();
  });

  it("warns for onLoadingComplete", async () => {
    const { getImageProps } = await loadImageModule();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    getImageProps({
      src: "/test.png",
      alt: "test",
      width: 100,
      height: 100,
      onLoadingComplete: () => {},
    } as any);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/deprecated "onLoadingComplete"/));
    warnSpy.mockRestore();
  });
});

describe("static import dimension inference", () => {
  it("infers width from height for static imports", async () => {
    const { getImageProps } = await loadImageModule();
    const staticImage = {
      src: "/static/photo.png",
      width: 1200,
      height: 800,
    };

    const { props } = getImageProps({
      alt: "static",
      src: staticImage,
      height: 400,
    } as any);

    expect(props.width).toBe(600);
    expect(props.height).toBe(400);
  });
});

describe("SVG auto-unoptimized", () => {
  it(".svg files are automatically unoptimized when dangerouslyAllowSVG is false", async () => {
    const { getImageProps } = await loadImageModule();
    const { props } = getImageProps({
      src: "/icon.svg",
      alt: "test",
      width: 100,
      height: 100,
    });

    expect(props.srcSet).toBeUndefined();
    expect(props.src).toBe("/icon.svg");
  });
});
