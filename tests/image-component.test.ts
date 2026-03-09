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

const originalEnv = {
  NEXT_DEPLOYMENT_ID: process.env.NEXT_DEPLOYMENT_ID,
  __VINEXT_IMAGE_UNOPTIMIZED: process.env.__VINEXT_IMAGE_UNOPTIMIZED,
  __VINEXT_IMAGE_LOCAL_PATTERNS: process.env.__VINEXT_IMAGE_LOCAL_PATTERNS,
};

beforeEach(() => {
  delete process.env.NEXT_DEPLOYMENT_ID;
  delete process.env.__VINEXT_IMAGE_UNOPTIMIZED;
  delete process.env.__VINEXT_IMAGE_LOCAL_PATTERNS;
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
