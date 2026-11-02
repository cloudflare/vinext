import { describe, expect, it } from "vite-plus/test";
import { isAnimatedImage } from "../packages/vinext/src/server/image-animation.js";
import {
  handleImageOptimization,
  markImageBuildAsset,
  sniffImageContentType,
} from "../packages/vinext/src/server/image-optimization.js";

// Ported from Next.js: packages/next/src/server/image-optimizer.ts
// https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/image-optimizer.ts
// `imageOptimizer` serves `BYPASS_TYPES` (SVG, ICO, ICNS, BMP, JPEG XL, HEIC)
// and animated GIF, PNG and WebP sources as-is, and rejects SVG unless
// `images.dangerouslyAllowSVG` is set.

const GIF_HEADER = [
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
];
const GIF_FRAME = [
  0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0,
];
const STATIC_GIF = new Uint8Array([...GIF_HEADER, ...GIF_FRAME, 0x3b]);
const ANIMATED_GIF = new Uint8Array([...GIF_HEADER, ...GIF_FRAME, ...GIF_FRAME, 0x3b]);

function pngChunk(type: string, data: number[] = []): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...Array.from(type, (char) => char.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const STATIC_PNG = new Uint8Array([
  ...PNG_SIGNATURE,
  ...pngChunk("IHDR", Array(13).fill(0)),
  ...pngChunk("IDAT", [0]),
  ...pngChunk("IEND"),
]);
const ANIMATED_PNG = new Uint8Array([
  ...PNG_SIGNATURE,
  ...pngChunk("IHDR", Array(13).fill(0)),
  ...pngChunk("acTL", Array(8).fill(0)),
  ...pngChunk("fcTL", Array(26).fill(0)),
  ...pngChunk("IDAT", [0]),
  ...pngChunk("fcTL", Array(26).fill(0)),
  ...pngChunk("fdAT", [0, 0, 0, 1, 0]),
  ...pngChunk("IEND"),
]);

function riff(chunks: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    ...Array.from("RIFF", (char) => char.charCodeAt(0)),
    0,
    0,
    0,
    0,
    ...Array.from(`WEBP${chunks}`, (char) => char.charCodeAt(0)),
  ]);
}
const STATIC_WEBP = riff("VP8 \0\0\0\0");
const ANIMATED_WEBP = riff("VP8X\0\0\0\0ANIM\0\0\0\0");

describe("isAnimatedImage", () => {
  it("detects animated GIF, PNG and WebP like Next.js' is-animated", () => {
    expect(isAnimatedImage(ANIMATED_GIF)).toBe(true);
    expect(isAnimatedImage(ANIMATED_PNG)).toBe(true);
    expect(isAnimatedImage(ANIMATED_WEBP)).toBe(true);
  });

  it("treats single-frame images and other formats as still", () => {
    expect(isAnimatedImage(STATIC_GIF)).toBe(false);
    expect(isAnimatedImage(STATIC_PNG)).toBe(false);
    expect(isAnimatedImage(STATIC_WEBP)).toBe(false);
    expect(isAnimatedImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(isAnimatedImage(new Uint8Array())).toBe(false);
  });

  it("ends the scan at a truncated PNG chunk", () => {
    expect(isAnimatedImage(ANIMATED_PNG.subarray(0, PNG_SIGNATURE.length + 30))).toBe(false);
  });
});

describe("handleImageOptimization formats Next.js does not optimize", () => {
  const imageRequest = (source: string) =>
    new Request(`http://localhost/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`, {
      headers: { Accept: "image/avif,image/webp,*/*" },
    });

  function handlers(body: BodyInit, contentType: string) {
    const transformed: string[] = [];
    return {
      transformed,
      handlers: {
        fetchAsset: async () =>
          new Response(body, { status: 200, headers: { "Content-Type": contentType } }),
        transformImage: async (input: ReadableStream, options: { format: string }) => {
          transformed.push(new TextDecoder().decode(await new Response(input).arrayBuffer()));
          return new Response("transformed", { headers: { "Content-Type": options.format } });
        },
      },
    };
  }

  for (const [source, contentType, responseType] of [
    ["/favicon.ico", "image/x-icon", "image/x-icon"],
    ["/favicon.ico", "image/vnd.microsoft.icon", "image/x-icon"],
    ["/icon.icns", "image/x-icns", "image/x-icns"],
    ["/image.bmp", "image/bmp", "image/bmp"],
    ["/image.jxl", "image/jxl", "image/jxl"],
    ["/image.heic", "image/heic", "image/heic"],
  ] as const) {
    it(`serves ${contentType} as-is without transforming it`, async () => {
      const { handlers: imageHandlers, transformed } = handlers("source-bytes", contentType);
      const response = await handleImageOptimization(imageRequest(source), imageHandlers);
      expect(response.status).toBe(200);
      expect(transformed).toEqual([]);
      expect(await response.text()).toBe("source-bytes");
      expect(response.headers.get("Content-Type")).toBe(responseType);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
      expect(response.headers.get("Vary")).toBe("Accept");
      expect(response.headers.get("Content-Security-Policy")).toBe(
        "script-src 'none'; frame-src 'none'; sandbox;",
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("x-nextjs-cache")).toBe("MISS");
    });
  }

  it("rejects SVG without dangerouslyAllowSVG and serves it as-is with it", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const blocked = handlers(svg, "image/svg+xml");
    const rejected = await handleImageOptimization(imageRequest("/logo.svg"), blocked.handlers);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toBe('"url" parameter is valid but image type is not allowed');
    expect(rejected.headers.get("x-nextjs-cache")).toBeNull();

    const allowed = handlers(svg, "image/svg+xml");
    const response = await handleImageOptimization(
      imageRequest("/logo.svg"),
      allowed.handlers,
      undefined,
      { dangerouslyAllowSVG: true },
    );
    expect(response.status).toBe(200);
    expect(allowed.transformed).toEqual([]);
    expect(await response.text()).toBe(svg);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "script-src 'none'; frame-src 'none'; sandbox;",
    );
  });

  it("keeps a build asset immutable, but not a public file under a _next/static folder", async () => {
    const { handlers: imageHandlers } = handlers("source-bytes", "image/x-icon");
    const buildAsset = await handleImageOptimization(
      imageRequest("/_next/static/media/favicon.0a1b2c3d.ico"),
      {
        ...imageHandlers,
        fetchAsset: async () => markImageBuildAsset(await imageHandlers.fetchAsset()),
      },
    );
    expect(buildAsset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const publicFile = await handleImageOptimization(
      imageRequest("/avatars/_next/static/favicon.ico"),
      imageHandlers,
    );
    expect(publicFile.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
  });

  for (const [name, bytes, contentType] of [
    ["GIF", ANIMATED_GIF, "image/gif"],
    ["PNG", ANIMATED_PNG, "image/png"],
    ["WebP", ANIMATED_WEBP, "image/webp"],
  ] as const) {
    it(`serves an animated ${name} as-is`, async () => {
      const { handlers: imageHandlers, transformed } = handlers(bytes, contentType);
      const response = await handleImageOptimization(imageRequest("/animated"), imageHandlers);
      expect(response.status).toBe(200);
      expect(transformed).toEqual([]);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get("Content-Type")).toBe(contentType);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
    });
  }

  it("transforms a still GIF from its buffered bytes", async () => {
    const { handlers: imageHandlers, transformed } = handlers(STATIC_GIF, "image/gif");
    const response = await handleImageOptimization(imageRequest("/still.gif"), imageHandlers);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("transformed");
    expect(response.headers.get("Content-Type")).toBe("image/avif");
    expect(transformed).toEqual([new TextDecoder().decode(STATIC_GIF)]);
  });

  it("falls back to the buffered source when the transform fails", async () => {
    const response = await handleImageOptimization(imageRequest("/still.png"), {
      fetchAsset: async () =>
        new Response(STATIC_PNG, { status: 200, headers: { "Content-Type": "image/png" } }),
      transformImage: async (input: ReadableStream) => {
        await new Response(input).arrayBuffer();
        throw new Error("unsupported");
      },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(STATIC_PNG);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
  });
});

describe("handleImageOptimization passthrough Cache-Control", () => {
  const imageRequest = (source: string) =>
    new Request(`http://localhost/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`);
  const source = (contentType: string, cacheControl: string, body: BodyInit = "source") => ({
    fetchAsset: async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
      }),
  });

  // Next.js sends max(images.minimumCacheTTL, the source's s-maxage or max-age).
  it("keeps a source max-age longer than the minimum TTL", async () => {
    for (const [cacheControl, expected] of [
      ["public, max-age=86400", "public, max-age=86400, must-revalidate"],
      ["public, max-age=60, s-maxage=90000", "public, max-age=90000, must-revalidate"],
      ['public, max-age="172800"', "public, max-age=172800, must-revalidate"],
      ["public, max-age=0, must-revalidate", "public, max-age=14400, must-revalidate"],
    ] as const) {
      const bypass = await handleImageOptimization(
        imageRequest("/favicon.ico"),
        source("image/x-icon", cacheControl),
      );
      expect(bypass.headers.get("Cache-Control"), cacheControl).toBe(expected);
      const unoptimized = await handleImageOptimization(
        imageRequest("/image.jpg"),
        source("image/jpeg", cacheControl),
      );
      expect(unoptimized.headers.get("Cache-Control"), cacheControl).toBe(expected);
    }
  });

  it("keeps an animated source's max-age", async () => {
    const response = await handleImageOptimization(imageRequest("/animated.gif"), {
      ...source("image/gif", "public, max-age=86400", ANIMATED_GIF),
      transformImage: async () => new Response("transformed"),
    });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400, must-revalidate");
  });

  it("uses images.minimumCacheTTL as the least max-age", async () => {
    for (const [cacheControl, expected] of [
      ["public, max-age=0", "public, max-age=60, must-revalidate"],
      ["public, max-age=86400", "public, max-age=86400, must-revalidate"],
    ] as const) {
      const response = await handleImageOptimization(
        imageRequest("/favicon.ico"),
        source("image/x-icon", cacheControl),
        undefined,
        { minimumCacheTTL: 60 },
      );
      expect(response.headers.get("Cache-Control"), cacheControl).toBe(expected);
    }
  });

  it("uses only the minimum TTL after a failed transform", async () => {
    const response = await handleImageOptimization(imageRequest("/image.jpg"), {
      ...source("image/jpeg", "public, max-age=86400"),
      transformImage: async () => {
        throw new Error("unsupported");
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
  });
});

describe("handleImageOptimization source size limit", () => {
  // Next.js reads at most `images.maximumResponseBody` (50 MB by default) of a
  // source and answers 413 past it.
  const TOO_LARGE = '"url" parameter is valid but internal response is invalid';
  const transformImage = async () => new Response("transformed");
  const imageRequest = new Request("http://localhost/_next/image?url=%2Fbig.png&w=640&q=75");

  it("rejects a source that declares more than the limit without reading it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1));
      },
    });
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "image/png", "Content-Length": "50000001" },
        }),
      transformImage,
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(TOO_LARGE);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("uses images.maximumResponseBody as the limit", async () => {
    const response = await handleImageOptimization(
      imageRequest,
      {
        fetchAsset: async () =>
          new Response(new Uint8Array(11), {
            status: 200,
            headers: { "Content-Type": "image/png" },
          }),
        transformImage,
      },
      undefined,
      { maximumResponseBody: 10 },
    );
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(TOO_LARGE);
  });

  it("stops reading a source once it exceeds the limit", async () => {
    const chunk = new Uint8Array(1_000_000);
    let enqueued = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueued += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () =>
        new Response(body, { status: 200, headers: { "Content-Type": "image/png" } }),
      transformImage,
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(TOO_LARGE);
    expect(cancelled).toBe(true);
    expect(enqueued).toBeLessThanOrEqual(52);
  });
});

describe("handleImageOptimization source without an image Content-Type", () => {
  const ICNS = new Uint8Array([0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 8]);
  const imageRequest = (source: string) =>
    new Request(`http://localhost/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`);
  // Split the bytes so the signature spans chunks.
  const chunked = (bytes: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });

  it("detects types by Next.js's signatures", () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    expect(sniffImageContentType(ICNS)).toBe("image/x-icns");
    expect(sniffImageContentType(bytes(0, 0, 1, 0))).toBe("image/x-icon");
    expect(sniffImageContentType(bytes(0x42, 0x4d))).toBe("image/bmp");
    expect(sniffImageContentType(bytes(0xff, 0x0a))).toBe("image/jxl");
    expect(
      sniffImageContentType(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63)),
    ).toBe("image/heic");
    expect(sniffImageContentType(new TextEncoder().encode("<svg xmlns"))).toBe("image/svg+xml");
    expect(sniffImageContentType(new TextEncoder().encode("<!DOCTYPE html>"))).toBeNull();
    expect(sniffImageContentType(new Uint8Array())).toBeNull();
  });

  for (const contentType of [null, "application/octet-stream"]) {
    it(`serves an ICNS source typed ${contentType} as-is`, async () => {
      const response = await handleImageOptimization(imageRequest("/icon.icns"), {
        fetchAsset: async () => {
          const response = new Response(chunked(ICNS), { status: 200 });
          if (contentType === null) response.headers.delete("Content-Type");
          else response.headers.set("Content-Type", contentType);
          return response;
        },
        transformImage: async () => new Response("transformed"),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/x-icns");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(ICNS);
    });
  }

  it("replays a large first chunk unchanged", async () => {
    const bytes = new Uint8Array(1_000_000);
    bytes.set(ICNS);
    const response = await handleImageOptimization(imageRequest("/icon.icns"), {
      fetchAsset: async () => new Response(bytes, { status: 200 }),
    });
    expect(response.headers.get("Content-Type")).toBe("image/x-icns");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("still rejects a source whose bytes are not an allowed image", async () => {
    for (const body of ["<!DOCTYPE html><p>page</p>", "<svg onload=alert(1)></svg>"]) {
      const response = await handleImageOptimization(imageRequest("/page"), {
        fetchAsset: async () =>
          new Response(body, { status: 200, headers: { "Content-Type": "text/html" } }),
      });
      expect(response.status, body).toBe(400);
      expect(await response.text()).toBe('"url" parameter is valid but image type is not allowed');
    }
  });
});
